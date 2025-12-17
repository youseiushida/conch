# API Reference

> ⚠️ これは [API.md](./API.md) の日本語訳です。最新情報は英語版をご確認ください。

このドキュメントは `src/` のコードに基づいた、Conchの公開API仕様書です。

## パッケージ構成
現状、主なクラスと関数は `src/index.ts` からexportされています。

```typescript
import { Conch, ConchSession, LocalPty, waitForText, waitForStable } from '@ushida_yosei/conch';
```

---

## `src/conch.ts` (Facade: `Conch`)

ライブラリを利用する際のメインエントリポイントです。`ConchSession` をラップし、高レベルな操作を提供します。

### Static Methods

#### `Conch.launch(options): Promise<Conch>`
新しい Conch インスタンスを作成・起動します。
- `options.backend`: `{ type: 'localPty', ... }` または `ITerminalBackend` インスタンス。
- `options.timeoutMs`: 操作のデフォルトタイムアウト。

### Methods

#### `run(command: string, options?): Promise<RunResult>`
コマンドを実行し、完了まで待機します。
- OSC 133 (Shell Integration) が利用可能な場合、正確なコマンド完了を検知します。
- 検知できない場合はタイムアウトまで待機します（fallbackモード）。
- 終了コード、出力テキスト、スナップショットを返します。

#### `pressAndSnapshot(key: string, options?): Promise<ActionResult>`
キーを入力し、画面更新を待機します（デフォルト）。
- 更新後のスナップショットを返します。

#### `typeAndSnapshot(text: string, options?): Promise<ActionResult>`
文字列を入力し、スナップショットを取得します。

#### `waitForText(pattern, options?): Promise<void>`
テキストが画面に現れるまで待機します。（`utils.waitForText` に委譲）

#### `waitForStable(options?): Promise<void>`
画面が安定するまで待機します。（`utils.waitForStable` に委譲）

#### `getSnapshot(options?): ISnapshot`
現在の画面スナップショットを取得します。

---

## `src/types.ts`（型定義）

### `ITerminalBackend`
ターミナル実行基盤（PTY/Docker/SSH等）の抽象インターフェース。

```ts
export interface ITerminalBackend extends IDisposable {
  // ライフサイクル
  spawn(): Promise<void>;
  dispose(): void;

  // I/O
  write(data: string): void;
  resize(cols: number, rows: number): void;

  // イベント
  onData(listener: (data: string) => void): IDisposable;
  onExit(listener: (code: number, signal?: number) => void): IDisposable;

  readonly id: string | number;
  readonly processName: string;
}
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
    // ...
  };
}

export interface FormatterContext {
  y: number;          // 互換性用（= bufferY）
  bufferY: number;    // バッファ絶対行番号
  snapshotY: number;  // スナップショット相対行番号
}
```

---

## `src/session.ts`（Core: `ConchSession`）

バックエンドとフロントエンドを接続し、操作と観測を提供するメインクラスです。

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

---

## `src/backend/LocalPty.ts`（Backend: `LocalPty`）

`node-pty` をラップしたローカルプロセス用バックエンドです。

### `spawn(): Promise<void>`
プロセスを起動します。
- Windows環境では `chcp 65001` によるUTF-8化と、画面クリアが完了するまで待機します。
- 一度 `dispose` されたインスタンスで呼ぶとエラーになります。

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
