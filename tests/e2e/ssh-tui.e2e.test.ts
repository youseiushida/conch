/**
 * E2E tests for TUI applications over SSH backend.
 *
 * Verifies that TUI apps (vim, less, nano, python3 REPL, tmux) work correctly
 * when the terminal is hosted over an SSH connection via SshPty.
 *
 * Skip condition: same as ssh.e2e.test.ts — requires SSH_TEST_KEY or
 * SSH_TEST_PASSWORD and a reachable sshd.
 *
 * Run with:
 *   SSH_TEST_USER=nezow SSH_TEST_KEY=~/.ssh/conch_test pnpm test:e2e
 */
import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Conch } from "../../src/conch";

const SSH_HOST = process.env.SSH_TEST_HOST ?? "localhost";
const SSH_PORT = Number(process.env.SSH_TEST_PORT ?? "22");
const SSH_USER = process.env.SSH_TEST_USER ?? process.env.USER ?? "root";

function getAuthOptions(): { password?: string; privateKey?: Buffer; agent?: string } {
	if (process.env.SSH_TEST_KEY) {
		try { return { privateKey: readFileSync(process.env.SSH_TEST_KEY) }; } catch { /* fall */ }
	}
	if (process.env.SSH_TEST_PASSWORD) return { password: process.env.SSH_TEST_PASSWORD };
	if (process.env.SSH_AUTH_SOCK) return { agent: process.env.SSH_AUTH_SOCK };
	return {};
}

function sshAvailable(): boolean {
	if (process.env.SKIP_SSH === "1") return false;
	const auth = getAuthOptions();
	if (!auth.password && !auth.privateKey && !auth.agent) return false;
	try {
		const keyFlag = process.env.SSH_TEST_KEY ? `-i "${process.env.SSH_TEST_KEY}"` : "";
		execSync(
			`ssh -o BatchMode=yes -o ConnectTimeout=2 -o StrictHostKeyChecking=no ${keyFlag} -p ${SSH_PORT} ${SSH_USER}@${SSH_HOST} exit`,
			{ stdio: "pipe", timeout: 5000 },
		);
		return true;
	} catch { return false; }
}

function remoteHasCommand(cmd: string): boolean {
	try {
		const keyFlag = process.env.SSH_TEST_KEY ? `-i "${process.env.SSH_TEST_KEY}"` : "";
		execSync(
			`ssh -o BatchMode=yes -o StrictHostKeyChecking=no ${keyFlag} -p ${SSH_PORT} ${SSH_USER}@${SSH_HOST} which ${cmd}`,
			{ stdio: "pipe", timeout: 5000 },
		);
		return true;
	} catch { return false; }
}

const hasSsh = sshAvailable();
const describeSsh = hasSsh ? describe : describe.skip;

let conch: Conch | undefined;

afterEach(async () => {
	if (conch) {
		const backend = conch.backend;
		conch.dispose();
		if (backend.disposeAsync) await backend.disposeAsync();
		conch = undefined;
	}
});

function launchSsh(size: { cols?: number; rows?: number } = {}) {
	const auth = getAuthOptions();
	return Conch.launch({
		backend: {
			type: "ssh" as const,
			host: SSH_HOST,
			port: SSH_PORT,
			username: SSH_USER,
			...auth,
		},
		cols: size.cols ?? 80,
		rows: size.rows ?? 24,
		timeoutMs: 20_000,
	});
}

describeSsh("SSH TUI E2E", () => {
	describe("vim", () => {
		it("should render in alternate buffer with t_RV disabled", async () => {
			conch = await launchSsh();
			conch.execute('vim --cmd "set t_RV=" /tmp/conch_ssh_e2e_vim.txt');

			await new Promise((r) => setTimeout(r, 2000));
			await conch.drain();

			const snap = conch.getSnapshot();
			// vim should have switched to alternate buffer
			expect(snap.meta.isAlternateBuffer).toBe(true);
			// vim always renders tildes for empty lines
			expect(snap.text).toContain("~");

			conch.write("\x1b");
			conch.write(":q!\r");
			await conch.waitForStable({ durationMs: 500, timeoutMs: 5_000 });

			// Back to normal shell
			expect(conch.getSnapshot().meta.isAlternateBuffer).toBe(false);
		});

		it("should accept text input and reflect it in buffer", async () => {
			conch = await launchSsh();
			conch.execute('vim --cmd "set t_RV=" /tmp/conch_ssh_e2e_vim2.txt');
			await new Promise((r) => setTimeout(r, 2000));
			await conch.drain();

			// i → insert mode → type → ESC
			conch.press("i");
			await new Promise((r) => setTimeout(r, 200));
			conch.type("SSH TUI test content");
			await new Promise((r) => setTimeout(r, 300));
			await conch.drain();

			expect(conch.getSnapshot().text).toContain("SSH TUI test content");

			conch.write("\x1b");
			conch.write(":q!\r");
			await conch.waitForStable({ durationMs: 500, timeoutMs: 5_000 });
		});

		it("should handle resize while vim is open", async () => {
			conch = await launchSsh({ cols: 80, rows: 24 });
			conch.execute('vim --cmd "set t_RV=" /tmp/conch_ssh_e2e_vim3.txt');
			await new Promise((r) => setTimeout(r, 2000));
			await conch.drain();

			expect(conch.getSnapshot().meta.isAlternateBuffer).toBe(true);

			// Resize and verify vim redraws
			conch.resize(120, 40);
			await new Promise((r) => setTimeout(r, 1000));
			await conch.drain();

			const snap = conch.getSnapshot();
			expect(snap.meta.cols).toBe(120);
			expect(snap.meta.rows).toBe(40);
			expect(snap.meta.isAlternateBuffer).toBe(true);

			conch.write("\x1b");
			conch.write(":q!\r");
			await conch.waitForStable({ durationMs: 500, timeoutMs: 5_000 });
		});
	});

	describe("less", () => {
		it("should render numbered content in alternate buffer", async () => {
			conch = await launchSsh();
			conch.execute("seq 1 100 | less");
			await new Promise((r) => setTimeout(r, 2000));
			await conch.drain();

			const snap = conch.getSnapshot();
			expect(snap.meta.isAlternateBuffer).toBe(true);
			// Should show numbers
			expect(snap.text).toMatch(/\b\d+\b/);

			conch.press("q");
			await conch.waitForStable({ durationMs: 500, timeoutMs: 5_000 });
			expect(conch.getSnapshot().meta.isAlternateBuffer).toBe(false);
		});

		it("should support scrolling and search", async () => {
			conch = await launchSsh();
			conch.execute("seq 1 200 | less");
			await new Promise((r) => setTimeout(r, 2000));
			await conch.drain();

			// Search for 150
			conch.type("/150");
			conch.press("Enter");
			await new Promise((r) => setTimeout(r, 500));
			await conch.drain();

			expect(conch.getSnapshot().text).toContain("150");

			conch.press("q");
			await conch.waitForStable({ durationMs: 500, timeoutMs: 5_000 });
		});
	});

	describe("nano", () => {
		it.skipIf(!remoteHasCommand("nano"))("should render in alternate buffer", async () => {
			conch = await launchSsh();
			conch.execute("nano /tmp/conch_ssh_e2e_nano.txt");
			await new Promise((r) => setTimeout(r, 2000));
			await conch.drain();

			const snap = conch.getSnapshot();
			expect(snap.meta.isAlternateBuffer).toBe(true);
			// nano always shows its header
			expect(snap.text).toMatch(/GNU nano|nano/i);

			conch.press("Ctrl+X");
			await conch.waitForStable({ durationMs: 500, timeoutMs: 5_000 });
			expect(conch.getSnapshot().meta.isAlternateBuffer).toBe(false);
		});

		it.skipIf(!remoteHasCommand("nano"))("should accept text input", async () => {
			conch = await launchSsh();
			conch.execute("nano /tmp/conch_ssh_e2e_nano2.txt");
			await new Promise((r) => setTimeout(r, 2000));
			await conch.drain();

			conch.type("SSH nano E2E");
			await new Promise((r) => setTimeout(r, 300));
			await conch.drain();

			expect(conch.getSnapshot().text).toContain("SSH nano E2E");

			conch.press("Ctrl+X");
			await new Promise((r) => setTimeout(r, 300));
			conch.press("n");
			await conch.waitForStable({ durationMs: 500, timeoutMs: 5_000 });
		});
	});

	describe("python3 REPL", () => {
		it.skipIf(!remoteHasCommand("python3"))("should interact with REPL over SSH", async () => {
			conch = await launchSsh();
			conch.execute("python3 -q");
			await new Promise((r) => setTimeout(r, 1500));

			conch.execute('print("SSH_PY_E2E")');
			await conch.waitForText("SSH_PY_E2E", { timeoutMs: 5_000 });

			conch.execute("2 ** 10");
			await conch.waitForText("1024", { timeoutMs: 5_000 });

			conch.execute("exit()");
			await conch.waitForStable({ durationMs: 500, timeoutMs: 5_000 });
		});
	});

	describe("tmux", () => {
		it.skipIf(!remoteHasCommand("tmux"))("should create session and run commands inside", async () => {
			conch = await launchSsh();
			conch.execute("tmux new-session -d -s conch_ssh_e2e && tmux attach -t conch_ssh_e2e");
			await new Promise((r) => setTimeout(r, 2000));
			await conch.drain();

			const snap = conch.getSnapshot();
			expect(snap.text.trim().length).toBeGreaterThan(0);

			conch.execute('echo "TMUX_SSH_E2E"');
			await conch.waitForText("TMUX_SSH_E2E", { timeoutMs: 5_000 });

			// Ctrl+B D to detach
			conch.write("\x02d");
			await conch.waitForStable({ durationMs: 500, timeoutMs: 5_000 });

			// Cleanup
			conch.execute("tmux kill-session -t conch_ssh_e2e");
			await conch.waitForStable({ durationMs: 300, timeoutMs: 3_000 });
		});
	});
});
