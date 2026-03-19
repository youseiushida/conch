import { LocalPty } from "./backend/LocalPty";
import type { BackendConfig, ITerminalBackend } from "./types";

function isTerminalBackend(x: unknown): x is ITerminalBackend {
	if (typeof x !== "object" || x === null) return false;
	const o = x as Record<string, unknown>;
	const requiredFns = [
		"spawn",
		"write",
		"resize",
		"onData",
		"onExit",
		"dispose",
	] as const;
	if (!requiredFns.every((k) => typeof o[k] === "function")) return false;

	// Guard required metadata too (used by ConchSession.enableShellIntegration()).
	const id = (o as { id?: unknown }).id;
	const processName = (o as { processName?: unknown }).processName;
	const hasId = typeof id === "string" || typeof id === "number";
	return hasId && typeof processName === "string";
}

export async function createBackend(
	backend: BackendConfig | ITerminalBackend,
	options: { cols?: number; rows?: number },
): Promise<ITerminalBackend> {
	// If an instance is provided, use as-is (duck typing)
	if (isTerminalBackend(backend)) return backend;

	const config = backend as BackendConfig;

	if (config.type === "localPty") {
		const isWin = process.platform === "win32";
		const file = config.file ?? (isWin ? "powershell.exe" : "bash");
		const args = config.args ?? [];
		return new LocalPty(file, args, {
			cols: options.cols,
			rows: options.rows,
			cwd: config.cwd,
			env: config.env,
		});
	}

	if (config.type === "docker") {
		const { DockerPty } = await import("./backend/DockerPty");
		return new DockerPty({
			image: config.image,
			cmd: config.cmd,
			workdir: config.workdir,
			env: config.env,
			name: config.name,
			user: config.user,
			autoRemove: config.autoRemove,
			docker: config.docker,
			cols: options.cols,
			rows: options.rows,
		});
	}

	if (config.type === "ssh") {
		const { SshPty } = await import("./backend/SshPty");
		return new SshPty({
			host: config.host,
			port: config.port,
			username: config.username,
			password: config.password,
			privateKey: config.privateKey,
			passphrase: config.passphrase,
			agent: config.agent,
			term: config.term,
			readyTimeout: config.readyTimeout,
			keepaliveInterval: config.keepaliveInterval,
			keepaliveCountMax: config.keepaliveCountMax,
			hostVerifier: config.hostVerifier,
			connectOptions: config.connectOptions,
			cols: options.cols,
			rows: options.rows,
		});
	}

	// Exhaustiveness guard for future backend types
	const _exhaustive: never = config;
	throw new Error(`Unsupported backend config: ${String((_exhaustive as BackendConfig).type)}`);
}
