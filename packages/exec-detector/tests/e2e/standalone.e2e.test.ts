/**
 * termosc スタンドアロン統合テスト
 *
 * Conch を一切使わず、node-pty + xterm.js を直接使って
 * 「注入 → OSC 133/633/7 検出 → 出力抽出」のフルパイプラインを検証する。
 *
 * 対応シェル: bash, zsh, fish, pwsh, elvish, nushell
 */
import { describe, it, expect, afterEach } from "vitest";
import * as pty from "@lydell/node-pty";
import { Terminal } from "@xterm/headless";
import { execSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	parseOsc133,
	parseOsc633,
	parseOsc7,
	extractCommandOutput,
	encodeScriptForShell,
	BASH_INTEGRATION_SCRIPT,
	PWSH_INTEGRATION_SCRIPT,
	ZSH_INTEGRATION_SCRIPT,
	FISH_INTEGRATION_SCRIPT,
	ELVISH_INTEGRATION_SCRIPT,
	NUSHELL_INTEGRATION_SCRIPT,
	ShellIntegrationType,
	type IShellIntegrationEvent,
	type Osc633Event,
	type Osc7Event,
} from "../../src";

// --- Shell availability check ---

function hasShell(name: string): boolean {
	try {
		execSync(`which ${name}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

// --- Helper ---

interface StandaloneSession {
	ptyProcess: pty.IPty;
	terminal: Terminal;
	osc133Events: IShellIntegrationEvent[];
	osc633Events: Osc633Event[];
	osc7Events: Osc7Event[];
	rawChunks: string[];
	dispose(): void;
	write(data: string): void;
	waitFor133(
		type: ShellIntegrationType,
		timeoutMs?: number,
	): Promise<IShellIntegrationEvent>;
	waitFor633(
		type: Osc633Event["type"],
		timeoutMs?: number,
	): Promise<Osc633Event>;
	waitFor7(timeoutMs?: number): Promise<Osc7Event>;
	waitForStable(durationMs?: number, timeoutMs?: number): Promise<string>;
	waitForRawContains(
		substring: string,
		timeoutMs?: number,
	): Promise<void>;
}

function createSession(
	shell: string,
	args: string[] = [],
	env?: Record<string, string>,
): StandaloneSession {
	const osc133Events: IShellIntegrationEvent[] = [];
	const osc633Events: Osc633Event[] = [];
	const osc7Events: Osc7Event[] = [];
	const rawChunks: string[] = [];

	const ptyProcess = pty.spawn(shell, args, {
		name: "xterm-256color",
		cols: 80,
		rows: 24,
		env: { ...process.env, TERM: "xterm-256color", ...env },
	});

	const terminal = new Terminal({
		allowProposedApi: true,
		cols: 80,
		rows: 24,
		scrollback: 5000,
	});

	ptyProcess.onData((data: string) => {
		rawChunks.push(data);
		terminal.write(data);
	});

	// Feed xterm responses (DSR etc.) back to PTY — required for pwsh/nushell
	terminal.onData((data: string) => {
		ptyProcess.write(data);
	});

	terminal.parser.registerOscHandler(133, (data: string) => {
		const event = parseOsc133(data);
		if (event) osc133Events.push(event);
		return true;
	});

	terminal.parser.registerOscHandler(633, (data: string) => {
		const event = parseOsc633(data);
		if (event) osc633Events.push(event);
		return true;
	});

	terminal.parser.registerOscHandler(7, (data: string) => {
		const event = parseOsc7(data);
		if (event) osc7Events.push(event);
		return true;
	});

	function waitForInArray<T>(
		arr: T[],
		predicate: (item: T) => boolean,
		label: string,
		timeoutMs: number,
	): Promise<T> {
		return new Promise((resolve, reject) => {
			const existing = arr.find(predicate);
			if (existing) {
				resolve(existing);
				return;
			}
			const timer = setTimeout(() => {
				clearInterval(poller);
				reject(new Error(`Timeout waiting for ${label}`));
			}, timeoutMs);
			const startIdx = arr.length;
			const poller = setInterval(() => {
				for (let i = startIdx; i < arr.length; i++) {
					if (predicate(arr[i])) {
						clearTimeout(timer);
						clearInterval(poller);
						resolve(arr[i]);
						return;
					}
				}
			}, 50);
		});
	}

	return {
		ptyProcess,
		terminal,
		osc133Events,
		osc633Events,
		osc7Events,
		rawChunks,
		dispose() {
			terminal.dispose();
			ptyProcess.kill();
		},
		write(data: string) {
			ptyProcess.write(data);
		},
		waitFor133(type, timeoutMs = 15_000) {
			return waitForInArray(
				osc133Events,
				(e) => e.type === type,
				`OSC 133 ${type}`,
				timeoutMs,
			);
		},
		waitFor633(type, timeoutMs = 15_000) {
			return waitForInArray(
				osc633Events,
				(e) => e.type === type,
				`OSC 633 ${type}`,
				timeoutMs,
			);
		},
		waitFor7(timeoutMs = 15_000) {
			return waitForInArray(
				osc7Events,
				() => true,
				"OSC 7",
				timeoutMs,
			);
		},
		waitForStable(durationMs = 300, timeoutMs = 10_000): Promise<string> {
			return new Promise((resolve, reject) => {
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
						resolve(rawChunks.join(""));
					}
					if (Date.now() > deadline) {
						clearInterval(poller);
						reject(new Error("Timeout waiting for stable output"));
					}
				}, 50);
			});
		},
		waitForRawContains(
			substring: string,
			timeoutMs = 15_000,
		): Promise<void> {
			return new Promise((resolve, reject) => {
				if (rawChunks.join("").includes(substring)) {
					resolve();
					return;
				}
				const timer = setTimeout(() => {
					clearInterval(poller);
					reject(
						new Error(
							`Timeout waiting for "${substring}" in raw output`,
						),
					);
				}, timeoutMs);
				const poller = setInterval(() => {
					if (rawChunks.join("").includes(substring)) {
						clearTimeout(timer);
						clearInterval(poller);
						resolve();
					}
				}, 50);
			});
		},
	};
}

function resetEvents(session: StandaloneSession) {
	session.osc133Events.length = 0;
	session.osc633Events.length = 0;
	session.osc7Events.length = 0;
	session.rawChunks.length = 0;
}

// ============================================================
// Bash
// ============================================================

describe("termosc standalone: bash", () => {
	let session: StandaloneSession | undefined;

	afterEach(() => {
		session?.dispose();
		session = undefined;
	});

	async function setup() {
		session = createSession("bash", ["--norc", "--noprofile"]);
		session.write(
			encodeScriptForShell(BASH_INTEGRATION_SCRIPT, "bash") + "\r",
		);
		await session.waitFor133(ShellIntegrationType.PromptStart);
		resetEvents(session);
		session.write("true\r");
		await session.waitFor133(ShellIntegrationType.CommandFinished);
		resetEvents(session);
	}

	it("OSC 133: detect A/C/D + exit code", async () => {
		await setup();
		session!.write('echo "hello"\r');
		const d = await session!.waitFor133(
			ShellIntegrationType.CommandFinished,
		);
		const types = session!.osc133Events.map((e) => e.type);
		expect(types).toContain(ShellIntegrationType.CommandExecuted);
		expect(d.params[0]).toBe("0");
	});

	it("OSC 133: extract command output", async () => {
		await setup();
		session!.write('echo "bash-extract-test"\r');
		await session!.waitFor133(ShellIntegrationType.CommandFinished);
		await session!.waitForStable(200);
		const output = extractCommandOutput(
			session!.rawChunks.join(""),
			true,
		);
		expect(output).toContain("bash-extract-test");
	});

	it("OSC 133: non-zero exit code", async () => {
		await setup();
		session!.write("false\r");
		const d = await session!.waitFor133(
			ShellIntegrationType.CommandFinished,
		);
		expect(d.params[0]).toBe("1");
	});

	it("OSC 633 E: CommandLine", async () => {
		await setup();
		session!.write('echo "osc633"\r');
		const e = await session!.waitFor633("CommandLine");
		expect((e as { command: string }).command).toContain("echo");
	});

	it("OSC 633 E: pipe command", async () => {
		await setup();
		session!.write("echo hello | cat\r");
		const e = await session!.waitFor633("CommandLine");
		expect((e as { command: string }).command).toContain("echo hello");
	});

	it("OSC 633 E: command with semicolon (escaped as \\x3b)", async () => {
		await setup();
		session!.write("echo a; echo b\r");
		// bash DEBUG trap captures each simple command, so we get "echo a" first
		const e = await session!.waitFor633("CommandLine");
		expect((e as { command: string }).command).toContain("echo");
	});

	it("OSC 633 E: command with quotes", async () => {
		await setup();
		session!.write("echo \"hello 'world'\"\r");
		const e = await session!.waitFor633("CommandLine");
		expect((e as { command: string }).command).toContain("echo");
	});

	it("OSC 633 E: command with backslash", async () => {
		await setup();
		session!.write("echo 'back\\\\slash'\r");
		const e = await session!.waitFor633("CommandLine");
		expect((e as { command: string }).command).toContain("echo");
	});

	it("OSC 633 P: Cwd", async () => {
		await setup();
		session!.write("pwd\r");
		await session!.waitFor133(ShellIntegrationType.CommandFinished);
		const p = await session!.waitFor633("Property");
		expect((p as { key: string; value: string }).key).toBe("Cwd");
		expect(
			(p as { key: string; value: string }).value.startsWith("/"),
		).toBe(true);
	});

	it("OSC 7: CWD notification", async () => {
		await setup();
		session!.write("true\r");
		const cwd = await session!.waitFor7();
		expect(cwd.scheme).toBe("file");
		expect(cwd.path.startsWith("/")).toBe(true);
	});

	it("OSC 7: updates after cd", async () => {
		await setup();
		session!.write("cd /tmp\r");
		await session!.waitFor133(ShellIntegrationType.CommandFinished);
		resetEvents(session!);
		session!.write("true\r");
		const cwd = await session!.waitFor7();
		expect(cwd.path).toBe("/tmp");
	});
});

// ============================================================
// Zsh
// ============================================================

describe.skipIf(!hasShell("zsh"))("termosc standalone: zsh", () => {
	let session: StandaloneSession | undefined;

	afterEach(() => {
		session?.dispose();
		session = undefined;
	});

	async function setup() {
		session = createSession("zsh", ["--no-rcs"]);
		// zsh: source the script via eval
		const escaped = ZSH_INTEGRATION_SCRIPT.replace(/'/g, "'\\''");
		session.write(`eval '${escaped}'\r`);
		await session.waitFor133(ShellIntegrationType.PromptStart);
		resetEvents(session);
		session.write("true\r");
		await session.waitFor133(ShellIntegrationType.CommandFinished);
		resetEvents(session);
	}

	it("OSC 133: detect A/C/D + exit code", async () => {
		await setup();
		session!.write('echo "hello"\r');
		const d = await session!.waitFor133(
			ShellIntegrationType.CommandFinished,
		);
		const types = session!.osc133Events.map((e) => e.type);
		expect(types).toContain(ShellIntegrationType.CommandExecuted);
		expect(d.params[0]).toBe("0");
	});

	it("OSC 133: extract command output", async () => {
		await setup();
		session!.write('echo "zsh-extract-test"\r');
		await session!.waitFor133(ShellIntegrationType.CommandFinished);
		await session!.waitForStable(200);
		const output = extractCommandOutput(
			session!.rawChunks.join(""),
			true,
		);
		expect(output).toContain("zsh-extract-test");
	});

	it("OSC 133: non-zero exit code", async () => {
		await setup();
		session!.write("false\r");
		const d = await session!.waitFor133(
			ShellIntegrationType.CommandFinished,
		);
		expect(d.params[0]).toBe("1");
	});

	it("OSC 633 E: CommandLine", async () => {
		await setup();
		session!.write('echo "zsh633"\r');
		const e = await session!.waitFor633("CommandLine");
		expect((e as { command: string }).command).toContain("echo");
	});

	it("OSC 633 E: pipe command", async () => {
		await setup();
		session!.write("echo hello | cat\r");
		const e = await session!.waitFor633("CommandLine");
		// zsh preexec receives the full command line
		expect((e as { command: string }).command).toContain("echo hello");
		expect((e as { command: string }).command).toContain("cat");
	});

	it("OSC 633 E: command with semicolon", async () => {
		await setup();
		session!.write("echo a; echo b\r");
		const e = await session!.waitFor633("CommandLine");
		// zsh preexec receives the full command line as $1
		const cmd = (e as { command: string }).command;
		expect(cmd).toContain("echo a");
		expect(cmd).toContain("echo b");
	});

	it("OSC 633 P: Cwd", async () => {
		await setup();
		session!.write("true\r");
		await session!.waitFor133(ShellIntegrationType.CommandFinished);
		const p = await session!.waitFor633("Property");
		expect((p as { key: string; value: string }).key).toBe("Cwd");
	});

	it("OSC 7: CWD notification", async () => {
		await setup();
		session!.write("true\r");
		const cwd = await session!.waitFor7();
		expect(cwd.scheme).toBe("file");
		expect(cwd.path.startsWith("/")).toBe(true);
	});
});

// ============================================================
// Fish
// ============================================================

describe.skipIf(!hasShell("fish"))("termosc standalone: fish", () => {
	let session: StandaloneSession | undefined;

	afterEach(() => {
		session?.dispose();
		session = undefined;
	});

	async function setup() {
		session = createSession("fish", ["--no-config"]);
		// fish: source script via eval
		const escaped = FISH_INTEGRATION_SCRIPT.replace(/\\/g, "\\\\").replace(
			/'/g,
			"\\'",
		);
		session.write(`eval '${escaped}'\r`);
		await session.waitFor133(ShellIntegrationType.PromptStart);
		resetEvents(session);
		session.write("true\r");
		await session.waitFor133(ShellIntegrationType.CommandFinished, 15_000);
		resetEvents(session);
	}

	it("OSC 133: detect A/C/D", async () => {
		await setup();
		session!.write('echo "hello"\r');
		const d = await session!.waitFor133(
			ShellIntegrationType.CommandFinished,
		);
		expect(d.params[0]).toBe("0");
	});

	it("OSC 133: non-zero exit code", async () => {
		await setup();
		session!.write("false\r");
		const d = await session!.waitFor133(
			ShellIntegrationType.CommandFinished,
		);
		expect(d.params[0]).toBe("1");
	});

	it("OSC 133: extract command output", async () => {
		await setup();
		session!.write('echo "fish-extract-test"\r');
		await session!.waitFor133(ShellIntegrationType.CommandFinished);
		await session!.waitForStable(200);
		const output = extractCommandOutput(
			session!.rawChunks.join(""),
			true,
		);
		expect(output).toContain("fish-extract-test");
	});

	it("OSC 633 E: CommandLine", async () => {
		await setup();
		session!.write('echo "fish633"\r');
		const e = await session!.waitFor633("CommandLine");
		expect((e as { command: string }).command).toContain("echo");
	});

	it("OSC 633 E: pipe command", async () => {
		await setup();
		session!.write("echo hello | cat\r");
		const e = await session!.waitFor633("CommandLine");
		expect((e as { command: string }).command).toContain("echo hello");
	});

	it("OSC 7: CWD notification", async () => {
		await setup();
		session!.write("true\r");
		const cwd = await session!.waitFor7();
		expect(cwd.scheme).toBe("file");
		expect(cwd.path.startsWith("/")).toBe(true);
	});

	it("OSC 7: updates after cd", async () => {
		await setup();
		session!.write("cd /tmp\r");
		await session!.waitFor133(ShellIntegrationType.CommandFinished);
		resetEvents(session!);
		session!.write("true\r");
		const cwd = await session!.waitFor7();
		expect(cwd.path).toBe("/tmp");
	});
});

// ============================================================
// PowerShell
// ============================================================

describe.skipIf(!hasShell("pwsh"))("termosc standalone: pwsh", () => {
	let session: StandaloneSession | undefined;
	let tmpDir: string | undefined;

	afterEach(() => {
		session?.dispose();
		session = undefined;
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
			tmpDir = undefined;
		}
	});

	async function setup() {
		tmpDir = mkdtempSync(join(tmpdir(), "eid-pwsh-"));
		const scriptPath = join(tmpDir, "init.ps1");
		writeFileSync(scriptPath, PWSH_INTEGRATION_SCRIPT);

		session = createSession("pwsh", ["-NoProfile", "-NoLogo"]);
		await session.waitForRawContains("PS ", 20_000);
		session.write(`. "${scriptPath}"\r`);
		await session.waitFor133(ShellIntegrationType.PromptStart);
		resetEvents(session);
		session.write("$null\r");
		await session.waitFor133(ShellIntegrationType.CommandFinished);
		resetEvents(session);
	}

	it("OSC 133: detect A/D", async () => {
		await setup();
		session!.write('Write-Output "hello"\r');
		const d = await session!.waitFor133(
			ShellIntegrationType.CommandFinished,
		);
		const types = session!.osc133Events.map((e) => e.type);
		expect(types).toContain(ShellIntegrationType.PromptStart);
		expect(types).toContain(ShellIntegrationType.CommandFinished);
		expect(d.params.length).toBeGreaterThanOrEqual(1);
	});

	it("OSC 133: non-zero exit code (native command)", async () => {
		await setup();
		// Use a native command that returns non-zero to set $LASTEXITCODE
		session!.write("bash -c 'exit 42'\r");
		const d = await session!.waitFor133(
			ShellIntegrationType.CommandFinished,
		);
		expect(d.params[0]).toBe("42");
	});

	it("OSC 133: extract command output", async () => {
		await setup();
		session!.write('Write-Output "pwsh-extract-test"\r');
		await session!.waitFor133(ShellIntegrationType.CommandFinished);
		await session!.waitForStable(300);
		const output = extractCommandOutput(
			session!.rawChunks.join(""),
			true,
		);
		expect(output).toContain("pwsh-extract-test");
	});

	it("OSC 633 E: CommandLine (via PSReadLine)", async () => {
		await setup();
		session!.write('Write-Output "pwsh633"\r');
		const e = await session!.waitFor633("CommandLine");
		expect((e as { command: string }).command).toContain("Write-Output");
	});

	it("OSC 633 P: Cwd", async () => {
		await setup();
		session!.write("Get-Location\r");
		await session!.waitFor133(ShellIntegrationType.CommandFinished);
		const p = await session!.waitFor633("Property");
		expect((p as { key: string; value: string }).key).toBe("Cwd");
	});

	it("OSC 7: CWD notification", async () => {
		await setup();
		session!.write("$null\r");
		const cwd = await session!.waitFor7();
		expect(cwd.scheme).toBe("file");
		expect(cwd.path.startsWith("/")).toBe(true);
	});
});

// ============================================================
// Elvish
// ============================================================

describe.skipIf(!hasShell("elvish"))(
	"termosc standalone: elvish",
	() => {
		let session: StandaloneSession | undefined;

		afterEach(() => {
			session?.dispose();
			session = undefined;
		});

		async function setup() {
			session = createSession("elvish");
			const escaped = ELVISH_INTEGRATION_SCRIPT.replace(/'/g, "''");
			session.write(`eval '${escaped}'\r`);
			await session.waitFor133(ShellIntegrationType.PromptStart);
			resetEvents(session);
			session.write("nop\r");
			await session.waitFor133(
				ShellIntegrationType.CommandFinished,
				15_000,
			);
			resetEvents(session);
		}

		it("OSC 133: detect A/C/D", async () => {
			await setup();
			session!.write('echo "hello"\r');
			const d = await session!.waitFor133(
				ShellIntegrationType.CommandFinished,
			);
			const types = session!.osc133Events.map((e) => e.type);
			expect(types).toContain(ShellIntegrationType.CommandExecuted);
			expect(types).toContain(ShellIntegrationType.CommandFinished);
		});

		it("OSC 133: exit code on failure", async () => {
			await setup();
			// elvish: `fail` raises an error; after-command receives exit-status=1
			session!.write("bash -c 'exit 7'\r");
			const d = await session!.waitFor133(
				ShellIntegrationType.CommandFinished,
			);
			expect(d.params.length).toBeGreaterThanOrEqual(1);
			expect(Number(d.params[0])).toBeGreaterThan(0);
		});

		it("OSC 133: extract command output", async () => {
			await setup();
			session!.write('echo "elvish-extract-test"\r');
			await session!.waitFor133(
				ShellIntegrationType.CommandFinished,
			);
			await session!.waitForStable(200);
			const output = extractCommandOutput(
				session!.rawChunks.join(""),
				true,
			);
			expect(output).toContain("elvish-extract-test");
		});

		it("OSC 633 E: CommandLine", async () => {
			await setup();
			session!.write('echo "elvish633"\r');
			const e = await session!.waitFor633("CommandLine");
			expect((e as { command: string }).command).toContain("echo");
		});

		it("OSC 7: CWD notification", async () => {
			await setup();
			session!.write("nop\r");
			const cwd = await session!.waitFor7();
			expect(cwd.scheme).toBe("file");
			expect(cwd.path.startsWith("/")).toBe(true);
		});
	},
);

// ============================================================
// Nushell
// ============================================================

describe.skipIf(!hasShell("nu"))("termosc standalone: nushell", () => {
	let session: StandaloneSession | undefined;
	let tmpDir: string | undefined;

	afterEach(() => {
		session?.dispose();
		session = undefined;
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
			tmpDir = undefined;
		}
	});

	async function setup() {
		tmpDir = mkdtempSync(join(tmpdir(), "eid-nu-"));
		const scriptPath = join(tmpDir, "init.nu");
		writeFileSync(scriptPath, NUSHELL_INTEGRATION_SCRIPT);

		session = createSession("nu", ["--no-config-file"]);
		session.write(`source "${scriptPath}"\r`);
		await session.waitFor133(ShellIntegrationType.PromptStart, 15_000);
		resetEvents(session);
		session.write("null\r");
		await session.waitFor133(ShellIntegrationType.CommandFinished, 15_000);
		resetEvents(session);
	}

	it("OSC 133: detect A/C/D", async () => {
		await setup();
		session!.write('echo "hello"\r');
		const d = await session!.waitFor133(
			ShellIntegrationType.CommandFinished,
		);
		const types = session!.osc133Events.map((e) => e.type);
		expect(types).toContain(ShellIntegrationType.PromptStart);
	});

	it("OSC 133: extract command output", async () => {
		await setup();
		session!.write('echo "nushell-extract-test"\r');
		await session!.waitFor133(ShellIntegrationType.CommandFinished);
		await session!.waitForStable(300);
		const output = extractCommandOutput(
			session!.rawChunks.join(""),
			true,
		);
		expect(output).toContain("nushell-extract-test");
	});

	// Note: OSC 633 E is not available in nushell (pre_execution hook
	// does not receive the command string — nushell limitation)

	it("OSC 7: CWD notification", async () => {
		await setup();
		session!.write("null\r");
		const cwd = await session!.waitFor7();
		expect(cwd.scheme).toBe("file");
		expect(cwd.path.startsWith("/")).toBe(true);
	});
});
