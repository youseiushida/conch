# Usage Guide

Conch is a robust library for controlling terminal applications.
It provides a high-level API (`Conch` facade) that combines action, waiting, and snapshotting into single atomic operations, making your automation scripts reliable and concise.

## 1. Getting Started

The recommended way to use Conch is through the `Conch.launch()` method. This handles backend creation, session initialization, and shell integration setup in one go.

```typescript
import { Conch } from '@ushida_yosei/conch';

// 1. Launch a new session
const conch = await Conch.launch({
  // Backend configuration (uses 'localPty' by default logic if omitted, but explicit is better)
  backend: {
    type: 'localPty',
    file: process.platform === 'win32' ? 'powershell.exe' : 'bash',
    args: [],
    env: process.env,
  },
  // Terminal size
  cols: 80,
  rows: 24,
  // Default timeout for all operations
  timeoutMs: 30_000,
});

try {
  // 2. Run a command and wait for it to finish
  // By default, this waits for output to settle (fallback mode).
  const result = await conch.run('echo "Hello Conch"');
  
  console.log(result.outputText); // "Hello Conch"
  console.log(result.exitCode);   // undefined (unless Shell Integration is enabled)

} finally {
  // 3. Always dispose to kill the process
  conch.dispose();
}
```

## 2. High-Level API (Action + Wait + Snapshot)

Conch's high-level methods perform an action, wait for a specific condition (like screen update), and return a snapshot of the result. This eliminates "flaky" sleeps from your code.

### `run(command, options?)`

Executes a shell command and waits for completion.

- **Returns**: `RunResult` (exitCode, outputText, snapshot)
- **Wait Strategy**:
  - If **Shell Integration** is enabled: Waits for the exact command completion event (OSC 133).
  - Otherwise: Waits for output to stop (fallback).

```typescript
const { exitCode, outputText } = await conch.run('ls -la', {
  timeoutMs: 5000,
  strict: true // Throw error if command times out
});
```

### `pressAndSnapshot(key, options?)`

Simulates a key press and waits for the screen to change. Ideal for TUI navigation.

- **Default Wait**: `change` (Waits until the screen content updates)

```typescript
// Press 'Down' and wait for the selection to move
const { snapshot } = await conch.pressAndSnapshot('ArrowDown');

// Verify the new state
if (snapshot.text.includes('> Selected Item')) {
  // ...
}
```

### `typeAndSnapshot(text, options?)`

Types a string and captures the screen.

- **Default Wait**: `drain` (Waits for input to be processed by xterm, fast)

```typescript
// Type a search query
await conch.typeAndSnapshot('search query');

// You can override the wait strategy if needed
await conch.typeAndSnapshot('enter', {
  wait: { kind: 'stable', durationMs: 500 } // Wait for 500ms stability
});
```

## 3. Shell Integration (OSC 133)

For the most reliable command execution, enable Shell Integration. This injects a small script into the shell to emit OSC 133 escape sequences, allowing Conch to detect exactly when a prompt returns and capture the exit code.

```typescript
const conch = await Conch.launch({
  backend: { type: 'localPty', ... },
  shellIntegration: {
    enable: true,
    shell: 'bash', // 'bash' or 'pwsh' (auto-detected if omitted, but explicit recommended)
    strict: false, // If true, throws error if injection fails
  }
});

// Now 'run' can capture the real exit code!
const { exitCode } = await conch.run('exit 42');
console.log(exitCode); // 42
```

## 4. Manual Control & Assertions

You can also use lower-level methods for granular control.

### Wait Utilities

These are available directly on the `conch` instance or as standalone functions.

```typescript
// Wait for specific text to appear
await conch.waitForText(/Success/);

// Wait for the screen to stop changing (useful for animations/spinners)
await conch.waitForStable({ durationMs: 1000 });

// Wait for no new data output
await conch.waitForSilence({ durationMs: 500 });
```

### Locator Functions (Instance Methods)

Shortcuts to extract or verify data from the screen.

```typescript
// Get the current screen text
const text = conch.screenText();

// Check if text exists (returns boolean)
if (conch.hasText('Error')) { ... }

// Find coordinates of a text
const matches = conch.findText('Error');

// Extract text from a specific region
const status = conch.cropText({ x: 0, y: 23, width: 80, height: 1 });
```

## 5. Low-Level Usage (`ConchSession`)

If you don't need the `Conch` facade or want to manage the `ConchSession` and `ITerminalBackend` manually:

```typescript
import { ConchSession, LocalPty } from '@ushida_yosei/conch';

const pty = new LocalPty('bash');
const session = new ConchSession(pty);

await pty.spawn();

session.write('ls\r'); // Raw write
// You must handle waiting manually
await waitForText(session, 'package.json');
```

## Appendix: Available Key Names

For `press()` and `pressAndSnapshot()`, you can use:

- `Enter`, `Backspace`, `Tab`, `Escape`
- `ArrowUp`, `ArrowDown`, `ArrowRight`, `ArrowLeft`
- `Home`, `End`, `PageUp`, `PageDown`, `Insert`, `Delete`
- `F1` to `F12`
- `Ctrl+C` (and other `Ctrl+*` combinations)
