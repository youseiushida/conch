import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConchSession } from '../src/session';
import { encodeScriptForShell } from '../src/utils';
import { MockBackend } from './utils/MockBackend';

describe('Script Injection (Step 1.5)', () => {
  let backend: MockBackend;
  let session: ConchSession;

  beforeEach(() => {
    backend = new MockBackend();
    session = new ConchSession(backend);
  });

  describe('encodeScriptForShell', () => {
    it('should generate eval command for bash', () => {
      const script = 'echo hello';
      const encoded = encodeScriptForShell(script, 'bash');
      // "echo hello" -> ZWNobyBoZWxsbw==
      expect(encoded).toContain('ZWNobyBoZWxsbw==');
      expect(encoded).toContain('base64 -d');
      expect(encoded).toContain('eval');
    });

    it('should generate iex command for pwsh', () => {
      const script = 'Write-Host hello';
      const encoded = encodeScriptForShell(script, 'pwsh');
      // "Write-Host hello" -> V3JpdGUtSG9zdCBoZWxsbw==
      expect(encoded).toContain('V3JpdGUtSG9zdCBoZWxsbw==');
      expect(encoded).toContain('FromBase64String');
      expect(encoded).toContain('iex');
    });

    it('should throw for unsupported shell', () => {
      expect(() => encodeScriptForShell('foo', 'zsh' as any)).toThrow();
    });
  });

  describe('unsafeInjectScript', () => {
    it('should send encoded command to backend via execute (bash)', () => {
      session.unsafeInjectScript('echo test', { shell: 'bash' });
      
      // Check that write was called with the encoded command + \r
      const expectedEncoded = encodeScriptForShell('echo test', 'bash');
      expect(backend.write).toHaveBeenCalledWith(`${expectedEncoded}\r`);
    });

    it('should send encoded command to backend via execute (pwsh)', () => {
      session.unsafeInjectScript('Write-Host test', { shell: 'pwsh' });
      
      const expectedEncoded = encodeScriptForShell('Write-Host test', 'pwsh');
      expect(backend.write).toHaveBeenCalledWith(`${expectedEncoded}\r`);
    });
  });

  describe('enableShellIntegration', () => {
    it('should inject preset and verify success (mocked flow)', async () => {
      // Setup backend to echo back the verify command output (sentinel)
      // This simulates a successful injection where the shell is responsive
      
      // Override write to simulate echo back
      backend.write.mockImplementation((data: string) => {
        // If the data looks like the verify command (echo sentinel)
        if (data.includes('__CONCH_OK_')) {
            // Extract the sentinel
            const match = data.match(/(__CONCH_OK_[a-z0-9]+)/);
            if (match) {
                // Emit it back as if the shell printed it
                backend.emitData(`${match[1]}\r\n`);
            }
        }
      });

      // Force shell to bash for predictable test
      const result = await session.enableShellIntegration('bash');
      
      expect(result).toBe(true);
      // Should have called write at least twice: injection + verification
      expect(backend.write).toHaveBeenCalledTimes(2);
    });

    it('should return false if verification times out', async () => {
      // Backend does nothing, so verification will timeout
      // Reduce timeout for test speed? waitForText defaults to 10s or whatever.
      // We can't easily change the hardcoded timeout in enableShellIntegration without exposing it.
      // But we can mock waitForText in session.ts or just rely on the test timing out if we are not careful.
      // Since enableShellIntegration has 5000ms timeout, this test would be slow.
      // Let's use vi.useFakeTimers to speed it up.
      
      vi.useFakeTimers();
      
      const promise = session.enableShellIntegration('bash');
      
      // Fast-forward time
      vi.advanceTimersByTime(6000);
      
      const result = await promise;
      expect(result).toBe(false);
      
      vi.useRealTimers();
    });
  });
});
