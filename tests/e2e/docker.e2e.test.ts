/**
 * E2E tests for Docker backend.
 * Requires a running Docker daemon with alpine:latest and bash:latest pulled.
 *
 * Skip condition: set SKIP_DOCKER=1 or if docker is not available.
 * Run with: pnpm test:e2e
 */
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { Conch } from "../../src/conch";
import { DockerPty } from "../../src/backend/DockerPty";

function dockerAvailable(): boolean {
	if (process.env.SKIP_DOCKER === "1") return false;
	try {
		execSync("docker info", { stdio: "pipe", timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

const hasDocker = dockerAvailable();
const describeDocker = hasDocker ? describe : describe.skip;

let conch: Conch | undefined;

afterEach(async () => {
	if (conch) {
		const backend = conch.backend;
		conch.dispose();
		if (backend.disposeAsync) await backend.disposeAsync();
		conch = undefined;
	}
});

describeDocker("Docker E2E", () => {
	beforeAll(() => {
		// Ensure images are pulled
		try {
			execSync("docker image inspect alpine:latest", { stdio: "pipe" });
		} catch {
			execSync("docker pull alpine:latest", { stdio: "inherit" });
		}
		try {
			execSync("docker image inspect bash:latest", { stdio: "pipe" });
		} catch {
			execSync("docker pull bash:latest", { stdio: "inherit" });
		}
	}, 60_000);

	describe("basic launch", () => {
		it("should launch and show shell prompt", async () => {
			conch = await Conch.launch({
				backend: { type: "docker", image: "alpine:latest", autoRemove: true },
				cols: 80,
				rows: 24,
				timeoutMs: 15_000,
			});

			await conch.waitForStable({ durationMs: 500, timeoutMs: 5_000 });
			const snap = conch.getSnapshot();
			expect(snap.text).toContain("#"); // root prompt
		});

		it("should execute commands and capture output", async () => {
			conch = await Conch.launch({
				backend: { type: "docker", image: "alpine:latest", autoRemove: true },
				cols: 80,
				rows: 24,
				timeoutMs: 15_000,
			});

			conch.execute('echo "DOCKER_HELLO"');
			await conch.waitForText("DOCKER_HELLO", { timeoutMs: 5_000 });

			const snap = conch.getSnapshot();
			expect(snap.text).toContain("DOCKER_HELLO");
		});
	});

	describe("run() with shell integration", () => {
		it("should capture output and exit code with bash image", async () => {
			conch = await Conch.launch({
				backend: {
					type: "docker",
					image: "bash:latest",
					cmd: ["bash"],
					autoRemove: true,
				},
				cols: 80,
				rows: 24,
				timeoutMs: 20_000,
				shellIntegration: { enable: true, strict: false },
			});

			const r = await conch.run('echo "docker bash"', { timeoutMs: 10_000 });
			expect(r.exitCode).toBe(0);
			expect(r.meta.method).toBe("osc133");
			expect(r.outputText).toContain("docker bash");
		});

		it("should capture non-zero exit code", async () => {
			conch = await Conch.launch({
				backend: {
					type: "docker",
					image: "bash:latest",
					cmd: ["bash"],
					autoRemove: true,
				},
				cols: 80,
				rows: 24,
				timeoutMs: 20_000,
				shellIntegration: { enable: true, strict: false },
			});

			const r = await conch.run("false", { timeoutMs: 10_000 });
			expect(r.exitCode).toBe(1);
		});
	});

	describe("environment & config", () => {
		it("should pass environment variables", async () => {
			conch = await Conch.launch({
				backend: {
					type: "docker",
					image: "alpine:latest",
					env: { MY_VAR: "docker_val" },
					autoRemove: true,
				},
				cols: 80,
				rows: 24,
				timeoutMs: 15_000,
			});

			await conch.waitForStable({ durationMs: 500, timeoutMs: 5_000 });
			conch.execute('echo "VAR=$MY_VAR"');
			await conch.waitForText("docker_val", { timeoutMs: 5_000 });
		});

		it("should resize", async () => {
			conch = await Conch.launch({
				backend: { type: "docker", image: "alpine:latest", autoRemove: true },
				cols: 80,
				rows: 24,
				timeoutMs: 15_000,
			});

			await conch.waitForStable({ durationMs: 500, timeoutMs: 5_000 });
			conch.resize(120, 40);
			await conch.waitForSilence({ durationMs: 500, timeoutMs: 3_000 });

			const snap = conch.getSnapshot();
			expect(snap.meta.cols).toBe(120);
			expect(snap.meta.rows).toBe(40);
		});
	});

	describe("cleanup", () => {
		it("should remove container after dispose (autoRemove)", async () => {
			const name = `conch_e2e_cleanup_${Date.now()}`;
			conch = await Conch.launch({
				backend: {
					type: "docker",
					image: "alpine:latest",
					name,
					autoRemove: true,
				},
				cols: 80,
				rows: 24,
				timeoutMs: 15_000,
			});

			conch.dispose();
			if (conch.backend.disposeAsync) await conch.backend.disposeAsync();
			await new Promise((r) => setTimeout(r, 2000));

			const out = execSync(
				`docker ps -a --filter name=${name} --format '{{.ID}}'`,
				{ encoding: "utf8" },
			).trim();

			expect(out).toBe("");
			conch = undefined;
		});
	});

	describe("DockerPty low-level", () => {
		it("should receive data and handle dispose", async () => {
			const pty = new DockerPty({
				image: "alpine:latest",
				cmd: ["/bin/sh"],
				autoRemove: true,
				cols: 80,
				rows: 24,
			});

			const data: string[] = [];
			pty.onData((d) => data.push(d));

			await pty.spawn();
			expect(pty.id).toBeTruthy();

			pty.write("echo DIRECT\r");
			await new Promise((r) => setTimeout(r, 1000));
			expect(data.join("")).toContain("DIRECT");

			await pty.disposeAsync?.();
		});
	});
});
