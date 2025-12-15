import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { LocalPty } from '../src/backend/LocalPty';
import * as os from 'os';

// Mock node-pty
const mockPtyProcess = {
  pid: 12345,
  process: 'mock-shell',
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  onData: vi.fn(),
  onExit: vi.fn(),
};

vi.mock('@lydell/node-pty', () => {
  return {
    spawn: vi.fn(() => mockPtyProcess),
  };
});

// Mock os to control platform
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof os>('os');
  return {
    ...actual,
    platform: vi.fn(),
  };
});

describe('LocalPty', () => {
  let pty: LocalPty;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default to linux behavior
    (os.platform as Mock).mockReturnValue('linux');
    
    // Reset mockPtyProcess methods
    mockPtyProcess.write.mockClear();
    mockPtyProcess.resize.mockClear();
    mockPtyProcess.kill.mockClear();
    mockPtyProcess.onData.mockClear();
    mockPtyProcess.onExit.mockClear();

    pty = new LocalPty('bash');
  });

  describe('Lifecycle & Spawn', () => {
    it('spawn() should call pty.spawn', async () => {
      await pty.spawn();
      
      const nodePty = await import('@lydell/node-pty');
      expect(nodePty.spawn).toHaveBeenCalledWith(
        'bash',
        expect.any(Array),
        expect.objectContaining({
          encoding: 'utf8',
          cols: 80,
          rows: 24
        })
      );
    });

    it('spawn() on Windows should inject chcp 65001', async () => {
      (os.platform as Mock).mockReturnValue('win32');
      
      await pty.spawn();

      // Should write chcp 65001 and Clear-Host
      expect(mockPtyProcess.write).toHaveBeenCalledWith(expect.stringContaining('chcp 65001'));
      expect(mockPtyProcess.write).toHaveBeenCalledWith(expect.stringContaining('Clear-Host'));
    });

    it('should throw if spawn is called twice', async () => {
      await pty.spawn();
      await expect(pty.spawn()).rejects.toThrow('LocalPty is already spawned');
    });

    it('should throw if spawn is called after dispose', async () => {
      pty.dispose();
      await expect(pty.spawn()).rejects.toThrow('LocalPty is disposed');
    });
  });

  describe('I/O Operations', () => {
    beforeEach(async () => {
      await pty.spawn();
    });

    it('write() should forward to pty process', () => {
      pty.write('ls\r');
      expect(mockPtyProcess.write).toHaveBeenCalledWith('ls\r');
    });

    it('resize() should forward to pty process', () => {
      pty.resize(100, 40);
      expect(mockPtyProcess.resize).toHaveBeenCalledWith(100, 40);
    });

    it('write() before spawn should not throw but log warning', () => {
      const freshPty = new LocalPty('bash');
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      freshPty.write('test');
      
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('write called before spawn'));
      expect(mockPtyProcess.write).not.toHaveBeenCalled();
      
      consoleSpy.mockRestore();
    });
  });

  describe('Events', () => {
    it('should propagate onData events', async () => {
      await pty.spawn();
      
      const listener = vi.fn();
      pty.onData(listener);

      // Simulate data from node-pty
      // We need to capture the callback passed to mockPtyProcess.onData
      const onDataCallback = mockPtyProcess.onData.mock.calls[0][0];
      onDataCallback('hello output');

      expect(listener).toHaveBeenCalledWith('hello output');
    });

    it('should propagate onExit events', async () => {
      await pty.spawn();

      const listener = vi.fn();
      pty.onExit(listener);

      // Simulate exit
      const onExitCallback = mockPtyProcess.onExit.mock.calls[0][0];
      onExitCallback({ exitCode: 1, signal: 0 });

      expect(listener).toHaveBeenCalledWith(1, 0);
    });
  });

  describe('Dispose', () => {
    it('should kill process and clear listeners', async () => {
      await pty.spawn();
      
      pty.dispose();
      
      expect(mockPtyProcess.kill).toHaveBeenCalled();
    });
  });
});
