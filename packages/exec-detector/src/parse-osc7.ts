import type { Osc7Event } from "./types";

/**
 * OSC 7 のペイロード文字列をパースする。
 * xterm の registerOscHandler(7, handler) のコールバックに渡される data を受け取る。
 *
 * 形式: `file://hostname/path` または `kitty-shell-cwd://hostname/path`
 *
 * file:// の場合はパーセントデコードを行う。
 * kitty-shell-cwd:// の場合は raw path として扱う（Kitty/Ghostty 互換）。
 *
 * @param data - OSC 7 のペイロード (e.g. "file://localhost/home/user", "kitty-shell-cwd://host/tmp")
 * @returns パース結果。不正な形式は null。
 */
export function parseOsc7(data: string): Osc7Event | null {
	let scheme: string;
	let rest: string;

	if (data.startsWith("file://")) {
		scheme = "file";
		rest = data.substring(7);
	} else if (data.startsWith("kitty-shell-cwd://")) {
		scheme = "kitty-shell-cwd";
		rest = data.substring(18);
	} else {
		return null;
	}

	const slashIdx = rest.indexOf("/");
	if (slashIdx === -1) return null;

	const hostname = rest.substring(0, slashIdx);
	let path = rest.substring(slashIdx);

	// file:// はパーセントエンコードされている可能性がある
	if (scheme === "file") {
		try {
			path = decodeURIComponent(path);
		} catch {
			// デコード失敗時は raw path を使用
		}
	}

	return { scheme, hostname, path };
}
