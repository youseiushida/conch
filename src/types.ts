import type { IBufferLine } from "@xterm/headless";

// 共通のイベントリスナー解除用インターフェース
export interface IDisposable {
	dispose(): void;
}

// ターミナルバックエンド（pty, docker, ssh等）の抽象インターフェース
export interface ITerminalBackend extends IDisposable {
	// Lifecycle
	spawn(): Promise<void>;

	// 基本操作
	write(data: string): void;
	resize(cols: number, rows: number): void;

	// イベント
	onData(listener: (data: string) => void): IDisposable;
	onExit(listener: (code: number, signal?: number) => void): IDisposable;

	// メタデータ
	readonly id: string | number; // PID or ContainerID
	readonly processName: string; // "bash", "node" etc.
}

// --- Snapshot Engine Types ---

export type SnapshotRange = "viewport" | "all";

export interface FormatterContext {
	y: number; // compatibility (same as bufferY)
	bufferY: number; // Absolute row index in buffer
	snapshotY: number; // Relative row index in snapshot (0-based)
}

export type SnapshotFormatter = (
	line: IBufferLine,
	ctx: FormatterContext,
) => string;

export interface SnapshotOptions {
	range?: SnapshotRange;
	formatter?: SnapshotFormatter;
}

export interface ISnapshot {
	text: string;
	cursor: { x: number; y: number }; // Absolute (Buffer)
	cursorSnapshot: { x: number; y: number }; // Relative (Snapshot)
	meta: {
		isAlternateBuffer: boolean;
		viewportY: number;
		rows: number;
		cols: number;
		startRow: number;
		endRow: number;
		rangeUsed: SnapshotRange;
	};
}

// --- Shell Integration Types (OSC 133) ---

export enum ShellIntegrationType {
	PromptStart = "A",
	CommandStart = "B",
	CommandExecuted = "C",
	CommandFinished = "D",
}

export interface IShellIntegrationEvent {
	type: ShellIntegrationType;
	params: string[];
}

// --- High Level API Types (Conch) ---

export type BackendConfig = {
	type: "localPty";
	file?: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
};
// | { type: 'ssh'; ... }
// | { type: 'docker'; ... }

export interface ConchLaunchOptions {
	cols?: number;
	rows?: number;
	backend: BackendConfig | ITerminalBackend;
	shellIntegration?: {
		enable?: boolean;
		shell?: "bash" | "pwsh";
		/** If true, throw when enable fails (default: false) */
		strict?: boolean;
	};
	/** Default timeout for wait methods in milliseconds (default: 10000) */
	timeoutMs?: number;
	/** @deprecated Use timeoutMs */
	timeout?: number;
}

// --- High Level API: Action Result (Conch) ---

export type SnapshotMode = "none" | SnapshotRange;

export type ConchWait =
	| { kind: "none" }
	| { kind: "drain"; budgetMs?: number }
	| { kind: "change"; timeoutMs?: number; intervalMs?: number }
	| {
			kind: "stable";
			durationMs?: number;
			timeoutMs?: number;
			intervalMs?: number;
	  }
	| { kind: "silence"; durationMs?: number; timeoutMs?: number }
	| {
			kind: "text";
			pattern: string | RegExp;
			timeoutMs?: number;
			intervalMs?: number;
	  };

export interface ConchActionOptions {
	/**
	 * How to wait after the action.
	 *
	 * - press: default {kind:'change'}
	 * - type/execute: default {kind:'drain'}
	 */
	wait?: ConchWait;
	/** Snapshot range to capture after action (default: 'viewport') */
	snapshot?: SnapshotRange;
}

export interface ActionResult {
	snapshot: ISnapshot;
	durationMs: number;
	meta: {
		action: "press" | "type" | "execute";
		waited: ConchWait["kind"];
		snapshotRange: SnapshotRange;
	};
}

export interface RunOptions {
	/** Timeout in milliseconds */
	timeoutMs?: number;
	/** @deprecated Use timeoutMs */
	timeout?: number;
	/**
	 * If true, require OSC 133 D (exit code).
	 * - When D is not observed before timeout, reject.\n
	 * - When false (default), return exitCode: undefined on timeout.\n
	 */
	strict?: boolean;
	/**
	 * Snapshot to include after run completes.
	 * - 'viewport' (default): the current visible screen
	 * - 'all': entire buffer including scrollback
	 * - 'none': omit snapshots for performance
	 */
	snapshot?: SnapshotMode;
}

export interface RunResult {
	exitCode?: number;
	outputText: string;
	/**
	 * Primary snapshot for this run (equals snapshotAfter when enabled).
	 * Omitted when RunOptions.snapshot is 'none'.
	 */
	snapshot?: ISnapshot;
	/**
	 * Snapshot captured after run completes (viewport by default).
	 * Useful for LLM loops (run -> observe screen -> decide next action).
	 *
	 * @deprecated Use snapshot (kept for backward compatibility)
	 */
	snapshotAfter?: ISnapshot;
	durationMs: number;
	meta: {
		action?: "run";
		waited?: "osc133" | "fallback";
		snapshotMode?: SnapshotMode;
		method: "osc133" | "fallback";
		shellIntegrationUsed: boolean;
	};
	/** Optional raw output (ANSI may be included). Reserved for future refinement. */
	outputRaw?: string;
}
