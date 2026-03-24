# TODO: TtydPty — ttyd WebSocket ターミナルバックエンド

## 概要

[ttyd](https://github.com/tsl0922/ttyd) が公開する WebSocket エンドポイントに接続し、
リモートシェルを操作する `ITerminalBackend` を提供する。

ttyd は最も普及した Web ターミナル共有ツール。C ベース、軽量、長期メンテされている。
`docker run -p 7681:7681 tsl0922/ttyd bash` の 1 行でターミナルをブラウザに公開できる。

## 動機

### ユースケース

1. **サンドボックス実行**: ttyd を Docker コンテナ内で起動し、WebSocket 経由で接続。SSH 鍵管理が不要。
2. **既存 WebTerminal への接続**: 社内の Web ターミナル (ttyd ベース) に Conch から接続して自動操作。
3. **CI/CD**: GitHub Actions 等で ttyd コンテナをサイドカーとして起動し、テスト環境に接続。
4. **コーディングエージェント**: クラウド上のサンドボックス環境に WebSocket で接続してコード実行。
5. **再接続**: WebSocket の接続断から自動復帰（SSH にはない利点）。

### なぜ SSH ではなく ttyd か

| | SSH (`SshPty`) | ttyd (`TtydPty`) |
|---|---|---|
| 認証 | 鍵/パスワード管理が必要 | URL のみ or Basic 認証 |
| ファイアウォール | ポート 22 がブロックされがち | HTTP/HTTPS (80/443) で通過 |
| セットアップ | sshd + ユーザー + 鍵配置 | `docker run tsl0922/ttyd bash` |
| ブラウザ連携 | 不可 | ブラウザからも同じターミナルにアクセス可能 |
| 再接続 | なし（新規セッション） | ttyd がネイティブサポート |

## ttyd プロトコル仕様

### 接続

- **URL**: `ws://host:port/ws`（デフォルトポート 7681）
- **プロトコル**: Binary WebSocket
- **フレーム形式**: 先頭 1 バイトがメッセージタイプ、残りがペイロード

### クライアント → サーバー (入力)

| タイプ | 値 | ペイロード | 説明 |
|---|---|---|---|
| INPUT | `0` | UTF-8 文字列 | 標準入力データ |
| RESIZE | `1` | JSON `{"columns":N,"rows":N}` | ターミナルリサイズ |
| PAUSE | `2` | なし | 出力一時停止 (XON/XOFF) |
| RESUME | `3` | なし | 出力再開 |
| JSON_DATA | `{` | JSON | 認証トークン等（ttyd v1.7+） |

### サーバー → クライアント (出力)

| タイプ | 値 | ペイロード | 説明 |
|---|---|---|---|
| OUTPUT | `0` | UTF-8 文字列 | 標準出力データ |
| SET_WINDOW_TITLE | `1` | UTF-8 文字列 | ウィンドウタイトル設定 |
| SET_PREFERENCES | `2` | JSON | ターミナル設定 |

### 接続シーケンス

```
Client                        Server (ttyd)
  |                              |
  |--- WebSocket CONNECT ------->|  ws://host:7681/ws
  |<-- HTTP 101 Upgrade ---------|
  |                              |
  |<-- [0] OUTPUT (banner) ------|  シェルの初期出力
  |--- [1] RESIZE (JSON) ------->|  初回リサイズ
  |--- [0] INPUT (keystroke) --->|  ユーザー入力
  |<-- [0] OUTPUT (response) ----|  コマンド出力
  |                              |
```

### 認証

ttyd は以下の認証方式をサポート:

1. **Basic 認証**: `--credential user:pass` で起動。WebSocket ハンドシェイク時に `Authorization: Basic ...` ヘッダー。
2. **URL トークン**: ttyd v1.7+ の `--auth-header` やリバースプロキシ経由。
3. **なし**: デフォルト（開発/ローカル用途）。

## API 設計

```typescript
export interface TtydPtyOptions {
  /** WebSocket URL (e.g. "ws://localhost:7681" or "wss://example.com") */
  url: string;

  cols?: number;
  rows?: number;

  /** Basic 認証 */
  credentials?: {
    username: string;
    password: string;
  };

  /** カスタムトークン（リバースプロキシ/ttyd v1.7+ 用） */
  token?: string;

  /** 再接続設定 */
  reconnect?: boolean;
  /** 最大再接続回数 (default: 5) */
  reconnectAttempts?: number;
  /** 再接続間隔 ms (default: 1000、exponential backoff) */
  reconnectDelay?: number;

  /** 追加 WebSocket ヘッダー（auth プロキシ等） */
  headers?: Record<string, string>;

  /** 接続タイムアウト ms (default: 10000) */
  connectTimeout?: number;
}
```

### BackendConfig

```typescript
// src/types.ts に追加
| {
    type: "ttyd";
    url: string;
    credentials?: { username: string; password: string };
    token?: string;
    reconnect?: boolean;
    reconnectAttempts?: number;
    reconnectDelay?: number;
    headers?: Record<string, string>;
    connectTimeout?: number;
  }
```

## 実装

```typescript
// src/backend/TtydPty.ts

import { StringDecoder } from "node:string_decoder";
import type { IDisposable, ITerminalBackend } from "../types";

// ttyd メッセージタイプ
const MSG_INPUT = 0;
const MSG_RESIZE = 1;
const MSG_PAUSE = 2;
const MSG_RESUME = 3;

const MSG_OUTPUT = 0;
const MSG_SET_WINDOW_TITLE = 1;
const MSG_SET_PREFERENCES = 2;

export class TtydPty implements ITerminalBackend {
  private ws: WebSocket | undefined;
  private _disposed = false;
  private _ended = false;
  private _dataListeners: ((data: string) => void)[] = [];
  private _exitListeners: ((code: number, signal?: number) => void)[] = [];
  private _errorListeners: ((err: Error) => void)[] = [];
  private disposePromise: Promise<void> | undefined;

  // 再接続
  private _reconnectCount = 0;
  private _lastCols?: number;
  private _lastRows?: number;

  constructor(private options: TtydPtyOptions) {}

  get id(): string {
    return `ttyd-${new URL(this.options.url).host}`;
  }

  get processName(): string {
    return new URL(this.options.url).host;
  }

  async spawn(): Promise<void> {
    if (this._disposed) throw new Error("TtydPty is disposed");
    if (this.ws) throw new Error("TtydPty is already spawned");
    await this.connectWebSocket();
  }

  private async connectWebSocket(): Promise<void> {
    // WebSocket URL 構築
    const wsUrl = this.buildWsUrl();

    // WebSocket インスタンス作成
    // Node.js 22+: globalThis.WebSocket
    // Node.js 18-21: ws パッケージにフォールバック
    const WS = this.resolveWebSocketImpl();
    this.ws = new WS(wsUrl, {
      headers: this.buildHeaders(),
    });

    // 接続待機
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`TtydPty connect timeout (${this.options.connectTimeout ?? 10000}ms)`)),
        this.options.connectTimeout ?? 10000,
      );
      this.ws!.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.ws!.onerror = (e) => {
        clearTimeout(timeout);
        reject(new Error(`TtydPty WebSocket error: ${e}`));
      };
    });

    // メッセージハンドラ
    const decoder = new StringDecoder("utf8");
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (event) => {
      const view = new Uint8Array(event.data as ArrayBuffer);
      if (view.length === 0) return;
      const type = view[0];
      const payload = view.slice(1);

      if (type === MSG_OUTPUT) {
        const text = decoder.write(Buffer.from(payload));
        if (text) this._dataListeners.forEach(l => l(text));
      }
      // SET_WINDOW_TITLE, SET_PREFERENCES は現時点では無視
    };

    this.ws.onclose = () => {
      if (this._disposed || this._ended) return;
      this.handleDisconnect();
    };

    this.ws.onerror = (e) => {
      if (this._disposed || this._ended) return;
      this._errorListeners.forEach(l =>
        l(new Error(`TtydPty WebSocket error: ${e}`)),
      );
    };

    // 初回リサイズ
    const cols = this.options.cols ?? 80;
    const rows = this.options.rows ?? 24;
    this.resize(cols, rows);
  }

  write(data: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("[TtydPty] write called while not connected");
      return;
    }
    const payload = Buffer.from(data, "utf8");
    const frame = new Uint8Array(1 + payload.length);
    frame[0] = MSG_INPUT;
    frame.set(payload, 1);
    this.ws.send(frame);
  }

  resize(cols: number, rows: number): void {
    this._lastCols = cols;
    this._lastRows = rows;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const json = JSON.stringify({ columns: cols, rows });
    const payload = Buffer.from(json, "utf8");
    const frame = new Uint8Array(1 + payload.length);
    frame[0] = MSG_RESIZE;
    frame.set(payload, 1);
    this.ws.send(frame);
  }

  // --- 再接続 ---

  private async handleDisconnect(): Promise<void> {
    if (!this.options.reconnect) {
      this.emitExit(0);
      return;
    }

    const maxAttempts = this.options.reconnectAttempts ?? 5;
    const baseDelay = this.options.reconnectDelay ?? 1000;

    while (this._reconnectCount < maxAttempts && !this._disposed) {
      this._reconnectCount++;
      const delay = baseDelay * this._reconnectCount; // linear backoff
      await new Promise(r => setTimeout(r, delay));

      if (this._disposed) return;

      try {
        this.ws = undefined;
        await this.connectWebSocket();
        this._reconnectCount = 0;
        // リサイズ再送信
        if (this._lastCols && this._lastRows) {
          this.resize(this._lastCols, this._lastRows);
        }
        return;
      } catch (e) {
        console.warn(
          `[TtydPty] Reconnect attempt ${this._reconnectCount}/${maxAttempts} failed:`,
          e,
        );
      }
    }

    this.emitError(new Error(`TtydPty: reconnect failed after ${maxAttempts} attempts`));
  }

  // --- 認証ヘッダー ---

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { ...this.options.headers };

    if (this.options.credentials) {
      const b64 = Buffer.from(
        `${this.options.credentials.username}:${this.options.credentials.password}`,
      ).toString("base64");
      headers.Authorization = `Basic ${b64}`;
    }

    if (this.options.token) {
      headers.Authorization = `Bearer ${this.options.token}`;
    }

    return headers;
  }

  private buildWsUrl(): string {
    const url = new URL(this.options.url);
    // パスが未指定なら /ws を付与（ttyd のデフォルト）
    if (url.pathname === "/" || url.pathname === "") {
      url.pathname = "/ws";
    }
    // http/https → ws/wss
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    return url.toString();
  }

  // --- WebSocket 実装の解決 ---

  private resolveWebSocketImpl(): typeof WebSocket {
    if (typeof globalThis.WebSocket !== "undefined") {
      return globalThis.WebSocket;
    }
    try {
      const { WebSocket: WsImpl } = require("ws");
      return WsImpl;
    } catch {
      throw new Error(
        "WebSocket not available. Node.js 22+ has built-in WebSocket, " +
        "or install 'ws' package: npm install ws",
      );
    }
  }

  // --- dispose, onData, onExit, onError は SshPty/DockerPty と同パターン ---

  dispose(): void {
    void this.disposeAsync();
  }

  disposeAsync(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this._disposed = true;
    this._ended = true;

    this.disposePromise = (async () => {
      this._dataListeners = [];
      this._exitListeners = [];
      this._errorListeners = [];

      if (this.ws) {
        try { this.ws.close(); } catch (e) {
          console.debug("[TtydPty] ws.close() failed:", e);
        }
        this.ws = undefined;
      }
    })();

    return this.disposePromise;
  }

  onData(listener: (data: string) => void): IDisposable {
    if (this._disposed) return { dispose: () => {} };
    this._dataListeners.push(listener);
    return {
      dispose: () => {
        this._dataListeners = this._dataListeners.filter(l => l !== listener);
      },
    };
  }

  onExit(listener: (code: number, signal?: number) => void): IDisposable {
    if (this._disposed) return { dispose: () => {} };
    this._exitListeners.push(listener);
    return {
      dispose: () => {
        this._exitListeners = this._exitListeners.filter(l => l !== listener);
      },
    };
  }

  onError(listener: (err: Error) => void): IDisposable {
    if (this._disposed) return { dispose: () => {} };
    this._errorListeners.push(listener);
    return {
      dispose: () => {
        this._errorListeners = this._errorListeners.filter(l => l !== listener);
      },
    };
  }

  private emitExit(code: number, signal?: number): void {
    if (this._ended) return;
    this._ended = true;
    if (this._disposed) return;
    this._exitListeners.forEach(l => l(code, signal));
  }

  private emitError(err: Error): void {
    if (this._ended) return;
    this._errorListeners.forEach(l => l(err));
    this.emitExit(-1);
  }
}
```

## サンドボックス Docker イメージ

Conch 用に最適化された ttyd Docker イメージ:

```dockerfile
# docker/conch-sandbox/Dockerfile
FROM ubuntu:22.04

RUN apt-get update && apt-get install -y \
    ttyd \
    bash \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

SHELL ["/bin/bash", "-c"]
EXPOSE 7681

# --writable: 書き込み許可（デフォルトは読み取り専用）
CMD ["ttyd", "--writable", "--port", "7681", "bash"]
```

```bash
docker build -t conch-sandbox docker/conch-sandbox/
docker run -d -p 7681:7681 conch-sandbox
```

## 利用例

### 基本

```typescript
import { Conch } from "@ushida_yosei/conch";

const conch = await Conch.launch({
  backend: {
    type: "ttyd",
    url: "ws://localhost:7681",
  },
  cols: 80,
  rows: 24,
  timeoutMs: 30_000,
  shellIntegration: { enable: true, strict: false },
});

try {
  const r = await conch.run('echo "hello from ttyd"', { timeoutMs: 5000 });
  console.log(r.outputText); // "hello from ttyd"
  console.log(r.exitCode);   // 0
} finally {
  conch.dispose();
}
```

### Basic 認証

```typescript
const conch = await Conch.launch({
  backend: {
    type: "ttyd",
    url: "wss://terminal.example.com",
    credentials: { username: "admin", password: "secret" },
  },
  // ...
});
```

### 再接続付き

```typescript
const conch = await Conch.launch({
  backend: {
    type: "ttyd",
    url: "ws://unstable-host:7681",
    reconnect: true,
    reconnectAttempts: 10,
    reconnectDelay: 2000,
  },
  // ...
});
```

### CI/CD サイドカー

```yaml
# GitHub Actions
services:
  sandbox:
    image: conch-sandbox
    ports:
      - 7681:7681

steps:
  - run: npx tsx test-via-ttyd.ts
```

## OSC 133 Shell Integration との関係

ttyd は PTY を透過的に中継するため、Shell Integration のスクリプト注入
（`enableShellIntegration`）はそのまま動作する。

**注意**: ttyd の `--readonly` モードでは `write()` が無効化されるため、
Shell Integration を含む全ての入力操作が使えない。

## ファイル構成

```
src/
  backend/
    TtydPty.ts                ← メインクラス
  types.ts                    ← BackendConfig に ttyd 追加
  backendFactory.ts           ← createBackend に ttyd 追加
docker/
  conch-sandbox/
    Dockerfile                ← ttyd + bash の最小イメージ
tests/
  ttydPty.test.ts             ← ユニットテスト（モック WebSocket）
  e2e/
    ttyd.e2e.test.ts          ← ttyd コンテナとの E2E テスト
```

## 依存ライブラリ

| ライブラリ | 用途 | 種別 |
|---|---|---|
| `ws` | WebSocket（Node.js 22 未満のフォールバック） | peerDependency (optional) |

Node.js 22+ では `globalThis.WebSocket` が安定しているため、`ws` なしで動作する。

## 見積もり

| カテゴリ | 行数 |
|---|---|
| TtydPty.ts | ~220行 |
| types.ts 変更 | ~15行 |
| backendFactory.ts 変更 | ~15行 |
| Dockerfile | ~15行 |
| テスト（unit） | ~80行 |
| テスト（e2e） | ~60行 |
| ドキュメント | ~30行 |
| **合計** | **~435行** |

## 優先度

**High** — WebSocket ターミナルバックエンドの中で最優先。
最も普及している Web ターミナルであり、サンドボックス実行の最短経路。

## 実装順序

1. **Phase 1**: `TtydPty` コア（接続 + 入出力 + リサイズ）
2. **Phase 2**: 認証（Basic + トークン）
3. **Phase 3**: 再接続ロジック
4. **Phase 4**: サンドボックス Dockerfile + E2E テスト
