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

  // I/O
  write(data: string): void;
  resize(cols: number, rows: number): void;
  
  // Events
  onData(listener: (data: string) => void): IDisposable;
  onExit(listener: (code: number, signal?: number) => void): IDisposable;

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

## How to Add a New Backend

To add `DockerPty` or `SshPty` in the future, follow these steps:

1. Create a new class that implements `ITerminalBackend`.
2. In the constructor, only "store configuration" and do not cause side effects (connection or spawning).
3. Implement the actual connection logic in the `spawn()` method and return a `Promise`.
4. Fire stdout/stderr via `onData` without distinction.
