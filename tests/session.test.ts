import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConchSession } from '../src/session';
import { ITerminalBackend, IDisposable } from '../src/types';

// Mock Backend Implementation
class MockBackend implements ITerminalBackend {
  public id = 12345;
  public processName = 'mock-shell';
  
  public write = vi.fn();
  public resize = vi.fn();
  public dispose = vi.fn();
  public spawn = vi.fn().mockResolvedValue(undefined);

  private dataListeners: ((data: string) => void)[] = [];
  private exitListeners: ((code: number, signal?: number) => void)[] = [];

  public onData(listener: (data: string) => void): IDisposable {
    this.dataListeners.push(listener);
    return {
      dispose: () => {
        this.dataListeners = this.dataListeners.filter(l => l !== listener);
      }
    };
  }

  public onExit(listener: (code: number, signal?: number) => void): IDisposable {
    this.exitListeners.push(listener);
    return {
      dispose: () => {
        this.exitListeners = this.exitListeners.filter(l => l !== listener);
      }
    };
  }

  // Helper to simulate incoming data from backend
  public emitData(data: string) {
    this.dataListeners.forEach(l => l(data));
  }

  // Helper to simulate backend exit
  public emitExit(code: number, signal?: number) {
    this.exitListeners.forEach(l => l(code, signal));
  }
}

describe('ConchSession', () => {
  let backend: MockBackend;
  let session: ConchSession;

  beforeEach(() => {
    backend = new MockBackend();
    session = new ConchSession(backend, { cols: 80, rows: 24 });
  });

  describe('Lifecycle', () => {
    it('should instantiate and dispose without errors', () => {
      expect(session).toBeDefined();
      session.dispose();
      // backend.dispose should be called
      expect(backend.dispose).toHaveBeenCalled();
    });
  });

  describe('Pipeline Connection', () => {
    it('should forward data from backend to terminal and output listeners', async () => {
      const outputSpy = vi.fn();
      session.onOutput(outputSpy);

      // Simulate data from backend
      backend.emitData('Hello World');

      // Check onOutput listener
      expect(outputSpy).toHaveBeenCalledWith('Hello World');

      // Check terminal content (need to wait for write to flush to buffer)
      await session.drain();
      const snapshot = session.getSnapshot();
      expect(snapshot.text).toContain('Hello World');
    });

    it('should forward resize to backend and terminal', () => {
      session.resize(100, 30);
      
      expect(backend.resize).toHaveBeenCalledWith(100, 30);
      
      const snapshot = session.getSnapshot();
      expect(snapshot.meta.cols).toBe(100);
      expect(snapshot.meta.rows).toBe(30);
    });
  });

  describe('Programmatic I/O', () => {
    it('write() should forward to backend', () => {
      session.write('test input');
      expect(backend.write).toHaveBeenCalledWith('test input');
    });

    it('execute() should append \\r', () => {
      session.execute('ls -la');
      expect(backend.write).toHaveBeenCalledWith('ls -la\r');
    });
  });

  describe('Input Simulation', () => {
    it('press() should send correct sequences', () => {
      session.press('Enter');
      expect(backend.write).toHaveBeenCalledWith('\r');

      session.press('ArrowUp');
      expect(backend.write).toHaveBeenCalledWith('\x1b[A');
    });

    it('type() should send string as is', () => {
      session.type('echo hello');
      expect(backend.write).toHaveBeenCalledWith('echo hello');
    });

    it('chord() should send control characters', () => {
      session.chord(['Ctrl', 'C']);
      expect(backend.write).toHaveBeenCalledWith('\x03'); // ^C
    });
  });

  describe('Snapshot (Viewport)', () => {
    it('should capture visible viewport only', async () => {
      // Simulate enough output to cause scrolling
      // Terminal height is 24 rows. We send 30 lines.
      for (let i = 0; i < 30; i++) {
        backend.emitData(`Line ${i}\r\n`);
      }
      await session.drain();

      const snapshot = session.getSnapshot({ range: 'viewport' });

      // Viewport should show the last 24 lines (roughly Line 6 to Line 29)
      // Note: Implementation details of xterm.js might slightly vary on scrolling logic,
      // but we expect to NOT see "Line 0" which should be scrolled out.
      expect(snapshot.text).not.toContain('Line 0');
      expect(snapshot.text).toContain('Line 29');
      
      // Meta check
      expect(snapshot.meta.rangeUsed).toBe('viewport');
      expect(snapshot.meta.rows).toBe(24);
      expect(snapshot.meta.viewportY).toBeGreaterThan(0);
    });

    it('cursorSnapshot should be relative to viewport', async () => {
      // Clear screen
      backend.emitData('\x1b[2J\x1b[H');
      // Move cursor to specific line/col (1-based in escape seq, 0-based in snapshot)
      // Move to line 5, col 5
      backend.emitData('\x1b[5;5H');
      await session.drain();

      const snapshot = session.getSnapshot();
      
      // In a fresh buffer without scroll, absolute Y == relative Y
      // Expected relative Y = 4 (0-based)
      expect(snapshot.cursorSnapshot.y).toBe(4);
      expect(snapshot.cursorSnapshot.x).toBe(4);
    });
  });

  describe('Snapshot (All)', () => {
    it('should capture scrollback', async () => {
       // Simulate scrolling
       for (let i = 0; i < 30; i++) {
        backend.emitData(`Log ${i}\r\n`);
      }
      await session.drain();

      const snapshot = session.getSnapshot({ range: 'all' });
      
      // Should contain early logs scrolled out of viewport
      expect(snapshot.text).toContain('Log 0');
      expect(snapshot.text).toContain('Log 29');
    });
  });

  describe('Edge Cases', () => {
    it('should safely handle dispose() then write()', () => {
      session.dispose();
      // Should not throw
      expect(() => session.write('foo')).not.toThrow();
      // Backend write should NOT be called after session dispose (session clears reference? or just ignores?)
      // Current implementation calls backend.write if backend exists.
      // But session.dispose() calls backend.dispose(). 
      // If backend implementation is safe, it's fine.
    });

    it('should clamp resize values to min 2 cols / 1 rows', () => {
      session.resize(0, -5);
      // Conch enforces min cols=2
      expect(backend.resize).toHaveBeenCalledWith(2, 1);
      
      const snapshot = session.getSnapshot();
      expect(snapshot.meta.cols).toBe(2);
      expect(snapshot.meta.rows).toBe(1);
    });

    it('should handle empty lines in snapshot', async () => {
        backend.emitData('Line 1\r\n\r\nLine 3');
        await session.drain();

        const snapshot = session.getSnapshot();
        const lines = snapshot.text.split('\n');
        
        // Ensure empty line is preserved
        // Line 1 -> text
        // Line 2 -> empty
        // Line 3 -> text
        // (Note: xterm might render empty line as just empty string or string with spaces depending on trim settings)
        // Default formatter trims right.
        
        expect(lines[0].trim()).toBe('Line 1');
        expect(lines[1]).toBe(''); 
        expect(lines[2].trim()).toBe('Line 3');
    });
  });
});
