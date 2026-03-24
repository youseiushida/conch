/**
 * 全 OSC パーサーの e2e テスト
 *
 * bash から printf で各 OSC シーケンスを発行し、
 * PTY → xterm パーサー → registerOscHandler → termosc パーサー
 * のフルパイプラインを検証する。
 *
 * アプリケーションが発行するのと同じバイト列が PTY を通るため、
 * 実環境での動作を保証する。
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as pty from "@lydell/node-pty";
import { Terminal } from "@xterm/headless";
import {
	parseOsc133,
	parseOsc633,
	parseOsc7,
	parseOsc9,
	parseOsc777,
	parseOscTitle,
	parseOsc8,
	parseOsc52,
	type IShellIntegrationEvent,
	type Osc633Event,
	type Osc7Event,
	type Osc9Event,
	type Osc777Event,
	type OscTitleEvent,
	type Osc8Event,
	type Osc52Event,
} from "../../src";

// --- Generic OSC capture session ---

interface OscSession {
	terminal: Terminal;
	ptyProcess: pty.IPty;
	captured: Map<number, unknown[]>;
	rawChunks: string[];
	dispose(): void;
	write(data: string): void;
	/** Send a printf command to bash that emits an OSC sequence, then wait for it */
	emitOsc(printf: string): Promise<void>;
	waitForOsc<T>(oscNum: number, timeoutMs?: number): Promise<T>;
	waitForOscCount<T>(
		oscNum: number,
		count: number,
		timeoutMs?: number,
	): Promise<T[]>;
	waitForStable(durationMs?: number, timeoutMs?: number): Promise<void>;
}

function createOscSession(): OscSession {
	const captured = new Map<number, unknown[]>();
	const rawChunks: string[] = [];

	const ptyProcess = pty.spawn("bash", ["--norc", "--noprofile"], {
		name: "xterm-256color",
		cols: 120,
		rows: 24,
		env: { ...process.env, TERM: "xterm-256color" },
	});

	const terminal = new Terminal({
		allowProposedApi: true,
		cols: 120,
		rows: 24,
		scrollback: 5000,
	});

	ptyProcess.onData((data: string) => {
		rawChunks.push(data);
		terminal.write(data);
	});

	terminal.onData((data: string) => {
		ptyProcess.write(data);
	});

	// Register handlers for ALL OSC types
	const handlers: [number, (data: string) => unknown][] = [
		[133, parseOsc133],
		[633, parseOsc633],
		[7, parseOsc7],
		[9, parseOsc9],
		[777, parseOsc777],
		[0, parseOscTitle],
		[2, parseOscTitle],
		[8, parseOsc8],
		[52, parseOsc52],
	];

	for (const [num, parser] of handlers) {
		captured.set(num, []);
		terminal.parser.registerOscHandler(num, (data: string) => {
			const result = parser(data);
			if (result) captured.get(num)!.push(result);
			return true;
		});
	}

	function waitForOsc<T>(oscNum: number, timeoutMs = 10_000): Promise<T> {
		return new Promise((resolve, reject) => {
			const arr = captured.get(oscNum)!;
			if (arr.length > 0) {
				resolve(arr[arr.length - 1] as T);
				return;
			}
			const timer = setTimeout(() => {
				clearInterval(poller);
				reject(
					new Error(
						`Timeout waiting for OSC ${oscNum} (captured: ${arr.length})`,
					),
				);
			}, timeoutMs);
			const poller = setInterval(() => {
				if (arr.length > 0) {
					clearTimeout(timer);
					clearInterval(poller);
					resolve(arr[arr.length - 1] as T);
				}
			}, 50);
		});
	}

	function waitForOscCount<T>(
		oscNum: number,
		count: number,
		timeoutMs = 10_000,
	): Promise<T[]> {
		return new Promise((resolve, reject) => {
			const arr = captured.get(oscNum)!;
			if (arr.length >= count) {
				resolve(arr.slice(0, count) as T[]);
				return;
			}
			const timer = setTimeout(() => {
				clearInterval(poller);
				reject(
					new Error(
						`Timeout waiting for ${count}x OSC ${oscNum} (got: ${arr.length})`,
					),
				);
			}, timeoutMs);
			const poller = setInterval(() => {
				if (arr.length >= count) {
					clearTimeout(timer);
					clearInterval(poller);
					resolve(arr.slice(0, count) as T[]);
				}
			}, 50);
		});
	}

	return {
		terminal,
		ptyProcess,
		captured,
		rawChunks,
		dispose() {
			terminal.dispose();
			ptyProcess.kill();
		},
		write(data: string) {
			ptyProcess.write(data);
		},
		async emitOsc(printf: string) {
			ptyProcess.write(`${printf}\r`);
			// Small settle time for PTY processing
			await new Promise((r) => setTimeout(r, 200));
		},
		waitForOsc,
		waitForOscCount,
		async waitForStable(durationMs = 300, timeoutMs = 10_000) {
			return new Promise<void>((resolve, reject) => {
				let lastLen = 0;
				let stableStart = Date.now();
				const deadline = Date.now() + timeoutMs;
				const poller = setInterval(() => {
					const currentLen = rawChunks.join("").length;
					if (currentLen !== lastLen) {
						lastLen = currentLen;
						stableStart = Date.now();
					}
					if (Date.now() - stableStart >= durationMs) {
						clearInterval(poller);
						resolve();
					}
					if (Date.now() > deadline) {
						clearInterval(poller);
						reject(new Error("Timeout waiting for stable"));
					}
				}, 50);
			});
		},
	};
}

// ============================================================
// OSC 133 — FinalTerm Shell Integration
// ============================================================

describe("OSC 133 via PTY", () => {
	let s: OscSession;

	beforeEach(() => {
		s = createOscSession();
	});
	afterEach(() => s.dispose());

	it("A marker (PromptStart)", async () => {
		await s.emitOsc("printf '\\e]133;A\\a'");
		const e = await s.waitForOsc<IShellIntegrationEvent>(133);
		expect(e.type).toBe("A");
		expect(e.params).toEqual([]);
	});

	it("B marker (CommandStart)", async () => {
		await s.emitOsc("printf '\\e]133;B\\a'");
		const e = await s.waitForOsc<IShellIntegrationEvent>(133);
		expect(e.type).toBe("B");
	});

	it("C marker (CommandExecuted)", async () => {
		await s.emitOsc("printf '\\e]133;C\\a'");
		const e = await s.waitForOsc<IShellIntegrationEvent>(133);
		expect(e.type).toBe("C");
	});

	it("D marker with exit code 0", async () => {
		await s.emitOsc("printf '\\e]133;D;0\\a'");
		const e = await s.waitForOsc<IShellIntegrationEvent>(133);
		expect(e.type).toBe("D");
		expect(e.params).toEqual(["0"]);
	});

	it("D marker with exit code 127", async () => {
		await s.emitOsc("printf '\\e]133;D;127\\a'");
		const e = await s.waitForOsc<IShellIntegrationEvent>(133);
		expect(e.params).toEqual(["127"]);
	});

	it("D marker with multiple params (WezTerm aid style)", async () => {
		await s.emitOsc("printf '\\e]133;D;0;aid=42\\a'");
		const e = await s.waitForOsc<IShellIntegrationEvent>(133);
		expect(e.params).toEqual(["0", "aid=42"]);
	});

	it("A marker with params (Ghostty style)", async () => {
		await s.emitOsc("printf '\\e]133;A;redraw=last;cl=line;aid=123\\a'");
		const e = await s.waitForOsc<IShellIntegrationEvent>(133);
		expect(e.type).toBe("A");
		expect(e.params).toEqual(["redraw=last", "cl=line", "aid=123"]);
	});

	it("ST terminator (ESC backslash)", async () => {
		await s.emitOsc("printf '\\e]133;D;0\\e\\\\'");
		const e = await s.waitForOsc<IShellIntegrationEvent>(133);
		expect(e.type).toBe("D");
		expect(e.params).toEqual(["0"]);
	});

	it("unknown type is ignored", async () => {
		await s.emitOsc("printf '\\e]133;L\\a'");
		await s.emitOsc("printf '\\e]133;A\\a'");
		const e = await s.waitForOsc<IShellIntegrationEvent>(133);
		// L should be skipped, A should be captured
		expect(e.type).toBe("A");
		expect(s.captured.get(133)!.length).toBe(1);
	});

	it("rapid-fire A/C/D sequence", async () => {
		await s.emitOsc(
			"printf '\\e]133;A\\a\\e]133;C\\a\\e]133;D;0\\a'",
		);
		const events =
			await s.waitForOscCount<IShellIntegrationEvent>(133, 3);
		expect(events.map((e) => e.type)).toEqual(["A", "C", "D"]);
	});
});

// ============================================================
// OSC 633 — VS Code Shell Integration
// ============================================================

describe("OSC 633 via PTY", () => {
	let s: OscSession;

	beforeEach(() => {
		s = createOscSession();
	});
	afterEach(() => s.dispose());

	it("A/B/C/D markers", async () => {
		await s.emitOsc(
			"printf '\\e]633;A\\a\\e]633;B\\a\\e]633;C\\a\\e]633;D;0\\a'",
		);
		const events = await s.waitForOscCount<Osc633Event>(633, 4);
		expect(events.map((e) => e.type)).toEqual([
			"PromptStart",
			"CommandStart",
			"CommandExecuted",
			"CommandFinished",
		]);
		expect(
			(events[3] as { type: "CommandFinished"; exitCode?: number })
				.exitCode,
		).toBe(0);
	});

	it("E marker (CommandLine) with plain text", async () => {
		await s.emitOsc("printf '\\e]633;E;echo hello\\a'");
		const e = await s.waitForOsc<Osc633Event>(633);
		expect(e.type).toBe("CommandLine");
		expect((e as { command: string }).command).toBe("echo hello");
	});

	it("E marker with escaped semicolon (\\x3b)", async () => {
		await s.emitOsc("printf '\\e]633;E;echo\\\\x3bhello\\a'");
		const e = await s.waitForOsc<Osc633Event>(633);
		expect(e.type).toBe("CommandLine");
		expect((e as { command: string }).command).toBe("echo;hello");
	});

	it("E marker with escaped backslash (\\\\)", async () => {
		await s.emitOsc("printf '\\e]633;E;path\\\\\\\\to\\\\\\\\file\\a'");
		const e = await s.waitForOsc<Osc633Event>(633);
		expect(e.type).toBe("CommandLine");
		expect((e as { command: string }).command).toBe("path\\to\\file");
	});

	it("E marker with escaped newline (\\x0a)", async () => {
		await s.emitOsc("printf '\\e]633;E;line1\\\\x0aline2\\a'");
		const e = await s.waitForOsc<Osc633Event>(633);
		expect((e as { command: string }).command).toBe("line1\nline2");
	});

	it("E marker with nonce", async () => {
		await s.emitOsc("printf '\\e]633;E;ls;nonce-abc123\\a'");
		const e = await s.waitForOsc<Osc633Event>(633);
		expect((e as { command: string; nonce?: string }).command).toBe("ls");
		expect((e as { nonce?: string }).nonce).toBe("nonce-abc123");
	});

	it("P marker with Cwd", async () => {
		await s.emitOsc("printf '\\e]633;P;Cwd=/home/user\\a'");
		const e = await s.waitForOsc<Osc633Event>(633);
		expect(e.type).toBe("Property");
		const p = e as { key: string; value: string };
		expect(p.key).toBe("Cwd");
		expect(p.value).toBe("/home/user");
	});

	it("P marker with IsWindows", async () => {
		await s.emitOsc("printf '\\e]633;P;IsWindows=True\\a'");
		const e = await s.waitForOsc<Osc633Event>(633);
		const p = e as { key: string; value: string };
		expect(p.key).toBe("IsWindows");
		expect(p.value).toBe("True");
	});

	it("F/G markers (continuation)", async () => {
		await s.emitOsc("printf '\\e]633;F\\a\\e]633;G\\a'");
		const events = await s.waitForOscCount<Osc633Event>(633, 2);
		expect(events[0].type).toBe("ContinuationStart");
		expect(events[1].type).toBe("ContinuationEnd");
	});

	it("H/I markers (right prompt)", async () => {
		await s.emitOsc("printf '\\e]633;H\\a\\e]633;I\\a'");
		const events = await s.waitForOscCount<Osc633Event>(633, 2);
		expect(events[0].type).toBe("RightPromptStart");
		expect(events[1].type).toBe("RightPromptEnd");
	});

	it("D without exit code", async () => {
		await s.emitOsc("printf '\\e]633;D\\a'");
		const e = await s.waitForOsc<Osc633Event>(633);
		expect(
			(e as { type: "CommandFinished"; exitCode?: number }).exitCode,
		).toBeUndefined();
	});

	it("D with non-zero exit code", async () => {
		await s.emitOsc("printf '\\e]633;D;1\\a'");
		const e = await s.waitForOsc<Osc633Event>(633);
		expect(
			(e as { type: "CommandFinished"; exitCode?: number }).exitCode,
		).toBe(1);
	});
});

// ============================================================
// OSC 7 — CWD Notification
// ============================================================

describe("OSC 7 via PTY", () => {
	let s: OscSession;

	beforeEach(() => {
		s = createOscSession();
	});
	afterEach(() => s.dispose());

	it("file:// with hostname", async () => {
		await s.emitOsc("printf '\\e]7;file://myhost/home/user\\a'");
		const e = await s.waitForOsc<Osc7Event>(7);
		expect(e.scheme).toBe("file");
		expect(e.hostname).toBe("myhost");
		expect(e.path).toBe("/home/user");
	});

	it("file:// with empty hostname (localhost)", async () => {
		await s.emitOsc("printf '\\e]7;file:///tmp\\a'");
		const e = await s.waitForOsc<Osc7Event>(7);
		expect(e.hostname).toBe("");
		expect(e.path).toBe("/tmp");
	});

	it("file:// with percent-encoded path", async () => {
		await s.emitOsc("printf '\\e]7;file://host/path%%20with%%20spaces\\a'");
		const e = await s.waitForOsc<Osc7Event>(7);
		expect(e.path).toBe("/path with spaces");
	});

	it("kitty-shell-cwd:// scheme", async () => {
		await s.emitOsc(
			"printf '\\e]7;kitty-shell-cwd://myhost/home/user\\a'",
		);
		const e = await s.waitForOsc<Osc7Event>(7);
		expect(e.scheme).toBe("kitty-shell-cwd");
		expect(e.hostname).toBe("myhost");
		expect(e.path).toBe("/home/user");
	});

	it("kitty-shell-cwd:// does NOT decode percent-encoding", async () => {
		await s.emitOsc(
			"printf '\\e]7;kitty-shell-cwd://host/path%%20raw\\a'",
		);
		const e = await s.waitForOsc<Osc7Event>(7);
		expect(e.path).toBe("/path%20raw");
	});

	it("ST terminator", async () => {
		await s.emitOsc("printf '\\e]7;file://host/tmp\\e\\\\'");
		const e = await s.waitForOsc<Osc7Event>(7);
		expect(e.path).toBe("/tmp");
	});

	it("path with unicode characters", async () => {
		await s.emitOsc("printf '\\e]7;file://host/home/日本語\\a'");
		const e = await s.waitForOsc<Osc7Event>(7);
		expect(e.path).toBe("/home/日本語");
	});

	it("deep nested path", async () => {
		await s.emitOsc(
			"printf '\\e]7;file://host/a/b/c/d/e/f/g/h/i/j\\a'",
		);
		const e = await s.waitForOsc<Osc7Event>(7);
		expect(e.path).toBe("/a/b/c/d/e/f/g/h/i/j");
	});
});

// ============================================================
// OSC 9 — Desktop Notification / ConEmu Progress
// ============================================================

describe("OSC 9 via PTY", () => {
	let s: OscSession;

	beforeEach(() => {
		s = createOscSession();
	});
	afterEach(() => s.dispose());

	it("plain notification text", async () => {
		await s.emitOsc("printf '\\e]9;Build complete!\\a'");
		const e = await s.waitForOsc<Osc9Event>(9);
		expect(e.type).toBe("notification");
		expect((e as { text: string }).text).toBe("Build complete!");
	});

	it("notification with special characters", async () => {
		await s.emitOsc("printf '\\e]9;Task done: 3/3 passed\\a'");
		const e = await s.waitForOsc<Osc9Event>(9);
		expect((e as { text: string }).text).toBe("Task done: 3/3 passed");
	});

	it("ConEmu progress: set percentage (state=1)", async () => {
		await s.emitOsc("printf '\\e]9;4;1;75\\a'");
		const e = await s.waitForOsc<Osc9Event>(9);
		expect(e.type).toBe("progress");
		expect((e as { state: number }).state).toBe(1);
		expect((e as { percentage?: number }).percentage).toBe(75);
	});

	it("ConEmu progress: indeterminate (state=3)", async () => {
		await s.emitOsc("printf '\\e]9;4;3\\a'");
		const e = await s.waitForOsc<Osc9Event>(9);
		expect(e.type).toBe("progress");
		expect((e as { state: number }).state).toBe(3);
		expect((e as { percentage?: number }).percentage).toBeUndefined();
	});

	it("ConEmu progress: remove (state=0)", async () => {
		await s.emitOsc("printf '\\e]9;4;0\\a'");
		const e = await s.waitForOsc<Osc9Event>(9);
		expect((e as { state: number }).state).toBe(0);
	});

	it("ConEmu progress: error (state=2)", async () => {
		await s.emitOsc("printf '\\e]9;4;2;50\\a'");
		const e = await s.waitForOsc<Osc9Event>(9);
		expect((e as { state: number }).state).toBe(2);
		expect((e as { percentage?: number }).percentage).toBe(50);
	});

	it("ConEmu progress: pause (state=4)", async () => {
		await s.emitOsc("printf '\\e]9;4;4;30\\a'");
		const e = await s.waitForOsc<Osc9Event>(9);
		expect((e as { state: number }).state).toBe(4);
	});

	it("text starting with number > 11 is treated as notification", async () => {
		await s.emitOsc("printf '\\e]9;42 new messages\\a'");
		const e = await s.waitForOsc<Osc9Event>(9);
		expect(e.type).toBe("notification");
		expect((e as { text: string }).text).toBe("42 new messages");
	});

	it("empty notification", async () => {
		await s.emitOsc("printf '\\e]9;\\a'");
		const e = await s.waitForOsc<Osc9Event>(9);
		expect(e.type).toBe("notification");
		expect((e as { text: string }).text).toBe("");
	});
});

// ============================================================
// OSC 777 — RXVT Notification
// ============================================================

describe("OSC 777 via PTY", () => {
	let s: OscSession;

	beforeEach(() => {
		s = createOscSession();
	});
	afterEach(() => s.dispose());

	it("notify with title and body", async () => {
		await s.emitOsc(
			"printf '\\e]777;notify;Build Status;All tests passed!\\a'",
		);
		const e = await s.waitForOsc<Osc777Event>(777);
		expect(e.title).toBe("Build Status");
		expect(e.body).toBe("All tests passed!");
	});

	it("body containing semicolons", async () => {
		await s.emitOsc(
			"printf '\\e]777;notify;Title;part1;part2;part3\\a'",
		);
		const e = await s.waitForOsc<Osc777Event>(777);
		expect(e.title).toBe("Title");
		expect(e.body).toBe("part1;part2;part3");
	});

	it("empty body", async () => {
		await s.emitOsc("printf '\\e]777;notify;Alert;\\a'");
		const e = await s.waitForOsc<Osc777Event>(777);
		expect(e.title).toBe("Alert");
		expect(e.body).toBe("");
	});
});

// ============================================================
// OSC 0 / OSC 2 — Window Title
// ============================================================

describe("OSC 0/2 via PTY", () => {
	let s: OscSession;

	beforeEach(() => {
		s = createOscSession();
	});
	afterEach(() => s.dispose());

	it("OSC 0: set icon name + window title", async () => {
		await s.emitOsc("printf '\\e]0;vim - file.txt\\a'");
		const e = await s.waitForOsc<OscTitleEvent>(0);
		expect(e.title).toBe("vim - file.txt");
	});

	it("OSC 2: set window title only", async () => {
		await s.emitOsc("printf '\\e]2;user@host: ~/project\\a'");
		const e = await s.waitForOsc<OscTitleEvent>(2);
		expect(e.title).toBe("user@host: ~/project");
	});

	it("title with special characters", async () => {
		await s.emitOsc("printf '\\e]2;[3/10] Building...\\a'");
		const e = await s.waitForOsc<OscTitleEvent>(2);
		expect(e.title).toBe("[3/10] Building...");
	});

	it("empty title (reset)", async () => {
		await s.emitOsc("printf '\\e]2;\\a'");
		const e = await s.waitForOsc<OscTitleEvent>(2);
		expect(e.title).toBe("");
	});

	it("ST terminator", async () => {
		await s.emitOsc("printf '\\e]2;Title\\e\\\\'");
		const e = await s.waitForOsc<OscTitleEvent>(2);
		expect(e.title).toBe("Title");
	});
});

// ============================================================
// OSC 8 — Hyperlink
// ============================================================

describe("OSC 8 via PTY", () => {
	let s: OscSession;

	beforeEach(() => {
		s = createOscSession();
	});
	afterEach(() => s.dispose());

	it("hyperlink start with URI only (no params)", async () => {
		await s.emitOsc("printf '\\e]8;;http://example.com\\a'");
		const e = await s.waitForOsc<Osc8Event>(8);
		expect(e.type).toBe("start");
		const start = e as {
			type: "start";
			uri: string;
			id?: string;
			params: Record<string, string>;
		};
		expect(start.uri).toBe("http://example.com");
		expect(start.id).toBeUndefined();
		expect(start.params).toEqual({});
	});

	it("hyperlink start with id param", async () => {
		await s.emitOsc("printf '\\e]8;id=link1;http://example.com\\a'");
		const e = await s.waitForOsc<Osc8Event>(8);
		const start = e as {
			type: "start";
			uri: string;
			id?: string;
			params: Record<string, string>;
		};
		expect(start.id).toBe("link1");
		expect(start.params.id).toBe("link1");
	});

	it("hyperlink start with multiple params (colon-separated)", async () => {
		await s.emitOsc(
			"printf '\\e]8;id=abc:class=error;http://example.com/err\\a'",
		);
		const e = await s.waitForOsc<Osc8Event>(8);
		const start = e as {
			type: "start";
			params: Record<string, string>;
		};
		expect(start.params.id).toBe("abc");
		expect(start.params.class).toBe("error");
	});

	it("hyperlink end (empty URI)", async () => {
		await s.emitOsc("printf '\\e]8;;\\a'");
		const e = await s.waitForOsc<Osc8Event>(8);
		expect(e.type).toBe("end");
	});

	it("hyperlink start then end sequence", async () => {
		await s.emitOsc(
			"printf '\\e]8;;http://example.com\\aClick here\\e]8;;\\a'",
		);
		const events = await s.waitForOscCount<Osc8Event>(8, 2);
		expect(events[0].type).toBe("start");
		expect(events[1].type).toBe("end");
	});

	it("hyperlink with file:// URI", async () => {
		await s.emitOsc("printf '\\e]8;;file:///path/to/file.rs\\a'");
		const e = await s.waitForOsc<Osc8Event>(8);
		expect(
			(e as { type: "start"; uri: string }).uri,
		).toBe("file:///path/to/file.rs");
	});

	it("switch hyperlink without explicit close", async () => {
		await s.emitOsc(
			"printf '\\e]8;;http://a.com\\alink1\\e]8;;http://b.com\\alink2\\e]8;;\\a'",
		);
		const events = await s.waitForOscCount<Osc8Event>(8, 3);
		expect(events[0].type).toBe("start");
		expect((events[0] as { uri: string }).uri).toBe("http://a.com");
		expect(events[1].type).toBe("start");
		expect((events[1] as { uri: string }).uri).toBe("http://b.com");
		expect(events[2].type).toBe("end");
	});
});

// ============================================================
// OSC 52 — Clipboard
// ============================================================

describe("OSC 52 via PTY", () => {
	let s: OscSession;

	beforeEach(() => {
		s = createOscSession();
	});
	afterEach(() => s.dispose());

	it("clipboard set (base64 encoded)", async () => {
		// "Hello" = SGVsbG8=
		await s.emitOsc("printf '\\e]52;c;SGVsbG8=\\a'");
		const e = await s.waitForOsc<Osc52Event>(52);
		expect(e.type).toBe("set");
		expect((e as { selection: string }).selection).toBe("c");
		expect((e as { data: string }).data).toBe("Hello");
	});

	it("clipboard query", async () => {
		await s.emitOsc("printf '\\e]52;c;?\\a'");
		const e = await s.waitForOsc<Osc52Event>(52);
		expect(e.type).toBe("query");
		expect((e as { selection: string }).selection).toBe("c");
	});

	it("clipboard clear (empty data)", async () => {
		await s.emitOsc("printf '\\e]52;c;\\a'");
		const e = await s.waitForOsc<Osc52Event>(52);
		expect(e.type).toBe("clear");
		expect((e as { selection: string }).selection).toBe("c");
	});

	it("primary selection (p)", async () => {
		// "test" = dGVzdA==
		await s.emitOsc("printf '\\e]52;p;dGVzdA==\\a'");
		const e = await s.waitForOsc<Osc52Event>(52);
		expect((e as { selection: string }).selection).toBe("p");
		expect((e as { data: string }).data).toBe("test");
	});

	it("select selection (s)", async () => {
		await s.emitOsc("printf '\\e]52;s;?\\a'");
		const e = await s.waitForOsc<Osc52Event>(52);
		expect((e as { selection: string }).selection).toBe("s");
	});

	it("multibyte characters (UTF-8 base64)", async () => {
		// "日本語" = 5pel5pys6Kqe
		const b64 = Buffer.from("日本語").toString("base64");
		await s.emitOsc(`printf '\\e]52;c;${b64}\\a'`);
		const e = await s.waitForOsc<Osc52Event>(52);
		expect((e as { data: string }).data).toBe("日本語");
	});

	it("long text (multiline command base64)", async () => {
		const text =
			'echo "hello world" && echo "line 2" && echo "line 3"';
		const b64 = Buffer.from(text).toString("base64");
		await s.emitOsc(`printf '\\e]52;c;${b64}\\a'`);
		const e = await s.waitForOsc<Osc52Event>(52);
		expect((e as { data: string }).data).toBe(text);
	});

	it("ST terminator", async () => {
		await s.emitOsc("printf '\\e]52;c;SGVsbG8=\\e\\\\'");
		const e = await s.waitForOsc<Osc52Event>(52);
		expect((e as { data: string }).data).toBe("Hello");
	});
});

// ============================================================
// Cross-OSC edge cases
// ============================================================

describe("Cross-OSC edge cases via PTY", () => {
	let s: OscSession;

	beforeEach(() => {
		s = createOscSession();
	});
	afterEach(() => s.dispose());

	it("multiple different OSC types in rapid succession", async () => {
		await s.emitOsc(
			"printf '\\e]133;A\\a\\e]633;P;Cwd=/tmp\\a\\e]7;file://host/tmp\\a\\e]2;title\\a'",
		);
		await s.waitForStable(300);

		expect(s.captured.get(133)!.length).toBeGreaterThanOrEqual(1);
		expect(s.captured.get(633)!.length).toBeGreaterThanOrEqual(1);
		expect(s.captured.get(7)!.length).toBeGreaterThanOrEqual(1);
		expect(s.captured.get(2)!.length).toBeGreaterThanOrEqual(1);
	});

	it("OSC interleaved with normal output", async () => {
		await s.emitOsc(
			"printf 'before\\e]133;C\\aoutput\\e]133;D;0\\aafter\\n'",
		);
		const events =
			await s.waitForOscCount<IShellIntegrationEvent>(133, 2);
		expect(events[0].type).toBe("C");
		expect(events[1].type).toBe("D");
	});

	it("OSC 8 hyperlink around normal text", async () => {
		await s.emitOsc(
			"printf '\\e]8;;http://example.com\\aClick me\\e]8;;\\a\\n'",
		);
		const events = await s.waitForOscCount<Osc8Event>(8, 2);
		expect(events[0].type).toBe("start");
		expect(events[1].type).toBe("end");
		// The text "Click me" should be in raw output
		await s.waitForStable(200);
		expect(s.rawChunks.join("")).toContain("Click me");
	});

	it("back-to-back OSC 52 set then query", async () => {
		const b64 = Buffer.from("clipboard data").toString("base64");
		await s.emitOsc(`printf '\\e]52;c;${b64}\\a\\e]52;c;?\\a'`);
		const events = await s.waitForOscCount<Osc52Event>(52, 2);
		expect(events[0].type).toBe("set");
		expect(events[1].type).toBe("query");
	});
});
