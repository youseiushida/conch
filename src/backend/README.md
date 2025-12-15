# Backend Adapters

このディレクトリには、ターミナルプロセスを抽象化する「バックエンドアダプター」が格納されます。

## Interface: `ITerminalBackend`

全てのバックエンドは `src/types.ts` で定義された `ITerminalBackend` を実装する必要があります。

```typescript
export interface ITerminalBackend extends IDisposable {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(listener: (data: string) => void): IDisposable;
  // ...
}
```

## Available Backends

### `LocalPty`
- **依存**: `node-pty`
- **概要**: ローカルマシン上のシェルプロセス（bash, powershell等）を起動します。
- **特記事項**: 
    - Windows環境では自動的に `chcp 65001` を実行してUTF-8モードで起動します。
    - コンストラクタで環境変数や初期サイズを指定可能です。

## How to Add a New Backend

1. `ITerminalBackend` を実装する新しいクラス（例: `DockerPty`）を作成してください。
2. コンストラクタで必要な接続情報（コンテナIDなど）を受け取ります。
3. プロセスの標準出力・標準エラー出力を `onData` で発火させてください。
