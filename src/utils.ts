import type { ConchSession } from "./session";
import type { ISnapshot } from "./types";

export interface WaitOptions {
	timeout?: number;
	interval?: number;
}

/**
 * 指定された正規表現または文字列が、セッションのスナップショット（viewport）に含まれるまで待機する
 *
 * ⚠️ 注意:
 * スクロールバック（viewport外）に流れた文字列は検知できません。
 * 大量の出力がある場合は、waitForSilence 等を併用するか、
 * 将来的に scrollback 検索が実装されるのを待つ必要があります。
 *
 * @param session - 監視対象のConchSession
 * @param pattern - 待機条件（文字列または正規表現）
 * @param options - タイムアウト設定など
 * @returns Promise<void>
 */
export function waitForText(
	session: ConchSession,
	pattern: string | RegExp,
	options: WaitOptions = {},
): Promise<void> {
	const timeout = options.timeout ?? 10000;
	const interval = options.interval ?? 50;

	return new Promise((resolve, reject) => {
		let timer: NodeJS.Timeout | undefined;

		// タイムアウト処理
		const timeoutId = setTimeout(() => {
			if (timer) clearInterval(timer);
			reject(
				new Error(
					`waitForText timed out after ${timeout}ms: pattern "${pattern}" not found`,
				),
			);
		}, timeout);

		// ポーリング処理
		const check = () => {
			const snapshot = session.getSnapshot(); // viewportのみ取得
			let found: boolean;

			if (typeof pattern === "string") {
				found = snapshot.text.includes(pattern);
			} else {
				// RegExp に /g や /y が付いていると test() が lastIndex を進めてしまうため、
				// ポーリング用途では毎回 0 に戻して安定させる。
				if (pattern.global || pattern.sticky) {
					pattern.lastIndex = 0;
				}
				found = pattern.test(snapshot.text);
			}

			if (found) {
				clearTimeout(timeoutId);
				if (timer) clearInterval(timer);
				resolve();
			}
		};

		// 初回チェック
		check();

		// 定期チェック開始
		timer = setInterval(check, interval);
	});
}

/**
 * 指定された時間、セッションからの出力が停止する（Silence状態になる）まで待機する
 *
 * @param session - 監視対象のConchSession
 * @param duration - 静止とみなす時間 (ms)。デフォルト500ms
 * @param timeout - 最大待機時間 (ms)。デフォルト10000ms
 * @returns Promise<void>
 */
export function waitForSilence(
	session: ConchSession,
	duration: number = 500,
	timeout: number = 10000,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let silenceTimer: NodeJS.Timeout | undefined;

		// イベント購読の解除用
		let disposable: { dispose: () => void } | undefined;

		// 全体のタイムアウト（cleanupから参照するので先に宣言）
		let timeoutId: NodeJS.Timeout | undefined;

		// クリーンアップ関数
		const cleanup = () => {
			if (disposable) {
				disposable.dispose();
				disposable = undefined;
			}
			if (silenceTimer) {
				clearTimeout(silenceTimer);
				silenceTimer = undefined;
			}
			if (timeoutId) {
				clearTimeout(timeoutId);
				timeoutId = undefined;
			}
		};

		// 全体のタイムアウト
		timeoutId = setTimeout(() => {
			cleanup();
			reject(new Error(`waitForSilence timed out after ${timeout}ms`));
		}, timeout);

		// 静止判定タイマーのリセット関数
		const resetSilenceTimer = () => {
			if (silenceTimer) clearTimeout(silenceTimer);
			silenceTimer = setTimeout(() => {
				cleanup();
				resolve();
			}, duration);
		};

		// 初期タイマーセット（既に出力がない場合も考慮）
		resetSilenceTimer();

		// 出力を監視してタイマーをリセット
		disposable = session.onOutput(() => {
			resetSilenceTimer();
		});
	});
}

/**
 * 画面の表示内容（スナップショット）が変化するまで待機する
 */
export function waitForChange(
	session: ConchSession,
	options: WaitOptions = {},
): Promise<void> {
	const timeout = options.timeout ?? 10000;
	const interval = options.interval ?? 50;

	return new Promise((resolve, reject) => {
		const initialText = session.getSnapshot().text;
		let timer: NodeJS.Timeout | undefined;

		const timeoutId = setTimeout(() => {
			if (timer) clearInterval(timer);
			reject(new Error(`waitForChange timed out after ${timeout}ms`));
		}, timeout);

		const check = () => {
			const currentText = session.getSnapshot().text;
			if (currentText !== initialText) {
				clearTimeout(timeoutId);
				if (timer) clearInterval(timer);
				resolve();
			}
		};

		timer = setInterval(check, interval);
	});
}

/**
 * 画面の表示内容が一定時間変化しなくなる（安定する）まで待機する
 *
 * waitForSilence との違い:
 * - waitForSilence: データ受信(onOutput)が止まるのを待つ
 * - waitForStable: 画面の見た目(Snapshot)が変わらなくなるのを待つ
 */
export function waitForStable(
	session: ConchSession,
	duration: number = 500,
	options: WaitOptions = {},
): Promise<void> {
	const timeout = options.timeout ?? 10000;
	const interval = options.interval ?? 50;

	return new Promise((resolve, reject) => {
		let timer: NodeJS.Timeout | undefined;
		let lastChangeTime = Date.now();
		let lastText = session.getSnapshot().text;

		const timeoutId = setTimeout(() => {
			if (timer) clearInterval(timer);
			reject(new Error(`waitForStable timed out after ${timeout}ms`));
		}, timeout);

		const check = () => {
			const currentText = session.getSnapshot().text;
			const now = Date.now();

			if (currentText !== lastText) {
				lastChangeTime = now;
				lastText = currentText;
			} else {
				if (now - lastChangeTime >= duration) {
					clearTimeout(timeoutId);
					if (timer) clearInterval(timer);
					resolve();
				}
			}
		};

		timer = setInterval(check, interval);
	});
}

// --- Locator Functions ---

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * スナップショットから指定された矩形領域のテキストを抽出する
 *
 * @param snapshot - スナップショット
 * @param rect - 抽出する矩形領域 (x, y はスナップショット相対座標)
 * @returns 抽出されたテキスト（複数行の場合は改行で結合）
 */
export function cropText(snapshot: ISnapshot, rect: Rect): string {
	const lines = snapshot.text.split("\n");
	const result: string[] = [];

	for (let i = 0; i < rect.height; i++) {
		const y = rect.y + i;
		if (y >= 0 && y < lines.length) {
			const line = lines[y];
			// 範囲外のアクセス防止
			const start = Math.max(0, Math.min(rect.x, line.length));
			const end = Math.max(0, Math.min(rect.x + rect.width, line.length));
			result.push(line.substring(start, end));
		} else {
			result.push("");
		}
	}

	return result.join("\n");
}

export interface TextMatch {
	x: number;
	y: number;
	match: string;
}

/**
 * スナップショット内で指定されたパターンが出現する位置を検索する
 *
 * @param snapshot - スナップショット
 * @param pattern - 検索パターン
 * @returns マッチした位置のリスト (y はスナップショット相対座標)
 */
export function findText(
	snapshot: ISnapshot,
	pattern: string | RegExp,
): TextMatch[] {
	const lines = snapshot.text.split("\n");
	const matches: TextMatch[] = [];

	lines.forEach((line, y) => {
		if (typeof pattern === "string") {
			let startIndex = 0;
			while (true) {
				const index = line.indexOf(pattern, startIndex);
				if (index === -1) break;
				matches.push({ x: index, y, match: pattern });
				startIndex = index + 1;
			}
		} else {
			// RegExp handling
			// Note: Global RegExp state (lastIndex) should be handled carefully if reused
			const regex = new RegExp(
				pattern.source,
				pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
			);
			let match: RegExpExecArray | null;
			// biome-ignore lint/suspicious/noAssignInExpressions: Standard RegExp loop pattern
			while ((match = regex.exec(line)) !== null) {
				matches.push({ x: match.index, y, match: match[0] });
				if (!regex.global) break; // if somehow g flag is missing (though we added it)
			}
		}
	});

	return matches;
}

// --- Injection Helper ---

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
		// Default to 'base64 -d' (Linux/WSL standard)
		// For macOS compatibility in future, we might need auto-detection or option
		return `eval "$(echo '${b64}' | base64 -d)"`;
	}

	if (shell === "pwsh") {
		// Use Invoke-Expression (iex)
		// PowerShell expects UTF-16LE for some things but .NET string from Base64 is straightforward
		return `$c=[System.Convert]::FromBase64String('${b64}');iex([System.Text.Encoding]::UTF8.GetString($c))`;
	}

	throw new Error(`Unsupported shell for injection: ${shell}`);
}
