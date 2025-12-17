import { vi } from 'vitest';
import type { ITerminalBackend, IDisposable } from '../../src/types';

// Mock Backend Implementation
export class MockBackend implements ITerminalBackend {
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
