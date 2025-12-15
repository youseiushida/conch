import * as pty from '@lydell/node-pty';
import * as os from 'os';
import { IDisposable, ITerminalBackend } from '../types';

export interface LocalPtyOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: { [key: string]: string | undefined };
}

export class LocalPty implements ITerminalBackend {
  private ptyProcess: pty.IPty | undefined;
  private _disposed = false;
  
  // Arguments for spawn
  private shell: string;
  private args: string[];
  private options: LocalPtyOptions;

  // Event listeners
  private _dataListeners: ((data: string) => void)[] = [];
  private _exitListeners: ((code: number, signal?: number) => void)[] = [];

  constructor(
    shell: string,
    args: string[] = [],
    options: LocalPtyOptions = {}
  ) {
    this.shell = shell;
    this.args = args;
    this.options = options;
  }

  public async spawn(): Promise<void> {
    if (this._disposed) {
      throw new Error('LocalPty is disposed. Cannot spawn a new process on a disposed instance.');
    }
    if (this.ptyProcess) {
      throw new Error('LocalPty is already spawned');
    }

    this.ptyProcess = pty.spawn(this.shell, this.args, {
      name: 'xterm-color',
      cols: this.options.cols ?? 80,
      rows: this.options.rows ?? 24,
      cwd: this.options.cwd ?? process.cwd(),
      env: this.options.env ?? process.env,
      encoding: 'utf8', // 常にUTF-8
    });

    // Hook up internal listeners to the process
    this.ptyProcess.onData((data) => {
      this._dataListeners.forEach(l => l(data));
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this._exitListeners.forEach(l => l(exitCode, signal ?? 0));
    });

    // Windows固有の初期化処理
    if (os.platform() === 'win32') {
      // コードページをUTF-8に変更
      this.write('chcp 65001\r');
      // 画面クリア (chcpの出力メッセージを消すため)
      this.write('Clear-Host\r');
      
      // chcpの反映を少し待つ（簡易的）
      // 本来は出力監視すべきだが、spawn完了としては一旦Waitを入れるだけでも効果あり
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  // --- ITerminalBackend implementation ---

  public get id(): number {
    return this.ptyProcess?.pid ?? -1;
  }

  public get processName(): string {
    return this.ptyProcess?.process ?? '';
  }

  public write(data: string): void {
    if (!this.ptyProcess) {
      console.warn('[LocalPty] write called before spawn');
      return;
    }
    try {
      this.ptyProcess.write(data);
    } catch (error) {
      // プロセス終了後の書き込みなどでエラーが出る可能性があるため、
      // ここでキャッチしてログ出しに留める（上位には伝播させない）
      console.warn(`[LocalPty] Write failed (pid: ${this.id}):`, error);
    }
  }

  public resize(cols: number, rows: number): void {
    if (!this.ptyProcess) return;
    try {
      this.ptyProcess.resize(cols, rows);
    } catch (error) {
      console.warn(`[LocalPty] Resize failed (pid: ${this.id}):`, error);
    }
  }

  public dispose(): void {
    this._disposed = true;
    if (this.ptyProcess) {
      this.ptyProcess.kill();
      this.ptyProcess = undefined;
    }
    this._dataListeners = [];
    this._exitListeners = [];
  }

  public onData(listener: (data: string) => void): IDisposable {
    if (this._disposed) {
      return { dispose: () => {} };
    }
    this._dataListeners.push(listener);
    return {
      dispose: () => {
        this._dataListeners = this._dataListeners.filter(l => l !== listener);
      },
    };
  }

  public onExit(listener: (code: number, signal?: number) => void): IDisposable {
    if (this._disposed) {
      return { dispose: () => {} };
    }
    this._exitListeners.push(listener);
    return {
      dispose: () => {
        this._exitListeners = this._exitListeners.filter(l => l !== listener);
      },
    };
  }
}
