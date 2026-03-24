# Backend Adapters

This directory contains "Backend Adapters" that abstract terminal processes.

## Interface: `ITerminalBackend`

All backends must implement `ITerminalBackend` defined in `src/types.ts`.
This allows unified handling of not only Local PTY but also Docker containers, SSH connections, etc.

```typescript
export interface ITerminalBackend extends IDisposable {
  // Lifecycle
  spawn(): Promise<void>; // Start process (async)
  dispose(): void;
  /**
   * Optional async disposal hook.
   * Useful for awaiting full backend shutdown (e.g., Docker container stop/remove).
   */
  disposeAsync?(): Promise<void>;

  // I/O
  write(data: string): void;
  resize(cols: number, rows: number): void;
  
  // Events
  onData(listener: (data: string) => void): IDisposable;
  onExit(listener: (code: number, signal?: number) => void): IDisposable;
  /**
   * Optional fatal backend error event.
   * When provided, `Conch.run()` can fail fast instead of waiting for timeout.
   */
  onError?(listener: (err: Error) => void): IDisposable;

  // Metadata
  readonly id: string | number; // PID or ContainerID
  readonly processName: string; // "bash", "node" etc.
}
```

## Available Backends

### `LocalPty`

- **Dependency**: `node-pty`
- **Overview**: Spawns a shell process (bash, powershell, etc.) on the local machine.
- **Features**:
    - **Async Spawn**: The `spawn()` method allows control over when the process starts. You can register listeners before starting.
    - **Windows Support**: On Windows, it automatically executes `chcp 65001` to start in UTF-8 mode and waits for initialization (screen clear) to complete. This prevents character encoding issues.
    - **Safety**: Calling `spawn()` on a disposed instance throws an error to prevent invalid states.

### `DockerPty`

- **Dependency**: `dockerode`
- **Overview**: Runs a shell inside a Docker container and attaches to it like a PTY (TTY mode).
- **Features**:
    - **Async Spawn**: Creates + starts a container and attaches a stream.
    - **Resize**: Calls `container.resize({ w, h })`.
    - **Safe Output Decoding**: Uses `StringDecoder` to decode UTF-8 safely across chunk boundaries.
    - **Cleanup**: Best-effort stop/remove on spawn failure, and idempotent `disposeAsync()` for awaited cleanup.
- **Notes**:
    - In TTY mode, stdout/stderr are combined into a single stream.
    - Shell Integration (OSC 133) typically requires an image with `bash` and `cmd: ["bash"]` (default is `/bin/sh`).

### `SshPty`

- **Dependency**: `ssh2`
- **Overview**: Connects to a remote host via SSH and opens a PTY shell session. Uses the `ssh2` library to manage the connection lifecycle.
- **Authentication**: Supports multiple methods -- any combination can be provided:
    - `password`: Password authentication.
    - `privateKey` (with optional `passphrase`): Public key authentication.
    - `agent`: SSH agent forwarding (e.g., `SSH_AUTH_SOCK`).
- **Features**:
    - **Async Spawn**: `spawn()` connects to the SSH server, authenticates, and opens an interactive shell with PTY allocation.
    - **Resize**: Uses `stream.setWindow(rows, cols, 0, 0)` to resize the remote PTY.
    - **Safe Output Decoding**: Uses `StringDecoder` to decode UTF-8 safely across chunk boundaries.
    - **Signal Mapping**: Maps POSIX signal names (HUP, INT, KILL, TERM, etc.) from `ssh2` stream exit events to numeric signal codes. Exit code follows Unix convention: `128 + signal` when killed by signal.
    - **Error Propagation**: Implements `onError` for SSH connection errors, enabling `Conch.run()` to fail fast instead of waiting for timeout. Backend exit events (server disconnect) are also detected immediately.
    - **Cleanup**: Idempotent `disposeAsync()` -- removes all stream/client handlers, closes the channel, and disconnects the client.
- **No Auto-Reconnect**: If the SSH connection drops, the backend emits an error/exit event. There is no automatic reconnection -- the consumer should create a new instance.
- **Host Key Verification**: Defaults to accept-all (`hostVerifier: () => true`) for automation use cases. Provide a custom `hostVerifier` callback for stricter verification in production.
- **Notes**:
    - Shell Integration (OSC 133) works if the remote shell is `bash` or `pwsh`.
    - Connection tuning is available via `readyTimeout`, `keepaliveInterval`, `keepaliveCountMax`, and raw `connectOptions` for advanced ssh2 overrides.

### `TmuxPty` (Planned)

- **Dependency**: `node-pty` (existing) + `tmux` (system)
- **Overview**: Connects to a tmux session via node-pty. The key behavioral difference from LocalPty: **`dispose()` = detach, not kill.** The tmux session survives and can be re-attached later.
- **Key Features**:
    - **Session Persistence**: `dispose()` disconnects the tmux client; the session remains alive on the tmux server.
    - **Re-attach**: Launch a new Conch instance with the same session name to resume where you left off. tmux redraws the full screen on attach.
    - **Human Debugging**: Run `tmux attach -t <session>` from another terminal to watch the agent's actions in real-time.
    - **OSC 133 Passthrough**: Automatically sets `allow-passthrough on` (tmux 3.3+, session-scoped) so Shell Integration works through tmux.
    - **destroyOnDispose**: Optional flag to kill the tmux session on dispose (behaves like LocalPty).
- **Design**: See [`docs/TODO-tmux-pty.md`](../../docs/TODO-tmux-pty.md) for full specification.

## How to Add a New Backend

To add custom backends, follow these steps:

1. Create a new class that implements `ITerminalBackend`.
2. In the constructor, only "store configuration" and do not cause side effects (connection or spawning).
3. Implement the actual connection logic in the `spawn()` method and return a `Promise`.
4. Fire stdout/stderr via `onData` without distinction.
5. Optionally implement `onError` to enable fast failure in `Conch.run()`.
6. Optionally implement `disposeAsync()` for awaitable cleanup.
