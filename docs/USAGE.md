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
  // Recommended: enables precise `run()` completion + exit codes (OSC 133)
  shellIntegration: { enable: true, strict: false },
});

try {
  // 2. Run a command and wait for it to finish
  // With Shell Integration enabled, `run()` can return the real exit code.
  const result = await conch.run('echo "Hello Conch"', { timeoutMs: 5000 });
  
  console.log(result.outputText); // "Hello Conch"
  console.log(result.exitCode);   // 0 (when Shell Integration is enabled)

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
  - Otherwise: Waits until `timeoutMs`.
    - `strict: false` (default): resolves with `exitCode: undefined` (`meta.method: "fallback"`).
    - `strict: true`: rejects on timeout.
  - If the backend supports `ITerminalBackend.onError`, `run()` can fail fast by default. Use `backendError: "ignore"` to keep the timeout-based fallback.

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

- **Default Wait**: `change` (Waits until the screen content updates, ensuring PTY echo is reflected)

```typescript
// Type a search query
await conch.typeAndSnapshot('search query');

// You can override the wait strategy if needed
await conch.typeAndSnapshot('enter', {
  wait: { kind: 'stable', durationMs: 500 } // Wait for 500ms stability
});
```

## 3. Shell Integration (OSC 133)

For the most reliable command execution, enable Shell Integration. This injects a small script into the shell to emit OSC 133 escape sequences with full A/B/C/D markers, allowing Conch to detect exactly when a prompt returns and capture the exit code.

**Markers**:
- **A** (Prompt Start) -- emitted before prompt display
- **B** (Command Start) -- emitted after prompt display (start of user input area)
- **C** (Command Executed) -- emitted just before the command runs (bash: DEBUG trap, pwsh: PSReadLine Enter handler)
- **D** (Command Finished) -- emitted at the next prompt with the exit code

The C/D boundary is used by `run()` for deterministic output extraction -- no heuristics needed.

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

## 6. Docker Backend (`DockerPty`)

You can run Conch against a Docker container instead of a local PTY:

```typescript
import { Conch } from "@ushida_yosei/conch";

const conch = await Conch.launch({
  backend: {
    type: "docker",
    image: "alpine:latest",
    cmd: ["/bin/sh"],
    autoRemove: true,
  },
  cols: 80,
  rows: 24,
  timeoutMs: 30_000,
});

try {
  const r = await conch.run('echo "hello from docker"', {
    timeoutMs: 1000,
    strict: false,
  });
  console.log(r.outputText);
} finally {
  conch.dispose();
}
```

Notes:

- Requires a reachable Docker daemon (Docker Desktop / dockerd).
- In TTY mode, stdout/stderr are combined into a single stream.
- Shell Integration (OSC 133) in Docker typically requires an image with `bash` and `cmd: ["bash"]` (default is `/bin/sh`).

## 7. SSH Backend (`SshPty`)

You can run Conch against a remote machine over SSH:

### Password Authentication

```typescript
import { Conch } from "@ushida_yosei/conch";

const conch = await Conch.launch({
  backend: {
    type: "ssh",
    host: "192.168.1.100",
    port: 22,
    username: "deploy",
    password: "secret",
  },
  cols: 80,
  rows: 24,
  timeoutMs: 30_000,
  shellIntegration: { enable: true, strict: false },
});

try {
  const r = await conch.run('uname -a', { timeoutMs: 5000 });
  console.log(r.outputText);
} finally {
  conch.dispose();
}
```

### Key-based Authentication

```typescript
import { readFileSync } from "node:fs";

const conch = await Conch.launch({
  backend: {
    type: "ssh",
    host: "example.com",
    username: "admin",
    privateKey: readFileSync("/home/user/.ssh/id_ed25519"),
    passphrase: "optional-passphrase", // omit if key is unencrypted
  },
  cols: 120,
  rows: 40,
  timeoutMs: 30_000,
});
```

You can also use an SSH agent by setting `agent` (e.g., `process.env.SSH_AUTH_SOCK`).

Notes:

- Requires the `ssh2` library.
- Host key verification defaults to accept-all (suitable for automation). Provide a `hostVerifier` callback for stricter verification.
- No auto-reconnect: if the SSH connection drops, `run()` rejects immediately via `onError` / `onExit`.
- Shell Integration (OSC 133) works if the remote shell is `bash` or `pwsh`.

## 8. TUI Application Support

Conch includes a terminal query auto-responder that enables interactive TUI applications (vim, less, nano, top, tmux, etc.) to render correctly inside headless xterm. These apps send terminal capability queries (DA1, DA2, CPR, DECRQM) on startup and block until the terminal responds. Conch intercepts these queries and writes standard responses back to the PTY, unblocking the apps automatically.

```typescript
// Launch less
conch.execute('less /var/log/syslog');
await conch.waitForStable({ durationMs: 500 });

// Navigate
const { snapshot } = await conch.pressAndSnapshot('PageDown');
console.log(snapshot.text);

// Quit
await conch.pressAndSnapshot('q');
```

```typescript
// Launch nano
conch.execute('nano myfile.txt');
await conch.waitForStable({ durationMs: 500 });

// Type some text
await conch.typeAndSnapshot('Hello from Conch!');

// Save and exit (Ctrl+O, Enter, Ctrl+X)
conch.press('Ctrl+O');
await conch.pressAndSnapshot('Enter');
await conch.pressAndSnapshot('Ctrl+X');
```

```typescript
// Launch vim (use t_RV= to avoid ~4s startup delay)
conch.execute('vim --cmd "set t_RV=" file.txt');
await conch.waitForStable({ durationMs: 1000 });

// Enter insert mode and type
conch.press('i');
await conch.typeAndSnapshot('Hello from Conch!');

// Save and quit
conch.press('Escape');
await conch.pressAndSnapshot(':');
await conch.typeAndSnapshot('wq');
await conch.pressAndSnapshot('Enter');
```

## Appendix: Available Key Names

For `press()` and `pressAndSnapshot()`, you can use:

- `Enter`, `Backspace`, `Tab`, `Escape`
- `ArrowUp`, `ArrowDown`, `ArrowRight`, `ArrowLeft`
- `Home`, `End`, `PageUp`, `PageDown`, `Insert`, `Delete`
- `F1` to `F12`
- `Ctrl+C` (and other `Ctrl+*` combinations)
