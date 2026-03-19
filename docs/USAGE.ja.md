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
  // 推奨: `run()` の完了検知と終了コード取得を安定させる（OSC 133）
  shellIntegration: { enable: true, strict: false },
});

try {
  // 2. コマンドを実行し、完了するまで待機する
  // Shell Integration が有効なら、`run()` で実際の終了コードを取得できます。
  const result = await conch.run('echo "Hello Conch"', { timeoutMs: 5000 });
  
  console.log(result.outputText); // "Hello Conch"
  console.log(result.exitCode);   // 0 (Shell Integrationが有効な場合)

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
  - 無効な場合: `timeoutMs` まで待ちます。
    - `strict: false`（デフォルト）: `exitCode: undefined` で解決します（`meta.method: "fallback"`）。
    - `strict: true`: タイムアウトでrejectします。
  - バックエンドが `ITerminalBackend.onError` を提供する場合、`run()` はデフォルトでタイムアウトを待たずに失敗できます。従来通りタイムアウトfallbackにしたい場合は `backendError: "ignore"` を指定します。

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

- **デフォルト待機**: `change` (画面内容が変わるまで待つ。PTYエコーがスナップショットに反映されることを保証します。)

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
これはシェルに小さなスクリプトを注入し、完全な A/B/C/D マーカーを含む OSC 133 エスケープシーケンスを発行させることで、Conch がプロンプトの戻りや終了コードを正確に検知できるようにする機能です。

**マーカー**:
- **A** (Prompt Start) -- プロンプト表示前に発行
- **B** (Command Start) -- プロンプト表示後に発行（ユーザー入力領域の開始）
- **C** (Command Executed) -- コマンド実行直前に発行（bash: DEBUG trap、pwsh: PSReadLine Enter ハンドラ）
- **D** (Command Finished) -- 次のプロンプトで終了コードとともに発行

`run()` は C/D の境界を使って決定的に出力を抽出します。ヒューリスティクスは不要です。

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

## 6. Docker Backend (`DockerPty`)

Local PTY の代わりに Docker コンテナをバックエンドとして利用できます:

```typescript
import { Conch } from "@ushida_yosei/conch";

const conch = await Conch.launch({
  backend: {
    type: "docker",
    image: "alpine:latest",
    cmd: ["/bin/sh"],
    autoRemove: true,
  },
  cols: 80,
  rows: 24,
  timeoutMs: 30_000,
});

try {
  const r = await conch.run('echo "hello from docker"', {
    timeoutMs: 1000,
    strict: false,
  });
  console.log(r.outputText);
} finally {
  conch.dispose();
}
```

注意点:

- Docker デーモンに接続できる必要があります（Docker Desktop / dockerd）。
- TTY モードでは stdout/stderr は単一ストリームにまとまります（分離できません）。
- Docker 内で Shell Integration（OSC 133）を使う場合、`bash` を含むイメージ＋ `cmd: ["bash"]` の指定が必要になることが多いです（デフォルトは `/bin/sh`）。

## 7. SSH Backend (`SshPty`)

Local PTY や Docker の代わりに、SSH経由でリモートマシンをバックエンドとして利用できます:

### パスワード認証

```typescript
import { Conch } from "@ushida_yosei/conch";

const conch = await Conch.launch({
  backend: {
    type: "ssh",
    host: "192.168.1.100",
    port: 22,
    username: "deploy",
    password: "secret",
  },
  cols: 80,
  rows: 24,
  timeoutMs: 30_000,
  shellIntegration: { enable: true, strict: false },
});

try {
  const r = await conch.run('uname -a', { timeoutMs: 5000 });
  console.log(r.outputText);
} finally {
  conch.dispose();
}
```

### 鍵認証

```typescript
import { readFileSync } from "node:fs";

const conch = await Conch.launch({
  backend: {
    type: "ssh",
    host: "example.com",
    username: "admin",
    privateKey: readFileSync("/home/user/.ssh/id_ed25519"),
    passphrase: "optional-passphrase", // 鍵が暗号化されていない場合は省略可
  },
  cols: 120,
  rows: 40,
  timeoutMs: 30_000,
});
```

SSH エージェントを利用する場合は `agent`（例: `process.env.SSH_AUTH_SOCK`）を指定します。

注意点:

- `ssh2` ライブラリが必要です。
- ホスト鍵検証はデフォルトで全て受け入れます（自動化用途向け）。厳密な検証が必要な場合は `hostVerifier` コールバックを指定してください。
- 自動再接続はありません: SSH接続が切断された場合、`run()` は `onError` / `onExit` 経由で即座にrejectされます。
- Shell Integration（OSC 133）はリモートシェルが `bash` または `pwsh` であれば動作します。

## 8. TUI Application Support

Conch にはターミナルクエリ自動応答機能が組み込まれており、vim、less、nano、top、tmux などの対話的なTUIアプリケーションをヘッドレス xterm 内で正しくレンダリングできます。これらのアプリは起動時にターミナル機能クエリ（DA1、DA2、CPR、DECRQM）を送信し、応答があるまでブロックします。Conch はこれらのクエリをインターセプトし、標準的な応答を PTY に書き戻すことで、アプリのブロックを自動的に解除します。

```typescript
// less を起動
conch.execute('less /var/log/syslog');
await conch.waitForStable({ durationMs: 500 });

// ナビゲーション
const { snapshot } = await conch.pressAndSnapshot('PageDown');
console.log(snapshot.text);

// 終了
await conch.pressAndSnapshot('q');
```

```typescript
// nano を起動
conch.execute('nano myfile.txt');
await conch.waitForStable({ durationMs: 500 });

// テキストを入力
await conch.typeAndSnapshot('Hello from Conch!');

// 保存して終了 (Ctrl+O, Enter, Ctrl+X)
conch.press('Ctrl+O');
await conch.pressAndSnapshot('Enter');
await conch.pressAndSnapshot('Ctrl+X');
```

```typescript
// vim を起動 (t_RV= で約4秒の起動遅延を回避)
conch.execute('vim --cmd "set t_RV=" file.txt');
await conch.waitForStable({ durationMs: 1000 });

// インサートモードに入り、テキストを入力
conch.press('i');
await conch.typeAndSnapshot('Hello from Conch!');

// 保存して終了
conch.press('Escape');
await conch.pressAndSnapshot(':');
await conch.typeAndSnapshot('wq');
await conch.pressAndSnapshot('Enter');
```

## Appendix: Available Key Names

`press()` や `pressAndSnapshot()` で使用可能なキー名の一例です:

- `Enter`, `Backspace`, `Tab`, `Escape`
- `ArrowUp`, `ArrowDown`, `ArrowRight`, `ArrowLeft`
- `Home`, `End`, `PageUp`, `PageDown`, `Insert`, `Delete`
- `F1` ～ `F12`
- `Ctrl+C` (その他の `Ctrl+*` コンビネーションも可)
