# termosc

Parse, detect, and extract shell command execution from terminal OSC sequences.

Zero dependencies. Works with any terminal emulator or PTY library.

## What it does

When a shell emits [OSC 133](https://gitlab.freedesktop.org/Per_Curiam/specifications/blob/master/proposals/semantic-prompts.md) / [OSC 633](https://code.visualstudio.com/docs/terminal/shell-integration) sequences, this library can:

1. **Parse** the sequences into typed events
2. **Extract** clean command output from raw terminal data
3. **Inject** shell integration scripts into bash, zsh, fish, PowerShell, elvish, and nushell

## Install

```bash
npm install termosc
```

## Parsers

### OSC 133 — Shell Integration (FinalTerm)

```typescript
import { parseOsc133 } from "termosc";

// In your xterm.js setup:
terminal.parser.registerOscHandler(133, (data) => {
  const event = parseOsc133(data);
  // event = { type: "D", params: ["0"] }
  return true;
});
```

### OSC 633 — VS Code Shell Integration

```typescript
import {
  parseOsc633,
  serializeOsc633Message,
  deserializeOsc633Message,
} from "termosc";

terminal.parser.registerOscHandler(633, (data) => {
  const event = parseOsc633(data);
  // { type: "CommandLine", command: "echo hello", nonce: "abc123" }
  // { type: "Property", key: "Cwd", value: "/home/user" }
  // { type: "CommandFinished", exitCode: 0 }
  return true;
});

// OSC 633 E uses \xHH encoding for special characters.
// Use these helpers to encode/decode command line strings:
const encoded = serializeOsc633Message('echo "hello; world"');
// 'echo\\x20"hello\\x3b\\x20world"'
const decoded = deserializeOsc633Message(encoded);
// 'echo "hello; world"'
```

### OSC 7 — CWD Notification

```typescript
import { parseOsc7 } from "termosc";

terminal.parser.registerOscHandler(7, (data) => {
  const event = parseOsc7(data);
  // { scheme: "file", hostname: "myhost", path: "/home/user" }
  return true;
});
```

### OSC 9 / 777 — Desktop Notifications

```typescript
import { parseOsc9, parseOsc777 } from "termosc";

terminal.parser.registerOscHandler(9, (data) => {
  const event = parseOsc9(data);
  // { type: "notification", text: "Build complete!" }
  // { type: "progress", state: 1, percentage: 75 }
  return true;
});

terminal.parser.registerOscHandler(777, (data) => {
  const event = parseOsc777(data);
  // { title: "Alert", body: "Deploy finished" }
  return true;
});
```

### OSC 8 — Hyperlinks

```typescript
import { parseOsc8 } from "termosc";

terminal.parser.registerOscHandler(8, (data) => {
  const event = parseOsc8(data);
  // { type: "start", uri: "http://example.com", id: "link1", params: { id: "link1" } }
  // { type: "end" }
  return true;
});
```

### OSC 52 — Clipboard

```typescript
import { parseOsc52 } from "termosc";

terminal.parser.registerOscHandler(52, (data) => {
  const event = parseOsc52(data);
  // { type: "set", selection: "c", data: "Hello" }
  // { type: "query", selection: "c" }
  // { type: "clear", selection: "c" }
  return true;
});
```

### OSC 0 / 2 — Window Title

```typescript
import { parseOscTitle } from "termosc";

terminal.parser.registerOscHandler(2, (data) => {
  const event = parseOscTitle(data);
  // { title: "vim - file.txt" }
  return true;
});
```

## Output Extraction

Extract clean command output from raw PTY data using OSC 133 C/D markers:

```typescript
import { extractCommandOutput, stripAnsiAndOsc } from "termosc";

// With shell integration markers
const output = extractCommandOutput(rawPtyData, true);
// "hello world" (extracted from between C and D markers, ANSI stripped)

// Without markers (plain ANSI stripping)
const clean = stripAnsiAndOsc(rawData);
```

`stripAnsiAndOsc` handles OSC, CSI, DCS, APC, and other ESC sequences.

## Shell Integration Scripts

Pre-built scripts that emit OSC 133 A/B/C/D + OSC 633 E/P + OSC 7 CWD:

```typescript
import {
  BASH_INTEGRATION_SCRIPT,
  PWSH_INTEGRATION_SCRIPT,
  ZSH_INTEGRATION_SCRIPT,
  FISH_INTEGRATION_SCRIPT,
  ELVISH_INTEGRATION_SCRIPT,
  NUSHELL_INTEGRATION_SCRIPT,
  encodeScriptForShell,
} from "termosc";

// Inject into a bash PTY
const command = encodeScriptForShell(BASH_INTEGRATION_SCRIPT, "bash");
pty.write(command + "\r");
```

| Shell | Script | OSC 133 | OSC 633 E | OSC 633 P | OSC 7 |
|-------|--------|---------|-----------|-----------|-------|
| bash | `BASH_INTEGRATION_SCRIPT` | A/B/C/D | E | Cwd | CWD |
| zsh | `ZSH_INTEGRATION_SCRIPT` | A/B/C/D | E | Cwd | CWD |
| fish | `FISH_INTEGRATION_SCRIPT` | A/B/C/D | E | Cwd | CWD |
| PowerShell | `PWSH_INTEGRATION_SCRIPT` | A/B/C/D | E | Cwd | CWD |
| elvish | `ELVISH_INTEGRATION_SCRIPT` | A/C/D | E | Cwd | CWD |
| nushell | `NUSHELL_INTEGRATION_SCRIPT` | A/B/C/D | — | Cwd | CWD |

## Types

All types are exported for TypeScript users.

### OSC 133

```typescript
enum ShellIntegrationType {
  PromptStart = "A",
  CommandStart = "B",
  CommandExecuted = "C",
  CommandFinished = "D",
}

interface IShellIntegrationEvent {
  type: ShellIntegrationType;
  params: string[];
}

// Discriminated union (future-ready, not yet used by parseOsc133)
type Osc133Event =
  | { type: "PromptStart" }
  | { type: "CommandStart" }
  | { type: "CommandExecuted" }
  | { type: "CommandFinished"; exitCode?: number; params: Record<string, string> };
```

### OSC 633

```typescript
type Osc633Event =
  | { type: "PromptStart" }
  | { type: "CommandStart" }
  | { type: "CommandExecuted" }
  | { type: "CommandFinished"; exitCode?: number }
  | { type: "CommandLine"; command: string; nonce?: string }
  | { type: "ContinuationStart" }
  | { type: "ContinuationEnd" }
  | { type: "RightPromptStart" }
  | { type: "RightPromptEnd" }
  | { type: "Property"; key: string; value: string };
```

### OSC 7

```typescript
interface Osc7Event {
  scheme: string;    // "file" | "kitty-shell-cwd"
  hostname: string;  // "" for localhost
  path: string;      // decoded for file://, raw for kitty-shell-cwd://
}
```

### OSC 9

```typescript
type Osc9Event =
  | { type: "notification"; text: string }
  | { type: "progress"; state: number; percentage?: number };
// state: 0=remove, 1=set, 2=error, 3=indeterminate, 4=pause
```

### OSC 777

```typescript
interface Osc777Event {
  title: string;
  body: string;
}
```

### OSC 0 / 2

```typescript
interface OscTitleEvent {
  title: string;
}
```

### OSC 8

```typescript
type Osc8Event =
  | { type: "start"; uri: string; id?: string; params: Record<string, string> }
  | { type: "end" };
```

### OSC 52

```typescript
type Osc52Event =
  | { type: "set"; selection: string; data: string }   // data is base64-decoded
  | { type: "query"; selection: string }
  | { type: "clear"; selection: string };
// selection: "c"=clipboard, "p"=primary, "s"=select, "0"-"9"=cut buffers
```

## Full Example

Detect command execution in a real shell using node-pty + xterm.js:

```typescript
import * as pty from "@lydell/node-pty";
import { Terminal } from "@xterm/headless";
import {
  parseOsc133,
  parseOsc633,
  parseOsc7,
  extractCommandOutput,
  encodeScriptForShell,
  BASH_INTEGRATION_SCRIPT,
} from "termosc";

// 1. Spawn a PTY
const proc = pty.spawn("bash", ["--norc", "--noprofile"], {
  name: "xterm-256color", cols: 80, rows: 24,
});

// 2. Connect to xterm.js
const terminal = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
const rawChunks: string[] = [];

proc.onData((data) => {
  rawChunks.push(data);
  terminal.write(data);
});
terminal.onData((data) => proc.write(data));

// 3. Register OSC handlers
terminal.parser.registerOscHandler(133, (data) => {
  const event = parseOsc133(data);
  if (event?.type === "D") {
    console.log("Command finished, exit code:", event.params[0]);
    const output = extractCommandOutput(rawChunks.join(""), true);
    console.log("Output:", output);
  }
  return true;
});

terminal.parser.registerOscHandler(633, (data) => {
  const event = parseOsc633(data);
  if (event?.type === "CommandLine") console.log("Command:", event.command);
  if (event?.type === "Property") console.log(`${event.key}=${event.value}`);
  return true;
});

terminal.parser.registerOscHandler(7, (data) => {
  const event = parseOsc7(data);
  if (event) console.log("CWD:", event.path);
  return true;
});

// 4. Inject shell integration
proc.write(encodeScriptForShell(BASH_INTEGRATION_SCRIPT, "bash") + "\r");
```

## License

MIT
