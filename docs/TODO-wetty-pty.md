# TODO: WeTTYPty — WeTTY socket.io ターミナルバックエンド

## 概要

[WeTTY](https://github.com/butlerx/wetty) が公開する socket.io エンドポイントに接続し、
リモートシェルを操作する `ITerminalBackend` を提供する。

WeTTY は Node.js ベースの Web ターミナルで、SSH セッションを WebSocket 経由でブラウザに中継する。
xterm.js フロントエンドと socket.io でつながっている。

## ttyd / GoTTY との違い

| | ttyd / GoTTY | WeTTY |
|---|---|---|
| トランスポート | 生 WebSocket (Binary) | **socket.io** |
| プロトコル | 1-byte type prefix | イベントベース (`data`, `input`, `resize`) |
| 用途 | ローカルプロセスの共有 | **SSH セッションの中継** |
| バックエンド | ローカル PTY | SSH 接続 |
| 言語 | C / Go | Node.js |
| 依存 | なし | `socket.io-client` が必要 |

**最大の違いはトランスポート。** socket.io は生 WebSocket とは異なるプロトコル
（ハンドシェイク、パケットフレーミング、自動再接続、名前空間）を持つ。
そのため ttyd/GoTTY とコードを共有する意味がなく、完全に独立した実装となる。

## WeTTY プロトコル仕様

### 接続

WeTTY は socket.io を使用。接続 URL のパス構造:

```
http://host:3000/wetty          ← HTTP エントリ（ブラウザ UI）
http://host:3000/wetty/socket.io  ← socket.io エンドポイント
```

デフォルトポート: **3000**

### socket.io イベント

#### サーバー → クライアント (出力)

| イベント | ペイロード | 説明 |
|---|---|---|
| `data` | `string` | ターミナル出力データ |

#### クライアント → サーバー (入力)

| イベント | ペイロード | 説明 |
|---|---|---|
| `input` | `string` | ターミナル入力データ |
| `resize` | `{ cols: number, rows: number }` | リサイズ |

### 接続シーケンス

```
Client                           Server (WeTTY)
  |                                 |
  |--- socket.io CONNECT ---------->|  http://host:3000/wetty/socket.io
  |<-- socket.io CONNECTED ---------|
  |                                 |  (WeTTY が SSH 接続を確立)
  |<-- "data" (SSH banner) ---------|
  |--- "resize" ({cols,rows}) ----->|
  |--- "input" (keystroke) -------->|
  |<-- "data" (response) -----------|
  |                                 |
```

### WeTTY の SSH プロキシアーキテクチャ

```
Browser/Conch  ──socket.io──>  WeTTY Server  ──SSH──>  Remote Host
                               (Node.js)               (sshd)
```

WeTTY 自体が SSH クライアントとして動作し、ブラウザ/Conch はその中継を通じてリモートシェルにアクセスする。
つまり Conch の `SshPty` と `WeTTYPty` は最終的に同じリモートホストに到達するが、経路が異なる:

- `SshPty`: Conch → SSH → Remote Host（直接）
- `WeTTYPty`: Conch → socket.io → WeTTY → SSH → Remote Host（中継）

### いつ WeTTYPty を使うか

- 既に WeTTY がデプロイ済みで、直接 SSH アクセスが許可されていない環境
- ブラウザユーザーと同じターミナルセッションに Conch から接続したい場合
- WeTTY のセッション管理/監査機能を活用したい場合

## API 設計

```typescript
export interface WeTTYPtyOptions {
  /** WeTTY サーバーの URL (e.g. "http://localhost:3000") */
  url: string;

  cols?: number;
  rows?: number;

  /** WeTTY の SSH 接続先設定（WeTTY 側の設定で決まることが多い） */
  ssh?: {
    /** SSH 接続先ホスト（WeTTY 側で固定されている場合は不要） */
    host?: string;
    /** SSH ポート */
    port?: number;
    /** SSH ユーザー名 */
    user?: string;
    /** 認証方式 */
    auth?: string;
  };

  /** socket.io のパス (default: "/wetty/socket.io") */
  socketPath?: string;

  /** socket.io の名前空間 (default: "/") */
  namespace?: string;

  /** 接続タイムアウト ms (default: 10000) */
  connectTimeout?: number;

  /** socket.io の追加オプション */
  socketOptions?: Record<string, unknown>;
}
```

### BackendConfig

```typescript
// src/types.ts に追加
| {
    type: "wetty";
    url: string;
    ssh?: {
      host?: string;
      port?: number;
      user?: string;
      auth?: string;
    };
    socketPath?: string;
    namespace?: string;
    connectTimeout?: number;
  }
```

## 実装

```typescript
// src/backend/WeTTYPty.ts

import type { IDisposable, ITerminalBackend } from "../types";

export class WeTTYPty implements ITerminalBackend {
  // socket.io-client の Socket 型は動的 import で解決
  private socket: any | undefined;  // Socket from "socket.io-client"
  private _disposed = false;
  private _ended = false;
  private _dataListeners: ((data: string) => void)[] = [];
  private _exitListeners: ((code: number, signal?: number) => void)[] = [];
  private _errorListeners: ((err: Error) => void)[] = [];
  private disposePromise: Promise<void> | undefined;

  constructor(private options: WeTTYPtyOptions) {}

  get id(): string {
    return `wetty-${new URL(this.options.url).host}`;
  }

  get processName(): string {
    const host = new URL(this.options.url).host;
    const sshUser = this.options.ssh?.user;
    return sshUser ? `${sshUser}@${host}(wetty)` : `wetty:${host}`;
  }

  async spawn(): Promise<void> {
    if (this._disposed) throw new Error("WeTTYPty is disposed");
    if (this.socket) throw new Error("WeTTYPty is already spawned");

    // socket.io-client を動的 import（peerDependency）
    const { io } = await import("socket.io-client");

    // WeTTY の URL 構築
    const url = this.buildUrl();
    const socketPath = this.options.socketPath ?? "/wetty/socket.io";

    this.socket = io(url, {
      path: socketPath,
      transports: ["websocket"],  // WebSocket のみ（polling フォールバック不要）
      timeout: this.options.connectTimeout ?? 10000,
      ...this.options.socketOptions,
    });

    // 接続待機
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("WeTTYPty connect timeout")),
        this.options.connectTimeout ?? 10000,
      );

      this.socket!.once("connect", () => {
        clearTimeout(timeout);
        resolve();
      });

      this.socket!.once("connect_error", (err: Error) => {
        clearTimeout(timeout);
        reject(new Error(`WeTTYPty connect error: ${err.message}`));
      });
    });

    // 出力イベント
    this.socket.on("data", (data: string) => {
      if (this._disposed) return;
      this._dataListeners.forEach(l => l(data));
    });

    // 切断イベント
    this.socket.on("disconnect", (reason: string) => {
      if (this._disposed || this._ended) return;
      if (reason === "io server disconnect") {
        // サーバー側が切断 → SSH セッション終了
        this.emitExit(0);
      } else {
        // ネットワーク切断等
        this.emitError(new Error(`WeTTYPty disconnected: ${reason}`));
      }
    });

    // エラーイベント
    this.socket.on("connect_error", (err: Error) => {
      if (this._disposed || this._ended) return;
      this._errorListeners.forEach(l => l(err));
    });

    // 初回リサイズ
    this.resize(this.options.cols ?? 80, this.options.rows ?? 24);
  }

  write(data: string): void {
    if (!this.socket?.connected) {
      console.warn("[WeTTYPty] write called while not connected");
      return;
    }
    this.socket.emit("input", data);
  }

  resize(cols: number, rows: number): void {
    if (!this.socket?.connected) return;
    this.socket.emit("resize", { cols, rows });
  }

  // --- URL 構築 ---

  private buildUrl(): string {
    const url = new URL(this.options.url);
    // WeTTY の SSH 先を URL パラメータで指定する場合
    if (this.options.ssh) {
      const ssh = this.options.ssh;
      if (ssh.user) url.pathname = `/wetty/ssh/${ssh.user}`;
      if (ssh.host) url.searchParams.set("host", ssh.host);
      if (ssh.port) url.searchParams.set("port", String(ssh.port));
    }
    return url.toString();
  }

  // --- dispose ---

  dispose(): void { void this.disposeAsync(); }

  disposeAsync(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this._disposed = true;
    this._ended = true;

    this.disposePromise = (async () => {
      this._dataListeners = [];
      this._exitListeners = [];
      this._errorListeners = [];

      if (this.socket) {
        try {
          this.socket.removeAllListeners();
          this.socket.disconnect();
        } catch (e) {
          console.debug("[WeTTYPty] socket.disconnect() failed:", e);
        }
        this.socket = undefined;
      }
    })();

    return this.disposePromise;
  }

  // onData, onExit, onError は他のバックエンドと同パターン

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

const conch = await Conch.launch({
  backend: {
    type: "wetty",
    url: "http://localhost:3000",
  },
  cols: 80,
  rows: 24,
  timeoutMs: 30_000,
});

try {
  // WeTTY が SSH 先のシェルに接続した後、コマンドを実行
  await conch.waitForText("$", { timeoutMs: 10000 }); // SSH プロンプト待ち
  const r = await conch.run("uname -a", { timeoutMs: 5000, strict: false });
  console.log(r.outputText);
} finally {
  conch.dispose();
}
```

### SSH ユーザー指定

```typescript
const conch = await Conch.launch({
  backend: {
    type: "wetty",
    url: "http://wetty.internal:3000",
    ssh: {
      user: "deploy",
      host: "prod.server.com",
      port: 22,
    },
  },
  // ...
});
```

## OSC 133 Shell Integration との関係

WeTTY は SSH セッションの中継なので、SSH 先のシェルで Shell Integration が動作する。
ただし WeTTY が中継するデータを改変しないことが前提（通常は透過的）。

**注意**: WeTTY の一部バージョンでは、データを文字列として処理する際に
バイナリ安全性が保証されない可能性がある。OSC 133 のエスケープシーケンスが
正しく通過するかは実機テストが必要。

## ファイル構成

```
src/
  backend/
    WeTTYPty.ts               ← メインクラス
  types.ts                    ← BackendConfig に wetty 追加
  backendFactory.ts           ← createBackend に wetty 追加
tests/
  wettyPty.test.ts            ← ユニットテスト（モック socket.io）
  e2e/
    wetty.e2e.test.ts         ← WeTTY + SSH の E2E テスト
```

## 依存ライブラリ

| ライブラリ | 用途 | 種別 |
|---|---|---|
| `socket.io-client` | socket.io クライアント | **peerDependency (optional)** |

`socket.io-client` は ~200KB。ttyd/GoTTY の `ws` (~50KB) と比べると重いが、
WeTTY を使うユーザーは既に socket.io エコシステムに馴染みがあるケースが多い。

## 見積もり

| カテゴリ | 行数 |
|---|---|
| WeTTYPty.ts | ~200行 |
| types.ts 変更 | ~15行 |
| backendFactory.ts 変更 | ~15行 |
| テスト（unit） | ~60行 |
| テスト（e2e） | ~60行 |
| ドキュメント | ~20行 |
| **合計** | **~370行** |

## 優先度

**Low-Medium** — ttyd, GoTTY, tty2web の後。理由:

1. **socket.io 依存が追加コスト** — 他の WebSocket バックエンドと依存を共有できない。
2. **SshPty で代替可能** — WeTTY の SSH 先に直接 `SshPty` で接続できるケースが多い。
3. **WeTTY 固有のユースケースが限定的** — 「WeTTY がデプロイ済みで SSH 直接接続不可」という状況は比較的稀。

ただし Node.js エコシステムとの親和性は高く、WeTTY ユーザーからの需要は一定数ある。

## 実装順序

1. **Phase 1**: `WeTTYPty` コア（socket.io 接続 + 入出力 + リサイズ）
2. **Phase 2**: SSH 先指定（URL パラメータ経由）
3. **Phase 3**: E2E テスト（WeTTY + OpenSSH Docker コンテナ）

## 検証が必要な項目

- [ ] WeTTY が OSC 133 エスケープシーケンスを透過的に中継するか
- [ ] socket.io の `data` イベントのペイロード形式（string or Buffer）
- [ ] WeTTY の `resize` イベントのフォーマット（`{cols, rows}` or `{columns, rows}`）
- [ ] WeTTY の認証フロー（パスワード入力が必要な場合の自動化方法）
