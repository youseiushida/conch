# Backend Adapters

このディレクトリには、ターミナルプロセスを抽象化する「バックエンドアダプター」が格納されます。

## Interface: `ITerminalBackend`

全てのバックエンドは `src/types.ts` で定義された `ITerminalBackend` を実装する必要があります。

```typescript
export interface ITerminalBackend extends IDisposable {
  // ライフサイクル
  spawn(): Promise<void>; // プロセスの起動（非同期）
  dispose(): void;

  // I/O
  write(data: string): void;
  resize(cols: number, rows: number): void;
  
  // イベント
  onData(listener: (data: string) => void): IDisposable;
  onExit(listener: (code: number, signal?: number) => void): IDisposable;

  // メタデータ
  readonly id: string | number; // PID or ContainerID
  readonly processName: string; // "bash", "node" etc.
}
```

## Available Backends

### `LocalPty`
- **依存**: `node-pty`
- **概要**: ローカルマシン上のシェルプロセス（bash, powershell等）を起動します。
- **特徴**:
    - **非同期起動**: `spawn()` メソッドにより、プロセスの起動タイミングを制御できます。
    - **Windows対応**: Windows環境では自動的に `chcp 65001` を実行してUTF-8モードで起動し、初期化完了を待機します。
    - **再利用防止**: 一度 `dispose()` されたインスタンスは再利用できません（安全設計）。

## How to Add a New Backend

1. `ITerminalBackend` を実装する新しいクラス（例: `DockerPty`, `SshPty`）を作成してください。
2. コンストラクタでは設定の保持のみを行い、副作用（接続や起動）は `spawn()` メソッド内に実装してください。
3. プロセスの標準出力・標準エラー出力を `onData` で発火させてください。
