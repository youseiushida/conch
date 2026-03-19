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
  /**
   * 任意: 非同期の後始末（await可能）
   * Dockerのstop/removeなど、完全停止を待ちたい場合に利用します。
   */
  disposeAsync?(): Promise<void>;

  // I/O
  write(data: string): void;
  resize(cols: number, rows: number): void;
  
  // イベント
  onData(listener: (data: string) => void): IDisposable;
  onExit(listener: (code: number, signal?: number) => void): IDisposable;
  /**
   * 任意: 致命的なバックエンドエラー通知
   * 提供される場合、`Conch.run()` はタイムアウトを待たずに失敗できます。
   */
  onError?(listener: (err: Error) => void): IDisposable;

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

### `DockerPty`

- **依存**: `dockerode`
- **概要**: Dockerコンテナ内でシェルを起動し、TTYとしてattachするバックエンドです。
- **特徴**:
    - **非同期起動**: コンテナ作成→起動→attach を `spawn()` で行います。
    - **リサイズ**: `container.resize({ w, h })` を呼びます。
    - **安全なデコード**: `StringDecoder` により UTF-8 chunk境界でも文字化けしにくくします。
    - **後始末**: spawn失敗時はstop/removeをベストエフォートで実行し、`disposeAsync()` はawait可能かつ冪等です。
- **注意点**:
    - TTYモードでは stdout/stderr は単一ストリームにまとまります（分離できません）。
    - Docker内で Shell Integration（OSC 133）を使う場合、`bash` を含むイメージ＋ `cmd: ["bash"]` の指定が必要になることが多いです（デフォルトは `/bin/sh`）。

### `SshPty`

- **依存**: `ssh2`
- **概要**: SSH経由でリモートホストに接続し、PTYシェルセッションを開きます。`ssh2` ライブラリを使用して接続ライフサイクルを管理します。
- **認証**: 複数の方式をサポートしており、任意の組み合わせで提供可能です:
    - `password`: パスワード認証。
    - `privateKey`（オプションの `passphrase` 付き）: 公開鍵認証。
    - `agent`: SSHエージェント転送（例: `SSH_AUTH_SOCK`）。
- **特徴**:
    - **非同期起動**: `spawn()` でSSHサーバーに接続、認証し、PTY割り当て付きの対話シェルを開きます。
    - **リサイズ**: `stream.setWindow(rows, cols, 0, 0)` でリモートPTYをリサイズします。
    - **安全なデコード**: `StringDecoder` により UTF-8 chunk境界でも文字化けしにくくします。
    - **シグナルマッピング**: `ssh2` のストリーム終了イベントからPOSIXシグナル名（HUP、INT、KILL、TERM等）を数値シグナルコードにマッピングします。終了コードはUnix慣例に従い、シグナルで終了した場合は `128 + シグナル番号` となります。
    - **エラー伝播**: SSH接続エラー用に `onError` を実装しており、`Conch.run()` がタイムアウトを待たずに即座に失敗できます。バックエンド終了イベント（サーバー切断）も即座に検知されます。
    - **後始末**: `disposeAsync()` は冪等で、全てのストリーム/クライアントハンドラを除去し、チャネルを閉じ、クライアントを切断します。
- **自動再接続なし**: SSH接続が切断された場合、バックエンドはエラー/終了イベントを発行します。自動再接続はありません。利用者は新しいインスタンスを作成する必要があります。
- **ホスト鍵検証**: 自動化用途向けにデフォルトで全て受け入れます（`hostVerifier: () => true`）。本番環境で厳密な検証が必要な場合はカスタム `hostVerifier` コールバックを指定してください。
- **注意点**:
    - Shell Integration（OSC 133）はリモートシェルが `bash` または `pwsh` であれば動作します。
    - `readyTimeout`、`keepaliveInterval`、`keepaliveCountMax`、および高度な ssh2 オーバーライド用の `connectOptions` で接続チューニングが可能です。

## 新しいバックエンドの追加方法

カスタムバックエンドを追加する場合は、以下の手順に従ってください。

1. `ITerminalBackend` を実装する新しいクラスを作成してください。
2. コンストラクタでは「設定の保持」のみを行い、副作用（接続や起動）は持たせないでください。
3. 実際の接続処理は `spawn()` メソッド内に実装し、完了を `Promise` で返してください。
4. プロセスの標準出力・標準エラー出力は区別せず、`onData` で発火させてください。
5. オプションとして `onError` を実装すると、`Conch.run()` での高速失敗が可能になります。
6. オプションとして `disposeAsync()` を実装すると、await可能なクリーンアップが可能になります。
