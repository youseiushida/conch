import type { Osc633Event } from "./types";

/**
 * OSC 633 のペイロード文字列をパースする。
 * xterm の registerOscHandler(633, handler) のコールバックに渡される data を受け取る。
 *
 * OSC 633 は VS Code シェル統合プロトコル。OSC 133 の A/B/C/D に加え、
 * E (コマンドライン), P (プロパティ), F/G (継続行), H/I (右プロンプト) をサポート。
 *
 * @param data - OSC 633 のペイロード (e.g. "A", "D;0", "E;echo hello;nonce123", "P;Cwd=/home")
 * @returns パース結果。未知のサブコマンドは null。
 */
export function parseOsc633(data: string): Osc633Event | null {
	const semicolonIdx = data.indexOf(";");
	const command = semicolonIdx === -1 ? data : data.substring(0, semicolonIdx);
	const argsStr = semicolonIdx === -1 ? "" : data.substring(semicolonIdx + 1);
	const args = argsStr ? argsStr.split(";") : [];

	switch (command) {
		case "A":
			return { type: "PromptStart" };
		case "B":
			return { type: "CommandStart" };
		case "C":
			return { type: "CommandExecuted" };
		case "D": {
			const raw = args[0];
			const exitCode =
				raw !== undefined ? Number.parseInt(raw, 10) : undefined;
			return {
				type: "CommandFinished",
				exitCode:
					exitCode !== undefined && !Number.isNaN(exitCode)
						? exitCode
						: undefined,
			};
		}
		case "E": {
			const commandLine =
				args[0] !== undefined ? deserializeOsc633Message(args[0]) : "";
			const nonce = args[1];
			return { type: "CommandLine", command: commandLine, nonce };
		}
		case "F":
			return { type: "ContinuationStart" };
		case "G":
			return { type: "ContinuationEnd" };
		case "H":
			return { type: "RightPromptStart" };
		case "I":
			return { type: "RightPromptEnd" };
		case "P": {
			const propStr = args[0] ?? "";
			const eqIdx = propStr.indexOf("=");
			if (eqIdx === -1) return null;
			return {
				type: "Property",
				key: propStr.substring(0, eqIdx),
				value: propStr.substring(eqIdx + 1),
			};
		}
		default:
			return null;
	}
}

/**
 * OSC 633 E で使われるエスケープ形式をデコードする。
 *
 * - `\\` → `\`
 * - `\xHH` → 対応する文字 (大文字小文字不問)
 */
export function deserializeOsc633Message(message: string): string {
	return message.replaceAll(
		/\\(\\|x([0-9a-f]{2}))/gi,
		(_match: string, op: string, hex?: string) =>
			hex ? String.fromCharCode(Number.parseInt(hex, 16)) : op,
	);
}

/**
 * 文字列を OSC 633 E のエスケープ形式にエンコードする。
 *
 * - `\` → `\\`
 * - `;` → `\x3b`
 * - 0x00-0x20 の制御文字 → `\xHH`
 */
export function serializeOsc633Message(message: string): string {
	return message.replace(/[\x00-\x20\\;]/g, (ch) => {
		if (ch === "\\") return "\\\\";
		return `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`;
	});
}
