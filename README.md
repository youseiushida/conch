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
*   **Pluggable Backend:** Designed to support Local PTY (default), and extensible for Docker or SSH in the future.

## Installation

> ⚠️ **Not yet published to npm.** Install from GitHub directly:

```bash
npm install github:youseiushida/conch
# or
pnpm add github:youseiushida/conch
```

## Quick Start

Here is a simple example that spawns a shell, executes a command, and verifies the output.

```typescript
import { ConchSession, LocalPty, waitForText } from 'conch';

async function main() {
  // 1. Setup Backend (node-pty wrapper) & Session (xterm emulator)
  const pty = new LocalPty('bash', [], { cols: 80, rows: 24 });
  const session = new ConchSession(pty);

  // 2. Start the process
  await pty.spawn();

  // 3. Execute a command
  // .execute() automatically appends \r
  session.execute('echo "Hello Conch"');

  // 4. Wait for the output to appear on the virtual screen
  await waitForText(session, 'Hello Conch');

  // 5. Inspect the screen state
  const snapshot = session.getSnapshot();
  console.log('--- Terminal Screen ---');
  console.log(snapshot.text);

  // Cleanup
  session.dispose();
}

main();
```

## Documentation

*   [**Usage Guide (USAGE.md)**](./docs/USAGE.md): Detailed examples and best practices.
*   [**API Reference (API.md)**](./docs/API.md): Complete API documentation for `ConchSession`, `LocalPty`, and utilities.
*   [**Source Docs (src/README.md)**](./src/README.md): Internal architecture overview.

## Roadmap

*   [ ] **Interaction Layer:** Abstract interface for connecting external agents (MCP, WebSocket servers).
*   [ ] **Shell Integration:** Support for OSC 133 to detect command completion events.
*   [ ] **Telnet/SSH Server:** Built-in server to allow human intervention or monitoring of automated sessions.

## License

MIT
