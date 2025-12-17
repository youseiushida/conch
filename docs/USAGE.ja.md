# Usage Guide

> ⚠️ これは [USAGE.md](./USAGE.md) の日本語訳です。最新情報は英語版をご確認ください。

Conch はターミナルアプリケーションを制御するための堅牢なライブラリです。
操作 (Action)、待機 (Wait)、スナップショット取得 (Snapshot) を一つのアトミックな操作としてまとめた高レベルAPI (`Conch` ファサード) を提供し、信頼性の高い自動化スクリプトを実現します。

## 1. Getting Started

Conch を利用する推奨方法は `Conch.launch()` メソッドを使うことです。これにより、バックエンドの作成、セッションの初期化、そしてシェル統合（Shell Integration）のセットアップを一括で行えます。

```typescript
import { Conch } from '@ushida_yosei/conch';

// 1. セッションの開始
const conch = await Conch.launch({
  // バックエンド設定（省略時は自動判定されますが、明示的な指定を推奨）
  backend: {
    type: 'localPty',
    file: process.platform === 'win32' ? 'powershell.exe' : 'bash',
    args: [],
    env: process.env,
  },
  // ターミナルサイズ
  cols: 80,
  rows: 24,
  // 全操作のデフォルトタイムアウト
  timeoutMs: 30_000,
});

try {
  // 2. コマンドを実行し、完了するまで待機する
  // デフォルトでは、出力が落ち着くまで待機します（fallbackモード）。
  const result = await conch.run('echo "Hello Conch"');
  
  console.log(result.outputText); // "Hello Conch"
  console.log(result.exitCode);   // undefined (Shell Integrationが無効な場合)

} finally {
  // 3. プロセスを終了するために必ず dispose を呼ぶ
  conch.dispose();
}
```

## 2. High-Level API (Action + Wait + Snapshot)

Conch の高レベルメソッドは、「操作を行い、特定の状態（画面更新など）を待ち、結果のスナップショットを返す」という一連の流れを実行します。これにより、コードから不安定な `sleep` を排除できます。

### `run(command, options?)`

シェルコマンドを実行し、完了を待機します。

- **戻り値**: `RunResult` (exitCode, outputText, snapshot)
- **待機戦略**:
  - **Shell Integration** が有効な場合: コマンド完了イベント (OSC 133) を正確に待ちます。
  - 無効な場合: 出力が止まるのを待ちます (fallback)。

```typescript
const { exitCode, outputText } = await conch.run('ls -la', {
  timeoutMs: 5000,
  strict: true // タイムアウト時にエラーを投げる
});
```

### `pressAndSnapshot(key, options?)`

キー入力をシミュレートし、画面が変化するのを待ちます。TUIアプリのナビゲーションに最適です。

- **デフォルト待機**: `change` (画面内容が変わるまで待つ)

```typescript
// 下矢印キーを押して、選択項目が移動するのを待つ
const { snapshot } = await conch.pressAndSnapshot('ArrowDown');

// 新しい状態を検証
if (snapshot.text.includes('> Selected Item')) {
  // ...
}
```

### `typeAndSnapshot(text, options?)`

文字列を入力し、画面をキャプチャします。

- **デフォルト待機**: `drain` (xtermが入力を処理し終わるのを待つ。高速。)

```typescript
// 検索クエリを入力
await conch.typeAndSnapshot('search query');

// 必要に応じて待機戦略をオーバーライド可能
await conch.typeAndSnapshot('enter', {
  wait: { kind: 'stable', durationMs: 500 } // 入力後、500ms画面が安定するのを待つ
});
```

## 3. Shell Integration (OSC 133)

最も信頼性の高いコマンド実行制御を行うには、Shell Integration を有効にしてください。
これはシェルに小さなスクリプトを注入し、OSC 133 エスケープシーケンスを発行させることで、Conch がプロンプトの戻りや終了コードを正確に検知できるようにする機能です。

```typescript
const conch = await Conch.launch({
  backend: { type: 'localPty', ... },
  shellIntegration: {
    enable: true,
    shell: 'bash', // 'bash' または 'pwsh' (省略時は自動検知を試みるが明示推奨)
    strict: false, // trueの場合、注入失敗時にエラーになる
  }
});

// これにより、run() で実際の終了コードを取得できるようになります！
const { exitCode } = await conch.run('exit 42');
console.log(exitCode); // 42
```

## 4. Manual Control & Assertions

より細かい制御のために、待機関数や抽出関数を利用できます。

### Wait Utilities

`conch` インスタンスのメソッドとして、または単体の関数として利用可能です。

```typescript
// 特定のテキストが現れるまで待つ
await conch.waitForText(/Success/);

// 画面が変化しなくなる（安定する）まで待つ (アニメーションやスピナー待ちに有用)
await conch.waitForStable({ durationMs: 1000 });

// 新しいデータ出力が止まるまで待つ
await conch.waitForSilence({ durationMs: 500 });
```

### Locator Functions (Instance Methods)

画面内容を検証・抽出するためのショートカットメソッドです。

```typescript
// 現在の画面テキストを取得
const text = conch.screenText();

// テキストが存在するか確認 (boolean)
if (conch.hasText('Error')) { ... }

// テキストの座標を検索
const matches = conch.findText('Error');

// 特定の領域からテキストを抽出
const status = conch.cropText({ x: 0, y: 23, width: 80, height: 1 });
```

## 5. Low-Level Usage (`ConchSession`)

`Conch` ファサードを使わず、`ConchSession` と `ITerminalBackend` を手動で管理する場合の使用法です。

```typescript
import { ConchSession, LocalPty } from '@ushida_yosei/conch';

const pty = new LocalPty('bash');
const session = new ConchSession(pty);

await pty.spawn();

session.write('ls\r'); // 生の書き込み
// 待機は手動で行う必要があります
await waitForText(session, 'package.json');
```

## Appendix: Available Key Names

`press()` や `pressAndSnapshot()` で使用可能なキー名の一例です:

- `Enter`, `Backspace`, `Tab`, `Escape`
- `ArrowUp`, `ArrowDown`, `ArrowRight`, `ArrowLeft`
- `Home`, `End`, `PageUp`, `PageDown`, `Insert`, `Delete`
- `F1` ～ `F12`
- `Ctrl+C` (その他の `Ctrl+*` コンビネーションも可)
