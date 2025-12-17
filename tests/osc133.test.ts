import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConchSession } from '../src/session';
import { ShellIntegrationType } from '../src/types';
import { MockBackend } from './utils/MockBackend';

describe('OSC 133 (Shell Integration)', () => {
  let backend: MockBackend;
  let session: ConchSession;

  beforeEach(() => {
    backend = new MockBackend();
    session = new ConchSession(backend);
  });

  it('should detect Prompt Start (A)', async () => {
    const spy = vi.fn();
    session.onShellIntegration(spy);

    // Send OSC 133;A with BEL terminator
    backend.emitData('\x1b]133;A\x07');
    
    // Wait for processing (xterm parser handles it synchronously usually, but drain is safer)
    await session.drain();

    expect(spy).toHaveBeenCalledWith({
      type: ShellIntegrationType.PromptStart,
      params: []
    });
  });

  it('should detect Command Finished (D) with exit code', async () => {
    const spy = vi.fn();
    session.onShellIntegration(spy);

    // Send OSC 133;D;0 with BEL terminator
    backend.emitData('\x1b]133;D;0\x07');
    
    await session.drain();

    expect(spy).toHaveBeenCalledWith({
      type: ShellIntegrationType.CommandFinished,
      params: ['0']
    });
  });

  it('should handle complex params (D;0;123)', async () => {
    const spy = vi.fn();
    session.onShellIntegration(spy);

    // Send OSC 133;D;0;123 with BEL terminator
    backend.emitData('\x1b]133;D;0;123\x07');
    
    await session.drain();

    expect(spy).toHaveBeenCalledWith({
      type: ShellIntegrationType.CommandFinished,
      params: ['0', '123']
    });
  });

  it('should handle ST terminator (\\x1b\\)', async () => {
    const spy = vi.fn();
    session.onShellIntegration(spy);

    // Send OSC 133;B with ST terminator
    backend.emitData('\x1b]133;B\x1b\\');
    
    await session.drain();

    expect(spy).toHaveBeenCalledWith({
      type: ShellIntegrationType.CommandStart,
      params: []
    });
  });

  it('should detect Command Executed (C)', async () => {
    const spy = vi.fn();
    session.onShellIntegration(spy);

    // Send OSC 133;C with BEL terminator
    backend.emitData('\x1b]133;C\x07');

    await session.drain();

    expect(spy).toHaveBeenCalledWith({
      type: ShellIntegrationType.CommandExecuted,
      params: []
    });
  });

  it('should clean up listeners on dispose', () => {
    const spy = vi.fn();
    session.onShellIntegration(spy);
    
    session.dispose();

    // Emitting data after dispose shouldn't trigger listener (and shouldn't crash)
    // Note: MockBackend doesn't automatically stop emitting on dispose unless we implement logic there,
    // but session should have cleared its listeners.
    backend.emitData('\x1b]133;A\x07');
    
    expect(spy).not.toHaveBeenCalled();
  });
});
