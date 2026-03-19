# Conch 🐚

> **Headless Terminal Driver for TUI Testing & Automation**

[![CI](https://github.com/youseiushida/conch/workflows/CI/badge.svg)](https://github.com/youseiushida/conch/actions)
![License](https://img.shields.io/github/license/youseiushida/conch)

[**🇯🇵 日本語ドキュメントはこちら**](./README.ja.md)

Conch is a robust library for programmatically controlling terminal applications. By combining `node-pty` for process management and `@xterm/headless` for accurate terminal emulation, Conch enables you to:

*   **Test TUI Applications:** Write integration tests for interactive CLI tools (vim, k9s, inquirer, etc.) with confidence.
*   **Automate Terminal Tasks:** Build bots that can navigate complex terminal interfaces, wait for specific states, and extract information.

Think of it as **"Playwright for Terminals"**.

## Features

*   **Accurate Emulation:** Uses `xterm.js` (headless) to maintain the exact state of the terminal screen, including cursor position, colors, and alternate buffers.
*   **Flakiness-Free Waits:** Built-in utilities like `waitForText`, `waitForSilence`, and `waitForStable` help you handle asynchronous terminal output reliably without random `sleep()`.
*   **Human-like Input:** Simulate key presses (`Enter`, `Esc`, `Ctrl+C`) and typing naturally.
*   **Snapshot Engine:** Capture the "visual" state of the terminal at any moment to verify what the user actually sees.
*   **TUI App Support:** Built-in terminal query auto-responder (DA1, DA2, CPR, DECRQM) enables interactive TUI apps like vim, less, nano, and top to render correctly in headless mode.
*   **Pluggable Backends:** Supports Local PTY and Docker today, and is extensible for SSH in the future.

## Using Conch as an LLM/Agent Foundation (CLI/TUI that doesn’t get stuck)

LLMs are good at deciding *what to do next*, but they need a reliable **execution substrate** for terminals:

- **Observation**: deterministic screen state via `getSnapshot()` (viewport or full scrollback)
- **Action**: `run()`, `pressAndSnapshot()`, `typeAndSnapshot()`
- **Wait**: `waitForText` / `waitForStable` / `waitForSilence` instead of fragile sleeps
- **Command boundaries**: optional **OSC 133 Shell Integration** to detect prompt/command completion and exit codes

This lets you implement a robust loop: *snapshot → decide → act → wait → snapshot*, even for interactive TUI apps.

```typescript
import { Conch } from "@ushida_yosei/conch";

const conch = await Conch.launch({
  backend: { type: "localPty", file: process.platform === "win32" ? "powershell.exe" : "bash", env: process.env },
  cols: 100,
  rows: 30,
  timeoutMs: 30_000,
  shellIntegration: { enable: true, strict: false }, // improves run() reliability
});

try {
  // (1) Bring up a TUI
  await conch.run("htop", { strict: false }); // example; pick your app

  // (2) Agent loop: observe → decide → act
  for (let step = 0; step < 20; step++) {
    const snap = conch.getSnapshot({ range: "viewport" });
    const screen = snap.text;

    // Your LLM/tooling decides the next key(s) from screen state
    const nextKey = screen.includes("Help") ? "F1" : "ArrowDown";

    await conch.pressAndSnapshot(nextKey, { wait: { kind: "change", timeoutMs: 5_000 } });
  }
} finally {
  conch.dispose();
}
```

## Installation

Install from npm:

```bash
npm install @ushida_yosei/conch
# or
pnpm add @ushida_yosei/conch
```

## Quick Start

Here is a simple example that spawns a shell, executes a command, and verifies the output.

```typescript
import { Conch } from '@ushida_yosei/conch';

async function main() {
  // 1. Launch (backend + spawn + session)
  const conch = await Conch.launch({
    backend: { type: 'localPty', file: 'bash', args: [], env: process.env },
    cols: 80,
    rows: 24,
    timeoutMs: 30_000,
  });

  // 2. Execute a command
  conch.execute('echo "Hello Conch"');

  // 3. Wait for the output to appear on the virtual screen
  await conch.waitForText('Hello Conch');

  // 4. Inspect the screen state
  const snapshot = conch.getSnapshot();
  console.log('--- Terminal Screen ---');
  console.log(snapshot.text);

  // Cleanup
  conch.dispose();
}

main();
```

## Docker Backend (DockerPty)

You can run Conch against a Docker container instead of a local PTY.

```typescript
import { Conch } from "@ushida_yosei/conch";

const conch = await Conch.launch({
  backend: {
    type: "docker",
    image: "alpine:latest",
    cmd: ["/bin/sh"], // default
    autoRemove: true,
  },
  cols: 80,
  rows: 24,
  timeoutMs: 30_000,
});

try {
  const r = await conch.run('echo "hello from docker"', { strict: false });
  console.log(r.outputText);
} finally {
  conch.dispose();
}
```

Notes:

- Requires a reachable Docker daemon (Docker Desktop / dockerd).
- In TTY mode, stdout/stderr are combined into a single stream.
- Shell Integration (OSC 133) in Docker usually requires an image with `bash` and `cmd: ["bash"]` (default is `/bin/sh`).

## SSH Backend (SshPty)

You can run Conch against a remote server via SSH.

```typescript
import { Conch } from "@ushida_yosei/conch";
import { readFileSync } from "fs";

const conch = await Conch.launch({
  backend: {
    type: "ssh",
    host: "example.com",
    username: "user",
    privateKey: readFileSync("/path/to/key"),
    // or: password: "secret",
    // or: agent: process.env.SSH_AUTH_SOCK,
  },
  cols: 80,
  rows: 24,
  timeoutMs: 30_000,
  shellIntegration: { enable: true, strict: false },
});

try {
  const r = await conch.run('echo "hello from SSH"');
  console.log(r.outputText); // "hello from SSH"
  console.log(r.exitCode);   // 0
} finally {
  conch.dispose();
}
```

Notes:

- Requires `ssh2` as a peer dependency: `npm install ssh2`
- Supports password, private key (with passphrase), and SSH agent authentication.
- Connection loss is treated as a fatal error (no auto-reconnect). Create a new instance to reconnect.
- Shell Integration (OSC 133) works over SSH when the remote shell is bash.
- Host key verification is disabled by default (automation use case). Pass `hostVerifier` for strict checking.

## TUI Application Support

Conch can drive interactive TUI applications (vim, less, nano, top, tmux) in headless mode. A built-in terminal query auto-responder handles the DA/CPR/DECRQM sequences that these apps send on startup.

```typescript
const conch = await Conch.launch({
  backend: { type: "localPty", file: "bash", env: process.env },
  cols: 80,
  rows: 24,
  timeoutMs: 30_000,
});

// Open vim, type text, save and quit
conch.execute('vim --cmd "set t_RV=" /tmp/test.txt');
await conch.waitForText("~", { timeoutMs: 5_000 }); // wait for vim UI

conch.press("i");                        // insert mode
conch.type("Hello from Conch!");
conch.press("Escape");
conch.type(":wq");
conch.press("Enter");
await conch.waitForStable({ durationMs: 500 });

conch.dispose();
```

| Program | Status | Notes |
|---------|--------|-------|
| vim/vi | ✅ | Use `--cmd "set t_RV="` for instant rendering (otherwise ~4s delay due to PTY buffering) |
| less | ✅ | Alternate buffer, search, PageDown all work |
| nano | ✅ | Alternate buffer, text input, Ctrl+X quit all work |
| top | ✅ | Batch mode (`-b -n 1`) works. Interactive mode works with delay |
| tmux | ✅ | Session create/attach, commands inside tmux, session cleanup |

## Documentation

*   [**Usage Guide (USAGE.md)**](./docs/USAGE.md): Detailed examples and best practices.
*   [**API Reference (API.md)**](./docs/API.md): Complete API documentation for `Conch`, backends (`LocalPty` / `DockerPty`), and utilities.
*   [**Source Docs (src/README.md)**](./src/README.md): Internal architecture overview.

## Roadmap

*   [ ] **Interaction Layer:** Abstract interface for connecting external agents (MCP, WebSocket servers).
*   [x] **Shell Integration (OSC 133):** Detect command completion events and exit codes.
*   [ ] **Telnet/SSH Server:** Built-in server to allow human intervention or monitoring of automated sessions.

## License

MIT
