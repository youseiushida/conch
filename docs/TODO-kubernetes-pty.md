# TODO: KubernetesPty — kubectl exec API 直接接続

## 概要

Kubernetes の Pod に対して `kubectl exec` 相当の API を直接叩き、
WebSocket 経由でインタラクティブシェルを操作する `ITerminalBackend` を提供する。
kubectl CLI を介さず、Kubernetes API に直接接続する。

## 動機

### ユースケース

1. **Pod 内の自動操作**: デバッグ用 Pod にシェル接続してログ確認、設定変更、DB 操作。
2. **CI/CD パイプライン**: テスト Pod 内でコマンド実行し、結果を検証。
3. **コーディングエージェント**: クラウドネイティブ環境で AI エージェントが Pod 内を操作。
4. **カオスエンジニアリング**: 特定 Pod 内でコマンドを実行して障害をシミュレーション。
5. **マルチコンテナ Pod**: sidecar コンテナや init コンテナへの個別接続。

### なぜ kubectl CLI を使わないのか

| | `kubectl exec` (CLI) | `KubernetesPty` (API 直接) |
|---|---|---|
| 依存 | kubectl バイナリが必要 | Node.js のみ |
| オーバーヘッド | プロセス fork + パイプ | WebSocket 直接接続 |
| エラーハンドリング | exit code のみ | API レベルのエラー情報 |
| 認証 | kubeconfig ファイル | kubeconfig or トークン or in-cluster |
| リサイズ | SIGWINCH 経由 | リサイズチャネル (ch 4) で正確 |
| ストリーム分離 | stdout/stderr 混在 | チャネル 0-4 で完全分離 |

### なぜ SshPty でノードに SSH しないのか

- Pod はノード上の任意の場所にスケジュールされる → ノード IP を事前に知れない
- Pod のネットワーク名前空間は分離されている → ノードから直接 PID に attach できない
- RBAC で `pods/exec` 権限だけ付与するのがセキュリティ的に正しい
- kubectl exec は Kubernetes の公式 API — SSH は運用上避けるべき

## Kubernetes exec API プロトコル

### エンドポイント

```
GET /api/v1/namespaces/{namespace}/pods/{pod}/exec
  ?command={cmd}
  &stdin=true
  &stdout=true
  &stderr=true
  &tty=true
  &container={container}  # マルチコンテナ Pod の場合
```

### WebSocket サブプロトコル

```
Sec-WebSocket-Protocol: v4.channel.k8s.io
```

利用可能なサブプロトコル:
- `v4.channel.k8s.io` — 最新。バイナリフレーム + チャネルマルチプレクス。
- `v3.channel.k8s.io`, `v2.channel.k8s.io`, `v1.channel.k8s.io` — レガシー。
- `channel.k8s.io` — 最初期。

**`v4.channel.k8s.io` を使用する。** 全ての現行 Kubernetes バージョン (1.24+) でサポート。

### チャネルマルチプレクス

各 WebSocket フレームの先頭 1 バイトがチャネル番号:

| チャネル | 方向 | 説明 |
|---|---|---|
| `0` | client → server | **stdin** |
| `1` | server → client | **stdout** |
| `2` | server → client | **stderr** |
| `3` | server → client | **error** (JSON: API エラー) |
| `4` | client → server | **resize** (JSON: `{"Width":N,"Height":N}`) |

```
バイナリフレーム: [チャネル番号 (1 byte)] [ペイロード (N bytes)]

例: stdin "ls\n"
  → [0x00] [0x6c 0x73 0x0a]

例: stdout 応答
  ← [0x01] [0x66 0x69 0x6c 0x65 ...]

例: リサイズ 120x40
  → [0x04] [{"Width":120,"Height":40}]
```

### エラーチャネル (ch 3)

コマンド終了時にチャネル 3 で JSON メッセージが送信される:

```json
{
  "metadata": {},
  "status": "Success"
}
```

異常終了:
```json
{
  "metadata": {},
  "status": "Failure",
  "message": "command terminated with exit code 1",
  "reason": "NonZeroExitCode",
  "details": {
    "causes": [
      {
        "reason": "ExitCode",
        "message": "1"
      }
    ]
  }
}
```

これにより OSC 133 なしでも exit code が取得可能（ただし Conch の Shell Integration とは別レイヤー）。

### 認証

Kubernetes API への認証方法:

| 方式 | 説明 | 設定 |
|---|---|---|
| kubeconfig | `~/.kube/config` から読み取り | デフォルト |
| Bearer Token | Service Account トークン | `token` オプション |
| In-Cluster | Pod 内から自動認証 | 自動検出 |
| Client Certificate | TLS クライアント証明書 | `certFile` + `keyFile` |

## 設計

### API

```typescript
export interface KubernetesPtyOptions {
  // 接続先
  namespace?: string;         // default: "default"
  pod: string;
  container?: string;         // マルチコンテナ Pod の場合

  // コマンド（デフォルト: シェル起動）
  command?: string[];         // default: ["/bin/sh"]

  // ターミナル
  cols?: number;
  rows?: number;

  // 認証
  kubeconfig?: string;        // kubeconfig ファイルパス（default: ~/.kube/config）
  context?: string;           // kubeconfig の context 名
  cluster?: string;           // クラスタ URL（直接指定）
  token?: string;             // Bearer Token（直接指定）
  certFile?: string;          // クライアント証明書
  keyFile?: string;           // クライアント秘密鍵
  caFile?: string;            // CA 証明書（自己署名クラスタ用）
  insecureSkipTlsVerify?: boolean; // TLS 検証スキップ（開発用）

  // タイムアウト
  connectTimeout?: number;    // default: 10000
}
```

### 利用例

```typescript
import { Conch } from "@ushida_yosei/conch";

// kubeconfig から接続
const conch = await Conch.launch({
  backend: {
    type: "kubernetes",
    pod: "my-app-7b8f9c6d4-x2k5p",
    namespace: "production",
    container: "app",
    command: ["/bin/bash"],
  },
  cols: 120,
  rows: 40,
  timeoutMs: 30_000,
  shellIntegration: { enable: true, strict: false },
});

try {
  const r = await conch.run("cat /etc/os-release", { timeoutMs: 5000 });
  console.log(r.outputText);
} finally {
  conch.dispose();
}
```

```typescript
// in-cluster 認証（Pod 内から別の Pod に接続）
const conch = await Conch.launch({
  backend: {
    type: "kubernetes",
    pod: "debug-pod",
    namespace: "default",
    // in-cluster: kubeconfig 不要、自動検出
  },
  // ...
});
```

```typescript
// Bearer Token で直接認証
const conch = await Conch.launch({
  backend: {
    type: "kubernetes",
    cluster: "https://k8s.example.com:6443",
    token: process.env.K8S_TOKEN,
    caFile: "/path/to/ca.crt",
    pod: "worker-0",
    command: ["/bin/bash"],
  },
  // ...
});
```

### KubernetesPty 実装

```typescript
// src/backend/KubernetesPty.ts

import { StringDecoder } from "node:string_decoder";
import type { IDisposable, ITerminalBackend } from "../types";

// Kubernetes exec チャネル番号
const CH_STDIN = 0;
const CH_STDOUT = 1;
const CH_STDERR = 2;
const CH_ERROR = 3;
const CH_RESIZE = 4;

export class KubernetesPty implements ITerminalBackend {
  private ws: WebSocket | undefined;
  private _disposed = false;
  private _ended = false;
  private _dataListeners: ((data: string) => void)[] = [];
  private _exitListeners: ((code: number, signal?: number) => void)[] = [];
  private _errorListeners: ((err: Error) => void)[] = [];

  private disposePromise: Promise<void> | undefined;

  constructor(private options: KubernetesPtyOptions) {}

  get id(): string {
    return `k8s-${this.options.namespace ?? "default"}/${this.options.pod}`;
  }

  get processName(): string {
    const cmd = this.options.command?.[0] ?? "/bin/sh";
    return `${this.options.pod}:${cmd}`;
  }

  async spawn(): Promise<void> {
    if (this._disposed) throw new Error("KubernetesPty is disposed");
    if (this.ws) throw new Error("KubernetesPty is already spawned");

    // 1. kubeconfig / in-cluster / direct token から接続情報を解決
    const config = await this.resolveConfig();

    // 2. exec API の WebSocket URL を構築
    const url = this.buildExecUrl(config);

    // 3. WebSocket 接続
    const WS = this.getWebSocket();
    this.ws = new WS(url, ["v4.channel.k8s.io"], {
      headers: {
        Authorization: `Bearer ${config.token}`,
      },
      // TLS 設定
      rejectUnauthorized: !this.options.insecureSkipTlsVerify,
      ca: config.ca,
      cert: config.cert,
      key: config.key,
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("KubernetesPty connect timeout")),
        this.options.connectTimeout ?? 10000,
      );
      this.ws!.onopen = () => { clearTimeout(timeout); resolve(); };
      this.ws!.onerror = (e) => { clearTimeout(timeout); reject(e); };
    });

    // 4. メッセージハンドラ
    const decoder = new StringDecoder("utf8");
    this.ws.onmessage = (event) => {
      const data = new Uint8Array(event.data as ArrayBuffer);
      const channel = data[0];
      const payload = data.slice(1);

      switch (channel) {
        case CH_STDOUT:
        case CH_STDERR: {
          // TTY モードでは stdout/stderr は統合されるが、
          // 念のため両方 onData に流す
          const text = decoder.write(Buffer.from(payload));
          if (text) this._dataListeners.forEach(l => l(text));
          break;
        }
        case CH_ERROR: {
          // コマンド終了 or API エラー
          const msg = JSON.parse(Buffer.from(payload).toString("utf8"));
          this.handleErrorChannel(msg);
          break;
        }
      }
    };

    this.ws.onclose = () => {
      if (!this._ended) this.emitExit(0);
    };

    // 5. 初回リサイズ
    if (this.options.cols || this.options.rows) {
      this.resize(this.options.cols ?? 80, this.options.rows ?? 24);
    }
  }

  write(data: string): void {
    if (!this.ws) return;
    // チャネル 0 (stdin) + データ
    const payload = Buffer.from(data, "utf8");
    const frame = new Uint8Array(1 + payload.length);
    frame[0] = CH_STDIN;
    frame.set(payload, 1);
    this.ws.send(frame);
  }

  resize(cols: number, rows: number): void {
    if (!this.ws) return;
    // チャネル 4 (resize) + JSON
    const json = JSON.stringify({ Width: cols, Height: rows });
    const payload = Buffer.from(json, "utf8");
    const frame = new Uint8Array(1 + payload.length);
    frame[0] = CH_RESIZE;
    frame.set(payload, 1);
    this.ws.send(frame);
  }

  private handleErrorChannel(msg: KubeExecStatus): void {
    if (msg.status === "Success") {
      this.emitExit(0);
    } else {
      // exit code を details.causes から抽出
      const exitCodeCause = msg.details?.causes?.find(
        (c: { reason: string }) => c.reason === "ExitCode",
      );
      const exitCode = exitCodeCause
        ? Number.parseInt(exitCodeCause.message, 10)
        : 1;
      this.emitExit(exitCode);
    }
  }

  // kubeconfig 解析 or in-cluster 検出
  private async resolveConfig(): Promise<KubeResolvedConfig> {
    // 1. 直接指定（cluster + token）
    if (this.options.cluster && this.options.token) {
      return {
        server: this.options.cluster,
        token: this.options.token,
        ca: this.options.caFile
          ? await fs.readFile(this.options.caFile, "utf8")
          : undefined,
      };
    }

    // 2. in-cluster 検出
    const inClusterTokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token";
    const inClusterCaPath = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
    try {
      const token = await fs.readFile(inClusterTokenPath, "utf8");
      const ca = await fs.readFile(inClusterCaPath, "utf8");
      const host = process.env.KUBERNETES_SERVICE_HOST;
      const port = process.env.KUBERNETES_SERVICE_PORT;
      if (host && port) {
        return { server: `https://${host}:${port}`, token: token.trim(), ca };
      }
    } catch {
      // in-cluster ではない
    }

    // 3. kubeconfig パース
    return this.parseKubeconfig();
  }

  private buildExecUrl(config: KubeResolvedConfig): string {
    const base = config.server.replace(/^http/, "ws"); // https → wss
    const ns = this.options.namespace ?? "default";
    const pod = this.options.pod;
    const cmd = this.options.command ?? ["/bin/sh"];

    const params = new URLSearchParams();
    for (const c of cmd) params.append("command", c);
    params.set("stdin", "true");
    params.set("stdout", "true");
    params.set("stderr", "true");
    params.set("tty", "true");
    if (this.options.container) {
      params.set("container", this.options.container);
    }

    return `${base}/api/v1/namespaces/${ns}/pods/${pod}/exec?${params}`;
  }

  // ... dispose, onData, onExit, onError は SshPty と同パターン
}
```

### BackendConfig 拡張

```typescript
// src/types.ts に追加
| {
    type: "kubernetes";
    pod: string;
    namespace?: string;
    container?: string;
    command?: string[];
    kubeconfig?: string;
    context?: string;
    cluster?: string;
    token?: string;
    certFile?: string;
    keyFile?: string;
    caFile?: string;
    insecureSkipTlsVerify?: boolean;
    connectTimeout?: number;
  }
```

### kubeconfig パース

kubeconfig は YAML だが、Conch のコア依存に YAML パーサーを追加したくない。戦略:

1. **`@kubernetes/client-node` を peerDependency にする案**: kubeconfig パース、
   in-cluster 検出、トークンリフレッシュ等が全てカバーされる。ただし重い（~20MB）。
2. **最小限の独自パーサー案**: kubeconfig の YAML は単純な構造なので、`js-yaml` (軽量) で
   パースし、必要なフィールドだけ抽出する。
3. **kubeconfig パースなし案**: `cluster` + `token` の直接指定のみサポート。
   kubeconfig からの読み取りはユーザー側で行う。

**推奨: 方式 2。** `js-yaml` は軽量（~30KB）で、kubeconfig パースに十分。
`@kubernetes/client-node` はオプションの peerDependency として将来対応可能。

## ファイル構成

```
src/
  backend/
    KubernetesPty.ts          ← メインクラス (~250行)
    kube-config.ts            ← kubeconfig パーサー (~100行)
  types.ts                    ← BackendConfig に kubernetes 追加
  backendFactory.ts           ← createBackend に kubernetes 追加
tests/
  kubernetesPty.test.ts       ← ユニットテスト（モック WebSocket）
  kube-config.test.ts         ← kubeconfig パーサーテスト
  e2e/
    kubernetes.e2e.test.ts    ← kind/minikube での E2E テスト
```

## 依存ライブラリ

| ライブラリ | 用途 | 種別 |
|---|---|---|
| `js-yaml` | kubeconfig YAML パース | dependency (軽量) |
| `ws` | WebSocket（Node.js 22 未満） | peerDependency (optional、WebSocketPty と共有) |
| `@kubernetes/client-node` | 高度な認証・API 操作 | peerDependency (optional、将来) |

## 見積もり

| カテゴリ | 行数 |
|---|---|
| KubernetesPty.ts | ~250行 |
| kube-config.ts | ~100行 |
| types.ts 変更 | ~20行 |
| backendFactory.ts 変更 | ~15行 |
| テスト（unit） | ~80行 |
| テスト（e2e） | ~60行 |
| ドキュメント | ~30行 |
| **合計** | **~555行** |

## 優先度

**Medium-High** — Kubernetes は現代のインフラの中心。Docker Pod 内での自動操作、
CI/CD パイプラインでのテスト実行、コーディングエージェントの実行環境として需要が高い。

WebSocketPty (ttyd/GoTTY) の後、WeTTY の前に実装するのが適切。

## 実装順序

1. **Phase 1**: `KubernetesPty` コア + 直接指定認証（cluster + token）
2. **Phase 2**: kubeconfig パーサー + in-cluster 検出
3. **Phase 3**: E2E テスト（kind or minikube）
4. **Phase 4**: `@kubernetes/client-node` 連携（optional peerDependency）

## OSC 133 Shell Integration との関係

`KubernetesPty` は Pod 内のシェルに直接接続するため、Shell Integration のスクリプト注入
（`enableShellIntegration`）はそのまま動作する。Pod 内に `bash` があれば完全対応。

チャネル 3 (error) から exit code が取得できるが、これは exec API レベルの exit code であり、
Shell Integration (OSC 133) が提供するコマンド単位の exit code とは異なる:

| | exec API (ch 3) | OSC 133 (Shell Integration) |
|---|---|---|
| 粒度 | セッション全体の終了コード | 個別コマンドの exit code |
| タイミング | WebSocket close 時 | 各コマンド完了時 |
| 用途 | Pod exec の成功/失敗判定 | `run()` の exit code 取得 |

両方を併用するのが最も堅牢。

## 既存バックエンドとの比較

| 特性 | DockerPty | KubernetesPty |
|---|---|---|
| コンテナ起動 | `createContainer` + `start` | 既存 Pod に接続（起動は外部） |
| プロトコル | Docker API (HTTP hijack) | Kubernetes exec API (WebSocket) |
| ストリーム | 単一 TTY ストリーム | ch 0-4 マルチプレクス |
| exit code | `container.wait()` | ch 3 JSON or OSC 133 |
| リサイズ | `container.resize()` | ch 4 JSON |
| 認証 | Docker socket | kubeconfig / token / in-cluster |
| スケーラビリティ | 単一ホスト | クラスタ全体 |

## セキュリティ考慮事項

- **RBAC**: `pods/exec` 権限は強力。必要最小限の namespace/pod に絞る。
- **TLS**: 本番では `insecureSkipTlsVerify: false`（デフォルト）を維持。
- **トークン管理**: Bearer Token をコードにハードコードしない。環境変数か Secret 管理ツールを使用。
- **監査ログ**: Kubernetes の audit log で exec 操作が記録されることを認識する。
