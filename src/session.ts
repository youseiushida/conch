import { Terminal } from '@xterm/headless';
import { IDisposable, ITerminalBackend } from './types';

export interface ConchSessionOptions {
  cols?: number;
  rows?: number;
}

export class ConchSession implements IDisposable {
  private terminal: Terminal;
  private backend: ITerminalBackend;
  private disposables: IDisposable[] = [];

  constructor(backend: ITerminalBackend, options: ConchSessionOptions = {}) {
    this.backend = backend;

    // xterm (headless) の初期化
    this.terminal = new Terminal({
      allowProposedApi: true,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
    });

    // 1-4. パイプライン接続: Backend -> xterm
    const dataDisposable = this.backend.onData((data) => {
      this.terminal.write(data);
    });
    this.disposables.push(dataDisposable);

    // 終了時のログ（暫定）
    const exitDisposable = this.backend.onExit((code) => {
      console.log(`[ConchSession] Backend exited with code ${code}`);
      // TODO: イベント発火
    });
    this.disposables.push(exitDisposable);
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
    this.write(command + '\r');
  }

  /**
   * 2-4. リサイズ
   * xtermバッファとバックエンドプロセスの両方をリサイズする
   */
  public resize(cols: number, rows: number): void {
    const c = Math.max(1, cols);
    const r = Math.max(1, rows);

    this.terminal.resize(c, r);
    this.backend.resize(c, r);
  }

  // 1-5. ライフサイクル管理
  public dispose(): void {
    // 登録されたリスナーを解除
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];

    // バックエンドとターミナルを破棄
    this.backend.dispose();
    this.terminal.dispose();
  }
}
