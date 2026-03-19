/**
 * E2E tests for SSH backend.
 * Requires a reachable SSH server (default: localhost:22).
 *
 * Skip condition: set SKIP_SSH=1 or if localhost SSH is not available.
 *
 * Authentication (in priority order):
 *   1. SSH_TEST_KEY env var → path to private key file
 *   2. SSH_TEST_PASSWORD env var → password
 *   3. SSH_AUTH_SOCK (ssh-agent) → agent forwarding
 *
 * SSH_TEST_USER env var → username (default: $USER)
 * SSH_TEST_HOST env var → host (default: localhost)
 * SSH_TEST_PORT env var → port (default: 22)
 *
 * Run with: pnpm test:e2e
 */
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Conch } from "../../src/conch";
import { SshPty } from "../../src/backend/SshPty";

const SSH_HOST = process.env.SSH_TEST_HOST ?? "localhost";
const SSH_PORT = Number(process.env.SSH_TEST_PORT ?? "22");
const SSH_USER = process.env.SSH_TEST_USER ?? process.env.USER ?? "root";

function getAuthOptions(): { password?: string; privateKey?: string | Buffer; agent?: string } {
	if (process.env.SSH_TEST_KEY) {
		try {
			return { privateKey: readFileSync(process.env.SSH_TEST_KEY) };
		} catch { /* fall through */ }
	}
	if (process.env.SSH_TEST_PASSWORD) {
		return { password: process.env.SSH_TEST_PASSWORD };
	}
	if (process.env.SSH_AUTH_SOCK) {
		return { agent: process.env.SSH_AUTH_SOCK };
	}
	return {};
}

function sshAvailable(): boolean {
	if (process.env.SKIP_SSH === "1") return false;
	const auth = getAuthOptions();
	if (!auth.password && !auth.privateKey && !auth.agent) return false;
	try {
		const keyFlag = process.env.SSH_TEST_KEY
			? `-i "${process.env.SSH_TEST_KEY}"`
			: "";
		// stdio:"pipe" captures stderr — no need for 2>/dev/null (which also
		// breaks on Windows cmd.exe where /dev/null is not a valid path).
		execSync(
			`ssh -o BatchMode=yes -o ConnectTimeout=2 -o StrictHostKeyChecking=no ${keyFlag} -p ${SSH_PORT} ${SSH_USER}@${SSH_HOST} exit`,
			{ stdio: "pipe", timeout: 5000 },
		);
		return true;
	} catch {
		return false;
	}
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

function launchSsh(opts?: { shellIntegration?: boolean }) {
	const auth = getAuthOptions();
	return Conch.launch({
		backend: {
			type: "ssh" as const,
			host: SSH_HOST,
			port: SSH_PORT,
			username: SSH_USER,
			...auth,
		},
		cols: 80,
		rows: 24,
		timeoutMs: 20_000,
		shellIntegration: opts?.shellIntegration
			? { enable: true, strict: false }
			: undefined,
	});
}

describeSsh("SSH E2E", () => {
	it("should launch and show shell prompt", async () => {
		conch = await launchSsh();
		await conch.waitForStable({ durationMs: 500, timeoutMs: 10_000 });

		const snap = conch.getSnapshot();
		expect(snap.text.trim().length).toBeGreaterThan(0);
	});

	it("should execute commands and capture output", async () => {
		conch = await launchSsh();

		conch.execute('echo "SSH_HELLO"');
		await conch.waitForText("SSH_HELLO", { timeoutMs: 10_000 });

		expect(conch.getSnapshot().text).toContain("SSH_HELLO");
	});

	it("should run() with shell integration", async () => {
		conch = await launchSsh({ shellIntegration: true });

		const r = await conch.run('echo "ssh run test"', { timeoutMs: 10_000 });

		expect(r.outputText).toContain("ssh run test");
		expect(r.exitCode).toBe(0);
		expect(r.meta.method).toBe("osc133");
	});

	it("should resize", async () => {
		conch = await launchSsh({ shellIntegration: true });

		const r1 = await conch.run('echo "$(tput cols)x$(tput lines)"', {
			timeoutMs: 10_000,
		});
		expect(r1.outputText).toContain("80x24");

		conch.resize(120, 40);
		await conch.waitForSilence({ durationMs: 500, timeoutMs: 5_000 });

		const r2 = await conch.run('echo "$(tput cols)x$(tput lines)"', {
			timeoutMs: 10_000,
		});
		expect(r2.outputText).toContain("120x40");
	});

	it("should work with low-level SshPty directly", async () => {
		const auth = getAuthOptions();
		const pty = new SshPty({
			host: SSH_HOST,
			port: SSH_PORT,
			username: SSH_USER,
			...auth,
			cols: 80,
			rows: 24,
		});

		const data: string[] = [];
		pty.onData((d) => data.push(d));

		await pty.spawn();
		expect(pty.id).toContain("ssh-");
		expect(pty.processName).toContain(SSH_USER);

		pty.write("echo SSH_DIRECT\r");
		await new Promise((r) => setTimeout(r, 2000));

		expect(data.join("")).toContain("SSH_DIRECT");

		await pty.disposeAsync?.();
	});
});
