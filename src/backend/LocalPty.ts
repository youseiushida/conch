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
  private ptyProcess: pty.IPty;

  constructor(
    shell: string,
    args: string[] = [],
    options: LocalPtyOptions = {}
  ) {
    this.ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-color',
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      encoding: 'utf8', // 常にUTF-8
    });

    // Windows固有の初期化処理
    if (os.platform() === 'win32') {
      // コードページをUTF-8に変更
      this.write('chcp 65001\r');
      // 画面クリア (chcpの出力メッセージを消すため)
      this.write('Clear-Host\r');
    }
  }

  // --- ITerminalBackend implementation ---

  public get id(): number {
    return this.ptyProcess.pid;
  }

  public get processName(): string {
    return this.ptyProcess.process;
  }

  public write(data: string): void {
    try {
      this.ptyProcess.write(data);
    } catch (error) {
      // プロセス終了後の書き込みなどでエラーが出る可能性があるため、
      // ここでキャッチしてログ出しに留める（上位には伝播させない）
      console.warn(`[LocalPty] Write failed (pid: ${this.id}):`, error);
    }
  }

  public resize(cols: number, rows: number): void {
    try {
      this.ptyProcess.resize(cols, rows);
    } catch (error) {
      console.warn(`[LocalPty] Resize failed (pid: ${this.id}):`, error);
    }
  }

  public dispose(): void {
    this.ptyProcess.kill();
  }

  public onData(listener: (data: string) => void): IDisposable {
    const disposable = this.ptyProcess.onData(listener);
    return {
      dispose: () => disposable.dispose(),
    };
  }

  public onExit(listener: (code: number, signal?: number) => void): IDisposable {
    const disposable = this.ptyProcess.onExit(({ exitCode, signal }) => {
      listener(exitCode, signal ?? 0);
    });
    return {
      dispose: () => disposable.dispose(),
    };
  }
}
