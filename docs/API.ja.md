# API Reference

> これは [API.md](./API.md) の日本語訳です。最新情報は英語版をご確認ください。

このドキュメントは `src/` のコードに基づいた、Conchの公開API仕様書です。

## パッケージ構成
現状、主なクラスと関数は `src/index.ts` からexportされています。

```typescript
import { Conch, ConchSession, LocalPty, waitForText, waitForStable } from '@ushida_yosei/conch';
// DockerPty / SshPty はdockeroode / ssh2 の依存を避けるため、バレルからは再exportされません。
// 直接インポートしてください:
//   import { DockerPty } from "@ushida_yosei/conch/backend/DockerPty"
//   import { SshPty }    from "@ushida_yosei/conch/backend/SshPty"
// または Conch.launch({ backend: { type: "docker"|"ssh", ... } }) でオンデマンド読み込みできます。
```

---

## `src/conch.ts` (Facade: `Conch`)

ライブラリを利用する際のメインエントリポイントです。`ConchSession` をラップし、高レベルな操作を提供します。

> **Disposeガード**: `dispose()` 呼び出し後、すべてのパブリックメソッドは `"Conch instance is disposed"` をスローします。

### Static Methods

#### `Conch.launch(options): Promise<Conch>`
新しい Conch インスタンスを作成・起動します。
- `options.backend`: `{ type: 'localPty' | 'docker' | 'ssh', ... }` または `ITerminalBackend` インスタンス。
- `options.shellIntegration`: 任意のOSC 133注入設定（`run()` の終了コード検知を安定させたい場合に推奨）。
- `options.autoDispose`: trueの場合、プロセス終了シグナル時に自動でdisposeします。
- `options.timeoutMs`: 操作のデフォルトタイムアウト（デフォルト: 10000）。
- `options.cols` / `options.rows`: ターミナルサイズ（デフォルト: 80x24）。

### Methods

#### `run(command: string, options?): Promise<RunResult>`
コマンドを実行し、完了まで待機します。
- OSC 133 (Shell Integration) が利用可能な場合、コマンド完了（OSC 133 D）と終了コードを検知します。
- **C-gate**: 精密なイベントフィルタリングを使用します。`execute()` 後に到着したCイベントのみを受け入れ、前のコマンドからの残留Dイベントはスキップされます。Dは自コマンドのCが確認された後にのみ受け入れられ、古いシェル統合イベントとの誤マッチを防ぎます。
- **バックエンド終了検知**: `run()` 実行中にバックエンドが終了した場合（SSH切断、PTY死亡等）、strictモードに関係なく `"Backend exited during run() (exit code: N)"` で即座にrejectします。終了後にOSCマーカーが届くことはないためです。
- **出力抽出**: シェル統合が有効な場合、`outputText` はC-D境界抽出で取得されます。最後のOSC 133 Cマーカーと最後のOSC 133 Dマーカーの間のコンテンツから、ANSI/OSCシーケンスを除去したものです。ヒューリスティクス不要の決定的な抽出です。
- OSC 133 D が観測できない場合:
  - `strict: false`（デフォルト）: `timeoutMs` 経過で解決し、`exitCode: undefined` になります（`meta.method: "fallback"`）。
  - `strict: true`: タイムアウトでrejectします。
- バックエンドが `ITerminalBackend.onError` で致命的エラーを通知する場合、`run()` はタイムアウトを待たずに失敗できます（デフォルト）。従来通りタイムアウトfallbackにしたい場合は `backendError: "ignore"` を指定します。
- 終了コード（取得できる場合）、出力テキスト、スナップショット（`snapshot: "viewport" | "all" | "none"`）を返します。

#### `pressAndSnapshot(key: string, options?): Promise<ActionResult>`
キーを入力し、画面変化を待機します（デフォルト: `{kind:'change'}`）。
- 更新後のスナップショットを返します。

#### `typeAndSnapshot(text: string, options?): Promise<ActionResult>`
文字列を入力し、スナップショットを取得します。
- デフォルト待機: `{kind:'change'}`（PTYエコーがスナップショットに反映されることを保証）。

#### `executeAndSnapshot(command: string, options?): Promise<ActionResult>`
コマンドを実行（`\r`を付与）し、スナップショットを取得します。
- デフォルト待機: `{kind:'drain'}`（即時エコー/プロンプト変化を表示するためのベストエフォートdrain）。

#### `waitForText(pattern, options?): Promise<void>`
テキストが画面に現れるまで待機します。（`utils.waitForText` に委譲）

#### `waitForStable(options?): Promise<void>`
画面が安定するまで待機します。（`utils.waitForStable` に委譲）

#### `waitForSilence(options?): Promise<void>`
指定時間、出力が止まるまで待機します。

#### `waitForChange(options?): Promise<void>`
画面スナップショットの内容が変化するまで待機します。

#### `getSnapshot(options?): ISnapshot`
現在の画面スナップショットを取得します。

#### `screenText(options?): string`
`getSnapshot().text` のショートカット。

#### `hasText(pattern, options?): boolean`
指定した文字列またはRegExpが現在の画面スナップショットに存在するか確認します。

#### `findText(pattern, options?): TextMatch[]`
現在のスナップショット内で指定したパターンの出現位置をすべて検索します。

#### `cropText(rect, options?): string`
画面の指定した矩形領域からテキストを抽出します。

---

## `src/types.ts`（型定義）

### `ITerminalBackend`
ターミナル実行基盤（PTY/Docker/SSH等）の抽象インターフェース。

```ts
export interface ITerminalBackend extends IDisposable {
  // ライフサイクル
  spawn(): Promise<void>;
  dispose(): void;
  disposeAsync?(): Promise<void>;

  // I/O
  write(data: string): void;
  resize(cols: number, rows: number): void;

  // イベント
  onData(listener: (data: string) => void): IDisposable;
  onExit(listener: (code: number, signal?: number) => void): IDisposable;
  onError?(listener: (err: Error) => void): IDisposable;

  readonly id: string | number;
  readonly processName: string;
}
```

### `BackendConfig`

`Conch.launch({ backend: ... })` にバックエンド設定オブジェクトを渡せます:

```ts
export type BackendConfig =
  | {
      type: "localPty";
      file?: string;
      args?: string[];
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    }
  | {
      type: "docker";
      image: string;
      cmd?: string[];
      workdir?: string;
      env?: Record<string, string>;
      name?: string;
      user?: string;
      autoRemove?: boolean;
      docker?: import("dockerode").DockerOptions;
    }
  | {
      type: "ssh";
      host: string;
      port?: number;
      username: string;
      password?: string;
      privateKey?: string | Buffer;
      passphrase?: string;
      agent?: string;
      term?: string;
      readyTimeout?: number;
      keepaliveInterval?: number;
      keepaliveCountMax?: number;
      hostVerifier?: (key: Buffer) => boolean;
      connectOptions?: Partial<import("ssh2").ConnectConfig>;
    };
```

### Snapshot関連

```ts
export interface ISnapshot {
  text: string;
  cursor: { x: number; y: number };          // Absolute (Buffer)
  cursorSnapshot: { x: number; y: number };  // Relative (Snapshot)
  meta: {
    viewportY: number;
    rows: number;
    cols: number;
    isAlternateBuffer: boolean;
    startRow: number;
    endRow: number;
    rangeUsed: SnapshotRange;
  };
}

export interface FormatterContext {
  y: number;          // 互換性用（= bufferY）
  bufferY: number;    // バッファ絶対行番号
  snapshotY: number;  // スナップショット相対行番号
}
```

### Action & Run 型

```ts
export type ConchWait =
  | { kind: "none" }
  | { kind: "drain"; budgetMs?: number }
  | { kind: "change"; timeoutMs?: number; intervalMs?: number }
  | { kind: "stable"; durationMs?: number; timeoutMs?: number; intervalMs?: number }
  | { kind: "silence"; durationMs?: number; timeoutMs?: number }
  | { kind: "text"; pattern: string | RegExp; timeoutMs?: number; intervalMs?: number };

export interface ActionResult {
  snapshot: ISnapshot;
  durationMs: number;
  meta: {
    action: "press" | "type" | "execute";
    waited: ConchWait["kind"];
    snapshotRange: SnapshotRange;
  };
}

export interface RunResult {
  exitCode?: number;
  outputText: string;
  snapshot?: ISnapshot;
  /** @deprecated snapshot を使用してください */
  snapshotAfter?: ISnapshot;
  durationMs: number;
  meta: {
    action?: "run";
    waited?: "osc133" | "fallback";
    snapshotMode?: SnapshotMode;
    method: "osc133" | "fallback";
    shellIntegrationUsed: boolean;
  };
  outputRaw?: string;
}
```

---

## `src/session.ts`（Core: `ConchSession`）

バックエンドとフロントエンドを接続し、操作と観測を提供するメインクラスです。

**ターミナルクエリ自動応答**: `ConchSession` は標準的なターミナルクエリ（DA1、DA2、CPR/DSR、DECRQM）に対する自動応答機能を内蔵しています。TUIアプリケーション（vim、less、nano、top、tmux）は起動時にこれらの機能クエリを送信し、応答があるまでブロックします。xterm.jsヘッドレスは応答を書き戻さないため、ConchSessionがこれらのクエリをインターセプトし、VT220/xterm互換の標準応答をPTYに書き込むことで、アプリのブロックを解除します。

### コンストラクタ
```ts
new ConchSession(backend: ITerminalBackend, options?: { cols?: number; rows?: number })
```

### Input Methods

#### `write(data: string): void`
バックエンドに文字列（エスケープシーケンス含む）を直接送信します。

#### `execute(command: string): void`
コマンド文字列に改行コード（`\r`）を付与して送信します。
※ 完了待機は行いません。

#### `press(key: string): void`
キー名（`Enter`, `Esc`, `ArrowUp`, `Ctrl+C` など）を指定してキー入力をシミュレートします。

#### `type(text: string): void`
文字列を1文字ずつ入力します。

#### `resize(cols: number, rows: number): void`
xtermとバックエンドの両方をリサイズします。

#### `drain(): Promise<void>`
xtermへの書き込みキューが空になるまで待機します。
※ バックエンドのコマンド実行完了を待つものではなく、あくまで「画面への反映」を待つものです。

### Observation Methods

#### `getSnapshot(options?: SnapshotOptions): ISnapshot`
現在の画面状態を取得します。
- `range: 'viewport'` (default): 現在表示されている範囲のみ
- `range: 'all'`: スクロールバックを含む全バッファ

### Events

#### `onOutput(listener): IDisposable`
PTYからの生データを受信します。

#### `onExit(listener): IDisposable`
プロセスの終了を検知します。

#### `onShellIntegration(listener): IDisposable`
OSC 133シェル統合イベント（A: PromptStart, B: CommandStart, C: CommandExecuted, D: CommandFinished）を受信します。

---

## `src/backend/LocalPty.ts`（Backend: `LocalPty`）

`node-pty` をラップしたローカルプロセス用バックエンドです。

### `spawn(): Promise<void>`
プロセスを起動します。
- Windows環境では `chcp 65001` によるUTF-8化と、画面クリアが完了するまで待機します。
- 一度 `dispose` されたインスタンスで呼ぶとエラーになります。

---

## `src/backend/DockerPty.ts`（Backend: `DockerPty`）

`dockerode` をラップした Docker コンテナ用バックエンドです。

- コンテナをTTYモードで起動し、単一のread/writeストリームとしてattachします。
- `autoRemove` はデフォルトで `true` です。
- TTYモードでは stdout/stderr は単一ストリームにまとまります（分離できません）。

---

## `src/backend/SshPty.ts`（Backend: `SshPty`）

`ssh2` をラップした SSH リモートシェル用バックエンドです。

- SSHでリモートホストに接続し、PTY付きの対話シェルを開き、`LocalPty` や `DockerPty` と同じ `ITerminalBackend` インターフェースを提供します。
- ホスト鍵検証はデフォルトですべて受け入れます（自動化用途向け）。`hostVerifier` でオーバーライドできます。

### `SshPtyOptions`

```ts
export interface SshPtyOptions {
  host: string;
  port?: number;               // デフォルト: 22
  username: string;

  // 認証（少なくとも1つ必要）
  password?: string;
  privateKey?: string | Buffer;
  passphrase?: string;
  agent?: string;              // SSHエージェントソケットパス

  // PTY
  cols?: number;               // デフォルト: 80
  rows?: number;               // デフォルト: 24
  term?: string;               // デフォルト: "xterm-256color"

  // 接続チューニング
  readyTimeout?: number;       // デフォルト: 20000
  keepaliveInterval?: number;  // デフォルト: 10000
  keepaliveCountMax?: number;  // デフォルト: 3

  // ホスト鍵検証（デフォルト: 自動化用途のためすべて受け入れ）
  hostVerifier?: (key: Buffer) => boolean;

  // エスケープハッチ: 生のssh2 ConnectConfig上書き（最後に適用）
  connectOptions?: Partial<ConnectConfig>;
}
```

### コンストラクタ

```ts
new SshPty(options: SshPtyOptions)
```

### プロパティ

- **`id`**: `string` — `"ssh-{host}:{port}-{N}"` を返します。Nは自動インクリメントされるインスタンスカウンタです（例: `"ssh-myhost:22-0"`）。
- **`processName`**: `string` — `"{username}@{host}"` を返します（例: `"root@myhost"`）。

### メソッド

#### `spawn(): Promise<void>`
SSHサーバーに接続し、認証を行い、PTY付きの対話シェルを開きます。
- dispose済みの場合は `"SshPty is disposed"` をスローします。
- 二重呼び出しの場合は `"SshPty is already spawned"` をスローします。
- 失敗時はロールバック（ストリームのクローズとクライアントの切断）を行い、例外を再スローします。

#### `write(data: string): void`
SSHチャネルにデータを書き込みます。`spawn()` 前に呼ぶと警告をログ出力します。

#### `resize(cols: number, rows: number): void`
SSHチャネルにウィンドウ変更リクエストを送信します（`setWindow` 経由）。

#### `dispose(): void`
同期dispose — `disposeAsync()` に委譲（fire-and-forget）。

#### `disposeAsync(): Promise<void>`
冪等な非同期disposal。すべてのイベントリスナーを削除し、SSHチャネルをクローズし、クライアントを切断します。

### シグナルマッピング

リモートシェルがシグナルで終了した場合、`SshPty` はシグナル名をPOSIXシグナル番号にマッピングして `onExit` コールバックに渡します。終了コードはUnix規約に従い `128 + シグナル番号` となります。

| シグナル | 番号 |
|----------|------|
| HUP      | 1    |
| INT      | 2    |
| QUIT     | 3    |
| ILL      | 4    |
| TRAP     | 5    |
| ABRT     | 6    |
| FPE      | 8    |
| KILL     | 9    |
| SEGV     | 11   |
| PIPE     | 13   |
| ALRM     | 14   |
| TERM     | 15   |

---

## `src/utils.ts`（Utilities）

### Wait Functions

#### `waitForText(session, pattern, options?): Promise<void>`
指定した文字列または正規表現が画面（Viewport）に現れるまで待機します。
- 正規表現の `lastIndex` は毎回リセットされるため、`/g` フラグ付きでも安全に使用できます。

#### `waitForSilence(session, duration?, timeout?): Promise<void>`
指定時間（デフォルト500ms）、出力が止まるまで待機します。

#### `waitForChange(session, options?): Promise<void>`
現在のスナップショット内容から変化があるまで待機します。

#### `waitForStable(session, duration?, options?): Promise<void>`
指定時間、画面内容が変化しなくなる（安定する）まで待機します。
アニメーションするCUIツールや、大量のログ出力の完了待ちに有用です。

### Locator Functions

#### `cropText(snapshot, rect): string`
スナップショットから指定した矩形領域（x, y, width, height）のテキストを抽出します。

#### `findText(snapshot, pattern): TextMatch[]`
スナップショット内で指定したパターンが出現する位置（x, y）を検索してリストで返します。

### Helper Functions

#### `encodeScriptForShell(script, shell): string`
スクリプトをBase64エンコードし、ターゲットシェルで実行するためのワンライナーを生成します。
- `bash` (Linux/GNUおよびmacOS/BSDの `base64` コマンド差異を吸収) および `pwsh` をサポートします。
