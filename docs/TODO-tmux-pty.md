# TODO: TmuxPty — tmux セッションバックエンド

## 概要

tmux セッションに接続する `ITerminalBackend` を提供する。
内部的には node-pty で `tmux new-session -A` を起動し、xterm.js でその出力をパースする。

**核心的な違い: `dispose()` = detach。** セッションは生き続ける。
再度 `Conch.launch({ backend: { type: "tmux", session: "work" } })` すれば、同じセッションに復帰できる。

## 動機

### tmux の強み + Conch の強み = 両取り

```
tmux 単体:
  ✅ セッション永続化     ✅ detach/reattach
  ✅ マルチペイン          ✅ 30年の安定性
  ❌ ポーリング待機 (flaky)  ❌ OSC 133 イベント取得不可
  ❌ xterm.js レベルの画面精度なし

Conch (LocalPty) 単体:
  ✅ xterm.js 精密パース    ✅ イベント駆動 wait
  ✅ OSC 133 exit code      ✅ Node.js API
  ❌ プロセス死亡 = 全消失   ❌ セッション永続化なし

TmuxPty (両取り):
  ✅ セッション永続化       ✅ detach/reattach
  ✅ xterm.js 精密パース    ✅ イベント駆動 wait
  ✅ OSC 133 exit code      ✅ Node.js API
```

### ユースケース

1. **LLM エージェントの長時間作業**: セッションを維持したまま Conch インスタンスを再接続
2. **TUI 操作テスト**: tmux 内で vim/htop を起動し、Conch の waitForText で確実に待機
3. **デバッグ**: `tmux attach -t <session>` で人間がリアルタイムに覗ける
4. **CI**: tmux セッションにテスト環境を構築し、テスト間でセッションを再利用
5. **リモート操作**: SSH 先の tmux セッションに Conch から接続（SshPty + tmux の組み合わせ）

## 設計

### 内部アーキテクチャ

```
Conch (xterm.js + waitForText + OSC 133)
  ↓
ConchSession (backend ↔ xterm.js ブリッジ)
  ↓
TmuxPty (ITerminalBackend)
  ↓
node-pty: "tmux new-session -A -s <name>"
  ↓
tmux server (セッション永続化)
  ↓
shell (bash 等)
```

TmuxPty は内部で node-pty を使って `tmux` クライアントプロセスを起動する。
xterm.js は tmux クライアントの PTY 出力をパースするので、tmux が描画する画面がそのまま Conch のスナップショットになる。

**注意: tmux の二重バッファ。** バイトストリームは「シェル → tmux 内部 VT エミュレータ → tmux 再描画 → node-pty → xterm.js」と 2 回パースされる。
tmux 自体が VT100 エミュレータを内蔵しており、シェルの出力を自身の内部バッファに保持してからクライアントに再描画する。
OSC 133 は `allow-passthrough` で正しく通過するため Conch の主要ユースケースでは問題にならないが、
tmux が解釈できない新しいプロトコル（kitty keyboard protocol, kitty graphics 等）は tmux 層で変形・消失する可能性がある。

### spawn() の動作

```typescript
// tmux new-session -A: セッションがなければ作成、あれば attach
// -s: セッション名
// -x, -y: ウィンドウサイズ
spawn() → node-pty.spawn("tmux", ["new-session", "-A", "-s", name, "-x", cols, "-y", rows])
```

`-A` フラグ (tmux 1.8+) により、create-or-attach が 1 コマンドで完結。

### dispose() の動作

```typescript
dispose() → node-pty process を kill
// tmux クライアントが切断される
// tmux セッションは生き続ける（tmux の仕様）
```

LocalPty との決定的な違い:
- **LocalPty**: dispose → プロセス kill → シェル死亡 → 復帰不可
- **TmuxPty**: dispose → tmux クライアント切断 → セッション存続 → 再 attach 可能

### re-attach の流れ

```typescript
// 1回目: セッション作成 + Conch 操作
const conch = await Conch.launch({
  backend: { type: "tmux", session: "work" },
  cols: 80, rows: 24,
  shellIntegration: { enable: true },
});
await conch.run("cd /app && npm install");
conch.dispose(); // detach。セッション "work" は生きている。

// 2回目: 同じセッションに再接続
const conch2 = await Conch.launch({
  backend: { type: "tmux", session: "work" },
  cols: 80, rows: 24,
});
// tmux が画面を再描画 → xterm.js がパース → 前回の状態が見える
const snap = conch2.getSnapshot();
const r = await conch2.run("npm test");
conch2.dispose();
```

## API

### BackendConfig

```typescript
// src/types.ts に追加
| {
    type: "tmux";

    /** tmux セッション名 (必須) */
    session: string;

    /** セッションが存在しない場合に作成するか (default: true)
     *  false の場合、セッションが存在しなければ spawn() が throw する */
    create?: boolean;

    /** 新規セッションで起動するシェル (default: ユーザーのデフォルトシェル)
     *  既存セッションへの attach 時は無視される */
    shell?: string;

    /** dispose 時にセッションを kill するか (default: false)
     *  false = detach のみ（セッション存続）
     *  true = セッションも破棄（LocalPty と同じ挙動） */
    destroyOnDispose?: boolean;

    /** OSC パススルーを自動で有効化するか (default: true)
     *  tmux 3.3+ の allow-passthrough を設定し、
     *  OSC 133 Shell Integration を tmux 越しで動作させる */
    enablePassthrough?: boolean;
  }
```

### TmuxPtyOptions

```typescript
export interface TmuxPtyOptions {
  session: string;
  create?: boolean;           // default: true
  shell?: string;
  destroyOnDispose?: boolean; // default: false
  enablePassthrough?: boolean; // default: true
  cols?: number;
  rows?: number;
}
```

### 利用例

```typescript
import { Conch } from "@ushida_yosei/conch";

// 基本: セッション作成 + Conch 操作
const conch = await Conch.launch({
  backend: { type: "tmux", session: "agent-work" },
  cols: 120, rows: 40,
  timeoutMs: 30_000,
  shellIntegration: { enable: true },
});

try {
  const r = await conch.run("npm test", { timeoutMs: 60_000 });
  console.log(r.exitCode);   // 0 (OSC 133 経由)
  console.log(r.outputText); // テスト出力
} finally {
  conch.dispose(); // detach のみ。セッションは残る。
}
```

```typescript
// 既存セッションに attach
const conch = await Conch.launch({
  backend: { type: "tmux", session: "agent-work", create: false },
  cols: 120, rows: 40,
});

// 前回の状態がそのまま見える
const snap = conch.getSnapshot();
console.log(snap.text);

conch.dispose();
```

```typescript
// 使い捨て: dispose でセッションも破棄
const conch = await Conch.launch({
  backend: { type: "tmux", session: "temp", destroyOnDispose: true },
  cols: 80, rows: 24,
});

await conch.run("echo hello");
conch.dispose(); // tmux セッション "temp" も kill される
```

```typescript
// デバッグ: 別ターミナルから覗ける
const conch = await Conch.launch({
  backend: { type: "tmux", session: "debug" },
});

// 別ターミナルで: tmux attach -t debug
// → エージェントの操作がリアルタイムで見える

await conch.run("some-command");
conch.dispose();
```

## 実装

```typescript
// src/backend/TmuxPty.ts

import { execFileSync } from "node:child_process";
import type { IDisposable, ITerminalBackend } from "../types";

export class TmuxPty implements ITerminalBackend {
  private ptyProcess: import("@lydell/node-pty").IPty | undefined;
  private _disposed = false;
  private _dataListeners: ((data: string) => void)[] = [];
  private _exitListeners: ((code: number, signal?: number) => void)[] = [];
  private disposePromise: Promise<void> | undefined;

  constructor(private options: TmuxPtyOptions) {}

  get id(): string {
    return `tmux-${this.options.session}`;
  }

  get processName(): string {
    // tmux 内のシェル名を返す（shell integration の検出に使われる）
    // 既存セッションの場合は tmux に問い合わせる
    return this.detectShellInSession() ?? this.options.shell ?? "bash";
  }

  async spawn(): Promise<void> {
    if (this._disposed) throw new Error("TmuxPty is disposed");
    if (this.ptyProcess) throw new Error("TmuxPty is already spawned");

    // 1. tmux が使えるか確認
    this.assertTmuxAvailable();

    // 2. create: false の場合、セッション存在チェック
    if (this.options.create === false && !this.hasSession()) {
      throw new Error(
        `tmux session "${this.options.session}" not found. ` +
        `Use create: true (default) to auto-create.`,
      );
    }

    // 3. 既存セッションか新規作成かを判定
    const isExistingSession = this.hasSession();

    // 4. OSC パススルー設定（tmux 3.3+、セッション単位）
    //    グローバル設定 (-g) は他のセッションに影響するため避ける
    if (this.options.enablePassthrough !== false && isExistingSession) {
      this.enablePassthrough();
    }

    // 5. node-pty で tmux クライアントを起動
    const pty = await import("@lydell/node-pty");
    const cols = this.options.cols ?? 80;
    const rows = this.options.rows ?? 24;

    const args = ["new-session", "-A", "-s", this.options.session];

    // 新規セッションのサイズ指定
    args.push("-x", String(cols), "-y", String(rows));

    // 新規セッションのシェル指定
    if (this.options.shell) {
      // -A 使用時: 新規作成の場合のみシェルが適用される
      // 既存セッションへの attach 時は無視される
      args.push(this.options.shell);
    }

    this.ptyProcess = pty.spawn("tmux", args, {
      cols,
      rows,
      env: process.env,
    });

    // 6. イベントハンドラ登録
    this.ptyProcess.onData((data) => {
      this._dataListeners.forEach((l) => l(data));
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this._exitListeners.forEach((l) => l(exitCode, signal ?? 0));
    });

    // 7. 新規セッションの場合: パススルー + ステータスバー設定
    //    (セッション作成後でないと -t で設定できない)
    if (!isExistingSession) {
      if (this.options.enablePassthrough !== false) {
        this.enablePassthrough();
      }
      this.disableStatusBar();
    }
  }

  write(data: string): void {
    if (!this.ptyProcess) return;
    this.ptyProcess.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.ptyProcess) return;
    this.ptyProcess.resize(cols, rows);
    // tmux はクライアントの PTY リサイズに自動追従する
  }

  // --- dispose: detach (セッション存続) ---

  dispose(): void {
    void this.disposeAsync();
  }

  disposeAsync(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this._disposed = true;

    this.disposePromise = (async () => {
      this._dataListeners = [];
      this._exitListeners = [];

      if (this.ptyProcess) {
        // destroyOnDispose: true の場合はセッションも kill
        if (this.options.destroyOnDispose) {
          try {
            execFileSync("tmux", [
              "kill-session", "-t", this.options.session,
            ], { stdio: "pipe" });
          } catch {
            // セッションが既に死んでいる場合は無視
          }
        }

        // ローカルの tmux クライアントプロセスを終了
        // tmux セッションは（destroyOnDispose でなければ）生き続ける
        this.ptyProcess.kill();
        this.ptyProcess = undefined;
      }
    })();

    return this.disposePromise;
  }

  // --- イベントリスナー (LocalPty と同パターン) ---

  onData(listener: (data: string) => void): IDisposable {
    if (this._disposed) return { dispose: () => {} };
    this._dataListeners.push(listener);
    return {
      dispose: () => {
        this._dataListeners = this._dataListeners.filter((l) => l !== listener);
      },
    };
  }

  onExit(listener: (code: number, signal?: number) => void): IDisposable {
    if (this._disposed) return { dispose: () => {} };
    this._exitListeners.push(listener);
    return {
      dispose: () => {
        this._exitListeners = this._exitListeners.filter((l) => l !== listener);
      },
    };
  }

  // --- tmux ヘルパー ---

  private assertTmuxAvailable(): void {
    try {
      execFileSync("tmux", ["-V"], { stdio: "pipe" });
    } catch {
      throw new Error(
        "tmux is not installed. Install it with:\n" +
        "  sudo apt install tmux  (Debian/Ubuntu)\n" +
        "  brew install tmux      (macOS)",
      );
    }
  }

  private hasSession(): boolean {
    try {
      execFileSync("tmux", [
        "has-session", "-t", this.options.session,
      ], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  private enablePassthrough(): void {
    // tmux 3.3+ で OSC 133 等のエスケープシーケンスをパススルーする
    // セッション単位で設定（-g グローバルは他セッションに影響するため避ける）
    try {
      execFileSync("tmux", [
        "set", "-t", this.options.session, "allow-passthrough", "on",
      ], { stdio: "pipe" });
    } catch {
      // tmux 3.3 未満では allow-passthrough が存在しない → 無視
      // OSC 133 は動作しないが、fallback モードで Conch は動く
    }
  }

  private disableStatusBar(): void {
    // ステータスバーを無効化（スナップショット精度のため）
    try {
      execFileSync("tmux", [
        "set", "-t", this.options.session, "status", "off",
      ], { stdio: "pipe" });
    } catch {
      // 無視
    }
  }

  private detectShellInSession(): string | undefined {
    if (!this.hasSession()) return undefined;
    try {
      const result = execFileSync("tmux", [
        "display-message", "-t", this.options.session,
        "-p", "#{pane_current_command}",
      ], { encoding: "utf8", stdio: "pipe" });
      return result.trim() || undefined;
    } catch {
      return undefined;
    }
  }
}
```

## tmux ステータスバーの考慮

tmux はデフォルトでステータスバー（画面下部1行）を表示する。
これが xterm.js のスナップショットに含まれる。

### 対処法

#### 方法 A: ステータスバーを無効化（推奨）

```typescript
// spawn() 内で、セッション作成後にステータスバーを無効化
private disableStatusBar(): void {
  try {
    execFileSync("tmux", [
      "set", "-t", this.options.session, "status", "off",
    ], { stdio: "pipe" });
  } catch {
    // 既存セッションで設定できない場合は無視
  }
}
```

エージェントがスナップショットを正確に読むためには、ステータスバーなしが理想。
ユーザーが `tmux attach` でデバッグする際はステータスバーがない分やや不便だが、
セッション名は tmux のタイトルや `tmux display-message -p '#S'` で確認可能。

#### 方法 B: ステータスバーの行数を考慮してスナップショットを補正

ステータスバーが 1 行占有するので、有効な画面領域が `rows - 1` になる。
Conch のスナップショットで最終行を無視するオプションを追加。

→ 複雑。方法 A を推奨。

### デフォルト動作

spawn() 内で新規セッション作成時にステータスバーを無効化する。
`statusBar?: boolean` オプションで制御可能にする（default: false = 無効）。

## OSC 133 Shell Integration との関係

tmux 越しで OSC 133 を動作させるには以下が必要:

1. **`allow-passthrough on`** (tmux 3.3+): TmuxPty が自動設定
2. **Shell Integration スクリプト注入**: Conch の `enableShellIntegration()` がそのまま動作

tmux が OSC 133 を消費せずパススルーすれば、xterm.js の `registerOscHandler(133)` で
イベントを受け取れる。つまり `conch.run()` の exit code 取得がそのまま動く。

**tmux 3.3 未満**: `allow-passthrough` がないため OSC 133 が tmux に食われる。
Conch は fallback モード（タイムアウトベース）で動作する。
`conch.run()` は使えるが `exitCode` が取れない。

## 既存セッションへの attach 時の画面状態

tmux に attach すると、tmux サーバーが現在の画面状態を **全再描画** する。
xterm.js はこの再描画を受け取ってバッファを構築するため、attach 直後に
`waitForStable()` が解決すれば、スナップショットは正確。

Conch.launch() は既に spawn 後に `waitForStable()` を呼んでいる（POST_SPAWN_STABLE_MS）ため、
特別な対応は不要。

## re-attach 時の Shell Integration 二重注入問題

既存セッションに attach した場合、OSC 133 の注入スクリプトは前回の Conch セッションで
既にシェルに読み込まれている。`Conch.launch({ shellIntegration: { enable: true } })` を
再度呼ぶと `enableShellIntegration()` が二重注入を試みる。

### 既存の二重注入防止ガード

Conch の注入スクリプトには `__conch_` プレフィックスの関数定義が含まれている。
`enableShellIntegration()` は注入前にこの関数が既に存在するかチェックするロジックを持つ
（bash: `type __conch_precmd`、pwsh: `Get-Command __conch_precmd` 等）。

**確認が必要**: re-attach 経由で `enableShellIntegration()` が呼ばれた際に、
この二重注入防止ガードが正しく動作するかを E2E テストで検証する。

### 代替案: re-attach 時は注入スキップ

```typescript
const isExistingSession = backend.hasSession(); // spawn 前にチェック
const conch = await Conch.launch({
  backend: { type: "tmux", session: "work" },
  shellIntegration: {
    enable: !isExistingSession, // 新規セッションのみ注入
  },
});
```

ただしこれはユーザー側の判断を要求するため、理想的にはガードが自動で動くべき。

## processName の注意点

`processName` は spawn 時に `tmux display-message -p '#{pane_current_command}'` で取得する。
この値は tmux ペイン内の **現在のフォアグラウンドプロセス** を返すが:

- spawn 時に 1 回取得して以降は更新しない（現設計）
- セッション中にシェルから python や node に切り替えた場合、古い値が返る
- `enableShellIntegration()` のシェル検出に使われるため、spawn 時点で正しければ実用上十分
- 将来的にリアルタイム更新が必要になれば、tmux に再問い合わせするメソッドを追加可能

## 既存バックエンドとの比較

| 特性 | LocalPty | TmuxPty |
|---|---|---|
| プロセス起動 | node-pty でシェル直接起動 | node-pty で tmux クライアント起動 |
| dispose の挙動 | **プロセス kill（復帰不可）** | **detach（セッション存続）** |
| セッション永続化 | なし | **あり（tmux）** |
| re-attach | 不可 | **可能** |
| マルチペイン | 不可 | tmux の機能で可能 |
| デバッグ | ログのみ | **tmux attach で目視可能** |
| OSC 133 | 直接動作 | allow-passthrough 設定で動作 |
| 依存 | node-pty | node-pty + tmux |
| xterm.js 精度 | 完全 | 完全（tmux の再描画経由）※1 |
| パフォーマンス | 最速 | tmux 1 層分のオーバーヘッド（微小） |
| エスケープシーケンス | 全て透過 | tmux が解釈できないものは変形される可能性 ※2 |

※1 tmux が内部 VT エミュレータで再描画した結果を xterm.js がパースするため、
  標準的な VT100/xterm シーケンスは正確。

※2 kitty keyboard protocol, kitty graphics, sixel 等の tmux 未対応プロトコルは
  tmux 層で消失・変形する。OSC 133 は allow-passthrough で正常に通過する。

## ファイル構成

```
src/
  backend/
    TmuxPty.ts            ← メインクラス (~180行)
  types.ts                ← BackendConfig に tmux 追加 (~15行)
  backendFactory.ts       ← createBackend に tmux 追加 (~15行)
tests/
  tmuxPty.test.ts         ← ユニットテスト (spawn/dispose/re-attach)
  e2e/
    tmux.e2e.test.ts      ← E2E テスト (tmux セッション永続化、OSC 133 パススルー)
```

## 依存ライブラリ

| ライブラリ | 用途 | 種別 |
|---|---|---|
| `@lydell/node-pty` | tmux クライアントの PTY 起動 | dependency (既存) |
| `tmux` | セッション管理 | **システム依存（ユーザーがインストール）** |

Conch 本体への新規依存追加はゼロ。

## 見積もり

| カテゴリ | 行数 |
|---|---|
| TmuxPty.ts | ~180行 |
| types.ts 変更 | ~15行 |
| backendFactory.ts 変更 | ~15行 |
| テスト（unit） | ~80行 |
| テスト（e2e） | ~60行 |
| ドキュメント | ~20行 |
| **合計** | **~370行** |

## 優先度

**High** — Conch のコア価値（xterm.js + イベント駆動 wait + OSC 133）と
tmux のコア価値（セッション永続化 + デバッグ可視性）を組み合わせる。
他の WebSocket バックエンド（ttyd, GoTTY 等）より先に実装する価値がある。

CLI の `conch run`（one-shot）と並んで、Conch の最も実用的な使い方になる可能性が高い。

## 実装順序

1. **Phase 1**: TmuxPty コア
   - spawn (new-session -A) + dispose (detach) + write/resize/onData/onExit
   - BackendConfig 追加 + backendFactory 追加
   - tmux 存在チェック

2. **Phase 2**: OSC パススルー + ステータスバー制御
   - `allow-passthrough on` の自動設定
   - ステータスバー無効化
   - OSC 133 Shell Integration の動作確認

3. **Phase 3**: テスト
   - Unit テスト: spawn/dispose/re-attach のライフサイクル
   - E2E テスト: tmux セッション永続化、run() + OSC 133 パススルー
   - tmux 未インストール環境での graceful エラー

4. **Phase 4**: destroyOnDispose + create: false
   - 使い捨てモード
   - 既存セッション専用 attach モード
