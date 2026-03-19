/**
 * E2E tests for TUI application support.
 * Tests that the terminal query auto-responder enables real TUI apps to render.
 *
 * Run with: pnpm test:e2e
 */
import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { Conch } from "../../src/conch";

let conch: Conch | undefined;

afterEach(() => {
	conch?.dispose();
	conch = undefined;
});

function launch() {
	return Conch.launch({
		backend: { type: "localPty", file: "bash", args: [], env: process.env },
		cols: 80,
		rows: 24,
		timeoutMs: 20_000,
	});
}

function hasCommand(cmd: string): boolean {
	try {
		execSync(`which ${cmd}`, { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

describe("TUI E2E", () => {
	describe("vim", () => {
		it.skipIf(!hasCommand("vim"))("should render with t_RV disabled", async () => {
			conch = await launch();
			conch.execute('vim --cmd "set t_RV=" /tmp/conch_e2e_vim.txt');

			// vim should render within ~2s with t_RV disabled
			await new Promise((r) => setTimeout(r, 2000));
			await conch.drain();

			const snap = conch.getSnapshot();
			// vim outputs content (may or may not enter altbuf depending on config)
			expect(snap.text.trim().length).toBeGreaterThan(20);

			conch.write("\x1b"); // ESC
			conch.write(":q!\r");
			await conch.waitForSilence({ durationMs: 500, timeoutMs: 5_000 });
			execSync("rm -f /tmp/conch_e2e_vim.txt");
		});

		it.skipIf(!hasCommand("vim"))("should render with default config (~5s)", async () => {
			conch = await launch();
			conch.execute("vim /tmp/conch_e2e_vim2.txt");

			// Wait for vim's t_RV timeout (~4-6s, varies by system)
			await new Promise((r) => setTimeout(r, 8000));
			await conch.drain();

			const snap = conch.getSnapshot();
			expect(snap.meta.isAlternateBuffer).toBe(true);
			expect(snap.text).toContain("~");

			conch.write("\x1b");
			conch.write(":q!\r");
			await conch.waitForSilence({ durationMs: 500, timeoutMs: 5_000 });
			execSync("rm -f /tmp/conch_e2e_vim2.txt");
		}, 15_000);

		it.skipIf(!hasCommand("vim"))("should accept text input and quit", async () => {
			conch = await launch();
			conch.execute('vim --cmd "set t_RV=" /tmp/conch_e2e_vim3.txt');
			await new Promise((r) => setTimeout(r, 2000));
			await conch.drain();

			// Insert mode → type → ESC → :q!
			conch.press("i");
			await new Promise((r) => setTimeout(r, 200));
			conch.type("E2E test content");
			await new Promise((r) => setTimeout(r, 500));

			const snap = conch.getSnapshot();
			expect(snap.text).toContain("E2E test content");

			conch.write("\x1b");
			conch.write(":q!\r");
			await conch.waitForStable({ durationMs: 500, timeoutMs: 5_000 });

			// Should be back to normal shell
			const afterSnap = conch.getSnapshot();
			expect(afterSnap.meta.isAlternateBuffer).toBe(false);
			execSync("rm -f /tmp/conch_e2e_vim3.txt");
		});
	});

	describe("less", () => {
		it("should render content in alternate buffer", async () => {
			conch = await launch();
			conch.execute("seq 1 200 | less");
			await new Promise((r) => setTimeout(r, 6000));
			await conch.drain();

			const snap = conch.getSnapshot();
			expect(snap.meta.isAlternateBuffer).toBe(true);
			expect(snap.text).toMatch(/\b\d+\b/);

			conch.press("q");
			await conch.waitForStable({ durationMs: 500, timeoutMs: 5_000 });
		}, 15_000);

		it("should support search", async () => {
			conch = await launch();
			conch.execute("seq 1 200 | less");
			await new Promise((r) => setTimeout(r, 6000));
			await conch.drain();

			conch.type("/100");
			conch.press("Enter");
			await new Promise((r) => setTimeout(r, 500));
			await conch.drain();

			expect(conch.getSnapshot().text).toContain("100");

			conch.press("q");
			await conch.waitForStable({ durationMs: 500, timeoutMs: 5_000 });
		}, 15_000);
	});

	describe("nano", () => {
		it.skipIf(!hasCommand("nano"))("should render in alternate buffer", async () => {
			conch = await launch();
			conch.execute("nano /tmp/conch_e2e_nano.txt");
			await new Promise((r) => setTimeout(r, 6000));
			await conch.drain();

			const snap = conch.getSnapshot();
			expect(snap.meta.isAlternateBuffer).toBe(true);

			conch.press("Ctrl+X");
			await conch.waitForStable({ durationMs: 500, timeoutMs: 5_000 });
			execSync("rm -f /tmp/conch_e2e_nano.txt");
		});

		it.skipIf(!hasCommand("nano"))("should accept text input", async () => {
			conch = await launch();
			conch.execute("nano /tmp/conch_e2e_nano2.txt");
			await new Promise((r) => setTimeout(r, 3000));
			await conch.drain();

			conch.type("Nano E2E test");
			await new Promise((r) => setTimeout(r, 500));
			await conch.drain();

			expect(conch.getSnapshot().text).toContain("Nano E2E test");

			// Ctrl+X, then N to not save
			conch.press("Ctrl+X");
			await new Promise((r) => setTimeout(r, 300));
			conch.press("n");
			await conch.waitForStable({ durationMs: 500, timeoutMs: 5_000 });
			execSync("rm -f /tmp/conch_e2e_nano2.txt");
		});
	});

	describe("top", () => {
		it.skipIf(!hasCommand("top"))("should capture batch mode output", async () => {
			conch = await launch();
			conch.execute("top -b -n 1");
			await new Promise((r) => setTimeout(r, 5000));
			await conch.drain();

			const snap = conch.getSnapshot({ range: "all" });
			expect(snap.text).toContain("PID");
		});
	});

	describe("tmux", () => {
		it.skipIf(!hasCommand("tmux"))("should create and attach session", async () => {
			conch = await launch();
			conch.execute(
				"tmux new-session -d -s conch_e2e && tmux attach -t conch_e2e",
			);
			await new Promise((r) => setTimeout(r, 2000));
			await conch.drain();

			const snap = conch.getSnapshot();
			expect(snap.text.trim().length).toBeGreaterThan(0);

			// Run command inside tmux
			conch.execute('echo "TMUX_E2E"');
			await conch.waitForText("TMUX_E2E", { timeoutMs: 3_000 });

			// Cleanup
			conch.execute("exit");
			await conch.waitForSilence({ durationMs: 500, timeoutMs: 3_000 });
			try {
				execSync("tmux kill-session -t conch_e2e 2>/dev/null");
			} catch { /* session may already be dead */ }
		});
	});

	describe("python3", () => {
		it.skipIf(!hasCommand("python3"))("should interact with REPL", async () => {
			conch = await launch();
			conch.execute("python3 -q");
			await new Promise((r) => setTimeout(r, 2000));

			conch.execute('print("PY_E2E")');
			await conch.waitForText("PY_E2E", { timeoutMs: 5_000 });

			conch.execute("2 + 3");
			await conch.waitForText("5", { timeoutMs: 5_000 });

			conch.execute("exit()");
			await conch.waitForSilence({ durationMs: 500, timeoutMs: 5_000 });
		});
	});

	describe("nested shell", () => {
		it("should handle nested bash and return to parent", async () => {
			conch = await Conch.launch({
				backend: { type: "localPty", file: "bash", args: [], env: process.env },
				cols: 80,
				rows: 24,
				timeoutMs: 15_000,
				shellIntegration: { enable: true, strict: false },
			});

			conch.execute("bash");
			await conch.waitForStable({ durationMs: 500, timeoutMs: 5_000 });

			conch.execute('echo "NESTED"');
			await conch.waitForText("NESTED", { timeoutMs: 5_000 });

			conch.execute("exit");
			await conch.waitForStable({ durationMs: 500, timeoutMs: 5_000 });

			const r = await conch.run('echo "PARENT"', { timeoutMs: 5_000 });
			expect(r.outputText).toContain("PARENT");
			expect(r.exitCode).toBe(0);
		});
	});

	describe("Ctrl+C", () => {
		it("should interrupt and recover", async () => {
			conch = await Conch.launch({
				backend: { type: "localPty", file: "bash", args: [], env: process.env },
				cols: 80,
				rows: 24,
				timeoutMs: 15_000,
				shellIntegration: { enable: true, strict: false },
			});

			conch.execute("sleep 100");
			await conch.waitForSilence({ durationMs: 300, timeoutMs: 3_000 });

			conch.press("Ctrl+C");
			await conch.waitForStable({ durationMs: 500, timeoutMs: 5_000 });

			const r = await conch.run('echo "AFTER"', { timeoutMs: 5_000 });
			expect(r.outputText).toContain("AFTER");
			expect(r.exitCode).toBe(0);
		});
	});
});
