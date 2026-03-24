import type { Osc52Event } from "./types";

/**
 * OSC 52 のペイロード文字列をパースする。
 * xterm の registerOscHandler(52, handler) のコールバックに渡される data を受け取る。
 *
 * 形式: `selection;data`
 * - selection: クリップボード選択 ("c"=clipboard, "p"=primary, "s"=select, "0"-"9"=cut buffers)
 * - data:
 *   - "?" → クエリ (クリップボード内容を要求)
 *   - base64 文字列 → セット (クリップボードに書き込み)
 *   - 空 → クリア
 *
 * @param data - OSC 52 のペイロード (e.g. "c;SGVsbG8=", "c;?", "c;")
 * @returns パース結果。不正な形式は null。
 */
export function parseOsc52(data: string): Osc52Event | null {
	const semicolonIdx = data.indexOf(";");

	if (semicolonIdx === -1) {
		// selection のみ、data なし → クリア
		return { type: "clear", selection: data || "s" };
	}

	const selection = data.substring(0, semicolonIdx) || "s";
	const payload = data.substring(semicolonIdx + 1);

	if (payload === "?") {
		return { type: "query", selection };
	}

	if (!payload) {
		return { type: "clear", selection };
	}

	// Base64 デコード
	try {
		const decoded = Buffer.from(payload, "base64").toString("utf-8");
		return { type: "set", selection, data: decoded };
	} catch {
		return null;
	}
}
