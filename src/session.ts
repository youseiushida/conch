import { Terminal } from '@xterm/headless';
import { SpecialKeys, getCtrlChar } from './keymap';
import { IDisposable, ISnapshot, ITerminalBackend, SnapshotOptions } from './types';

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
      // 1. xterm に流す（反映完了を追跡する）
      this.pendingTerminalWrites++;
      this.terminal.write(data, () => {
        this.pendingTerminalWrites = Math.max(0, this.pendingTerminalWrites - 1);
        if (this.pendingTerminalWrites === 0) {
          const waiters = this.drainWaiters;
          this.drainWaiters = [];
          waiters.forEach((w) => w());
        }
      });
      
      // 2. 外部リスナーにブロードキャスト
      this.outputListeners.forEach(listener => listener(data));
    });
    this.disposables.push(dataDisposable);

    // 終了イベントの接続
    const exitDisposable = this.backend.onExit((code, signal) => {
      // 終了リスナーに通知
      this.exitListeners.forEach(listener => listener(code, signal));
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
   * キー入力をシミュレートする
   * @param key キー名 (e.g. 'Enter', 'Esc', 'Ctrl+C', 'a')
   */
  public press(key: string): void {
    if (key.includes('+')) {
      const parts = key.split('+');
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
    const hasCtrl = keys.some(k => k.toLowerCase() === 'ctrl' || k.toLowerCase() === 'control');
    const charKey = keys[keys.length - 1];

    if (hasCtrl && charKey.length === 1) {
      this.write(getCtrlChar(charKey));
      return;
    }
    
    console.warn(`[ConchSession] Unsupported chord: ${keys.join('+')}`);
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
    const range = options.range ?? 'viewport';
    
    const viewportY = buffer.viewportY;
    let startRow = 0;
    let endRow = buffer.length;

    // 3-4. ビューポート制御
    if (range === 'viewport') {
      // viewportY: 現在表示されている一番上の行
      // rows: 画面の高さ
      startRow = viewportY;
      endRow = Math.min(buffer.length, startRow + this.terminal.rows);
    }

    const lines: string[] = [];
    for (let i = startRow; i < endRow; i++) {
      const line = buffer.getLine(i);
      if (!line) {
        lines.push(''); // 空行
        continue;
      }

      // 3-2. 行レンダリングとフォーマッター適用
      if (options.formatter) {
        lines.push(options.formatter(line, {
          y: i,
          bufferY: i,
          snapshotY: i - startRow,
        }));
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
    const isAlternateBuffer = this.terminal.buffer.active.type === 'alternate';

    return {
      text: lines.join('\n'),
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
      }
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
        this.outputListeners = this.outputListeners.filter(l => l !== listener);
      }
    };
  }

  /**
   * 4-1. 終了イベントの購読
   * バックエンドプロセスの終了通知を受け取る
   */
  public onExit(listener: (code: number, signal?: number) => void): IDisposable {
    this.exitListeners.push(listener);
    return {
      dispose: () => {
        this.exitListeners = this.exitListeners.filter(l => l !== listener);
      }
    };
  }

  // 1-5. ライフサイクル管理
  public dispose(): void {
    this.disposed = true;

    // 登録されたリスナーを解除
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.outputListeners = [];
    this.exitListeners = [];
    // drain待機を解放
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    waiters.forEach((w) => w());

    // バックエンドとターミナルを破棄
    this.backend.dispose();
    this.terminal.dispose();
  }
}
