# API Reference

This document is the public API specification for Conch, based on the code in `src/`.

## Package Structure
Currently, main classes and functions are exported from `src/index.ts`.

```typescript
import { Conch, ConchSession, LocalPty, waitForText, waitForStable } from '@ushida_yosei/conch';
// DockerPty / SshPty are not re-exported from the barrel to avoid pulling in
// dockerode / ssh2 for users who only need LocalPty. Import directly:
//   import { DockerPty } from "@ushida_yosei/conch/backend/DockerPty"
//   import { SshPty }    from "@ushida_yosei/conch/backend/SshPty"
// Or use Conch.launch({ backend: { type: "docker"|"ssh", ... } }) which loads them on demand.
```

---

## `src/conch.ts` (Facade: `Conch`)

The primary entry point for using the library. It wraps `ConchSession` and provides high-level operations.

> **Dispose guard**: After `dispose()` is called, all public methods throw `"Conch instance is disposed"`.

### Static Methods

#### `Conch.launch(options): Promise<Conch>`
Creates and starts a new Conch instance.
- `options.backend`: `{ type: 'localPty' | 'docker' | 'ssh', ... }` or an `ITerminalBackend` instance.
- `options.shellIntegration`: Optional OSC 133 injection settings (recommended for reliable `run()` exit codes).
- `options.autoDispose`: If true, disposes the session on process exit signals.
- `options.timeoutMs`: Default timeout for operations (default: 10000).
- `options.cols` / `options.rows`: Terminal dimensions (default: 80x24).

### Methods

#### `run(command: string, options?): Promise<RunResult>`
Executes a command and waits for completion.
- Uses OSC 133 (Shell Integration) if available to detect exact command completion and exit code.
- **C-gate**: Uses precise event filtering. Only C events arriving after `execute()` are accepted; residual D events from prior commands are skipped. D is accepted only after our C is seen, preventing false matches from stale shell integration events.
- **Backend exit detection**: If the backend exits during `run()` (e.g. SSH disconnect, PTY death), the promise rejects immediately with `"Backend exited during run() (exit code: N)"` regardless of strict mode, since OSC markers can never arrive after exit.
- **Output extraction**: When shell integration is active, `outputText` is extracted using C-D boundary extraction — content between the last OSC 133 C marker and the last OSC 133 D marker, with ANSI/OSC sequences stripped. This is deterministic, with no heuristics needed.
- If OSC 133 D is not observed:
  - `strict: false` (default): resolves after `timeoutMs` with `exitCode: undefined` (`meta.method: "fallback"`).
  - `strict: true`: rejects on timeout.
- If the backend emits a fatal error via `ITerminalBackend.onError`, `run()` can fail fast (default). Use `backendError: "ignore"` to keep the timeout-based fallback.
- Returns exit code (when available), output text, and snapshots (`snapshot: "viewport" | "all" | "none"`).

#### `pressAndSnapshot(key: string, options?): Promise<ActionResult>`
Presses a key and waits for a screen change (default: `{kind:'change'}`).
- Returns the snapshot after the update.

#### `typeAndSnapshot(text: string, options?): Promise<ActionResult>`
Types a string and captures a snapshot.
- Default wait: `{kind:'change'}` (waits for screen change to ensure PTY echo is reflected).

#### `executeAndSnapshot(command: string, options?): Promise<ActionResult>`
Executes a command (appends `\r`) and captures a snapshot.
- Default wait: `{kind:'drain'}` (best-effort drain to show immediate echo/prompt changes).

#### `waitForText(pattern, options?): Promise<void>`
Waits for text to appear on the screen. (Delegates to `utils.waitForText`)

#### `waitForStable(options?): Promise<void>`
Waits for the screen to stabilize. (Delegates to `utils.waitForStable`)

#### `waitForSilence(options?): Promise<void>`
Waits until output stops for a specified duration.

#### `waitForChange(options?): Promise<void>`
Waits until the screen snapshot content changes.

#### `getSnapshot(options?): ISnapshot`
Returns the current screen snapshot.

#### `screenText(options?): string`
Shortcut for `getSnapshot().text`.

#### `hasText(pattern, options?): boolean`
Checks if the specified string or RegExp exists in the current screen snapshot.

#### `findText(pattern, options?): TextMatch[]`
Finds all occurrences of the pattern in the current snapshot.

#### `cropText(rect, options?): string`
Extracts text from a specific rectangular region of the screen.

---

## `src/types.ts` (Type Definitions)

### `ITerminalBackend`
Abstract interface for terminal execution infrastructure (PTY/Docker/SSH, etc.).

```ts
export interface ITerminalBackend extends IDisposable {
  // Lifecycle
  spawn(): Promise<void>;
  dispose(): void;
  disposeAsync?(): Promise<void>;

  // I/O
  write(data: string): void;
  resize(cols: number, rows: number): void;

  // Events
  onData(listener: (data: string) => void): IDisposable;
  onExit(listener: (code: number, signal?: number) => void): IDisposable;
  onError?(listener: (err: Error) => void): IDisposable;

  readonly id: string | number;
  readonly processName: string;
}
```

### `BackendConfig`

You can pass a backend configuration object to `Conch.launch({ backend: ... })`:

```ts
export type BackendConfig =
  | {
      type: "localPty";
      file?: string;
      args?: string[];
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    }
  | {
      type: "docker";
      image: string;
      cmd?: string[];
      workdir?: string;
      env?: Record<string, string>;
      name?: string;
      user?: string;
      autoRemove?: boolean;
      docker?: import("dockerode").DockerOptions;
    }
  | {
      type: "ssh";
      host: string;
      port?: number;
      username: string;
      password?: string;
      privateKey?: string | Buffer;
      passphrase?: string;
      agent?: string;
      term?: string;
      readyTimeout?: number;
      keepaliveInterval?: number;
      keepaliveCountMax?: number;
      hostVerifier?: (key: Buffer) => boolean;
      connectOptions?: Partial<import("ssh2").ConnectConfig>;
    };
```

### Snapshot Types

```ts
export interface ISnapshot {
  text: string;
  cursor: { x: number; y: number };          // Absolute (Buffer)
  cursorSnapshot: { x: number; y: number };  // Relative (Snapshot)
  meta: {
    viewportY: number;
    rows: number;
    cols: number;
    isAlternateBuffer: boolean;
    startRow: number;
    endRow: number;
    rangeUsed: SnapshotRange;
  };
}

export interface FormatterContext {
  y: number;          // compatibility (= bufferY)
  bufferY: number;    // Absolute row index in buffer
  snapshotY: number;  // Relative row index in snapshot
}
```

### Action & Run Types

```ts
export type ConchWait =
  | { kind: "none" }
  | { kind: "drain"; budgetMs?: number }
  | { kind: "change"; timeoutMs?: number; intervalMs?: number }
  | { kind: "stable"; durationMs?: number; timeoutMs?: number; intervalMs?: number }
  | { kind: "silence"; durationMs?: number; timeoutMs?: number }
  | { kind: "text"; pattern: string | RegExp; timeoutMs?: number; intervalMs?: number };

export interface ActionResult {
  snapshot: ISnapshot;
  durationMs: number;
  meta: {
    action: "press" | "type" | "execute";
    waited: ConchWait["kind"];
    snapshotRange: SnapshotRange;
  };
}

export interface RunResult {
  exitCode?: number;
  outputText: string;
  snapshot?: ISnapshot;
  /** @deprecated Use snapshot */
  snapshotAfter?: ISnapshot;
  durationMs: number;
  meta: {
    action?: "run";
    waited?: "osc133" | "fallback";
    snapshotMode?: SnapshotMode;
    method: "osc133" | "fallback";
    shellIntegrationUsed: boolean;
  };
  outputRaw?: string;
}
```

---

## `src/session.ts` (Core: `ConchSession`)

The main class that bridges backend and frontend, providing control and observation capabilities.

**Terminal query auto-responder**: `ConchSession` includes built-in auto-responders for standard terminal queries (DA1, DA2, CPR/DSR, DECRQM). TUI applications (vim, less, nano, top, tmux) send these capability queries on startup and block until a response arrives. Since xterm.js headless never writes responses back, ConchSession intercepts these queries and writes standard VT220/xterm-compatible responses to the PTY, unblocking the apps.

### Constructor
```ts
new ConchSession(backend: ITerminalBackend, options?: { cols?: number; rows?: number })
```

### Input Methods

#### `write(data: string): void`
Sends string (including escape sequences) directly to the backend.

#### `execute(command: string): void`
Appends a newline code (`\r`) to the command string and sends it.
*Note: Does not wait for completion.*

#### `press(key: string): void`
Simulates key input by specifying key name (`Enter`, `Esc`, `ArrowUp`, `Ctrl+C`, etc.).

#### `type(text: string): void`
Inputs string character by character.

#### `resize(cols: number, rows: number): void`
Resizes both xterm and backend.

#### `drain(): Promise<void>`
Waits until the write queue to xterm is empty.
*Note: This waits for "reflection to screen", not backend command completion.*

### Observation Methods

#### `getSnapshot(options?: SnapshotOptions): ISnapshot`
Gets the current screen state.
- `range: 'viewport'` (default): Currently visible range only
- `range: 'all'`: Entire buffer including scrollback

### Events

#### `onOutput(listener): IDisposable`
Receives raw data from PTY.

#### `onExit(listener): IDisposable`
Detects process termination.

#### `onShellIntegration(listener): IDisposable`
Receives OSC 133 shell integration events (A: PromptStart, B: CommandStart, C: CommandExecuted, D: CommandFinished).

---

## `src/backend/LocalPty.ts` (Backend: `LocalPty`)

Local process backend wrapping `node-pty`.

### `spawn(): Promise<void>`
Starts the process.
- On Windows, waits for UTF-8 setting (`chcp 65001`) and screen clear to complete.
- Throws error if called on a disposed instance.

---

## `src/backend/DockerPty.ts` (Backend: `DockerPty`)

Docker container backend wrapping `dockerode`.

- Runs a container in TTY mode and attaches to it as a single read/write stream.
- `autoRemove` defaults to `true`.
- In TTY mode, stdout/stderr are combined into a single stream.

---

## `src/backend/SshPty.ts` (Backend: `SshPty`)

SSH remote shell backend wrapping `ssh2`.

- Connects to a remote host via SSH, opens an interactive shell with a PTY, and provides the same `ITerminalBackend` interface as `LocalPty` and `DockerPty`.
- Host key verification defaults to accepting all keys (automation use case). Override with `hostVerifier`.

### `SshPtyOptions`

```ts
export interface SshPtyOptions {
  host: string;
  port?: number;               // default: 22
  username: string;

  // Authentication (at least one required)
  password?: string;
  privateKey?: string | Buffer;
  passphrase?: string;
  agent?: string;              // SSH agent socket path

  // PTY
  cols?: number;               // default: 80
  rows?: number;               // default: 24
  term?: string;               // default: "xterm-256color"

  // Connection tuning
  readyTimeout?: number;       // default: 20000
  keepaliveInterval?: number;  // default: 10000
  keepaliveCountMax?: number;  // default: 3

  // Host key verification (default: accept all for automation)
  hostVerifier?: (key: Buffer) => boolean;

  // Escape hatch: raw ssh2 ConnectConfig overrides (applied last)
  connectOptions?: Partial<ConnectConfig>;
}
```

### Constructor

```ts
new SshPty(options: SshPtyOptions)
```

### Properties

- **`id`**: `string` — Returns `"ssh-{host}:{port}-{N}"` where N is an auto-incrementing instance counter (e.g. `"ssh-myhost:22-0"`).
- **`processName`**: `string` — Returns `"{username}@{host}"` (e.g. `"root@myhost"`).

### Methods

#### `spawn(): Promise<void>`
Connects to the SSH server, authenticates, and opens an interactive shell with a PTY.
- Throws `"SshPty is disposed"` if called after dispose.
- Throws `"SshPty is already spawned"` if called twice.
- On failure, rolls back (closes stream and disconnects client) before rethrowing.

#### `write(data: string): void`
Writes data to the SSH channel. Logs a warning if called before `spawn()`.

#### `resize(cols: number, rows: number): void`
Sends a window-change request to the SSH channel (via `setWindow`).

#### `dispose(): void`
Synchronous dispose — delegates to `disposeAsync()` (fire-and-forget).

#### `disposeAsync(): Promise<void>`
Idempotent async disposal. Removes all event listeners, closes the SSH channel, and disconnects the client.

### Signal Mapping

When the remote shell exits due to a signal, `SshPty` maps the signal name to a POSIX signal number for the `onExit` callback. Exit code follows Unix convention: `128 + signal_number`.

| Signal | Number |
|--------|--------|
| HUP    | 1      |
| INT    | 2      |
| QUIT   | 3      |
| ILL    | 4      |
| TRAP   | 5      |
| ABRT   | 6      |
| FPE    | 8      |
| KILL   | 9      |
| SEGV   | 11     |
| PIPE   | 13     |
| ALRM   | 14     |
| TERM   | 15     |

---

## `src/utils.ts` (Utilities)

### Wait Functions

#### `waitForText(session, pattern, options?): Promise<void>`
Waits until specified string or RegExp appears on screen (Viewport).
- RegExp `lastIndex` is reset every time, so it's safe to use with `/g` flag.

#### `waitForSilence(session, duration?, timeout?): Promise<void>`
Waits until output stops for specified duration (default 500ms).

#### `waitForChange(session, options?): Promise<void>`
Waits until current snapshot content changes.

#### `waitForStable(session, duration?, options?): Promise<void>`
Waits until screen content stops changing (stabilizes) for specified duration.
Useful for waiting for completion of animated CUI tools or large log outputs.

### Locator Functions

#### `cropText(snapshot, rect): string`
Extracts text from specified rectangular area (x, y, width, height) in snapshot.

#### `findText(snapshot, pattern): TextMatch[]`
Searches for occurrences of pattern in snapshot and returns list of positions (x, y).

### Helper Functions

#### `encodeScriptForShell(script, shell): string`
Encodes a script to Base64 and generates a one-liner to execute it in the target shell.
- Supports `bash` (using `base64 -d` or `-D` or `--decode` for cross-platform compatibility) and `pwsh`.
