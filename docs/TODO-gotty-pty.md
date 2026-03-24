# TODO: GoTTYPty — GoTTY WebSocket ターミナルバックエンド

## 概要

[GoTTY](https://github.com/yudai/gotty) が公開する WebSocket エンドポイントに接続し、
リモートシェルを操作する `ITerminalBackend` を提供する。

GoTTY は ttyd の元ネタ的存在。Go ベース。本家リポジトリ (yudai/gotty) はメンテ停止しているが、
フォーク ([sorenisanerd/gotty](https://github.com/sorenisanerd/gotty) 等) が存続している。

## ttyd との関係

GoTTY と ttyd のプロトコルはほぼ同じ構造（先頭 1 バイトがメッセージタイプの Binary WebSocket）だが、
以下の差異があるため独立した実装とする:

| | ttyd | GoTTY |
|---|---|---|
| 言語 | C | Go |
| デフォルトポート | 7681 | 8080 |
| WS パス | `/ws` | `/ws` |
| 書き込み権限 | `--writable` フラグ | `--permit-write` フラグ |
| 認証 | Basic 認証 (`--credential`) | Basic 認証 (`--credential`) |
| 再接続 | ネイティブサポート | なし（クライアント側で実装） |
| PAUSE/RESUME | あり (タイプ 2, 3) | なし |
| クライアントハンドシェイク | なし | `AuthToken` JSON 送信が必要なケースあり |
| 出力タイプ追加 | SET_PREFERENCES (2) | SET_RECONNECT (2) |

プロトコルの 9 割は共通だが、ハンドシェイクの差異と `--permit-write` の検証が
GoTTY 固有のロジックになるため、TtydPty を継承するより独立実装が素直。

## GoTTY プロトコル仕様

### 接続

- **URL**: `ws://host:port/ws`（デフォルトポート 8080）
- **プロトコル**: Binary WebSocket
- **フレーム形式**: 先頭 1 バイトがメッセージタイプ

### クライアント → サーバー (入力)

| タイプ | 値 | ペイロード | 説明 |
|---|---|---|---|
| INPUT | `0` | UTF-8 文字列 | 標準入力データ |
| RESIZE | `1` | JSON `{"columns":N,"rows":N}` | ターミナルリサイズ |
| PING | `2` | なし | キープアライブ |

### サーバー → クライアント (出力)

| タイプ | 値 | ペイロード | 説明 |
|---|---|---|---|
| OUTPUT | `0` | UTF-8 文字列 | 標準出力データ |
| SET_WINDOW_TITLE | `1` | UTF-8 文字列 | ウィンドウタイトル設定 |
| SET_RECONNECT | `2` | 数値文字列 | 再接続間隔（秒）。`-1` で無効。 |

### 接続シーケンス

GoTTY は接続直後に認証トークンの送信を求める場合がある:

```
Client                          Server (GoTTY)
  |                                |
  |--- WebSocket CONNECT --------->|  ws://host:8080/ws
  |<-- HTTP 101 Upgrade -----------|
  |                                |
  |--- {"AuthToken":"..."} ------->|  認証（--credential 設定時）
  |--- [1] RESIZE (JSON) --------->|  初回リサイズ
  |<-- [0] OUTPUT (banner) --------|  シェルの初期出力
  |--- [0] INPUT (keystroke) ----->|  ユーザー入力
  |<-- [0] OUTPUT (response) ------|  コマンド出力
  |                                |
```

**注意**: `--permit-write` が無効の場合、INPUT メッセージは無視される（読み取り専用モード）。

## API 設計

```typescript
export interface GoTTYPtyOptions {
  /** WebSocket URL (e.g. "ws://localhost:8080" or "wss://example.com") */
  url: string;

  cols?: number;
  rows?: number;

  /** Basic 認証 */
  credentials?: {
    username: string;
    password: string;
  };

  /** 追加 WebSocket ヘッダー */
  headers?: Record<string, string>;

  /** 接続タイムアウト ms (default: 10000) */
  connectTimeout?: number;

  /** Ping 送信間隔 ms (default: 30000、0 で無効) */
  pingInterval?: number;
}
```

### BackendConfig

```typescript
// src/types.ts に追加
| {
    type: "gotty";
    url: string;
    credentials?: { username: string; password: string };
    headers?: Record<string, string>;
    connectTimeout?: number;
    pingInterval?: number;
  }
```

## 実装

```typescript
// src/backend/GoTTYPty.ts

import { StringDecoder } from "node:string_decoder";
import type { IDisposable, ITerminalBackend } from "../types";

const MSG_INPUT = 0;
const MSG_RESIZE = 1;
const MSG_PING = 2;

const MSG_OUTPUT = 0;
const MSG_SET_WINDOW_TITLE = 1;
const MSG_SET_RECONNECT = 2;

export class GoTTYPty implements ITerminalBackend {
  private ws: WebSocket | undefined;
  private _disposed = false;
  private _ended = false;
  private _dataListeners: ((data: string) => void)[] = [];
  private _exitListeners: ((code: number, signal?: number) => void)[] = [];
  private _errorListeners: ((err: Error) => void)[] = [];
  private disposePromise: Promise<void> | undefined;
  private _pingTimer: NodeJS.Timeout | undefined;

  constructor(private options: GoTTYPtyOptions) {}

  get id(): string {
    return `gotty-${new URL(this.options.url).host}`;
  }

  get processName(): string {
    return new URL(this.options.url).host;
  }

  async spawn(): Promise<void> {
    if (this._disposed) throw new Error("GoTTYPty is disposed");
    if (this.ws) throw new Error("GoTTYPty is already spawned");

    const wsUrl = this.buildWsUrl();
    const WS = this.resolveWebSocketImpl();
    this.ws = new WS(wsUrl, {
      headers: this.buildHeaders(),
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`GoTTYPty connect timeout`)),
        this.options.connectTimeout ?? 10000,
      );
      this.ws!.onopen = () => { clearTimeout(timeout); resolve(); };
      this.ws!.onerror = (e) => { clearTimeout(timeout); reject(e); };
    });

    // GoTTY 固有: 認証トークン送信
    if (this.options.credentials) {
      const authPayload = JSON.stringify({
        AuthToken: Buffer.from(
          `${this.options.credentials.username}:${this.options.credentials.password}`,
        ).toString("base64"),
      });
      this.ws.send(authPayload);
    }

    // メッセージハンドラ
    const decoder = new StringDecoder("utf8");
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (event) => {
      const view = new Uint8Array(event.data as ArrayBuffer);
      if (view.length === 0) return;
      const type = view[0];
      const payload = view.slice(1);

      switch (type) {
        case MSG_OUTPUT: {
          const text = decoder.write(Buffer.from(payload));
          if (text) this._dataListeners.forEach(l => l(text));
          break;
        }
        case MSG_SET_RECONNECT: {
          // サーバーから再接続間隔の通知（-1 で無効）
          // 現時点では無視（GoTTY 自体に再接続機能がないため）
          break;
        }
      }
    };

    this.ws.onclose = () => {
      this.stopPing();
      if (!this._ended && !this._disposed) this.emitExit(0);
    };

    this.ws.onerror = (e) => {
      if (this._disposed || this._ended) return;
      this._errorListeners.forEach(l =>
        l(new Error(`GoTTYPty WebSocket error: ${e}`)),
      );
    };

    // 初回リサイズ
    this.resize(this.options.cols ?? 80, this.options.rows ?? 24);

    // Ping 送信開始
    this.startPing();
  }

  write(data: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload = Buffer.from(data, "utf8");
    const frame = new Uint8Array(1 + payload.length);
    frame[0] = MSG_INPUT;
    frame.set(payload, 1);
    this.ws.send(frame);
  }

  resize(cols: number, rows: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const json = JSON.stringify({ columns: cols, rows });
    const payload = Buffer.from(json, "utf8");
    const frame = new Uint8Array(1 + payload.length);
    frame[0] = MSG_RESIZE;
    frame.set(payload, 1);
    this.ws.send(frame);
  }

  // --- Ping (GoTTY 固有) ---

  private startPing(): void {
    const interval = this.options.pingInterval ?? 30000;
    if (interval <= 0) return;
    this._pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const frame = new Uint8Array([MSG_PING]);
      this.ws.send(frame);
    }, interval);
  }

  private stopPing(): void {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = undefined;
    }
  }

  // --- URL / ヘッダー ---

  private buildWsUrl(): string {
    const url = new URL(this.options.url);
    if (url.pathname === "/" || url.pathname === "") url.pathname = "/ws";
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    return url.toString();
  }

  private buildHeaders(): Record<string, string> {
    return { ...this.options.headers };
  }

  private resolveWebSocketImpl(): typeof WebSocket {
    if (typeof globalThis.WebSocket !== "undefined") return globalThis.WebSocket;
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

  // --- dispose, onData, onExit, onError は SshPty と同パターン ---

  dispose(): void { void this.disposeAsync(); }

  disposeAsync(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this._disposed = true;
    this._ended = true;

    this.disposePromise = (async () => {
      this.stopPing();
      this._dataListeners = [];
      this._exitListeners = [];
      this._errorListeners = [];
      if (this.ws) {
        try { this.ws.close(); } catch (e) {
          console.debug("[GoTTYPty] ws.close() failed:", e);
        }
        this.ws = undefined;
      }
    })();

    return this.disposePromise;
  }

  onData(listener: (data: string) => void): IDisposable {
    if (this._disposed) return { dispose: () => {} };
    this._dataListeners.push(listener);
    return { dispose: () => { this._dataListeners = this._dataListeners.filter(l => l !== listener); } };
  }

  onExit(listener: (code: number, signal?: number) => void): IDisposable {
    if (this._disposed) return { dispose: () => {} };
    this._exitListeners.push(listener);
    return { dispose: () => { this._exitListeners = this._exitListeners.filter(l => l !== listener); } };
  }

  onError(listener: (err: Error) => void): IDisposable {
    if (this._disposed) return { dispose: () => {} };
    this._errorListeners.push(listener);
    return { dispose: () => { this._errorListeners = this._errorListeners.filter(l => l !== listener); } };
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

## 利用例

### 基本

```typescript
import { Conch } from "@ushida_yosei/conch";

// gotty --permit-write --port 8080 bash
const conch = await Conch.launch({
  backend: {
    type: "gotty",
    url: "ws://localhost:8080",
  },
  cols: 80,
  rows: 24,
  timeoutMs: 30_000,
  shellIntegration: { enable: true, strict: false },
});

try {
  const r = await conch.run('echo "hello from GoTTY"', { timeoutMs: 5000 });
  console.log(r.outputText);
} finally {
  conch.dispose();
}
```

### 認証

```typescript
// gotty --credential user:pass --permit-write bash
const conch = await Conch.launch({
  backend: {
    type: "gotty",
    url: "ws://localhost:8080",
    credentials: { username: "user", password: "pass" },
  },
  // ...
});
```

## OSC 133 Shell Integration との関係

GoTTY は PTY を透過的に中継するため、Shell Integration はそのまま動作する。
ただし `--permit-write` が無効の場合は入力不可のため、Shell Integration を含む全操作が無効。

## ファイル構成

```
src/
  backend/
    GoTTYPty.ts               ← メインクラス
  types.ts                    ← BackendConfig に gotty 追加
  backendFactory.ts           ← createBackend に gotty 追加
tests/
  gottyPty.test.ts            ← ユニットテスト
  e2e/
    gotty.e2e.test.ts         ← GoTTY コンテナとの E2E テスト
```

## 依存ライブラリ

| ライブラリ | 用途 | 種別 |
|---|---|---|
| `ws` | WebSocket（Node.js 22 未満のフォールバック） | peerDependency (optional、TtydPty と共有) |

## 見積もり

| カテゴリ | 行数 |
|---|---|
| GoTTYPty.ts | ~200行 |
| types.ts 変更 | ~10行 |
| backendFactory.ts 変更 | ~15行 |
| テスト（unit） | ~60行 |
| テスト（e2e） | ~50行 |
| ドキュメント | ~20行 |
| **合計** | **~355行** |

## 優先度

**High** — TtydPty の直後。プロトコルが近いため、TtydPty の知見をそのまま活かせる。

## 実装順序

1. **Phase 1**: `GoTTYPty` コア（接続 + 入出力 + リサイズ + Ping）
2. **Phase 2**: 認証（AuthToken ハンドシェイク）
3. **Phase 3**: E2E テスト（sorenisanerd/gotty Docker イメージ）
