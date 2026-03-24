/**
 * スクリプトをBase64エンコードし、ターゲットシェルで実行するためのワンライナーを生成する
 *
 * ⚠️ Bash互換性に関する注意:
 * 現在の実装は Linux/WSL 等の `base64 -d` コマンドを前提としています。
 * macOS (BSD base64) の場合、`-d` オプションが使えない環境（`-D`が必要）では動作しない可能性があります。
 *
 * @param script - 注入するスクリプト
 * @param shell - ターゲットシェル ('bash' | 'pwsh')
 * @returns 実行用コマンド文字列
 */
export function encodeScriptForShell(
	script: string,
	shell: "bash" | "pwsh",
): string {
	// Node.js Buffer to Base64
	const b64 = Buffer.from(script, "utf-8").toString("base64");

	if (shell === "bash") {
		// Use eval to execute in current shell context
		// Try 'base64 --decode' (GNU), 'base64 -d' (Linux), then 'base64 -D' (macOS)
		// Use printf to avoid newline injection
		return `eval "$(printf '%s' '${b64}' | { base64 --decode 2>/dev/null || base64 -d 2>/dev/null || base64 -D 2>/dev/null; })"`;
	}

	if (shell === "pwsh") {
		// Use Invoke-Expression (iex)
		// PowerShell expects UTF-16LE for some things but .NET string from Base64 is straightforward
		return `$c=[System.Convert]::FromBase64String('${b64}');iex([System.Text.Encoding]::UTF8.GetString($c))`;
	}

	throw new Error(`Unsupported shell for injection: ${shell}`);
}
