/**
 * E2E tests for PowerShell backend.
 * Requires pwsh (PowerShell Core) to be installed.
 *
 * Skip condition: pwsh not available (Linux without PowerShell, etc.)
 * Run with: pnpm test:e2e
 */
import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { Conch } from "../../src/conch";

function pwshAvailable(): boolean {
	try {
		execSync("pwsh -v", { stdio: "pipe", timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

const hasPwsh = pwshAvailable();
const describePwsh = hasPwsh ? describe : describe.skip;

let conch: Conch | undefined;

afterEach(() => {
	conch?.dispose();
	conch = undefined;
});

describePwsh("PowerShell E2E", () => {
	it("should launch and capture output", async () => {
		conch = await Conch.launch({
			backend: {
				type: "localPty",
				file: "pwsh",
				args: ["-NoProfile"],
				env: process.env,
			},
			cols: 80,
			rows: 24,
			timeoutMs: 20_000,
			shellIntegration: { enable: true, shell: "pwsh", strict: false },
		});

		const r = await conch.run('Write-Output "hello pwsh"', {
			timeoutMs: 10_000,
		});

		expect(r.outputText).toContain("hello pwsh");
		expect(r.meta.method).toBe("osc133");
		expect(r.exitCode).toBeDefined();
	});

	it("should capture exit code 0", async () => {
		conch = await Conch.launch({
			backend: {
				type: "localPty",
				file: "pwsh",
				args: ["-NoProfile"],
				env: process.env,
			},
			cols: 80,
			rows: 24,
			timeoutMs: 20_000,
			shellIntegration: { enable: true, shell: "pwsh", strict: false },
		});

		const r = await conch.run('Write-Output "ok"', { timeoutMs: 10_000 });
		expect(r.exitCode).toBe(0);
	});

	it("should auto-detect pwsh shell from processName", async () => {
		conch = await Conch.launch({
			backend: {
				type: "localPty",
				file: "pwsh",
				args: ["-NoProfile"],
				env: process.env,
			},
			cols: 80,
			rows: 24,
			timeoutMs: 20_000,
			// shell not specified — should auto-detect from processName
			shellIntegration: { enable: true, strict: false },
		});

		const r = await conch.run('Write-Output "auto"', { timeoutMs: 10_000 });
		expect(r.outputText).toContain("auto");
		expect(r.meta.method).toBe("osc133");
	});

	it("should handle rapid sequential commands", async () => {
		conch = await Conch.launch({
			backend: {
				type: "localPty",
				file: "pwsh",
				args: ["-NoProfile"],
				env: process.env,
			},
			cols: 80,
			rows: 24,
			timeoutMs: 30_000,
			shellIntegration: { enable: true, shell: "pwsh", strict: false },
		});

		for (let i = 1; i <= 3; i++) {
			const r = await conch.run(`Write-Output "CMD_${i}"`, {
				timeoutMs: 10_000,
			});
			expect(r.outputText).toContain(`CMD_${i}`);
		}
	});
});
