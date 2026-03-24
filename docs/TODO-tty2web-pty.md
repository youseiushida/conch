# TODO: Tty2webPty — tty2web WebSocket ターミナルバックエンド

## 概要

[tty2web](https://github.com/nicholasgasior/tty2web) (GoTTY のアクティブフォーク) が公開する
WebSocket エンドポイントに接続し、リモートシェルを操作する `ITerminalBackend` を提供する。

tty2web は GoTTY のメンテ停止を受けて開発が続けられているフォークで、
GoTTY のコアプロトコルを維持しつつ以下の機能が追加されている:

- **ファイル転送**: ブラウザとターミナル間のファイルアップロード/ダウンロード
- **リバースモード**: tty2web 側からクライアントに接続（NAT 越え）
- **改善された認証**: トークンベース認証の強化
- **監査ログ**: セッションの記録

## GoTTY との関係

| | GoTTY | tty2web |
|---|---|---|
| 本家 | yudai/gotty（メンテ停止） | nicholasgasior/tty2web（アクティブ） |
| ベースプロトコル | Binary WS + 1-byte type | **GoTTY 互換** |
| 追加機能 | なし | ファイル転送、リバース、監査 |
| デフォルトポート | 8080 | 8080 |
| 書き込み権限 | `--permit-write` | `--permit-write` |
| 認証 | `--credential` | `--credential` + トークン拡張 |

### GoTTYPty がそのまま使えるか？

**コアプロトコルは互換。** GoTTY のメッセージタイプ（INPUT=0, RESIZE=1, OUTPUT=0 等）は
tty2web でもそのまま動作する可能性が高い。ただし:

1. **ファイル転送用の追加メッセージタイプ** が存在する可能性がある → 未知のタイプは無視すれば安全
2. **ハンドシェイクの拡張** があるかもしれない → 互換性テストで検証が必要
3. **リバースモード** は接続方向が逆になるため、通常の `spawn()` フローとは異なる

そのため、`GoTTYPty` をそのまま使えるケースと、`Tty2webPty` が必要なケースの両方がある:

- **基本機能のみ**: `GoTTYPty` で接続可能（type: "gotty" で URL を tty2web に向ける）
- **ファイル転送/リバース等の拡張機能**: `Tty2webPty` が必要

## tty2web プロトコル仕様

### 基本プロトコル (GoTTY 互換部分)

GoTTY と同一。`TODO-gotty-pty.md` を参照。

### クライアント → サーバー

| タイプ | 値 | ペイロード | 説明 |
|---|---|---|---|
| INPUT | `0` | UTF-8 文字列 | 標準入力 |
| RESIZE | `1` | JSON `{"columns":N,"rows":N}` | リサイズ |
| PING | `2` | なし | キープアライブ |

### サーバー → クライアント

| タイプ | 値 | ペイロード | 説明 |
|---|---|---|---|
| OUTPUT | `0` | UTF-8 文字列 | 標準出力 |
| SET_WINDOW_TITLE | `1` | UTF-8 文字列 | タイトル設定 |
| SET_RECONNECT | `2` | 数値文字列 | 再接続間隔 |

### 拡張プロトコル (tty2web 固有)

**注意: 以下は tty2web のソースコードから推測した仕様であり、実機検証が必要。**

#### ファイル転送

tty2web はファイル転送用に追加のメッセージタイプまたは別の WebSocket エンドポイントを使用する可能性がある。

```
# ファイルアップロード（推測）
POST /upload?token=...
Content-Type: multipart/form-data

# ファイルダウンロード（推測）
GET /download/{filename}?token=...
```

#### リバースモード

通常モードでは Client → Server に接続するが、リバースモードでは:

```
tty2web (behind NAT)  ───connect───>  Relay Server
Client                ───connect───>  Relay Server
```

Conch からの利用:
- 通常モード: `Tty2webPty` で直接接続（GoTTY 互換）
- リバースモード: Relay Server の URL に接続（WebSocket エンドポイントは同じ）

## API 設計

```typescript
export interface Tty2webPtyOptions {
  /** WebSocket URL */
  url: string;

  cols?: number;
  rows?: number;

  /** 認証 */
  credentials?: {
    username: string;
    password: string;
  };

  /** 追加ヘッダー */
  headers?: Record<string, string>;

  /** 接続タイムアウト ms (default: 10000) */
  connectTimeout?: number;

  /** Ping 間隔 ms (default: 30000) */
  pingInterval?: number;

  // --- tty2web 拡張機能 ---

  /** ファイル転送を有効にするか (default: false) */
  enableFileTransfer?: boolean;
}
```

### BackendConfig

```typescript
// src/types.ts に追加
| {
    type: "tty2web";
    url: string;
    credentials?: { username: string; password: string };
    headers?: Record<string, string>;
    connectTimeout?: number;
    pingInterval?: number;
    enableFileTransfer?: boolean;
  }
```

## 実装方針

### Phase 1: GoTTY 互換コア

tty2web の基本接続は GoTTY と同一プロトコルのため、`GoTTYPty` とほぼ同じ構造。
ただし独立したクラスとして実装する（将来の拡張機能追加時に GoTTYPty に影響を与えないため）。

```typescript
// src/backend/Tty2webPty.ts

import { StringDecoder } from "node:string_decoder";
import type { IDisposable, ITerminalBackend } from "../types";

const MSG_INPUT = 0;
const MSG_RESIZE = 1;
const MSG_PING = 2;
const MSG_OUTPUT = 0;

export class Tty2webPty implements ITerminalBackend {
  // GoTTYPty とほぼ同じ構造。
  // 差分:
  //   - id が "tty2web-..." プレフィックス
  //   - 将来の拡張メソッド用のフック

  constructor(private options: Tty2webPtyOptions) {}

  get id(): string {
    return `tty2web-${new URL(this.options.url).host}`;
  }

  get processName(): string {
    return new URL(this.options.url).host;
  }

  // spawn, write, resize, dispose 等は GoTTYPty と同一ロジック
  // ...

  // --- tty2web 拡張 ---

  /**
   * ファイルをアップロードする（tty2web 拡張機能）
   * ターミナルセッションに紐づくファイル転送。
   */
  async uploadFile?(
    filename: string,
    content: Buffer,
  ): Promise<void> {
    // tty2web のファイル転送 API を叩く
    // 実装は Phase 2
  }

  /**
   * ファイルをダウンロードする（tty2web 拡張機能）
   */
  async downloadFile?(filename: string): Promise<Buffer> {
    // 実装は Phase 2
  }
}
```

### Phase 2: ファイル転送

tty2web のファイル転送プロトコルを調査し、`uploadFile` / `downloadFile` メソッドを実装。
これらは `ITerminalBackend` インターフェースの外にある拡張メソッド。

```typescript
// 利用例
const conch = await Conch.launch({
  backend: {
    type: "tty2web",
    url: "ws://localhost:8080",
    enableFileTransfer: true,
  },
  // ...
});

// ファイル転送は backend に直接アクセス
const tty2web = conch.backend as Tty2webPty;
await tty2web.uploadFile("config.yaml", Buffer.from("key: value"));
```

## GoTTY 互換性テスト計画

GoTTYPty で tty2web に接続できるかの検証:

```typescript
// tests/e2e/tty2web-compat.e2e.test.ts

describe("tty2web GoTTY compatibility", () => {
  it("should connect using GoTTYPty", async () => {
    // tty2web コンテナを起動
    // GoTTYPty で接続してコマンド実行
    // → 成功すれば「GoTTYPty でも使える」ことが確認される
  });

  it("should connect using Tty2webPty", async () => {
    // Tty2webPty で接続して同じテスト
    // → 両方動けば、ユーザーはどちらを使っても良い
  });
});
```

## 利用例

### 基本（GoTTY 互換モード）

```typescript
import { Conch } from "@ushida_yosei/conch";

// tty2web --permit-write bash
const conch = await Conch.launch({
  backend: {
    type: "tty2web",
    url: "ws://localhost:8080",
  },
  cols: 80,
  rows: 24,
  shellIntegration: { enable: true, strict: false },
});

try {
  const r = await conch.run('echo "hello from tty2web"');
  console.log(r.outputText);
} finally {
  conch.dispose();
}
```

### GoTTYPty で代用する場合

```typescript
// プロトコル互換なので GoTTYPty でも接続可能
const conch = await Conch.launch({
  backend: {
    type: "gotty", // GoTTYPty を使用
    url: "ws://localhost:8080", // tty2web サーバーの URL
  },
  // ...
});
```

## ファイル構成

```
src/
  backend/
    Tty2webPty.ts             ← メインクラス
  types.ts                    ← BackendConfig に tty2web 追加
  backendFactory.ts           ← createBackend に tty2web 追加
tests/
  tty2webPty.test.ts          ← ユニットテスト
  e2e/
    tty2web.e2e.test.ts       ← tty2web コンテナとの E2E テスト
    tty2web-compat.e2e.test.ts ← GoTTYPty 互換性テスト
```

## 依存ライブラリ

| ライブラリ | 用途 | 種別 |
|---|---|---|
| `ws` | WebSocket（Node.js 22 未満） | peerDependency (optional、TtydPty/GoTTYPty と共有) |

## 見積もり

| カテゴリ | 行数 |
|---|---|
| Tty2webPty.ts（Phase 1: コア） | ~200行 |
| Tty2webPty.ts（Phase 2: ファイル転送） | ~80行 |
| types.ts 変更 | ~15行 |
| backendFactory.ts 変更 | ~15行 |
| テスト（unit） | ~60行 |
| テスト（e2e + 互換性） | ~80行 |
| ドキュメント | ~20行 |
| **合計（Phase 1）** | **~310行** |
| **合計（Phase 1 + 2）** | **~470行** |

## 優先度

**Medium** — GoTTYPty の後。GoTTY 互換が確認されれば Phase 1 はほぼコピーで済む。
ファイル転送等の拡張機能の実装は需要を見てから。

## 実装順序

1. **Phase 1**: GoTTY 互換コア + GoTTYPty 互換性テスト
2. **Phase 2**: ファイル転送 (`uploadFile` / `downloadFile`)
3. **Phase 3**: リバースモード対応（需要があれば）

## 事前調査が必要な項目

- [ ] tty2web のファイル転送プロトコルの正確な仕様（ソースコード読解）
- [ ] リバースモードの Relay Server プロトコル
- [ ] GoTTYPty での接続互換性の実機検証
- [ ] tty2web の Docker イメージの入手方法（公式イメージがあるか）
