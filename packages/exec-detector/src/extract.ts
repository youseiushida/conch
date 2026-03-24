/**
 * 生のターミナル出力から ANSI/OSC エスケープシーケンスを除去する。
 *
 * 対応シーケンス:
 * - DCS: ESC P ... (BEL | ST)  — tmux パススルー、sixel 等
 * - APC: ESC _ ... (BEL | ST)  — Kitty グラフィクス等
 * - OSC: ESC ] ... (BEL | ST)
 * - CSI: ESC [ params intermediate final
 * - その他 2 文字 ESC シーケンス (ESC ( , ESC ) 等)
 */
export function stripAnsiAndOsc(input: string): string {
	// DCS: ESC P ... (BEL | ST)
	const withoutDcs = input.replace(/\x1bP[\s\S]*?(?:\x07|\x1b\\)/g, "");
	// APC: ESC _ ... (BEL | ST)
	const withoutApc = withoutDcs.replace(/\x1b_[\s\S]*?(?:\x07|\x1b\\)/g, "");
	// OSC: ESC ] ... (BEL | ST)
	const withoutOsc = withoutApc.replace(
		/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g,
		"",
	);
	// CSI: ESC [ ... command
	const withoutCsi = withoutOsc.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
	// Other 2-char ESC sequences
	return withoutCsi.replace(/\x1b[@-Z\\-_]/g, "");
}

/**
 * OSC 133 C/D 境界を使ってコマンド出力を抽出する。
 *
 * C (CommandExecuted) マーカーと D (CommandFinished) マーカーの間の
 * テキストがコマンド出力となる。複数の C-D ペアがある場合は最後のペアを使用。
 *
 * shellIntegrationUsed が false または C-D 境界が見つからない場合は
 * 全体を ANSI ストリップして返すフォールバック。
 *
 * @param raw - 生のターミナル出力（ANSI/OSC 含む）
 * @param shellIntegrationUsed - OSC 133 が使われたか
 * @returns クリーンなコマンド出力
 */
export function extractCommandOutput(
	raw: string,
	shellIntegrationUsed: boolean,
): string {
	if (shellIntegrationUsed) {
		const cRe = /\x1b\]133;C(?:\x07|\x1b\\)/g;
		const dRe = /\x1b\]133;D;?[^\x07\x1b]*(?:\x07|\x1b\\)/g;

		let lastCEnd = -1;
		let lastDStart = -1;
		let m: RegExpExecArray | null;

		while ((m = cRe.exec(raw)) !== null) {
			lastCEnd = m.index + m[0].length;
		}
		while ((m = dRe.exec(raw)) !== null) {
			lastDStart = m.index;
		}

		// C-D boundary extraction (deterministic).
		if (lastCEnd >= 0 && lastDStart >= 0 && lastCEnd <= lastDStart) {
			return stripAnsiAndOsc(raw.slice(lastCEnd, lastDStart));
		}
	}

	// No markers: strip ANSI/OSC and return as-is.
	return stripAnsiAndOsc(raw);
}
