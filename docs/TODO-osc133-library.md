# TODO: OSC 133/633 コアロジックの別ライブラリ化

## 概要

Conch 内の OSC 133 (Shell Integration) 関連コードのうち、
Conch/xterm に依存しない純粋なパース・生成ロジックを独立ライブラリとして切り出す。

## 動機

- OSC 133 のパースや注入スクリプトは Conch 固有ではない。他のターミナルツールでも使える。
- OSC 633 (VS Code 拡張) への対応を Conch を膨らませずに追加できる。
- 純粋関数だけのライブラリはテストが簡単（xterm も backend もモック不要）。
- 注入スクリプト (bash/pwsh) だけ欲しい人がいる（dotfiles 用等）。

## 現状の全 OSC 133 参照マップ

### 全ファイル横断の参照一覧

| ファイル | 行 | 要素 | 分類 |
|---|---|---|---|
| `src/types.ts` | 77-82 | `ShellIntegrationType` enum (A/B/C/D) | **PURE** |
| `src/types.ts` | 84-87 | `IShellIntegrationEvent` interface | **PURE** |
| `src/types.ts` | 151-156 | `ConchLaunchOptions.shellIntegration` | Conch 固有の設定型 |
| `src/types.ts` | 221-225 | `RunOptions.strict` | Conch 固有 |
| `src/types.ts` | 256 | `RunResult.meta.shellIntegrationUsed` | Conch 固有 |
| `src/scripts.ts` | 61-91 | `BASH_INTEGRATION_SCRIPT` | **PURE** (定数文字列) |
| `src/scripts.ts` | 19-46 | `PWSH_INTEGRATION_SCRIPT` | **PURE** (定数文字列) |
| `src/utils.ts` | 381-402 | `encodeScriptForShell()` | **PURE** (Buffer.from のみ) |
| `src/conch.ts` | 248-258 | `stripAnsiAndOsc()` (private static) | **PURE** (正規表現のみ) |
| `src/conch.ts` | 274-307 | `extractCommandOutput()` (private static) | **PURE** (`stripAnsiAndOsc` のみ依存) |
| `src/conch.ts` | 18 | `import { ShellIntegrationType }` | import |
| `src/conch.ts` | 113-132 | `launch()` 内の shellIntegration 初期化 | **ORCH** |
| `src/conch.ts` | 186-191 | `onShellIntegration()` 委譲 | **ORCH** |
| `src/conch.ts` | 526 | `shellIntegrationUsed` フラグ | **ORCH** |
| `src/conch.ts` | 565-604 | C-gate 状態マシン (sawC, commandIssued) | **ORCH** |
| `src/conch.ts` | 645 | `extractCommandOutput()` 呼び出し | **ORCH** |
| `src/session.ts` | 3 | `import { BASH_INTEGRATION_SCRIPT, PWSH_INTEGRATION_SCRIPT }` | import |
| `src/session.ts` | 11 | `import { ShellIntegrationType }` | import |
| `src/session.ts` | 12 | `import { encodeScriptForShell, waitForText }` | import |
| `src/session.ts` | 32-34 | `shellIntegrationListeners` 配列 | **ORCH** |
| `src/session.ts` | 95-103 | `registerOscHandler(133, ...)` xterm パーサー登録 | **ORCH** (xterm API) |
| `src/session.ts` | 222-260 | `enableShellIntegration()` | **ORCH** (backend I/O + waitForText) |
| `src/session.ts` | 443-454 | `onShellIntegration()` リスナー登録 | **ORCH** |
| `src/session.ts` | 460-486 | `handleOsc133()` パース＋ディスパッチ | **境界** (後述) |

### テストファイル

| ファイル | 行 | 内容 |
|---|---|---|
| `tests/osc133.test.ts` | 6-104 | OSC 133 イベント検知のユニットテスト。MockBackend + ConchSession 経由。 |
| `tests/conch.test.ts` | 23-47 | `run()` + C/D フローの統合テスト |
| `tests/conch.test.ts` | 49-64 | fallback モード（D なし）テスト |
| `tests/conch.test.ts` | 103-121 | `snapshot: "none"` + C/D テスト |
| `tests/conch.test.ts` | 123-174 | 並行 `run()` の OSC 133 分離テスト |
| `tests/conch.test.ts` | 242-345 | `extractCommandOutput` の境界テスト群 |
| `tests/conch.test.ts` | 290-308 | D-without-C 無視テスト |
| `tests/e2e/localPty.e2e.test.ts` | 18-30 | ローカル bash + shellIntegration |
| `tests/e2e/pwsh.e2e.test.ts` | 43, 66, 85 | PowerShell + shellIntegration |
| `tests/e2e/ssh.e2e.test.ts` | 78-91, 116, 126 | SSH + shellIntegration |
| `tests/e2e/docker.e2e.test.ts` | 94, 114 | Docker + shellIntegration |

### OSC 633 の参照

**ゼロ。** 現在のコードベースに OSC 633 への言及はない。

## データフロー図

```
[Backend PTY 出力 (raw bytes)]
  ↓
[ConchSession: backend.onData(data)]
  ↓
[terminal.write(data)]  ← xterm.js が ESC シーケンスをパース
  ↓
[registerOscHandler(133)]  ← xterm パーサーが OSC 133 を検出
  ↓
[handleOsc133(data)]  ← "A", "D;0" 等の文字列を受け取る
  ↓                       ★ ここがパースの境界
  ├─ ShellIntegrationType の検証 (A/B/C/D のみ)
  ├─ params のパース ("D;0;123" → ["0", "123"])
  └─ IShellIntegrationEvent の構築
  ↓
[shellIntegrationListeners に dispatch]
  ↓
[Conch.runInternal() の OSC リスナー]
  ↓
[C-gate 状態マシン]  ← commandIssued → sawC → D 検出
  ↓
[extractCommandOutput(raw, true)]  ← ★ 純粋関数
  ↓
  ├─ C マーカー正規表現: /\x1b\]133;C(?:\x07|\x1b\\)/g
  ├─ D マーカー正規表現: /\x1b\]133;D;?[^\x07\x1b]*(?:\x07|\x1b\\)/g
  ├─ lastC ~ lastD の間をスライス
  └─ stripAnsiAndOsc() で残存 ANSI を除去  ← ★ 純粋関数
  ↓
[RunResult.outputText]
```

## 分類の詳細

### PURE: 外部依存ゼロで抽出可能

これらは入力→出力の純粋な変換で、xterm にも backend にも session にも依存しない。

#### 1. `ShellIntegrationType` enum

```typescript
// src/types.ts:77-82
export enum ShellIntegrationType {
  PromptStart = "A",
  CommandStart = "B",
  CommandExecuted = "C",
  CommandFinished = "D",
}
```

依存: なし。

#### 2. `IShellIntegrationEvent` interface

```typescript
// src/types.ts:84-87
export interface IShellIntegrationEvent {
  type: ShellIntegrationType;
  params: string[];
}
```

依存: `ShellIntegrationType` のみ。

#### 3. `BASH_INTEGRATION_SCRIPT` / `PWSH_INTEGRATION_SCRIPT`

```typescript
// src/scripts.ts:61-91 / 19-46
export const BASH_INTEGRATION_SCRIPT = `...`;
export const PWSH_INTEGRATION_SCRIPT = `...`;
```

依存: なし。純粋な文字列定数。

#### 4. `encodeScriptForShell()`

```typescript
// src/utils.ts:381-402
export function encodeScriptForShell(script: string, shell: "bash" | "pwsh"): string
```

依存: `Buffer.from()` のみ (Node.js 標準)。Conch 非依存。

#### 5. `stripAnsiAndOsc()`

```typescript
// src/conch.ts:248-258 (private static)
private static stripAnsiAndOsc(input: string): string {
  const withoutOsc = input.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "");
  const withoutCsi = withoutOsc.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  return withoutCsi.replace(/\x1b[@-Z\\-_]/g, "");
}
```

依存: なし。正規表現のみ。現在 `private static` なので外部からアクセス不可。

#### 6. `extractCommandOutput()`

```typescript
// src/conch.ts:274-307 (private static)
private static extractCommandOutput(raw: string, shellIntegrationUsed: boolean): string
```

依存: `stripAnsiAndOsc()` のみ（上記5）。OSC 133 C/D マーカーの正規表現で境界抽出。

### 境界: パースロジックは純粋だが、ディスパッチは session 依存

#### `handleOsc133()`

```typescript
// src/session.ts:460-486
private handleOsc133(data: string): void {
  const parts = data.split(";");
  const rawType = parts[0];
  switch (rawType) {
    case ShellIntegrationType.PromptStart:
    case ShellIntegrationType.CommandStart:
    case ShellIntegrationType.CommandExecuted:
    case ShellIntegrationType.CommandFinished:
      break;
    default:
      return;
  }
  const type = rawType as ShellIntegrationType;
  const params = parts.slice(1);
  const event: IShellIntegrationEvent = { type, params };
  this.shellIntegrationListeners.forEach((listener) => { listener(event); });
}
```

**パース部分** (`data.split(";")` → type 検証 → params 抽出 → `IShellIntegrationEvent` 構築) は純粋。
**ディスパッチ部分** (`this.shellIntegrationListeners.forEach(...)`) は session のイベントシステムに依存。

→ パース部分を純粋関数 `parseOsc133(data: string): IShellIntegrationEvent | null` として抽出可能。

### ORCH: Conch に残す（オーケストレーション）

| コード | なぜ残すか |
|---|---|
| `launch()` 内の shellIntegration 初期化 | `session.enableShellIntegration()` + `conch.run()` に依存 |
| `enableShellIntegration()` | `backend.processName`, `unsafeInjectScript()`, `waitForText()` に依存 |
| `registerOscHandler(133, ...)` | xterm.js パーサー API 直接使用 |
| `onShellIntegration()` リスナー管理 | session のイベントパターン |
| C-gate 状態マシン | `run()` のタイミング制御と密結合 |
| `shellIntegrationListeners` 配列 | session のライフサイクル管理 |

## 抽出対象と新ライブラリの API 設計

### パッケージ名案

`@ushida_yosei/exec-detector`

### 抽出するもの

```
新ライブラリ
├── types.ts        ← ShellIntegrationType, IShellIntegrationEvent
├── parse.ts        ← parseOsc133(), parseOsc633() (将来)
├── extract.ts      ← extractCommandOutput(), stripAnsiAndOsc()
├── scripts.ts      ← BASH_INTEGRATION_SCRIPT, PWSH_INTEGRATION_SCRIPT
├── inject.ts       ← encodeScriptForShell()
└── index.ts        ← 全 export
```

### API

```typescript
// --- types ---
export enum ShellIntegrationType {
  PromptStart = "A",
  CommandStart = "B",
  CommandExecuted = "C",
  CommandFinished = "D",
}

export interface IShellIntegrationEvent {
  type: ShellIntegrationType;
  params: string[];
}

// --- parse ---
/**
 * OSC 133 のペイロード文字列をパースする。
 * xterm の registerOscHandler(133, handler) のコールバックに渡される data を受け取る。
 *
 * @param data - OSC 133 のペイロード (e.g. "A", "D;0", "D;0;123")
 * @returns パース結果。未知のタイプは null。
 */
export function parseOsc133(data: string): IShellIntegrationEvent | null;

// 将来: OSC 633 (VS Code 拡張)
// export function parseOsc633(data: string): IShellIntegration633Event | null;

// --- extract ---
/**
 * 生のターミナル出力から ANSI/OSC エスケープシーケンスを除去する。
 */
export function stripAnsiAndOsc(input: string): string;

/**
 * OSC 133 C/D 境界を使ってコマンド出力を抽出する。
 *
 * @param raw - 生のターミナル出力（ANSI/OSC 含む）
 * @param shellIntegrationUsed - OSC 133 が使われたか
 * @returns クリーンなコマンド出力
 */
export function extractCommandOutput(raw: string, shellIntegrationUsed: boolean): string;

// --- scripts ---
/** OSC 133 A/B/C/D を発火する bash スクリプト */
export const BASH_INTEGRATION_SCRIPT: string;

/** OSC 133 A/B/C/D を発火する PowerShell スクリプト */
export const PWSH_INTEGRATION_SCRIPT: string;

// --- inject ---
/**
 * スクリプトを Base64 エンコードしてシェルで実行するワンライナーを生成する。
 */
export function encodeScriptForShell(script: string, shell: "bash" | "pwsh"): string;
```

### 新関数: `parseOsc133()`

現在 `handleOsc133()` の中にインラインで書かれているパースロジックを純粋関数として抽出:

```typescript
// 新ライブラリ: parse.ts
export function parseOsc133(data: string): IShellIntegrationEvent | null {
  const parts = data.split(";");
  const rawType = parts[0];

  switch (rawType) {
    case ShellIntegrationType.PromptStart:
    case ShellIntegrationType.CommandStart:
    case ShellIntegrationType.CommandExecuted:
    case ShellIntegrationType.CommandFinished:
      break;
    default:
      return null; // 未知のタイプ
  }

  return {
    type: rawType as ShellIntegrationType,
    params: parts.slice(1),
  };
}
```

## Conch 側の変更

### Before → After の差分

#### `src/session.ts`

```typescript
// Before
import { BASH_INTEGRATION_SCRIPT, PWSH_INTEGRATION_SCRIPT } from "./scripts";
import { ShellIntegrationType } from "./types";
import { encodeScriptForShell, waitForText } from "./utils";

// After
import {
  BASH_INTEGRATION_SCRIPT,
  PWSH_INTEGRATION_SCRIPT,
  ShellIntegrationType,
  encodeScriptForShell,
  parseOsc133,
} from "@ushida_yosei/exec-detector";
import { waitForText } from "./utils";
```

```typescript
// Before (session.ts:460-486)
private handleOsc133(data: string): void {
  const parts = data.split(";");
  const rawType = parts[0];
  switch (rawType) {
    case ShellIntegrationType.PromptStart:
    // ... 13行のパースロジック
  }
  this.shellIntegrationListeners.forEach((listener) => { listener(event); });
}

// After
private handleOsc133(data: string): void {
  const event = parseOsc133(data);
  if (!event) return;
  this.shellIntegrationListeners.forEach((listener) => { listener(event); });
}
```

#### `src/conch.ts`

```typescript
// Before
import { ShellIntegrationType } from "./types";

// After
import {
  ShellIntegrationType,
  extractCommandOutput,
  stripAnsiAndOsc,
} from "@ushida_yosei/exec-detector";
```

```typescript
// Before (conch.ts:248-307)
private static stripAnsiAndOsc(input: string): string { ... }
private static extractCommandOutput(raw: string, shellIntegrationUsed: boolean): string { ... }

// After: 削除。新ライブラリからインポート。
```

```typescript
// Before (conch.ts:645)
const outputText = Conch.extractCommandOutput(raw, shellIntegrationUsed);

// After
const outputText = extractCommandOutput(raw, shellIntegrationUsed);
```

#### `src/types.ts`

```typescript
// Before: ShellIntegrationType, IShellIntegrationEvent を定義
// After: 削除し、re-export で後方互換を維持

export { ShellIntegrationType, IShellIntegrationEvent } from "@ushida_yosei/exec-detector";
```

#### `src/scripts.ts`

```typescript
// Before: BASH_INTEGRATION_SCRIPT, PWSH_INTEGRATION_SCRIPT を定義
// After: 削除し、re-export で後方互換を維持

export { BASH_INTEGRATION_SCRIPT, PWSH_INTEGRATION_SCRIPT } from "@ushida_yosei/exec-detector";
```

#### `src/utils.ts`

```typescript
// Before: encodeScriptForShell() を定義
// After: 削除し、re-export で後方互換を維持

export { encodeScriptForShell } from "@ushida_yosei/exec-detector";
```

#### `src/index.ts`

変更不要。既に `export * from "./types"`, `export * from "./utils"` しているため、
re-export チェーンで後方互換が維持される。

### テストの移行

#### 新ライブラリ側に移行するテスト

`tests/conch.test.ts:242-345` の `extractCommandOutput` テスト群のうち、
**純粋関数のテスト** を新ライブラリに移動:

- C-D 境界抽出 (243-263) → 新ライブラリの extract.test.ts
- 複数 C-D ペア (265-288) → 新ライブラリの extract.test.ts
- 複数行出力 (310-328) → 新ライブラリの extract.test.ts
- 空出力 (330-345) → 新ライブラリの extract.test.ts

ただしこれらは現在 Conch + MockBackend 経由のテスト（`run()` → `extractCommandOutput` の
統合テスト）なので、新ライブラリには **直接呼び出しの純粋テスト** を新規作成し、
Conch 側の統合テストはそのまま残す。

#### Conch 側に残すテスト

- `tests/osc133.test.ts` — xterm パーサー + session 経由のイベント検知テスト。session 依存なので残す。
- `tests/conch.test.ts:23-47` — C-gate 統合テスト。Conch の orchestration テストなので残す。
- `tests/conch.test.ts:290-308` — D-without-C テスト。C-gate の挙動テストなので残す。
- `tests/e2e/*` — 全て残す。

## 後方互換性

### 公開 API への影響: ゼロ

re-export パターンにより、既存の全 import パスがそのまま動作する:

```typescript
// これらは全て引き続き動作する
import { ShellIntegrationType } from "@ushida_yosei/conch";
import { IShellIntegrationEvent } from "@ushida_yosei/conch";
import { BASH_INTEGRATION_SCRIPT } from "@ushida_yosei/conch";
import { encodeScriptForShell } from "@ushida_yosei/conch";
```

### 破壊的変更: なし

- `Conch.extractCommandOutput()` と `Conch.stripAnsiAndOsc()` は `private static` なので外部利用者はいない。
- 型定義と定数の re-export は TypeScript の型互換性を維持する。

## 依存関係の方向

```
@ushida_yosei/exec-detector  (新ライブラリ)
  ← 依存なし（Node.js 標準の Buffer のみ）

@ushida_yosei/conch  (既存)
  ← depends on: @ushida_yosei/exec-detector
  ← depends on: @xterm/headless, @lydell/node-pty, etc.
```

新ライブラリは Conch に依存しない。Conch が新ライブラリに依存する。一方向。

## ファイル構成（新ライブラリ）

```
packages/exec-detector/
  src/
    types.ts          ← ShellIntegrationType, IShellIntegrationEvent
    parse.ts          ← parseOsc133()
    extract.ts        ← extractCommandOutput(), stripAnsiAndOsc()
    scripts.ts        ← BASH_INTEGRATION_SCRIPT, PWSH_INTEGRATION_SCRIPT
    inject.ts         ← encodeScriptForShell()
    index.ts          ← barrel export
  tests/
    parse.test.ts     ← parseOsc133() 単体テスト
    extract.test.ts   ← extractCommandOutput() 単体テスト
    inject.test.ts    ← encodeScriptForShell() 単体テスト
  package.json
  tsconfig.json
```

## 依存ライブラリ

**なし。** Node.js 標準 API (`Buffer`) のみ。

## 見積もり

### 新ライブラリ

| ファイル | 行数 |
|---|---|
| types.ts | ~15行 |
| parse.ts | ~25行 |
| extract.ts | ~50行 |
| scripts.ts | ~95行 (既存コピー) |
| inject.ts | ~25行 |
| index.ts | ~10行 |
| テスト | ~120行 |
| package.json + tsconfig.json | ~30行 |
| **合計** | **~370行** |

### Conch 側の変更

| 変更 | 規模 |
|---|---|
| import パスの変更 | 3ファイル、各1-3行 |
| `handleOsc133()` の簡略化 | -13行 → +2行 |
| `extractCommandOutput()` / `stripAnsiAndOsc()` 削除 | -60行 |
| `scripts.ts` を re-export に変更 | -70行 → +1行 |
| `types.ts` の enum/interface を re-export に変更 | -13行 → +1行 |
| `utils.ts` の `encodeScriptForShell()` を re-export に変更 | -22行 → +1行 |
| **Conch 側の純減** | **約 -170行** |

## モノレポ vs 別リポジトリ

| | モノレポ (pnpm workspace) | 別リポジトリ |
|---|---|---|
| 開発体験 | 同時に編集・テスト可能 | PR が2つに分かれる |
| バージョン管理 | workspace protocol で常に最新 | semver で明示的に管理 |
| CI | 1つの CI で両方テスト | 各リポジトリに CI |
| 公開 | changeset 等で個別 publish | 独立 publish |

**推奨: モノレポ (pnpm workspace)。** 当面は Conch と密に開発されるため、
同じリポジトリで workspace パッケージとして管理するのが効率的。

```
conch/
  packages/
    conch/              ← 既存の src/ を移動
      package.json      ← @ushida_yosei/conch
    exec-detector/
      package.json      ← @ushida_yosei/exec-detector
  pnpm-workspace.yaml
```

あるいはルート直下をそのまま conch にして、新ライブラリだけ `packages/` に置く軽量な構成でもよい:

```
conch/                  ← 既存構造を維持
  src/                  ← @ushida_yosei/conch (ルートパッケージ)
  packages/
    exec-detector/
      src/
      package.json      ← @ushida_yosei/exec-detector
  pnpm-workspace.yaml
```

## 対応 OSC シーケンス一覧

このライブラリで対応する（または将来対応する）OSC シーケンスの全体像。
ターミナル統合に関わる OSC を網羅的にカバーすることで、
「ターミナルの OSC パーサーはこのライブラリを使えば良い」というポジションを取る。

### 必須（コア機能）— これだけで Show HN に出せる

#### OSC 133 — FinalTerm シェル統合 (A/B/C/D)

Conch が既に実装済み。iTerm2、WezTerm、Windows Terminal、kitty が対応。

| マーカー | 説明 |
|---|---|
| A (PromptStart) | プロンプト表示開始 |
| B (CommandStart) | ユーザー入力開始（プロンプト末尾） |
| C (CommandExecuted) | コマンド実行直前 |
| D (CommandFinished) | コマンド完了 + exit code |

```
ESC ] 133 ; A BEL          ← プロンプト開始
ESC ] 133 ; B BEL          ← コマンド入力開始
ESC ] 133 ; C BEL          ← コマンド実行
ESC ] 133 ; D ; 0 BEL      ← コマンド完了 (exit code 0)
```

#### OSC 633 — VS Code シェル統合 (OSC 133 の上位互換)

VS Code のターミナル統合プロトコル。OSC 133 の A/B/C/D をそのまま含みつつ、
E（明示的コマンドライン）、P（プロパティ: CWD、IsWindows 等）、nonce 検証を追加。
**Cline、Roo Code、Kilo Code、GitHub Copilot** が依存。

| マーカー | 説明 |
|---|---|
| A (PromptStart) | = OSC 133 A |
| B (CommandStart) | = OSC 133 B |
| C (CommandExecuted) | = OSC 133 C |
| D (CommandFinished) | = OSC 133 D + exit code |
| **E (CommandLine)** | 実行されたコマンドライン文字列（明示的） |
| **P (Property)** | プロパティ設定 (`Cwd`, `IsWindows`, `Nonce` 等) |

```
ESC ] 633 ; E ; echo hello ; nonce BEL   ← コマンドライン "echo hello"
ESC ] 633 ; P ; Cwd=/home/user BEL       ← CWD 通知
ESC ] 633 ; P ; IsWindows=True BEL       ← OS 判定
```

nonce は VS Code が生成するランダム文字列で、シェル統合スクリプトが正しいセッションから
発火されたことを検証する。Conch でも同様の nonce 検証を実装できる。

### 強く推奨（実用価値が高い）

#### OSC 7 — CWD 通知

シェルが現在のディレクトリ変更を通知する。`file://hostname/path` 形式。
多くのターミナル (iTerm2, GNOME Terminal, WezTerm, Windows Terminal) が対応。

```
ESC ] 7 ; file://hostname/home/user/project BEL
```

エージェントが「今どのディレクトリにいるか」を知る手段になる。
OSC 633 の `P;Cwd=...` と重複するが、OSC 7 の方が広くサポートされている。
両方パースして、どちらか到着した方を使うのが堅牢。

**注入スクリプトに含める。** precmd/chpwd で CWD 変更時に発行。

#### OSC 9 / OSC 777 — デスクトップ通知

長時間コマンドの完了通知をエージェントがキャッチできる。

```
ESC ] 9 ; notification text BEL           ← iTerm2 形式
ESC ] 777 ; notify ; title ; body BEL     ← urxvt/rxvt-unicode 形式
```

iTerm2 は OSC 9、urxvt は OSC 777。パースは軽量。
エージェントが「バックグラウンドタスクの完了」を検知する手段になる。

**注入スクリプトには含めない。** アプリ/ユーザーが明示的に発行するもの。パーサー側で検出するだけ。

注意: OSC 9;4 は iTerm2 のプログレスバー通知と衝突する。Ghostty は両シーケンスをサポートする
唯一のエミュレータで、OSC 9;4 は常にプログレスレポートとしてパースされる。

### あると良い（パースは軽いので入れておいて損はない）

#### OSC 0 / OSC 2 — ウィンドウタイトル設定

```
ESC ] 0 ; title BEL    ← アイコン名 + ウィンドウタイトル
ESC ] 2 ; title BEL    ← ウィンドウタイトルのみ
```

多くのシェルやプログラムがこれで状態を通知する（例: vim がファイル名をタイトルに設定）。
エージェントが「今何のアプリが動いているか」を推測する手がかりになる。

**注入スクリプトに含める（オプショナル）。** Ghostty は `title` フィーチャーフラグで制御。

#### OSC 8 — ハイパーリンク

```
ESC ] 8 ; params ; uri ST    ← リンク開始
ESC ] 8 ; ; ST               ← リンク終了
```

VTE、iTerm2、mintty、WezTerm などが対応。
エージェントがターミナル出力中の URL を構造化データとして取得できる。
`params` には `id=value` 形式のキーバリューペアが入る。

**注入スクリプトには含めない。** アプリが発行する（`ls --hyperlink=auto`, gcc エラー出力等）。パーサーで検出するだけ。

仕様書: https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda

#### OSC 52 — クリップボード操作

```
ESC ] 52 ; c ; base64-data BEL    ← クリップボードにコピー
ESC ] 52 ; c ; ? BEL              ← クリップボード内容を要求
```

リモートサーバーからシステムクリップボードにコピーする手段。
Neovim が最近デフォルトで有効にした。
エージェントがデータを外部に渡す経路になりうる。

**注入スクリプトには含めない。** アプリが発行する（tmux, vim, neovim 等）。パーサーで検出するだけ。

### 対応 OSC まとめ

| OSC | 名称 | 優先度 | パース | 注入スクリプト | 主な用途 |
|---|---|---|---|---|---|
| **133** | FinalTerm Shell Integration | **必須** | 低 | **含める** | コマンド境界検出、exit code |
| **633** | VS Code Shell Integration | **必須** | 中 | **含める** | コマンドライン取得、CWD、nonce |
| **7** | CWD 通知 | **強く推奨** | 低 | **含める** | ディレクトリ追跡 |
| **9** | iTerm2 通知 | **強く推奨** | 低 | パーサーのみ | コマンド完了通知 |
| **777** | urxvt 通知 | **強く推奨** | 低 | パーサーのみ | コマンド完了通知 |
| **0/2** | ウィンドウタイトル | あると良い | 低 | オプショナル | アプリ状態推測 |
| **8** | ハイパーリンク | あると良い | 低 | パーサーのみ | URL 構造化抽出 |
| **52** | クリップボード | あると良い | 低 | パーサーのみ | データ受け渡し |

## 注入スクリプト戦略

### 方針

ターミナルエミュレータの注入スクリプトをフォークするのではなく、
**参考にして最小実装を新規に書く**。

ターミナルエミュレータの注入スクリプトが巨大なのは、
OSC 7（CWD 通知）、OSC 1337（ユーザー変数）、sudo ラッパー、SSH ラッパーなど、
ターミナルエミュレータ固有の機能が大量に含まれているから。
OSC 133 の A/B/C/D を正しいタイミングで発行するだけなら、各シェルのスクリプトは
**30〜50 行程度** で書ける。

### 対応シェルと参考実装

| シェル | 一次参考 (MIT) | 補助参考 (MIT) |
|---|---|---|
| **bash** | WezTerm [`wezterm.sh`](https://github.com/wezterm/wezterm/blob/main/assets/shell-integration/wezterm.sh) | Ghostty [`ghostty.bash`](https://github.com/ghostty-org/ghostty/blob/main/src/shell-integration/bash/ghostty.bash) |
| **zsh** | WezTerm [`wezterm.sh`](https://github.com/wezterm/wezterm/blob/main/assets/shell-integration/wezterm.sh) (bash/zsh 両対応) | Ghostty [`ghostty-integration`](https://github.com/ghostty-org/ghostty/blob/main/src/shell-integration/zsh/ghostty-integration) |
| **fish** | Ghostty [`ghostty-shell-integration.fish`](https://github.com/ghostty-org/ghostty/blob/main/src/shell-integration/fish/vendor_conf.d/ghostty-shell-integration.fish) | (WezTerm に fish 対応なし) |
| **PowerShell** | VS Code [`shellIntegration.ps1`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration.ps1) | WezTerm [PR #7296](https://github.com/wezterm/wezterm/pull/7296) |
| **elvish** | Ghostty [`ghostty-integration.elv`](https://github.com/ghostty-org/ghostty/blob/main/src/shell-integration/elvish/lib/ghostty-integration.elv) | (他に MIT 実装なし) |
| **nushell** | Ghostty [`ghostty.nu`](https://github.com/ghostty-org/ghostty/blob/main/src/shell-integration/nushell/vendor/autoload/ghostty.nu) | (他に MIT 実装なし) |

WezTerm の `wezterm.sh` が bash/zsh の出発点として最もクリーンで、
Ghostty が fish/elvish/nushell までカバーする唯一の MIT ソース。

切り出し用ミラー: https://github.com/Riatre/wezterm-shell-integration (`wezterm.sh` だけを抽出したリポジトリ)

Ghostty シェル統合の開発者向けドキュメント:
https://github.com/ghostty-org/ghostty/blob/main/src/shell-integration/README.md

Ghostty のプログラムからの動的注入ロジック（Zig 実装）:
https://github.com/ghostty-org/ghostty/blob/main/src/termio/shell_integration.zig

### 現在の Conch スクリプトからの変更点

Conch は現在 bash と pwsh のみ対応。新ライブラリでは:

1. **bash**: 既存の `BASH_INTEGRATION_SCRIPT` をベースに、WezTerm `wezterm.sh` を参考に OSC 7 (CWD) を追加
2. **zsh**: WezTerm `wezterm.sh` を参考に新規作成（bash とはフック機構が異なる: `precmd`, `preexec`, `chpwd`)
3. **fish**: Ghostty `ghostty-shell-integration.fish` を参考に新規作成（`fish_prompt`, `fish_preexec` イベント）
4. **PowerShell**: 既存の `PWSH_INTEGRATION_SCRIPT` をベースに、VS Code `shellIntegration.ps1` を参考に OSC 633 E/P を追加
5. **elvish**: Ghostty `ghostty-integration.elv` を参考に新規作成（需要を見てから）
6. **nushell**: Ghostty `ghostty.nu` を参考に新規作成（需要を見てから）

各スクリプトで OSC 133 A/B/C/D + OSC 7 (CWD) の最小セットを発行。
ターミナルエミュレータ固有機能（OSC 1337 ユーザー変数、sudo ラッパー、SSH ラッパー等）は全て除外。

### OSC 別の注入スクリプト / パーサー 分担

| OSC | 注入スクリプトに含めるか | 理由 |
|---|---|---|
| **133** (A/B/C/D) | **はい** | シェルのフック機構で発行する必要がある |
| **633** (E/P/nonce) | **はい** | シェルのフック機構で発行する必要がある |
| **7** (CWD) | **はい** | precmd/chpwd で CWD 変更時に発行する必要がある |
| **0/2** (タイトル) | **オプショナル** | フィーチャーフラグで制御。Ghostty 方式 |
| **9** (通知) | いいえ | アプリ/ユーザーが明示的に発行 |
| **777** (通知) | いいえ | アプリ/ユーザーが明示的に発行 |
| **8** (リンク) | いいえ | アプリが発行 (`ls --hyperlink=auto` 等) |
| **52** (クリップ) | いいえ | アプリが発行 (tmux, neovim 等) |

## パーサー参考実装リンク集

### OSC 133 / 633 パーサー

| プロジェクト | URL | 備考 |
|---|---|---|
| **VS Code** ShellIntegrationAddon | https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/common/xterm/shellIntegrationAddon.ts | OSC 133/633 のパース。xterm.js addon |
| **VS Code** CommandDetectionCapability | https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/common/capabilities/commandDetectionCapability.ts | パースしたイベントからコマンドモデルを構築 |
| **Ghostty** osc.zig | https://github.com/ghostty-org/ghostty/blob/main/src/terminal/osc.zig | OSC 7/8/9/52/133/777 全てがパース対象 |
| **Ghostty** stream_handler.zig | https://github.com/ghostty-org/ghostty/blob/main/src/termio/stream_handler.zig | OSC ディスパッチの実処理 |
| **WezTerm** termwiz | https://github.com/wezterm/wezterm/tree/main/termwiz | Rust 製 VT エミュレータコア。OSC パース含む |
| **WezTerm** osc.rs | https://github.com/wezterm/wezterm/blob/main/termwiz/src/escape/osc.rs | OSC パース実装 |

### OSC 7 (CWD) パーサー

| プロジェクト | URL | 備考 |
|---|---|---|
| Ghostty | https://github.com/ghostty-org/ghostty/blob/main/src/terminal/osc.zig | OSC "7" がパース対象 |
| WezTerm | https://github.com/wezterm/wezterm/blob/main/termwiz/src/escape/osc.rs | termwiz クレート |

### OSC 9 / 777 (通知) パーサー

| プロジェクト | URL | 備考 |
|---|---|---|
| Ghostty osc.zig | https://github.com/ghostty-org/ghostty/blob/main/src/terminal/osc.zig | OSC 9 + 777 両方。777 は `rxvt_extension` ステートで `notify` のみサポート |
| Ghostty handler | https://github.com/ghostty-org/ghostty/blob/main/src/termio/stream_handler.zig | クロスターミナル互換の通知処理 |

### OSC 8 (ハイパーリンク) パーサー

| プロジェクト | URL | 備考 |
|---|---|---|
| Ghostty | https://github.com/ghostty-org/ghostty/blob/main/src/terminal/osc.zig | `hyperlink_param_key`, `hyperlink_uri` ステートマシン |
| Ghostty Screen | https://github.com/ghostty-org/ghostty/blob/main/src/terminal/Screen.zig | `cursor.hyperlink_id` でセルに適用 |
| WezTerm | https://github.com/wezterm/wezterm/blob/main/termwiz/src/escape/osc.rs | OSC 8 パース |
| 仕様書 | https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda | OSC 8 ハイパーリンク公式仕様 |

### OSC 52 (クリップボード) パーサー

| プロジェクト | URL | 備考 |
|---|---|---|
| Ghostty osc.zig | https://github.com/ghostty-org/ghostty/blob/main/src/terminal/osc.zig | `clipboard_kind` ステートで処理 |
| Ghostty handler | https://github.com/ghostty-org/ghostty/blob/main/src/termio/stream_handler.zig | base64 デコード後にクリップボード更新 (795-823 行付近) |
| Ghostty VT ドキュメント | https://ghostty.org/docs/vt/osc/52 | クリップボードデータのクエリ・変更仕様 |
| WezTerm | https://github.com/wezterm/wezterm/blob/main/termwiz/src/escape/osc.rs | OSC 52 パース |

### OSC 7 (CWD) 注入スクリプト

| プロジェクト | URL | 備考 |
|---|---|---|
| WezTerm | https://github.com/wezterm/wezterm/blob/main/assets/shell-integration/wezterm.sh | `__wezterm_osc7()` 関数。bash/zsh 両対応 |
| Ghostty bash | https://github.com/ghostty-org/ghostty/blob/main/src/shell-integration/bash/ghostty.bash | `_ghostty_report_pwd` で `kitty-shell-cwd://` 形式発行 |
| Ghostty zsh | https://github.com/ghostty-org/ghostty/blob/main/src/shell-integration/zsh/ghostty-integration | `chpwd_functions` に登録 |
| Ghostty fish | https://github.com/ghostty-org/ghostty/blob/main/src/shell-integration/fish/vendor_conf.d/ghostty-shell-integration.fish | `fish_prompt` イベントで発行 |
| VS Code bash | https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-bash.sh | `633;P;Cwd` 形式 (VS Code 独自拡張) |
| VS Code zsh | https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-rc.zsh | 同上 |
| VS Code pwsh | https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration.ps1 | `633;P;Cwd=` 形式 |

### OSC 0/2 (タイトル) 注入スクリプト

| プロジェクト | URL | 備考 |
|---|---|---|
| Ghostty bash | https://github.com/ghostty-org/ghostty/blob/main/src/shell-integration/bash/ghostty.bash | `title` フィーチャー有効時に `\e]2;タイトル\a` 発行 |
| Ghostty zsh | https://github.com/ghostty-org/ghostty/blob/main/src/shell-integration/zsh/ghostty-integration | `GHOSTTY_SHELL_FEATURES` に `title` が含まれる場合 |
| Ghostty fish | https://github.com/ghostty-org/ghostty/blob/main/src/shell-integration/fish/vendor_conf.d/ghostty-shell-integration.fish | 同上 |

### OSC 633 注入スクリプト

| プロジェクト | URL | 備考 |
|---|---|---|
| VS Code bash | https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-bash.sh | OSC 633 E/P 含む |
| VS Code zsh | https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-rc.zsh | 同上 |
| VS Code fish | https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration.fish | 同上 |
| VS Code pwsh | https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration.ps1 | 同上 |

## ファイル構成（全 OSC 反映版）

```
packages/exec-detector/
  src/
    # --- 型定義 ---
    types.ts              ← ShellIntegrationType, IShellIntegrationEvent, IOsc633Event, etc.

    # --- パーサー ---
    parse-osc133.ts       ← parseOsc133()
    parse-osc633.ts       ← parseOsc633()  ← E, P マーカー、nonce 検証
    parse-osc7.ts         ← parseOsc7()    ← CWD 抽出 (file://hostname/path → パス)
    parse-osc-notify.ts   ← parseOsc9(), parseOsc777()
    parse-osc-title.ts    ← parseOsc0(), parseOsc2()
    parse-osc8.ts         ← parseOsc8()    ← ハイパーリンク (params + uri)
    parse-osc52.ts        ← parseOsc52()   ← クリップボード (base64 デコード)
    extract.ts            ← extractCommandOutput(), stripAnsiAndOsc()

    # --- 注入スクリプト ---
    scripts/
      bash.ts             ← OSC 133 A/B/C/D + OSC 7 (CWD) の bash 用最小スクリプト
      zsh.ts              ← zsh 用 (precmd/preexec/chpwd)
      fish.ts             ← fish 用 (fish_prompt/fish_preexec)
      pwsh.ts             ← PowerShell 用 (PSReadLine)
      elvish.ts           ← elvish 用 (将来)
      nushell.ts          ← nushell 用 (将来)
    inject.ts             ← encodeScriptForShell()

    index.ts              ← barrel export
  tests/
    parse-osc133.test.ts
    parse-osc633.test.ts
    parse-osc7.test.ts
    parse-osc-notify.test.ts
    parse-osc8.test.ts
    parse-osc52.test.ts
    extract.test.ts
    inject.test.ts
    scripts.test.ts       ← 各シェル用スクリプトの内容検証
  package.json
  tsconfig.json
```

Conch 側は `registerOscHandler(633, ...)`, `registerOscHandler(7, ...)` 等を追加するだけ。

## 優先度

**Medium** — 機能追加ではなくリファクタリングなので、ユーザー向けの価値は間接的。
ただし OSC 633 対応や他ツールからの利用を見据えると、早めに切り出しておくメリットがある。

## 実装順序

1. **Phase 1**: 新ライブラリの骨格 + OSC 133 パーサー + 既存純粋関数の移動 + テスト
2. **Phase 2**: Conch 側の import 切り替え + re-export で後方互換維持
3. **Phase 3**: 注入スクリプト拡充 + OSC 7 パーサー (注入して即パースの E2E テストが書けるようにセットで。bash/zsh/fish/pwsh に OSC 7 CWD 追加、zsh/fish は新規作成。WezTerm `wezterm.sh` + Ghostty 各シェルスクリプトを参考)
4. **Phase 4**: OSC 633 パーサー + 注入スクリプトに E/P/nonce 追加 (VS Code `shellIntegration*.sh` を参考)
5. **Phase 5**: OSC 9/777/0/2/8/52 パーサー (Ghostty `osc.zig` + `stream_handler.zig` を参考)
6. **Phase 6**: npm publish + Conch の dependency に追加

## 移行チェックリスト

- [ ] 新ライブラリの package.json / tsconfig.json 作成
- [ ] `ShellIntegrationType`, `IShellIntegrationEvent` を新ライブラリに移動
- [ ] `BASH_INTEGRATION_SCRIPT`, `PWSH_INTEGRATION_SCRIPT` を新ライブラリに移動。スクリプト内の `__conch_` プレフィックスを `__exec_detector_` 等のライブラリ名に合わせた汎用名にリネーム（Conch 側は re-export するだけなので影響なし。既存セッションとの二重注入防止ガードは維持）
- [ ] `encodeScriptForShell()` を新ライブラリに移動
- [ ] `stripAnsiAndOsc()` を新ライブラリに移動 (private → public export)
- [ ] `extractCommandOutput()` を新ライブラリに移動 (private → public export)
- [ ] `parseOsc133()` を新規作成
- [ ] 新ライブラリのテスト作成
- [ ] Conch の `src/types.ts` を re-export に変更
- [ ] Conch の `src/scripts.ts` を re-export に変更
- [ ] Conch の `src/utils.ts` の `encodeScriptForShell` を re-export に変更
- [ ] Conch の `src/session.ts` の import を変更 + `handleOsc133()` を `parseOsc133()` 利用に簡略化
- [ ] Conch の `src/conch.ts` の import を変更 + private static メソッド削除
- [ ] 全テスト (unit + e2e) が通ることを確認
- [ ] 既存の `import { ShellIntegrationType } from "@ushida_yosei/conch"` が動くことを確認
