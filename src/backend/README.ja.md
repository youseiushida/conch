# バックエンドアダプター

> ⚠️ これは [src/backend/README.md](./README.md) の日本語訳です。最新情報は英語版をご確認ください。

このディレクトリには、ターミナルプロセスを抽象化する「バックエンドアダプター」が格納されます。

## インターフェース: `ITerminalBackend`

全てのバックエンドは `src/types.ts` で定義された `ITerminalBackend` を実装する必要があります。
これにより、Local PTYだけでなく、DockerコンテナやSSH接続なども統一的に扱えるようになります。

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

## 利用可能なバックエンド

### `LocalPty`

- **依存**: `node-pty`
- **概要**: ローカルマシン上のシェルプロセス（bash, powershell等）を起動します。
- **特徴**:
    - **非同期起動**: `spawn()` メソッドにより、プロセスの起動タイミングを制御できます。リスナー登録を完了してから起動することが可能です。
    - **Windows対応**: Windows環境では自動的に `chcp 65001` を実行してUTF-8モードで起動し、初期化完了（画面クリア）まで待機します。これにより文字化けを防ぎます。
    - **安全性**: 一度 `dispose()` されたインスタンスで `spawn()` しようとするとエラーを投げ、不正な状態を防ぎます。

## 新しいバックエンドの追加方法

将来的に `DockerPty` や `SshPty` を追加する場合は、以下の手順に従ってください。

1. `ITerminalBackend` を実装する新しいクラスを作成してください。
2. コンストラクタでは「設定の保持」のみを行い、副作用（接続や起動）は持たせないでください。
3. 実際の接続処理は `spawn()` メソッド内に実装し、完了を `Promise` で返してください。
4. プロセスの標準出力・標準エラー出力は区別せず、`onData` で発火させてください。
