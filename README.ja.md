# Conch 🐚

> **Headless Terminal Driver for TUI Testing & Automation**

[![CI](https://github.com/youseiushida/conch/workflows/CI/badge.svg)](https://github.com/youseiushida/conch/actions)
![License](https://img.shields.io/github/license/youseiushida/conch)

> ⚠️ これは [README.md](./README.md) の日本語訳です。最新情報は英語版をご確認ください。

Conch（コンク）は、ターミナルアプリケーションをプログラムから制御するための堅牢なライブラリです。
`node-pty` によるプロセス管理と、`@xterm/headless` による正確なターミナルエミュレーションを組み合わせることで、以下を実現します。

*   **TUIアプリのテスト:** Vim, k9s, inquirer など、対話的なCLIツールの統合テストを自信を持って記述できます。
*   **ターミナル操作の自動化:** 複雑なターミナル画面を操作し、特定の状態を待機したり、情報を抽出するBotを作成できます。

一言で言えば、**「ターミナル版 Playwright」** です。

## 特徴

*   **正確なエミュレーション:** `xterm.js` (headless) を採用し、カーソル位置、色、代替バッファなど、実際の画面状態を正確に再現します。
*   **Flakiness（不安定さ）の排除:** `waitForText`, `waitForSilence`, `waitForStable` などの待機ユーティリティを標準装備。`sleep()` に頼ることなく、非同期なターミナル出力を確実にハンドリングできます。
*   **人間らしい入力:** `Enter`, `Esc`, `Ctrl+C` などのキー入力や、自然なタイピングをシミュレートできます。
*   **スナップショットエンジン:** 任意のタイミングでターミナルの「見た目（Visual State）」を取得し、ユーザーが実際に何を見ているかを検証できます。
*   **TUIアプリサポート:** ターミナルクエリ自動応答機能（DA1, DA2, CPR, DECRQM）を内蔵しており、vim, less, nano, top などの対話的TUIアプリをヘッドレスモードで正しく描画できます。
*   **拡張可能なバックエンド:** Local PTY、Docker、SSH をサポート。さらに他のバックエンドにも拡張可能な設計です。

## LLM/エージェントがCLI/TUIを“止めずに”扱うための基盤として

LLMは「次に何をするか」の判断は得意ですが、CLI/TUIを安定して操作するには **実行基盤** が必要です。Conchは以下をまとめて提供します。

- **観測**: `getSnapshot()` による決定的な画面状態（viewport / scrollback含むall）
- **操作**: `run()`, `pressAndSnapshot()`, `typeAndSnapshot()`
- **待機**: `waitForText` / `waitForStable` / `waitForSilence` による“sleep不要”な同期
- **コマンド境界**: 任意で **OSC 133（Shell Integration）** を有効化し、プロンプト復帰・完了・終了コードをより正確に検知

これにより、対話的なTUIアプリでも *snapshot → 判断 → 操作 → 待機 → snapshot* のループで、止まりにくい自動化を組めます。

```typescript
import { Conch } from "@ushida_yosei/conch";

const conch = await Conch.launch({
  backend: { type: "localPty", file: process.platform === "win32" ? "powershell.exe" : "bash", env: process.env },
  cols: 100,
  rows: 30,
  timeoutMs: 30_000,
  shellIntegration: { enable: true, strict: false }, // run()の信頼性が上がる
});

try {
  // (1) TUIを起動
  await conch.run("htop", { strict: false }); // 例。対象は任意のTUIアプリ

  // (2) エージェントループ: 観測 → 判断 → 操作
  for (let step = 0; step < 20; step++) {
    const snap = conch.getSnapshot({ range: "viewport" });
    const screen = snap.text;

    // ここでLLM/ルールが画面状態から次のキー入力を決める
    const nextKey = screen.includes("Help") ? "F1" : "ArrowDown";

    await conch.pressAndSnapshot(nextKey, { wait: { kind: "change", timeoutMs: 5_000 } });
  }
} finally {
  conch.dispose();
}
```

## インストール

npm:

```bash
npm install @ushida_yosei/conch
# or
pnpm add @ushida_yosei/conch
```

## クイックスタート

シェルを起動し、コマンドを実行して、その出力を検証するシンプルな例です。

```typescript
import { Conch } from '@ushida_yosei/conch';

async function main() {
  // 1. 起動（backend 作成 + spawn + session 生成）
  const conch = await Conch.launch({
    backend: { type: 'localPty', file: 'bash', args: [], env: process.env },
    cols: 80,
    rows: 24,
    timeoutMs: 30_000,
  });

  // 2. コマンド実行（完了待機はしない）
  conch.execute('echo "Hello Conch"');

  // 3. 仮想画面上に指定の文字が出るまで待機
  await conch.waitForText('Hello Conch');

  // 4. 画面の状態（スナップショット）を取得して表示
  const snapshot = conch.getSnapshot();
  console.log('--- Terminal Screen ---');
  console.log(snapshot.text);

  // 後始末
  conch.dispose();
}

main();
```

## Docker Backend (DockerPty)

Local PTY の代わりに Docker コンテナをバックエンドとして利用できます。

```typescript
import { Conch } from "@ushida_yosei/conch";

const conch = await Conch.launch({
  backend: {
    type: "docker",
    image: "alpine:latest",
    cmd: ["/bin/sh"], // デフォルト
    autoRemove: true,
  },
  cols: 80,
  rows: 24,
  timeoutMs: 30_000,
});

try {
  const r = await conch.run('echo "hello from docker"', { strict: false });
  console.log(r.outputText);
} finally {
  conch.dispose();
}
```

注意点:

- Docker デーモンに接続できる必要があります（Docker Desktop / dockerd）。
- TTY モードでは stdout/stderr は単一ストリームにまとまります（分離できません）。
- Docker 内で Shell Integration（OSC 133）を使う場合、`bash` を含むイメージ＋ `cmd: ["bash"]` の指定が必要になることが多いです（デフォルトは `/bin/sh`）。

## SSH Backend (SshPty)

SSH 経由でリモートサーバー上のシェルをバックエンドとして利用できます。

```typescript
import { Conch } from "@ushida_yosei/conch";
import { readFileSync } from "fs";

const conch = await Conch.launch({
  backend: {
    type: "ssh",
    host: "example.com",
    username: "user",
    privateKey: readFileSync("/path/to/key"),
    // または: password: "secret",
    // または: agent: process.env.SSH_AUTH_SOCK,
  },
  cols: 80,
  rows: 24,
  timeoutMs: 30_000,
  shellIntegration: { enable: true, strict: false },
});

try {
  const r = await conch.run('echo "hello from SSH"');
  console.log(r.outputText); // "hello from SSH"
  console.log(r.exitCode);   // 0
} finally {
  conch.dispose();
}
```

注意点:

- ピア依存として `ssh2` が必要です: `npm install ssh2`
- パスワード認証、秘密鍵認証（パスフレーズ付き対応）、SSH エージェント認証をサポートしています。
- 接続断は致命的エラーとして扱われます（自動再接続なし）。再接続するには新しいインスタンスを作成してください。
- リモートシェルが bash の場合、SSH 経由でも Shell Integration（OSC 133）が動作します。
- 自動化ユースケース向けに、ホスト鍵検証はデフォルトで無効です。厳密に検証する場合は `hostVerifier` を指定してください。

## TUIアプリケーションサポート

Conch はヘッドレスモードで対話的な TUI アプリケーション（vim, less, nano, top, tmux）を操作できます。内蔵のターミナルクエリ自動応答機能が、これらのアプリが起動時に送信する DA/CPR/DECRQM シーケンスを処理します。

```typescript
const conch = await Conch.launch({
  backend: { type: "localPty", file: "bash", env: process.env },
  cols: 80,
  rows: 24,
  timeoutMs: 30_000,
});

// vim を開いてテキストを入力し、保存して終了
conch.execute('vim --cmd "set t_RV=" /tmp/test.txt');
await conch.waitForText("~", { timeoutMs: 5_000 }); // vim の UI を待機

conch.press("i");                        // インサートモード
conch.type("Hello from Conch!");
conch.press("Escape");
conch.type(":wq");
conch.press("Enter");
await conch.waitForStable({ durationMs: 500 });

conch.dispose();
```

| プログラム | 状態 | 備考 |
|-----------|------|------|
| vim/vi | ✅ | `--cmd "set t_RV="` を指定すると即座に描画される（指定しない場合、PTY バッファリングにより約4秒の遅延あり） |
| less | ✅ | 代替バッファ、検索、PageDown すべて動作 |
| nano | ✅ | 代替バッファ、テキスト入力、Ctrl+X 終了すべて動作 |
| top | ✅ | バッチモード（`-b -n 1`）動作。インタラクティブモードも遅延付きで動作 |
| tmux | ✅ | セッション作成/アタッチ、tmux 内コマンド、セッション後始末 |

## ドキュメント

*   [**利用ガイド (USAGE.md)**](./docs/USAGE.ja.md): 詳細なコード例とベストプラクティス
*   [**API リファレンス (API.md)**](./docs/API.ja.md): `Conch`、バックエンド（`LocalPty` / `DockerPty`）、ユーティリティ関数の詳細仕様
*   [**ソースコード解説 (src/README.md)**](./src/README.ja.md): 内部アーキテクチャの解説

## ロードマップ

*   [ ] **Interaction Layer:** 外部エージェント（MCP, WebSocketサーバー等）と接続するための抽象インターフェース
*   [x] **Shell Integration (OSC 133):** フル A/B/C/D 対応によるコマンド境界（完了イベント）と終了コードの検知
*   [ ] **Telnet/SSH Server:** 自動操作中のセッションに人間が介入・監視できるサーバー機能

## ライセンス

MIT
