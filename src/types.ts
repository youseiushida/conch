// 共通のイベントリスナー解除用インターフェース
export interface IDisposable {
  dispose(): void;
}

// ターミナルバックエンド（pty, docker, ssh等）の抽象インターフェース
export interface ITerminalBackend extends IDisposable {
  // 基本操作
  write(data: string): void;
  resize(cols: number, rows: number): void;
  
  // イベント
  onData(listener: (data: string) => void): IDisposable;
  onExit(listener: (code: number, signal?: number) => void): IDisposable;

  // メタデータ
  readonly id: string | number; // PID or ContainerID
  readonly processName: string; // "bash", "node" etc.
}
