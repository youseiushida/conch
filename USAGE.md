# Usage Guide

Conch は、AIエージェントや自動化スクリプトが「ターミナル画面（TUI）」を人間と同じように認識・操作するためのライブラリです。

## Basic Usage

### 1. セッションの開始

`ConchSession` はバックエンド（PTYプロセス）とフロントエンド（画面状態）を管理します。
`spawn()` は非同期メソッドであり、プロセスの起動と初期化（WindowsでのUTF-8設定など）を行います。

```typescript
import { ConchSession, LocalPty } from 'conch';

// 1. バックエンドの作成 (設定のみ)
const pty = new LocalPty('powershell.exe', [], {
  cols: 80,
  rows: 24,
  env: process.env
});

// 2. セッションの作成
const session = new ConchSession(pty, {
  cols: 80,
  rows: 24
});

// 3. バックエンドの起動 (必須)
await pty.spawn();

// 終了時のクリーンアップ
process.on('SIGINT', () => {
  session.dispose();
});
```

### 2. 操作 (Input API)

エージェントは `press`, `type` などの高レベルAPIを使って操作します。
従来の `write` や `execute` も引き続き利用可能です。

```typescript
// コマンド実行 (末尾に改行コード \r を自動付与)
// ※ 完了待機はしないので注意
session.execute('ls -la');

// キー入力のシミュレーション
session.press('Enter');
session.press('ArrowDown');
session.press('Ctrl+C');

// 文字列の入力 (インクリメンタルサーチなど)
session.type('filter query');

// ※ write も使用可能 (生のシーケンス送信)
session.write('\x1b[A'); 
```

### 3. 画面の取得 (Snapshot)

現在のターミナル画面を文字列として取得します。
デフォルトでは「現在見えている範囲（Viewport）」のテキストが返されます。

```typescript
const snapshot = session.getSnapshot();
console.log(snapshot.text);

// メタデータの利用
// cursor: バッファ全体での絶対座標
// cursorSnapshot: 取得したテキスト内での相対座標 (0,0 始まり)
console.log(`Cursor (Abs): (${snapshot.cursor.x}, ${snapshot.cursor.y})`);
console.log(`Cursor (Rel): (${snapshot.cursorSnapshot.x}, ${snapshot.cursorSnapshot.y})`);
console.log(`Viewport Top: ${snapshot.meta.viewportY}`);
```

### 4. バッファ範囲の指定 (Scrolling)

`range` オプションを使うことで、過去のログ（スクロールバック）も含めた情報を取得できます。

```typescript
// 全バッファを取得（スクロールバック + 現在の画面）
const fullLog = session.getSnapshot({ range: 'all' });

// 現在のビューポートのみ取得（デフォルト）
const viewportOnly = session.getSnapshot({ range: 'viewport' });
```

## Wait API & Polling

TUIアプリケーションでは「画面が変化するまで待つ」「出力が落ち着くまで待つ」といった同期待機が重要です。

```typescript
import { waitForText, waitForSilence, waitForChange, waitForStable } from 'conch';

// 1. 特定の文字が出るまで待つ
await waitForText(session, /Package installed/);

// 2. 画面に変化があるまで待つ
// 何かキーを押した後、画面が更新されるのを待つ場合に有用
session.press('Enter');
await waitForChange(session);

// 3. 画面が安定するまで待つ
// topコマンドやアニメーションなど、激しく更新される画面が落ち着くのを待つ
await waitForStable(session, 500); // 500ms変化がなければ完了

// 4. 出力が止まるのを待つ (Raw Outputベース)
await waitForSilence(session, 500);
```

## Advanced Usage

### Custom Formatting (Snapshot Hook)

スナップショット生成時にフックを挟むことで、行番号の付与や特定の色の強調などが可能です。
Formatter には `ctx` として座標情報が渡されます。

```typescript
const snapshot = session.getSnapshot({
  formatter: (line, ctx) => {
    // ctx.bufferY   : バッファ全体での行番号 (0..1000+)
    // ctx.snapshotY : 取得した範囲内での行番号 (0..24)
    const lineContent = line.translateToString(true);
    return `${ctx.snapshotY.toString().padStart(2, '0')} | ${lineContent}`;
  }
});
```

### Locator Functions

取得したスナップショットから、特定の領域や文字列を抽出するためのユーティリティ関数です。

```typescript
import { cropText, findText } from 'conch';

const snapshot = session.getSnapshot();

// 1. 指定した矩形領域のテキストを抽出
const sidebarText = cropText(snapshot, { x: 0, y: 0, width: 20, height: 10 });

// 2. 文字列の座標を検索
const matches = findText(snapshot, 'Error');
matches.forEach(m => {
  console.log(`Found at (${m.x}, ${m.y})`);
});
```

### Handling Colors (ANSI)

`formatter` 内で `line.getCell(x)` を使うと、各セルの色情報や文字スタイルにアクセスできます。

```typescript
session.getSnapshot({
  formatter: (line, ctx) => {
    let output = '';
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell) continue;
      // 前景色(fg)などの判定ロジックをここに記述
      output += cell.getChars();
    }
    return output;
  }
});
```

### Human Intervention (Telnet)

人間が外部から接続して、エージェントの操作を監視したり、割り込んだりできます。
（実装予定: Telnetサーバー機能の統合）

```bash
# 別のターミナルから接続
$ telnet localhost 3007
```
