/**
 * E2E tests for Local PTY backend.
 * These tests spawn real bash processes and verify end-to-end behavior.
 *
 * Run with: pnpm test:e2e
 */
import { describe, it, expect, afterEach } from "vitest";
import { Conch } from "../../src/conch";

// Track instances for cleanup
let conch: Conch | undefined;

afterEach(() => {
	conch?.dispose();
	conch = undefined;
});

async function launch(opts?: { shellIntegration?: boolean; cols?: number; rows?: number }) {
	const c = await Conch.launch({
		backend: { type: "localPty", file: "bash", args: [], env: process.env },
		cols: opts?.cols ?? 80,
		rows: opts?.rows ?? 24,
		timeoutMs: 15_000,
		shellIntegration: opts?.shellIntegration !== false
			? { enable: true, strict: false }
			: undefined,
	});
	// Extra warm-up: the flush run(":") in launch() handles most residuals,
	// but one additional run ensures the C-gate pipeline is fully stable.
	if (opts?.shellIntegration !== false) {
		await c.run("true", { timeoutMs: 5_000 });
	}
	return c;
}

describe("Local PTY E2E", () => {
	describe("run() output", () => {
		it("should capture simple echo output", async () => {
			conch = await launch();
			const r = await conch.run('echo "hello world"', { timeoutMs: 5_000 });

			expect(r.outputText).toContain("hello world");
			expect(r.exitCode).toBe(0);
			expect(r.meta.method).toBe("osc133");
		});

		it("should not leak shell integration internals into outputText", async () => {
			conch = await launch();
			const r = await conch.run('echo "clean"', { timeoutMs: 5_000 });

			expect(r.outputText).not.toContain("eval");
			expect(r.outputText).not.toContain("base64");
			expect(r.outputText).not.toContain("__conch");
			expect(r.outputText).not.toContain("CONCH_OK");
		});

		it("should handle multi-line output", async () => {
			conch = await launch();
			await conch.run("true", { timeoutMs: 5_000 });
			const r = await conch.run('printf "a\\nb\\nc\\n"', { timeoutMs: 5_000 });
			const lines = r.outputText.split(/\r?\n/).filter((l) => /^[abc]$/.test(l));

			expect(lines).toHaveLength(3);
		});

		it("should handle large output (100 lines)", async () => {
			conch = await launch();
			const r = await conch.run(
				'for i in $(seq 1 100); do echo "L$i"; done',
				{ timeoutMs: 10_000 },
			);
			const lines = r.outputText
				.split(/\r?\n/)
				.filter((l) => /^L\d+$/.test(l));

			expect(lines).toHaveLength(100);
		});

		it("should handle large output (1000 lines)", async () => {
			conch = await launch();
			const r = await conch.run("seq 1 1000", { timeoutMs: 10_000 });
			const lines = r.outputText
				.split(/\r?\n/)
				.filter((l) => /^\d+$/.test(l));

			expect(lines).toHaveLength(1000);
		});

		it("should strip ANSI escape sequences from outputText", async () => {
			conch = await launch();
			const r = await conch.run('printf "\\033[31mRED\\033[0m"', {
				timeoutMs: 5_000,
			});

			expect(r.outputText).toContain("RED");
			expect(r.outputText).not.toContain("\x1b");
		});

		it("should handle unicode output", async () => {
			conch = await launch();
			const r = await conch.run('echo "日本語テスト"', { timeoutMs: 5_000 });

			expect(r.outputText).toContain("日本語テスト");
		});

		it("should capture empty output for no-output commands", async () => {
			conch = await launch();
			const r = await conch.run("true", { timeoutMs: 5_000 });

			expect(r.outputText.trim()).toBe("");
			expect(r.exitCode).toBe(0);
		});
	});

	describe("exit codes", () => {
		it("should capture exit code 0", async () => {
			conch = await launch();
			expect((await conch.run("true", { timeoutMs: 5_000 })).exitCode).toBe(0);
		});

		it("should capture exit code 1", async () => {
			conch = await launch();
			expect((await conch.run("false", { timeoutMs: 5_000 })).exitCode).toBe(1);
		});

		it.each([2, 42, 127, 255])("should capture exit code %i", async (code) => {
			conch = await launch();
			const r = await conch.run(`bash -c 'exit ${code}'`, { timeoutMs: 5_000 });

			expect(r.exitCode).toBe(code);
		});

		it("should alternate exit codes correctly", async () => {
			conch = await launch();
			for (let i = 0; i < 5; i++) {
				const rOk = await conch.run("true", { timeoutMs: 5_000 });
				const rFail = await conch.run("false", { timeoutMs: 5_000 });
				expect(rOk.exitCode).toBe(0);
				expect(rFail.exitCode).toBe(1);
			}
		});
	});

	describe("rapid sequential", () => {
		it("should handle 20 rapid sequential runs", async () => {
			conch = await launch();
			for (let i = 1; i <= 20; i++) {
				const r = await conch.run(`echo "R${i}"`, { timeoutMs: 5_000 });
				expect(r.outputText).toContain(`R${i}`);
				expect(r.exitCode).toBe(0);
			}
		});

		it("should serialize concurrent run() calls", async () => {
			conch = await launch();
			const promises = Array.from({ length: 5 }, (_, i) =>
				conch!.run(`echo "C${i + 1}"`, { timeoutMs: 10_000 }),
			);
			const results = await Promise.all(promises);

			for (let i = 0; i < 5; i++) {
				expect(results[i].outputText).toContain(`C${i + 1}`);
				expect(results[i].exitCode).toBe(0);
			}
		});
	});

	describe("complex commands", () => {
		it("should handle pipes", async () => {
			conch = await launch();
			const r = await conch.run('echo "hello" | tr a-z A-Z', {
				timeoutMs: 5_000,
			});
			expect(r.outputText).toContain("HELLO");
		});

		it("should handle multi-command with semicolons", async () => {
			conch = await launch();
			const r = await conch.run('echo "a"; echo "b"; echo "c"', {
				timeoutMs: 5_000,
			});
			expect(r.outputText).toContain("a");
			expect(r.outputText).toContain("b");
			expect(r.outputText).toContain("c");
		});

		it("should handle heredoc", async () => {
			conch = await launch();
			const r = await conch.run("cat <<EOF\nheredoc test\nEOF", {
				timeoutMs: 5_000,
			});
			expect(r.outputText).toContain("heredoc test");
		});

		it("should handle subshell", async () => {
			conch = await launch();
			const r = await conch.run('(echo "s1"; echo "s2")', {
				timeoutMs: 5_000,
			});
			expect(r.outputText).toContain("s1");
			expect(r.outputText).toContain("s2");
		});

		it("should handle redirect + cat", async () => {
			conch = await launch();
			const r = await conch.run(
				'echo "redirect_test" > /tmp/conch_e2e_redir && cat /tmp/conch_e2e_redir && rm /tmp/conch_e2e_redir',
				{ timeoutMs: 5_000 },
			);
			expect(r.outputText).toContain("redirect_test");
		});

		it("should handle slow streaming output", async () => {
			conch = await launch();
			const r = await conch.run(
				'for i in 1 2 3 4 5; do echo "S$i"; sleep 0.1; done',
				{ timeoutMs: 10_000 },
			);
			const lines = r.outputText
				.split(/\r?\n/)
				.filter((l) => /^S\d$/.test(l));
			expect(lines).toHaveLength(5);
		});
	});

	describe("environment & resize", () => {
		it("should pass environment variables", async () => {
			conch = await Conch.launch({
				backend: {
					type: "localPty",
					file: "bash",
					args: [],
					env: { ...process.env, CONCH_E2E: "test_value" },
				},
				cols: 80,
				rows: 24,
				timeoutMs: 15_000,
				shellIntegration: { enable: true, strict: false },
			});
			const r = await conch.run('echo "$CONCH_E2E"', { timeoutMs: 5_000 });
			expect(r.outputText).toContain("test_value");
		});

		it("should resize and reflect new dimensions", async () => {
			conch = await launch();
			await conch.run("true", { timeoutMs: 5_000 });
			const r1 = await conch.run('echo "$(tput cols)x$(tput lines)"', {
				timeoutMs: 5_000,
			});
			expect(r1.outputText).toContain("80x24");

			conch.resize(120, 40);
			await conch.waitForSilence({ durationMs: 300, timeoutMs: 3_000 });

			const r2 = await conch.run('echo "$(tput cols)x$(tput lines)"', {
				timeoutMs: 5_000,
			});
			expect(r2.outputText).toContain("120x40");
		});
	});

	describe("timeout & strict mode", () => {
		it("should resolve with undefined exit on non-strict timeout", async () => {
			conch = await launch();
			const r = await conch.run("sleep 10", {
				timeoutMs: 1_000,
				strict: false,
			});
			expect(r.exitCode).toBeUndefined();
			expect(r.meta.method).toBe("fallback");

			conch.press("Ctrl+C");
			await conch.waitForSilence({ durationMs: 500, timeoutMs: 3_000 });
		});

		it("should reject on strict timeout", async () => {
			conch = await launch();
			await expect(
				conch.run("sleep 10", { timeoutMs: 1_000, strict: true }),
			).rejects.toThrow("timed out");

			conch.press("Ctrl+C");
			await conch.waitForSilence({ durationMs: 500, timeoutMs: 3_000 });
		});

		it("should recover after timeout", async () => {
			conch = await launch();
			await conch.run("sleep 10", { timeoutMs: 1_000, strict: false });
			conch.press("Ctrl+C");
			await conch.waitForSilence({ durationMs: 500, timeoutMs: 3_000 });

			const r = await conch.run('echo "recovered"', { timeoutMs: 5_000 });
			expect(r.outputText).toContain("recovered");
			expect(r.exitCode).toBe(0);
		});
	});

	describe("stderr", () => {
		it("should capture stderr in TTY mode", async () => {
			conch = await launch();
			const r = await conch.run('echo "out"; echo "err" >&2', {
				timeoutMs: 5_000,
			});
			expect(r.outputText).toContain("out");
			expect(r.outputText).toContain("err");
		});
	});

	describe("multiple instances", () => {
		it("should isolate sessions", async () => {
			const c1 = await launch();
			const c2 = await launch();

			try {
				const [r1, r2] = await Promise.all([
					c1.run('echo "I1"', { timeoutMs: 5_000 }),
					c2.run('echo "I2"', { timeoutMs: 5_000 }),
				]);

				expect(r1.outputText).toContain("I1");
				expect(r2.outputText).toContain("I2");
				expect(r1.outputText).not.toContain("I2");
				expect(r2.outputText).not.toContain("I1");
			} finally {
				c1.dispose();
				c2.dispose();
			}
		});
	});

	describe("dispose", () => {
		it("should throw on all methods after dispose", async () => {
			conch = await launch();
			conch.dispose();

			expect(() => conch!.execute("x")).toThrow("disposed");
			expect(() => conch!.write("x")).toThrow("disposed");
			expect(() => conch!.press("Enter")).toThrow("disposed");
			expect(() => conch!.getSnapshot()).toThrow("disposed");

			conch = undefined; // prevent afterEach double dispose
		});

		it("should not leak processes", async () => {
			const { execSync } = await import("node:child_process");
			const countBash = () =>
				parseInt(
					execSync("ps aux | grep '[b]ash' | wc -l", {
						encoding: "utf8",
					}).trim(),
					10,
				);

			const before = countBash();

			for (let i = 0; i < 3; i++) {
				const c = await launch();
				await c.run(`echo "leak_${i}"`, { timeoutMs: 5_000 });
				c.dispose();
			}

			await new Promise((r) => setTimeout(r, 1000));
			const after = countBash();
			expect(after).toBeLessThanOrEqual(before);
		});
	});
});
