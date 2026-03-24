# TODO: RecordReplayPty — ターミナルセッションの記録・再生バックエンド

## 概要

実際の `ITerminalBackend` をラップして全 I/O イベントをタイムスタンプ付きで記録し、
記録ファイルから再生する `ITerminalBackend` を提供する。
Conch 自体のテスト、バグ再現、デモ、CI の決定論的テストに使用する。

## 動機

### 問題

1. **E2E テストの非決定性**: ローカル PTY / Docker / SSH のテストはネットワーク遅延、
   CPU 負荷、シェル初期化速度に依存してフレーキーになる。
2. **バグ再現の困難さ**: 「この操作順序で壊れた」を再現するために毎回手動で環境を構築する必要がある。
3. **CI の外部依存**: Docker デーモンや SSH サーバーが必要な E2E テストは CI 環境の制約を受ける。
4. **デバッグの困難さ**: `run()` のタイミング問題（OSC 133 マーカーの順序、drain 競合）は
   ライブ環境でしか発生しないことがある。

### RecordReplayPty が解決すること

```
[記録フェーズ]
  Conch → RecordReplayPty(wrapping: LocalPty) → LocalPty
           ↓ 全 onData/onExit イベントをファイルに記録
           recording.jsonl

[再生フェーズ]
  Conch → RecordReplayPty(replay: recording.jsonl)
           ↑ ファイルからイベントを時系列で再生
           外部依存ゼロ、決定論的
```

- **決定論的テスト**: 同じ recording からは毎回同じ出力。CI でフレーキーにならない。
- **バグ再現**: 問題のセッションを記録して共有すれば、誰でも再現可能。
- **高速テスト**: ネットワーク/プロセス起動の待ち時間ゼロ。recording の再生は即座。
- **外部依存ゼロ**: Docker、SSH、ttyd 等が不要。

## 設計

### 2つのモード

#### Record モード: 実バックエンドをラップして記録

```typescript
import { Conch, LocalPty } from "@ushida_yosei/conch";
import { RecordReplayPty } from "@ushida_yosei/conch/backend/RecordReplayPty";

// 実バックエンドを作成
const real = new LocalPty("bash");

// RecordReplayPty でラップ
const recorder = RecordReplayPty.record(real, {
  output: "./recordings/my-session.jsonl",
});

// 通常通り Conch を使う（記録は透過的）
const conch = await Conch.launch({
  backend: recorder,
  cols: 80,
  rows: 24,
  shellIntegration: { enable: true },
});

const r = await conch.run("echo hello");
console.log(r.outputText); // "hello"

conch.dispose();
// → ./recordings/my-session.jsonl に全イベントが保存される
```

#### Replay モード: 記録ファイルから再生

```typescript
import { Conch } from "@ushida_yosei/conch";
import { RecordReplayPty } from "@ushida_yosei/conch/backend/RecordReplayPty";

// 記録ファイルから再生バックエンドを作成
const player = RecordReplayPty.replay("./recordings/my-session.jsonl");

const conch = await Conch.launch({
  backend: player,
  cols: 80,
  rows: 24,
});

// 記録時と同じ出力が再生される
const r = await conch.run("echo hello");
console.log(r.outputText); // "hello" — 決定論的

conch.dispose();
```

### 記録フォーマット

JSONL (JSON Lines) 形式。各行が 1 イベント。asciicast v2 フォーマットとの互換性を考慮。

```jsonl
{"version":1,"cols":80,"rows":24,"timestamp":"2026-03-20T12:00:00.000Z","backend":"LocalPty","shell":"bash"}
{"t":0,"type":"spawn"}
{"t":12,"type":"data","data":"$ "}
{"t":45,"type":"write","data":"echo hello\r"}
{"t":50,"type":"data","data":"echo hello\r\n"}
{"t":52,"type":"data","data":"hello\r\n$ "}
{"t":55,"type":"write","data":"exit\r"}
{"t":60,"type":"data","data":"exit\r\n"}
{"t":62,"type":"exit","code":0}
```

#### ヘッダー行 (1行目)

```typescript
interface RecordingHeader {
  version: 1;
  cols: number;
  rows: number;
  timestamp: string;      // ISO 8601
  backend: string;        // "LocalPty", "DockerPty", etc.
  shell?: string;         // "bash", "powershell.exe", etc.
  env?: Record<string, string>; // 記録時の環境変数（optional、フィルタ済み）
}
```

#### イベント行

```typescript
type RecordingEvent =
  | { t: number; type: "spawn" }
  | { t: number; type: "data"; data: string }       // onData (サーバー → クライアント)
  | { t: number; type: "write"; data: string }       // write (クライアント → サーバー)
  | { t: number; type: "resize"; cols: number; rows: number }
  | { t: number; type: "exit"; code: number; signal?: number }
  | { t: number; type: "error"; message: string };
```

- `t`: セッション開始からの経過時間 (ms)。
- `data` / `write`: 入出力両方を記録することで、再生時に write のタイミングを検証可能。

### RecordReplayPty クラス

```typescript
// src/backend/RecordReplayPty.ts

import * as fs from "node:fs";
import * as readline from "node:readline";
import type { IDisposable, ITerminalBackend } from "../types";

export interface RecordOptions {
  /** 記録ファイルの出力先パス */
  output: string;
  /** 環境変数を記録に含めるか (default: false) */
  includeEnv?: boolean;
  /** 記録に含める環境変数のキーフィルタ */
  envFilter?: string[];
}

export interface ReplayOptions {
  /** 再生速度倍率 (default: 0 = 即座) */
  speed?: number;
  /** write イベントを無視するか (default: true — 再生時は Conch が write する) */
  ignoreWrites?: boolean;
}

export class RecordReplayPty implements ITerminalBackend {
  // --- ファクトリメソッド ---

  /**
   * Record モード: 実バックエンドをラップ。
   * 全イベントを透過しつつファイルに記録。
   */
  static record(
    backend: ITerminalBackend,
    options: RecordOptions,
  ): RecordReplayPty {
    return new RecordReplayPty({ mode: "record", backend, ...options });
  }

  /**
   * Replay モード: 記録ファイルから再生。
   * 外部依存なし。
   */
  static replay(
    file: string,
    options?: ReplayOptions,
  ): RecordReplayPty {
    return new RecordReplayPty({ mode: "replay", file, ...options });
  }

  // --- ITerminalBackend ---

  private _dataListeners: ((data: string) => void)[] = [];
  private _exitListeners: ((code: number, signal?: number) => void)[] = [];
  private _errorListeners: ((err: Error) => void)[] = [];
  private _disposed = false;
  private _ended = false;

  // Record モード
  private wrappedBackend?: ITerminalBackend;
  private writeStream?: fs.WriteStream;
  private startTime?: number;

  // Replay モード
  private events?: RecordingEvent[];
  private header?: RecordingHeader;
  private replayTimers: NodeJS.Timeout[] = [];

  get id(): string | number {
    if (this.config.mode === "record") {
      return this.wrappedBackend?.id ?? "record";
    }
    return "replay";
  }

  get processName(): string {
    if (this.config.mode === "record") {
      return this.wrappedBackend?.processName ?? "record";
    }
    return this.header?.shell ?? "replay";
  }

  async spawn(): Promise<void> {
    if (this.config.mode === "record") {
      await this.spawnRecord();
    } else {
      await this.spawnReplay();
    }
  }

  private async spawnRecord(): Promise<void> {
    const backend = this.wrappedBackend!;

    // 記録ファイルを開く
    this.writeStream = fs.createWriteStream(this.config.output);
    this.startTime = Date.now();

    // ヘッダー書き出し
    const header: RecordingHeader = {
      version: 1,
      cols: 80, // 後で resize イベントから更新可能
      rows: 24,
      timestamp: new Date().toISOString(),
      backend: backend.constructor.name,
      shell: backend.processName,
    };
    this.writeStream.write(JSON.stringify(header) + "\n");

    // 実バックエンドの onData を透過 + 記録
    backend.onData((data) => {
      this.recordEvent({ t: this.elapsed(), type: "data", data });
      this._dataListeners.forEach(l => l(data));
    });

    backend.onExit((code, signal) => {
      this.recordEvent({ t: this.elapsed(), type: "exit", code, signal });
      this._exitListeners.forEach(l => l(code, signal));
    });

    backend.onError?.((err) => {
      this.recordEvent({ t: this.elapsed(), type: "error", message: err.message });
      this._errorListeners.forEach(l => l(err));
    });

    // spawn を記録して実行
    this.recordEvent({ t: 0, type: "spawn" });
    await backend.spawn();
  }

  private async spawnReplay(): Promise<void> {
    // 記録ファイルを読み込み
    const content = await fs.promises.readFile(this.config.file!, "utf8");
    const lines = content.trim().split("\n");

    this.header = JSON.parse(lines[0]) as RecordingHeader;
    this.events = lines.slice(1).map(l => JSON.parse(l)) as RecordingEvent[];

    const speed = this.config.speed ?? 0; // 0 = 即座

    // イベントをスケジュール
    for (const event of this.events) {
      if (event.type === "write" && (this.config.ignoreWrites ?? true)) {
        continue; // 再生時は Conch 側が write するので無視
      }

      const delay = speed === 0 ? 0 : event.t / (speed || 1);

      const timer = setTimeout(() => {
        if (this._disposed) return;

        switch (event.type) {
          case "data":
            this._dataListeners.forEach(l => l(event.data));
            break;
          case "exit":
            this.emitExit(event.code, event.signal);
            break;
          case "error":
            this._errorListeners.forEach(l => l(new Error(event.message)));
            break;
        }
      }, delay);

      this.replayTimers.push(timer);
    }
  }

  write(data: string): void {
    if (this.config.mode === "record") {
      this.recordEvent({ t: this.elapsed(), type: "write", data });
      this.wrappedBackend!.write(data);
    }
    // Replay モードでは write は無視（data イベントが再生される）
  }

  resize(cols: number, rows: number): void {
    if (this.config.mode === "record") {
      this.recordEvent({ t: this.elapsed(), type: "resize", cols, rows });
      this.wrappedBackend!.resize(cols, rows);
    }
  }

  dispose(): void {
    void this.disposeAsync();
  }

  async disposeAsync(): Promise<void> {
    this._disposed = true;

    // 再生タイマーをクリア
    for (const timer of this.replayTimers) {
      clearTimeout(timer);
    }
    this.replayTimers = [];

    // 記録ファイルを閉じる
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = undefined;
    }

    // ラップされたバックエンドを破棄
    if (this.wrappedBackend) {
      if (this.wrappedBackend.disposeAsync) {
        await this.wrappedBackend.disposeAsync();
      } else {
        this.wrappedBackend.dispose();
      }
    }
  }

  private elapsed(): number {
    return Date.now() - (this.startTime ?? Date.now());
  }

  private recordEvent(event: RecordingEvent): void {
    if (this.writeStream && !this._disposed) {
      this.writeStream.write(JSON.stringify(event) + "\n");
    }
  }

  // onData, onExit, onError, emitExit は他のバックエンドと同パターン
}
```

### BackendConfig 拡張

```typescript
// src/types.ts に追加
| {
    type: "replay";
    file: string;
    speed?: number;
  }
```

**Record モードは `BackendConfig` に追加しない。** Record はプログラム的に
`RecordReplayPty.record(backend)` で使用する（設定ファイルで指定するユースケースが薄い）。

### Conch.launch() での利用

```typescript
// Replay モードは Conch.launch() から直接使える
const conch = await Conch.launch({
  backend: { type: "replay", file: "./recordings/session.jsonl" },
  cols: 80,
  rows: 24,
});

// Record モードはプログラム的に
const conch = await Conch.launch({
  backend: RecordReplayPty.record(
    new LocalPty("bash"),
    { output: "./recordings/session.jsonl" },
  ),
  cols: 80,
  rows: 24,
});
```

## ユースケース

### 1. Conch 自体のユニットテスト

```typescript
// tests/conch-run.test.ts
import { describe, it, expect } from "vitest";
import { Conch } from "../src/conch";
import { RecordReplayPty } from "../src/backend/RecordReplayPty";

describe("Conch.run() with OSC 133", () => {
  it("should extract exit code from D marker", async () => {
    // 事前に記録した「echo hello + OSC 133 マーカー」のセッション
    const conch = await Conch.launch({
      backend: RecordReplayPty.replay("./fixtures/echo-hello-osc133.jsonl"),
      cols: 80,
      rows: 24,
    });

    const r = await conch.run("echo hello", { timeoutMs: 5000 });
    expect(r.exitCode).toBe(0);
    expect(r.outputText).toContain("hello");
    expect(r.meta.method).toBe("osc133");

    conch.dispose();
  });
});
```

### 2. バグ再現の共有

```typescript
// バグ報告者が記録を取る
const conch = await Conch.launch({
  backend: RecordReplayPty.record(
    new LocalPty("bash"),
    { output: "./bug-report-session.jsonl" },
  ),
  shellIntegration: { enable: true },
});

// バグが発生する操作を実行
await conch.run("problematic-command");
// → bug-report-session.jsonl を Issue に添付

conch.dispose();
```

```typescript
// 開発者が再現する
const conch = await Conch.launch({
  backend: RecordReplayPty.replay("./bug-report-session.jsonl"),
});

// 完全に同じ出力が再生される → デバッグ可能
const r = await conch.run("problematic-command");
```

### 3. CI での決定論的テスト

```typescript
// 初回: 実環境で recording を生成（ローカル or CI セットアップ）
// → fixtures/ ディレクトリにコミット

// CI: recording から再生（Docker/SSH 不要）
describe("SSH backend integration", () => {
  it("should handle connection drop gracefully", async () => {
    // 実際の SSH 接続断を記録したファイル
    const conch = await Conch.launch({
      backend: RecordReplayPty.replay("./fixtures/ssh-connection-drop.jsonl"),
    });

    await expect(
      conch.run("long-running-command", { timeoutMs: 5000, strict: true }),
    ).rejects.toThrow("Backend exited during run()");

    conch.dispose();
  });
});
```

### 4. asciicast 互換変換

```typescript
// asciicast v2 (asciinema) 形式への変換
import { convertToAsciicast } from "@ushida_yosei/conch/recording";

const asciicast = await convertToAsciicast("./recordings/session.jsonl");
fs.writeFileSync("./demo.cast", asciicast);
// → asciinema play demo.cast で再生可能
```

asciicast v2 フォーマット:
```jsonl
{"version":2,"width":80,"height":24,"timestamp":1679000000}
[0.012,"o","$ "]
[0.045,"i","echo hello\r"]
[0.050,"o","echo hello\r\nhello\r\n$ "]
```

Conch の記録フォーマットは asciicast v2 と構造が近いため、相互変換は容易。

## Replay モードのタイミング制御

### speed = 0 (デフォルト: 即座再生)

全イベントを `setTimeout(fn, 0)` でスケジュール。マイクロタスクキューで順序は保証。
テスト用途では最速。

### speed = 1 (リアルタイム再生)

記録時のタイミングをそのまま再現。デモやデバッグに有用。

### speed > 1 (高速再生)

`delay = event.t / speed` で加速。長いセッションの確認に有用。

### Conch の wait メソッドとの互換性

Replay モードでも `waitForText`, `waitForStable` 等は正常に動作する:

- `data` イベントが xterm バッファに書き込まれる
- `getSnapshot()` がバッファを読む
- ポーリングベースの wait が変化を検知

**speed = 0 の場合**: 全 data が一瞬で流れるため、`waitForStable` の duration 判定が
即座に成立する。テスト用途では問題ない。

**speed = 1 の場合**: リアルタイムのタイミングで data が流れるため、
記録時の wait と同じタイミングで解決する。

## ファイル構成

```
src/
  backend/
    RecordReplayPty.ts        ← メインクラス (~250行)
  types.ts                    ← BackendConfig に replay 追加
  backendFactory.ts           ← createBackend に replay 追加
tests/
  recordReplayPty.test.ts     ← ユニットテスト
  fixtures/
    echo-hello.jsonl          ← テスト用 recording
    osc133-markers.jsonl      ← OSC 133 テスト用 recording
    connection-drop.jsonl     ← 異常系テスト用 recording
```

## 依存ライブラリ

**なし。** Node.js 標準ライブラリ (`fs`, `readline`) のみ使用。

## 見積もり

| カテゴリ | 行数 |
|---|---|
| RecordReplayPty.ts | ~250行 |
| types.ts 変更 | ~10行 |
| backendFactory.ts 変更 | ~10行 |
| テスト | ~100行 |
| fixture 生成スクリプト | ~50行 |
| ドキュメント | ~30行 |
| **合計** | **~450行** |

## 優先度

**Medium** — Conch 自体の開発効率とテスト品質を直接的に向上させる。
ユーザー向け機能ではないが、他のバックエンド（WebSocketPty, KubernetesPty）の
テストを決定論的に行えるようになるため、間接的に開発速度を加速する。

## 実装順序

1. **Phase 1**: Record モード（実バックエンドのラップ + JSONL 出力）
2. **Phase 2**: Replay モード（JSONL 読み込み + イベント再生）
3. **Phase 3**: `BackendConfig` 統合 + `Conch.launch()` 対応
4. **Phase 4**: asciicast v2 変換ユーティリティ（optional）
5. **Phase 5**: 既存テストの一部を recording ベースに移行

## 設計上の判断

### なぜ JSONL か

| 形式 | 利点 | 欠点 |
|---|---|---|
| JSONL | ストリーミング書き込み可能。行単位で読める。差分が見やすい。 | バイナリ比でファイルサイズ大 |
| MessagePack | コンパクト。高速パース。 | バイナリで人間が読めない。依存追加。 |
| asciicast v2 | asciinema 互換。エコシステム活用。 | write (入力) が記録できない。Conch 固有メタデータが入らない。 |
| protobuf | 型安全。高速。 | 依存追加。スキーマ管理が煩雑。 |

**JSONL を選択。** 理由:
- ストリーミング書き込み（crash しても途中まで読める）
- 人間が読める（`cat recording.jsonl | head` でデバッグ）
- 依存ゼロ
- asciicast v2 への変換は後付けで容易

### write (入力) を記録する理由

asciicast v2 は出力 (`o`) と入力 (`i`) を分けて記録するが、入力は optional。
Conch では入力の記録が重要:

1. **タイミング検証**: `run()` が execute した時刻と、出力が返った時刻の関係を再現。
2. **C-gate デバッグ**: OSC 133 C マーカーが execute の前後どちらで到着したかを確認。
3. **再生時の write スキップ**: Replay モードでは Conch が `write()` を呼ぶが、
   実バックエンドがないため無視する。記録された write イベントは参考情報として保持。

### Replay での write の扱い

Replay モードでは `write()` 呼び出しは **無視される** (デフォルト)。理由:

- Conch の `run()` が `execute(command)` → `write(command + "\r")` を呼ぶ
- Replay バックエンドには実プロセスがないので、write を受けても何も起きない
- 出力 (data イベント) は recording から再生されるので、write がなくても正しく動作

`ignoreWrites: false` に設定すると、write のタイミングを検証用途に使える。
