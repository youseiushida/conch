import type { Osc8Event } from "./types";

/**
 * OSC 8 のペイロード文字列をパースする。
 * xterm の registerOscHandler(8, handler) のコールバックに渡される data を受け取る。
 *
 * 形式: `params;URI`
 * - params: コロン区切りの key=value ペア (e.g. "id=xyz123:foo=bar")
 * - URI: ハイパーリンクの URL
 *
 * リンク終了: `ESC ] 8 ; ; ST` → params="", URI="" → { type: "end" }
 *
 * 仕様: https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda
 *
 * @param data - OSC 8 のペイロード (e.g. "id=foo;http://example.com" or ";")
 * @returns パース結果。不正な形式は null。
 */
export function parseOsc8(data: string): Osc8Event | null {
	const semicolonIdx = data.indexOf(";");
	if (semicolonIdx === -1) return null;

	const paramsStr = data.substring(0, semicolonIdx);
	const uri = data.substring(semicolonIdx + 1);

	// 空 URI = リンク終了
	if (!uri) {
		return { type: "end" };
	}

	// params をパース (コロン区切り key=value)
	const params: Record<string, string> = {};
	if (paramsStr) {
		for (const pair of paramsStr.split(":")) {
			const eqIdx = pair.indexOf("=");
			if (eqIdx > 0) {
				params[pair.substring(0, eqIdx)] = pair.substring(eqIdx + 1);
			}
		}
	}

	return {
		type: "start",
		uri,
		id: params.id,
		params,
	};
}
