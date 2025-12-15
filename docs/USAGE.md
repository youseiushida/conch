# Usage Guide

Conch is a library that allows AI agents and automation scripts to recognize and control "terminal screens (TUI)" just like humans do.

## Basic Usage

### 1. Starting a Session

`ConchSession` manages the backend (PTY process) and the frontend (screen state).
`spawn()` is an asynchronous method that launches the process and initializes it (e.g., UTF-8 configuration on Windows).

```typescript
import { ConchSession, LocalPty } from 'conch';

// 1. Create Backend (configuration only)
const pty = new LocalPty('powershell.exe', [], {
  cols: 80,
  rows: 24,
  env: process.env
});

// 2. Create Session
const session = new ConchSession(pty, {
  cols: 80,
  rows: 24
});

// 3. Spawn the Backend (Required)
await pty.spawn();

// Cleanup on exit
process.on('SIGINT', () => {
  session.dispose();
});
```

### 2. Operation (Input API)

Agents interact using high-level APIs like `press` and `type`.
Traditional `write` and `execute` are also available.

```typescript
// Execute command (automatically appends \r newline code)
// Note: Does not wait for completion
session.execute('ls -la');

// Simulate key presses
session.press('Enter');
session.press('ArrowDown');
session.press('Ctrl+C');

// Input string (e.g., incremental search)
session.type('filter query');

// Note: write is also available (sends raw sequence)
session.write('\x1b[A'); 
```

### 3. Screen Capture (Snapshot)

Captures the current terminal screen as a string.
By default, it returns the text of the "currently visible range (Viewport)".

```typescript
const snapshot = session.getSnapshot();
console.log(snapshot.text);

// Using Metadata
// cursor: Absolute coordinates in the entire buffer
// cursorSnapshot: Relative coordinates within the captured text (0,0 based)
console.log(`Cursor (Abs): (${snapshot.cursor.x}, ${snapshot.cursor.y})`);
console.log(`Cursor (Rel): (${snapshot.cursorSnapshot.x}, ${snapshot.cursorSnapshot.y})`);
console.log(`Viewport Top: ${snapshot.meta.viewportY}`);
```

### 4. Specifying Buffer Range (Scrolling)

Using the `range` option, you can retrieve information including past logs (scrollback).

```typescript
// Get entire buffer (scrollback + current screen)
const fullLog = session.getSnapshot({ range: 'all' });

// Get current viewport only (default)
const viewportOnly = session.getSnapshot({ range: 'viewport' });
```

## Wait API & Polling

In TUI applications, synchronous waiting such as "wait until screen changes" or "wait until output settles" is crucial.

```typescript
import { waitForText, waitForSilence, waitForChange, waitForStable } from 'conch';

// 1. Wait for specific text to appear
await waitForText(session, /Package installed/);

// 2. Wait for screen change
// Useful when waiting for screen update after pressing a key
session.press('Enter');
await waitForChange(session);

// 3. Wait for screen to stabilize
// Wait until rapidly updating screen (like top command or animation) settles down
await waitForStable(session, 500); // Complete if no change for 500ms

// 4. Wait for output to stop (Raw Output based)
await waitForSilence(session, 500);
```

## Advanced Usage

### Custom Formatting (Snapshot Hook)

You can hook into snapshot generation to add line numbers or highlight specific colors.
`ctx` containing coordinate information is passed to the Formatter.

```typescript
const snapshot = session.getSnapshot({
  formatter: (line, ctx) => {
    // ctx.bufferY   : Row number in entire buffer (0..1000+)
    // ctx.snapshotY : Row number in captured range (0..24)
    const lineContent = line.translateToString(true);
    return `${ctx.snapshotY.toString().padStart(2, '0')} | ${lineContent}`;
  }
});
```

### Locator Functions

Utility functions to extract specific regions or strings from a captured snapshot.

```typescript
import { cropText, findText } from 'conch';

const snapshot = session.getSnapshot();

// 1. Extract text from specified rectangular region
const sidebarText = cropText(snapshot, { x: 0, y: 0, width: 20, height: 10 });

// 2. Search for string coordinates
const matches = findText(snapshot, 'Error');
matches.forEach(m => {
  console.log(`Found at (${m.x}, ${m.y})`);
});
```

### Handling Colors (ANSI)

Using `line.getCell(x)` within `formatter` allows access to color information and character styles of each cell.

```typescript
session.getSnapshot({
  formatter: (line, ctx) => {
    let output = '';
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell) continue;
      // Logic for foreground color (fg) etc.
      output += cell.getChars();
    }
    return output;
  }
});
```

### Human Intervention (Telnet)

Allows humans to connect externally to monitor agent operations or intervene.
(Planned implementation: Telnet server integration)

```bash
# Connect from another terminal
$ telnet localhost 3007
```
