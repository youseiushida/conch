import type { IBufferLine } from "@xterm/headless";

// 共通のイベントリスナー解除用インターフェース
export interface IDisposable {
	dispose(): void;
}

// ターミナルバックエンド（pty, docker, ssh等）の抽象インターフェース
export interface ITerminalBackend extends IDisposable {
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
