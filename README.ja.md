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

## インストール

> ⚠️ **まだnpmには公開されていません。** GitHubから直接インストールしてください：

```bash
npm install github:youseiushida/conch
# or
pnpm add github:youseiushida/conch
```

## クイックスタート

シェルを起動し、コマンドを実行して、その出力を検証するシンプルな例です。

```typescript
import { ConchSession, LocalPty, waitForText } from 'conch';

async function main() {
  // 1. バックエンド(node-pty) と セッション(xterm emulator) のセットアップ
  const pty = new LocalPty('bash', [], { cols: 80, rows: 24 });
  const session = new ConchSession(pty);

  // 2. プロセス起動
  await pty.spawn();

  // 3. コマンド実行
  // .execute() は自動的に改行コード(\r)を付与します
  session.execute('echo "Hello Conch"');

  // 4. 仮想画面上に指定の文字が出るまで待機
  await waitForText(session, 'Hello Conch');

  // 5. 画面の状態（スナップショット）を取得して表示
  const snapshot = session.getSnapshot();
  console.log('--- Terminal Screen ---');
  console.log(snapshot.text);

  // 後始末
  session.dispose();
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
