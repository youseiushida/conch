import { ShellIntegrationType, type IShellIntegrationEvent } from "./types";

/**
 * OSC 133 のペイロード文字列をパースする。
 * xterm の registerOscHandler(133, handler) のコールバックに渡される data を受け取る。
 *
 * @param data - OSC 133 のペイロード (e.g. "A", "D;0", "D;0;123")
 * @returns パース結果。未知のタイプは null。
 */
export function parseOsc133(data: string): IShellIntegrationEvent | null {
	const parts = data.split(";");
	const rawType = parts[0];

	switch (rawType) {
		case ShellIntegrationType.PromptStart:
		case ShellIntegrationType.CommandStart:
		case ShellIntegrationType.CommandExecuted:
		case ShellIntegrationType.CommandFinished:
			break;
		default:
			return null;
	}

	return {
		type: rawType as ShellIntegrationType,
		params: parts.slice(1),
	};
}
