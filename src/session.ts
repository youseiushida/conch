import { Terminal } from "@xterm/headless";
import { getCtrlChar, SpecialKeys } from "./keymap";
import { BASH_INTEGRATION_SCRIPT, PWSH_INTEGRATION_SCRIPT } from "./scripts";
import type {
	IDisposable,
	IShellIntegrationEvent,
	ISnapshot,
	ITerminalBackend,
	SnapshotOptions,
} from "./types";
import { ShellIntegrationType } from "./types";
import { encodeScriptForShell, waitForText } from "./utils";

export interface ConchSessionOptions {
	cols?: number;
	rows?: number;
}

export class ConchSession implements IDisposable {
	private terminal: Terminal;
	private backend: ITerminalBackend;
	private disposables: IDisposable[] = [];
	private disposed = false;

	// xterm.write は非同期になり得るため、反映完了を待つためのカウンタ/待機列を持つ
	private pendingTerminalWrites = 0;
	private drainWaiters: (() => void)[] = [];

	// イベントリスナー
	private outputListeners: ((data: string) => void)[] = [];
	private exitListeners: ((code: number, signal?: number) => void)[] = [];
	private shellIntegrationListeners: ((
		event: IShellIntegrationEvent,
	) => void)[] = [];

	constructor(backend: ITerminalBackend, options: ConchSessionOptions = {}) {
		this.backend = backend;

		// xterm (headless) の初期化
		this.terminal = new Terminal({
			allowProposedApi: true,
			cols: options.cols ?? 80,
			rows: options.rows ?? 24,
			// ログが多くても保持できるようにスクロールバックを確保
			scrollback: 5000,
		});

		// 1-4. パイプライン接続: Backend -> xterm & Listeners
		const dataDisposable = this.backend.onData((data) => {
			// 0. Auto-respond to DECRQM (DEC Private Mode Report): ESC [ ? Ps $ p
			// xterm.js's registerCsiHandler can't match the "$" intermediate byte,
			// so we intercept it in the raw data stream. Response: ESC [ ? Ps ; 2 $ y
			// (Pm=2 means "reset/not set" — safe default for all modes).
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Matching CSI DECRQM sequence.
			const decrqmRe = /\x1b\[\?(\d+)\$p/g;
			let decrqmMatch: RegExpExecArray | null;
			// biome-ignore lint/suspicious/noAssignInExpressions: Standard RegExp loop pattern.
			while ((decrqmMatch = decrqmRe.exec(data)) !== null) {
				const mode = decrqmMatch[1];
				this.backend.write(`\x1b[?${mode};2$y`);
			}

			// 1. xterm に流す（反映完了を追跡する）
			this.pendingTerminalWrites++;
			this.terminal.write(data, () => {
				this.pendingTerminalWrites = Math.max(
					0,
					this.pendingTerminalWrites - 1,
				);
				if (this.pendingTerminalWrites === 0) {
					const waiters = this.drainWaiters;
					this.drainWaiters = [];
					waiters.forEach((w) => {
						w();
					});
				}
			});

			// 2. 外部リスナーにブロードキャスト
			this.outputListeners.forEach((listener) => {
				listener(data);
			});
		});
		this.disposables.push(dataDisposable);

		// 終了イベントの接続
		const exitDisposable = this.backend.onExit((code, signal) => {
			// 終了リスナーに通知
			this.exitListeners.forEach((listener) => {
				listener(code, signal);
			});
		});
		this.disposables.push(exitDisposable);

		// OSC 133 (Shell Integration) ハンドラの登録
		const oscDisposable = this.terminal.parser.registerOscHandler(
			133,
			(data) => {
				this.handleOsc133(data);
				return true; // handled
			},
		);
		this.disposables.push(oscDisposable);

		// Terminal query auto-responder.
		//
		// TUI apps (vim, less, nano) send terminal capability queries (DA1, DA2,
		// CPR, DSR) on startup and block until the terminal responds. xterm.js
		// headless parses these sequences but never writes responses back — it has
		// no reference to the PTY. We intercept the queries here and write standard
		// responses back to the backend, unblocking the TUI app.
		this.registerTerminalResponders();
	}

	/**
	 * Register auto-responders for standard terminal queries.
	 *
	 * These are well-defined protocol responses that any terminal emulator would
	 * send. Without them, TUI apps block on startup waiting for answers that
	 * never come from xterm.js headless.
	 */
	private registerTerminalResponders(): void {
		// DA1 (Primary Device Attributes): ESC [ c
		// Response: VT220-compatible — ESC [ ? 62 ; 22 c
		const da1 = this.terminal.parser.registerCsiHandler(
			{ final: "c" },
			(params) => {
				if (params.length === 0 || params[0] === 0) {
					this.backend.write("\x1b[?62;22c");
				}
				return false; // let xterm also process
			},
		);
		this.disposables.push(da1);

		// DA2 (Secondary Device Attributes): ESC [ > c
		// Response: xterm-compatible — ESC [ > 0 ; 0 ; 0 c
		const da2 = this.terminal.parser.registerCsiHandler(
			{ prefix: ">", final: "c" },
			(params) => {
				if (params.length === 0 || params[0] === 0) {
					this.backend.write("\x1b[>0;0;0c");
				}
				return false;
			},
		);
		this.disposables.push(da2);

		// DSR (Device Status Report) / CPR (Cursor Position Report): ESC [ Ps n
		//   Ps=5: DSR — respond ESC [ 0 n (terminal OK)
		//   Ps=6: CPR — respond ESC [ row ; col R (cursor position, 1-based)
		const dsr = this.terminal.parser.registerCsiHandler(
			{ final: "n" },
			(params) => {
				if (params[0] === 5) {
					// DSR: report "OK"
					this.backend.write("\x1b[0n");
				} else if (params[0] === 6) {
					// CPR: report current cursor position (1-based)
					const row = this.terminal.buffer.active.cursorY + 1;
					const col = this.terminal.buffer.active.cursorX + 1;
					this.backend.write(`\x1b[${row};${col}R`);
				}
				return false;
			},
		);
		this.disposables.push(dsr);
	}

	// --- 2. Programmatic I/O API ---

	/**
	 * 2-1. プログラム向け操作API: 書き込み
	 * バックエンド（Pty）へデータを送信する
	 */
	public write(data: string): void {
		// 将来的にここにフックを入れる可能性がある
		this.backend.write(data);
	}

	/**
	 * 2-3. コマンド実行ヘルパー
	 * コマンド文字列に改行コードを付与して送信する
	 * ※ 完了待機は行わない（呼び出し側でSnapshot監視が必要）
	 */
	public execute(command: string): void {
		// 入力としての改行は '\r' が最も安全（全OS共通）
		this.write(`${command}\r`);
	}

	/**
	 * スクリプトをBase64エンコードして実行する（安全な注入）
	 *
	 * ⚠️ セキュリティ警告:
	 * このメソッドはシェル上で任意のコードを実行します。
	 * 信頼できるスクリプトのみを渡してください。
	 *
	 * @param script - 実行するシェルスクリプト
	 * @param options.shell - ターゲットシェル ('bash' | 'pwsh')
	 */
	public unsafeInjectScript(
		script: string,
		options: { shell: "bash" | "pwsh" },
	): void {
		const command = encodeScriptForShell(script, options.shell);
		this.execute(command);
	}

	/**
	 * OSC 133 シェル統合を有効化する
	 *
	 * 既知のシェル向けプリセットスクリプトを注入し、有効化を確認します。
	 *
	 * ⚠️ 注意点:
	 * 1. 成功確認は「注入スクリプトがエラーなく流れたか」の検証であり、
	 *    「実際にOSC 133イベントが発火し始めたか」の検証ではありません。
	 * 2. シェル自動判定は完全ではないため、可能な限り `shell` 引数を明示することを推奨します。
	 *
	 * @param shell - ターゲットシェル (省略時は processName から推測を試みるが、明示推奨)
	 * @returns 成功した場合は true
	 */
	public async enableShellIntegration(
		shell?: "bash" | "pwsh",
	): Promise<boolean> {
		const targetShell =
			shell ??
			(this.backend.processName.includes("pwsh") ||
			this.backend.processName.includes("powershell")
				? "pwsh"
				: "bash");

		let script = "";
		let verifyCmd = "";
		const sentinel = `__CONCH_OK_${Math.random().toString(36).slice(2)}`;

		if (targetShell === "pwsh") {
			script = PWSH_INTEGRATION_SCRIPT;
			verifyCmd = `Write-Output "${sentinel}"`;
		} else {
			script = BASH_INTEGRATION_SCRIPT;
			verifyCmd = `echo "${sentinel}"`;
		}

		// 1. スクリプト注入
		this.unsafeInjectScript(script, { shell: targetShell });

		// 2. 検証コマンド実行 (注入が成功していれば、これも実行されるはず)
		// 少し待ってから実行したほうが安全かもしれないが、キューに入れば順次実行されるはず
		this.execute(verifyCmd);

		// 3. センチネル文字列の出現を待つ
		try {
			// WSLなどの遅い環境を考慮してタイムアウトを長めに設定
			await waitForText(this, sentinel, { timeout: 15000 });
			return true;
		} catch (e) {
			console.warn("[ConchSession] Shell integration verification failed:", e);
			return false;
		}
	}

	/**
	 * キー入力をシミュレートする
	 * @param key キー名 (e.g. 'Enter', 'Esc', 'Ctrl+C', 'a')
	 */
	public press(key: string): void {
		if (key.includes("+")) {
			const parts = key.split("+");
			this.chord(parts);
			return;
		}

		const seq = SpecialKeys[key];
		if (seq) {
			this.write(seq);
		} else {
			if (key.length === 1) {
				this.write(key);
			} else {
				console.warn(`[ConchSession] Unknown key: ${key}`);
			}
		}
	}

	/**
	 * 文字列を入力する（1文字ずつ入力扱い）
	 */
	public type(text: string): void {
		this.write(text);
	}

	/**
	 * 同時押し入力 (Chord)
	 * 現状は Ctrl+Char のみ対応
	 */
	public chord(keys: string[]): void {
		const hasCtrl = keys.some(
			(k) => k.toLowerCase() === "ctrl" || k.toLowerCase() === "control",
		);
		const charKey = keys[keys.length - 1];

		if (hasCtrl && charKey.length === 1) {
			this.write(getCtrlChar(charKey));
			return;
		}

		console.warn(`[ConchSession] Unsupported chord: ${keys.join("+")}`);
	}

	/**
	 * 2-4. リサイズ
	 * xtermバッファとバックエンドプロセスの両方をリサイズする
	 */
	public resize(cols: number, rows: number): void {
		const c = Math.max(2, cols); // Minimum 2 cols for safety
		const r = Math.max(1, rows);

		this.terminal.resize(c, r);
		this.backend.resize(c, r);
	}

	/**
	 * xterm（headless）への反映が追いつくまで待機する。
	 *
	 * - これは「backend から既に到着した data が xterm のバッファに反映された」ことを保証する。
	 * - execute/write でコマンドを投げた後に「コマンドが完了した」ことは保証しない（完了検知は別問題）。
	 */
	public drain(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		if (this.pendingTerminalWrites === 0) return Promise.resolve();
		return new Promise((resolve) => {
			this.drainWaiters.push(resolve);
		});
	}

	// --- 3. Snapshot Engine ---

	/**
	 * 3-1. スナップショット取得
	 * 現在のターミナル画面の状態を取得する
	 */
	public getSnapshot(options: SnapshotOptions = {}): ISnapshot {
		const buffer = this.terminal.buffer.active;
		const range = options.range ?? "viewport";

		const viewportY = buffer.viewportY;
		let startRow = 0;
		let endRow = buffer.length;

		// 3-4. ビューポート制御
		if (range === "viewport") {
			// viewportY: 現在表示されている一番上の行
			// rows: 画面の高さ
			startRow = viewportY;
			endRow = Math.min(buffer.length, startRow + this.terminal.rows);
		}

		const lines: string[] = [];
		for (let i = startRow; i < endRow; i++) {
			const line = buffer.getLine(i);
			if (!line) {
				lines.push(""); // 空行
				continue;
			}

			// 3-2. 行レンダリングとフォーマッター適用
			if (options.formatter) {
				lines.push(
					options.formatter(line, {
						y: i,
						bufferY: i,
						snapshotY: i - startRow,
					}),
				);
			} else {
				// デフォルト: 右端の空白をトリムして文字列化
				lines.push(line.translateToString(true));
			}
		}

		// 3-3. カーソル位置とメタデータ
		// カーソル位置はバッファ全体の中での座標
		const cursorX = buffer.cursorX;
		const cursorY = buffer.cursorY;

		// Snapshot相対座標 (0始まり)
		const cursorSnapshotY = cursorY - startRow;

		// 代替バッファ（Vim等）かどうかの判定
		const isAlternateBuffer = this.terminal.buffer.active.type === "alternate";

		return {
			text: lines.join("\n"),
			cursor: { x: cursorX, y: cursorY },
			cursorSnapshot: { x: cursorX, y: cursorSnapshotY },
			meta: {
				isAlternateBuffer,
				viewportY,
				rows: this.terminal.rows,
				cols: this.terminal.cols,
				startRow,
				endRow,
				rangeUsed: range,
			},
		};
	}

	// --- 4. Event Listeners ---

	/**
	 * 4-1. 出力イベントの購読
	 * バックエンドからの生データ（Raw Output）を受け取る
	 */
	public onOutput(listener: (data: string) => void): IDisposable {
		this.outputListeners.push(listener);
		return {
			dispose: () => {
				this.outputListeners = this.outputListeners.filter(
					(l) => l !== listener,
				);
			},
		};
	}

	/**
	 * 4-1. 終了イベントの購読
	 * バックエンドプロセスの終了通知を受け取る
	 */
	public onExit(
		listener: (code: number, signal?: number) => void,
	): IDisposable {
		this.exitListeners.push(listener);
		return {
			dispose: () => {
				this.exitListeners = this.exitListeners.filter((l) => l !== listener);
			},
		};
	}

	/**
	 * OSC 133 (Shell Integration) イベントの購読
	 */
	public onShellIntegration(
		listener: (event: IShellIntegrationEvent) => void,
	): IDisposable {
		this.shellIntegrationListeners.push(listener);
		return {
			dispose: () => {
				this.shellIntegrationListeners = this.shellIntegrationListeners.filter(
					(l) => l !== listener,
				);
			},
		};
	}

	/**
	 * OSC 133 シーケンスの処理
	 * Format: 133 ; TYPE [; Params...]
	 */
	private handleOsc133(data: string): void {
		const parts = data.split(";");
		const rawType = parts[0];
		// Only emit known event types. Ignore unknown/extended markers for stability.
		// This keeps `onShellIntegration` predictable for consumers (esp. run()).
		switch (rawType) {
			case ShellIntegrationType.PromptStart:
			case ShellIntegrationType.CommandStart:
			case ShellIntegrationType.CommandExecuted:
			case ShellIntegrationType.CommandFinished:
				break;
			default:
				return;
		}

		const type = rawType as ShellIntegrationType;
		const params = parts.slice(1);

		const event: IShellIntegrationEvent = {
			type,
			params,
		};

		this.shellIntegrationListeners.forEach((listener) => {
			listener(event);
		});
	}

	// 1-5. ライフサイクル管理
	public dispose(): void {
		this.disposed = true;

		// 登録されたリスナーを解除
		this.disposables.forEach((d) => {
			d.dispose();
		});
		this.disposables = [];
		this.outputListeners = [];
		this.exitListeners = [];
		this.shellIntegrationListeners = [];

		// drain待機を解放
		const waiters = this.drainWaiters;
		this.drainWaiters = [];
		waiters.forEach((w) => {
			w();
		});

		// バックエンドとターミナルを破棄
		this.backend.dispose();
		this.terminal.dispose();
	}
}
