import type { OscTitleEvent } from "./types";

/**
 * OSC 0 / OSC 2 のペイロード文字列をパースする。
 * xterm の registerOscHandler(0, handler) または registerOscHandler(2, handler) で使用。
 *
 * OSC 0: アイコン名 + ウィンドウタイトルを設定
 * OSC 2: ウィンドウタイトルのみを設定
 * どちらもペイロードは単純なテキスト文字列。
 *
 * @param data - OSC 0 / 2 のペイロード (e.g. "vim - file.txt")
 * @returns パース結果
 */
export function parseOscTitle(data: string): OscTitleEvent {
	return { title: data };
}
