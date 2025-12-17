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
	return requiredFns.every((k) => typeof o[k] === "function");
}

export function createBackend(
	backend: BackendConfig | ITerminalBackend,
	options: { cols?: number; rows?: number },
): ITerminalBackend {
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

	// Exhaustiveness guard for future backend types
	throw new Error(`Unsupported backend config: ${config.type}`);
}
