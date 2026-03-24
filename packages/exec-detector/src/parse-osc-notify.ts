import type { Osc9Event, Osc777Event } from "./types";

/**
 * OSC 9 のペイロード文字列をパースする。
 * xterm の registerOscHandler(9, handler) のコールバックに渡される data を受け取る。
 *
 * OSC 9 は 2 つの用途を持つ:
 * - デスクトップ通知: `ESC ] 9 ; text BEL` → テキスト通知
 * - ConEmu プログレス: `ESC ] 9 ; 4 ; state [; percentage] BEL` → プログレスバー
 *
 * ConEmu サブコマンド (1-11) のうち、4 (プログレス) のみパースし、
 * それ以外のサブコマンドは null を返す。
 *
 * @param data - OSC 9 のペイロード
 * @returns パース結果
 */
export function parseOsc9(data: string): Osc9Event | null {
	const semicolonIdx = data.indexOf(";");
	if (semicolonIdx > 0) {
		const potentialSub = data.substring(0, semicolonIdx);
		const subNum = Number.parseInt(potentialSub, 10);
		// ConEmu サブコマンド: 整数 1-11 かつ文字列表現が一致（"4" != "4abc"）
		if (
			!Number.isNaN(subNum) &&
			subNum >= 1 &&
			subNum <= 11 &&
			String(subNum) === potentialSub
		) {
			if (subNum === 4) {
				// プログレスバー: 4;state[;percentage]
				const rest = data.substring(semicolonIdx + 1).split(";");
				const state = Number.parseInt(rest[0], 10);
				const pct =
					rest[1] !== undefined
						? Number.parseInt(rest[1], 10)
						: undefined;
				return {
					type: "progress",
					state: Number.isNaN(state) ? 0 : state,
					percentage:
						pct !== undefined && !Number.isNaN(pct)
							? pct
							: undefined,
				};
			}
			// その他の ConEmu サブコマンドは未サポート
			return null;
		}
	}
	// プレーン通知テキスト
	return { type: "notification", text: data };
}

/**
 * OSC 777 のペイロード文字列をパースする。
 * xterm の registerOscHandler(777, handler) のコールバックに渡される data を受け取る。
 *
 * 形式: `notify;title;body`
 * 実用的には `notify` サブコマンドのみ。それ以外は null を返す。
 *
 * @param data - OSC 777 のペイロード (e.g. "notify;Build Complete;Success!")
 * @returns パース結果。notify 以外は null。
 */
export function parseOsc777(data: string): Osc777Event | null {
	const parts = data.split(";");
	if (parts[0] !== "notify" || parts.length < 3) return null;
	return {
		title: parts[1],
		body: parts.slice(2).join(";"),
	};
}
