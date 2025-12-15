# API Reference

This document is the public API specification for Conch, based on the code in `src/`.

## Package Structure
Currently, main classes and functions are exported from `src/index.ts`.

```typescript
import { ConchSession, LocalPty, waitForText, waitForStable } from 'conch';
```

---

## `src/types.ts` (Type Definitions)

### `ITerminalBackend`
Abstract interface for terminal execution infrastructure (PTY/Docker/SSH, etc.).

```ts
export interface ITerminalBackend extends IDisposable {
  // Lifecycle
  spawn(): Promise<void>;
  dispose(): void;

  // I/O
  write(data: string): void;
  resize(cols: number, rows: number): void;

  // Events
  onData(listener: (data: string) => void): IDisposable;
  onExit(listener: (code: number, signal?: number) => void): IDisposable;

  readonly id: string | number;
  readonly processName: string;
}
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
    // ...
  };
}

export interface FormatterContext {
  y: number;          // compatibility (= bufferY)
  bufferY: number;    // Absolute row index in buffer
  snapshotY: number;  // Relative row index in snapshot
}
```

---

## `src/session.ts` (Core: `ConchSession`)

The main class that bridges backend and frontend, providing control and observation capabilities.

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

---

## `src/backend/LocalPty.ts` (Backend: `LocalPty`)

Local process backend wrapping `node-pty`.

### `spawn(): Promise<void>`
Starts the process.
- On Windows, waits for UTF-8 setting (`chcp 65001`) and screen clear to complete.
- Throws error if called on a disposed instance.

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
