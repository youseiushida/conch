import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConchSession } from '../src/session';
import { waitForText, waitForSilence, waitForChange, waitForStable, cropText, findText } from '../src/utils';

// Partial Mock Session
const mockSession = {
  getSnapshot: vi.fn(),
  onOutput: vi.fn(),
} as unknown as ConchSession;

describe('Utils', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Wait Functions', () => {
    describe('waitForText', () => {
      it('should resolve when text appears', async () => {
        // Mock sequence of snapshots
        mockSession.getSnapshot = vi.fn()
          .mockReturnValueOnce({ text: 'loading...' })
          .mockReturnValueOnce({ text: 'loading...' })
          .mockReturnValue({ text: 'completed!' });

        const promise = waitForText(mockSession, 'completed', { interval: 10 });

        // Advance timers to trigger polling
        await vi.advanceTimersByTimeAsync(30);

        await expect(promise).resolves.toBeUndefined();
      });

      it('should resolve when regex matches', async () => {
        mockSession.getSnapshot = vi.fn().mockReturnValue({ text: 'Error: code 123' });

        const promise = waitForText(mockSession, /Error: code \d+/, { interval: 10 });
        
        await vi.advanceTimersByTimeAsync(10);
        await expect(promise).resolves.toBeUndefined();
      });

      it('should handle regex with /g flag (lastIndex reset)', async () => {
        const regex = /pattern/g;
        // First call sets lastIndex, subsequent calls might fail if not reset
        mockSession.getSnapshot = vi.fn().mockReturnValue({ text: 'pattern found' });

        // 1. Manually mess up lastIndex
        regex.lastIndex = 5;

        // 2. waitForText should fix it
        const promise = waitForText(mockSession, regex, { interval: 10 });
        await vi.advanceTimersByTimeAsync(10);
        
        await expect(promise).resolves.toBeUndefined();
      });

      it('should timeout if text never appears', async () => {
        mockSession.getSnapshot = vi.fn().mockReturnValue({ text: 'still loading...' });

        const promise = waitForText(mockSession, 'finished', { timeout: 100, interval: 10 });
        const expectPromise = expect(promise).rejects.toThrow('waitForText timed out');

        await vi.advanceTimersByTimeAsync(150);
        await expectPromise;
      });
    });

    describe('waitForSilence', () => {
      it('should resolve if no output for duration', async () => {
        // Mock onOutput subscription
        mockSession.onOutput = vi.fn().mockReturnValue({ dispose: () => {} });

        const promise = waitForSilence(mockSession, 50, 200);

        // No output events occur
        await vi.advanceTimersByTimeAsync(60);

        await expect(promise).resolves.toBeUndefined();
      });

      it('should reset timer on output', async () => {
        let outputCallback: (data: string) => void = () => {};
        mockSession.onOutput = vi.fn((cb) => {
          outputCallback = cb;
          return { dispose: () => {} };
        });

        const promise = waitForSilence(mockSession, 50, 200);

        // 1. Advance 30ms (not enough)
        await vi.advanceTimersByTimeAsync(30);
        
        // 2. Emit output -> timer resets
        outputCallback('data');

        // 3. Advance another 30ms (total 60ms, but only 30ms since reset)
        await vi.advanceTimersByTimeAsync(30);

        // 4. Advance 30ms more (total 60ms since reset > 50ms duration)
        await vi.advanceTimersByTimeAsync(30);

        await expect(promise).resolves.toBeUndefined();
      });

      it('should timeout if output keeps coming', async () => {
        let outputCallback: (data: string) => void = () => {};
        mockSession.onOutput = vi.fn((cb) => {
          outputCallback = cb;
          return { dispose: () => {} };
        });

        const promise = waitForSilence(mockSession, 50, 100);
        const expectPromise = expect(promise).rejects.toThrow('waitForSilence timed out');

        // Keep emitting every 30ms
        const interval = setInterval(() => outputCallback('.'), 30);

        // Advance past timeout
        await vi.advanceTimersByTimeAsync(150);
        clearInterval(interval);

        await expectPromise;
      });
    });

    describe('waitForChange', () => {
        it('should resolve when snapshot text changes', async () => {
            mockSession.getSnapshot = vi.fn()
                .mockReturnValueOnce({ text: 'initial' }) // called at start
                .mockReturnValueOnce({ text: 'initial' })
                .mockReturnValue({ text: 'changed' });
            
            const promise = waitForChange(mockSession, { interval: 10 });
            await vi.advanceTimersByTimeAsync(30);
            await expect(promise).resolves.toBeUndefined();
        });
    });

    describe('waitForStable', () => {
        it('should resolve when snapshot stops changing', async () => {
            mockSession.getSnapshot = vi.fn()
                .mockReturnValueOnce({ text: 'a' })
                .mockReturnValueOnce({ text: 'b' }) // change! reset stable timer
                .mockReturnValue({ text: 'b' });    // stable...
            
            const promise = waitForStable(mockSession, 50, { interval: 10 });
            
            // a -> b (change)
            await vi.advanceTimersByTimeAsync(20);
            
            // b -> b (stable for 50ms)
            await vi.advanceTimersByTimeAsync(60);

            await expect(promise).resolves.toBeUndefined();
        });
    });
  });

  describe('Locator Functions', () => {
    // Helper to create dummy snapshot
    const createSnapshot = (lines: string[]) => ({
      text: lines.join('\n'),
      cursor: { x: 0, y: 0 },
      cursorSnapshot: { x: 0, y: 0 },
      meta: {} as any
    });

    describe('cropText', () => {
      it('should crop correct rect', () => {
        const snap = createSnapshot([
          '12345',
          '67890',
          'abcde'
        ]);
        // Crop: x=1, y=1, w=3, h=2
        // Line 1: '789'
        // Line 2: 'bcd'
        const result = cropText(snap, { x: 1, y: 1, width: 3, height: 2 });
        expect(result).toBe('789\nbcd');
      });

      it('should handle out of bounds gracefully', () => {
        const snap = createSnapshot(['abc']);
        // y=5 is out of bounds
        const result = cropText(snap, { x: 0, y: 5, width: 1, height: 1 });
        expect(result).toBe('');
      });
    });

    describe('findText', () => {
      it('should find all occurrences of string', () => {
        const snap = createSnapshot([
          'foo bar',
          'baz foo'
        ]);
        const matches = findText(snap, 'foo');
        expect(matches).toHaveLength(2);
        expect(matches[0]).toEqual({ x: 0, y: 0, match: 'foo' });
        expect(matches[1]).toEqual({ x: 4, y: 1, match: 'foo' });
      });

      it('should find regex matches', () => {
        const snap = createSnapshot(['item 123', 'item 456']);
        const matches = findText(snap, /\d+/);
        expect(matches).toHaveLength(2);
        expect(matches[0].match).toBe('123');
        expect(matches[1].match).toBe('456');
      });
    });
  });
});
