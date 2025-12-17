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
*   **拡張可能なバックエンド:** デフォルトの Local PTY に加え、将来的に Docker や SSH への対応も可能な設計になっています。

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

## ドキュメント

*   [**利用ガイド (USAGE.md)**](./docs/USAGE.ja.md): 詳細なコード例とベストプラクティス
*   [**API リファレンス (API.md)**](./docs/API.ja.md): `ConchSession`, `LocalPty`, ユーティリティ関数の詳細仕様
*   [**ソースコード解説 (src/README.md)**](./src/README.ja.md): 内部アーキテクチャの解説

## ロードマップ

*   [ ] **Interaction Layer:** 外部エージェント（MCP, WebSocketサーバー等）と接続するための抽象インターフェース
*   [ ] **Shell Integration:** OSC 133 をサポートし、コマンドの完了イベントを正確に検知する機能
*   [ ] **Telnet/SSH Server:** 自動操作中のセッションに人間が介入・監視できるサーバー機能

## ライセンス

MIT
