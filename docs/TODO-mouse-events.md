# TODO: Mouse Events — クリック・スクロール・ドラッグ対応

## 概要

TUI アプリケーション（htop, k9s, lazygit, midnight commander 等）がマウスイベントを
受け付ける場合、Conch からクリック・スクロール・ドラッグをシミュレートできるようにする。

## 背景

TUI アプリがマウスを有効化すると、ターミナルはマウスイベントをエスケープシーケンスとして
アプリの stdin に送る。Conch は `write()` でこのシーケンスを送るだけで良い。

### マウスモード（TUI アプリが有効化する）

| シーケンス | モード | 説明 |
|---|---|---|
| `ESC[?1000h` | Normal | クリックのみ報告 |
| `ESC[?1002h` | Button | クリック＋ボタン押下中の移動を報告 |
| `ESC[?1003h` | Any | 全マウス移動を報告 |
| `ESC[?1006h` | SGR 拡張 | 座標を 10 進数で報告（223 以上の座標対応） |

現代の TUI (htop, lazygit, k9s) は `?1006h` (SGR) を使う。レガシーアプリは `?1000h` を使う。

## エスケープシーケンス仕様

### SGR 拡張マウス（主流）

フォーマット: `ESC[<ボタン;列;行M`（押下）/ `ESC[<ボタン;列;行m`（リリース）

| ボタン値 | 意味 |
|---|---|
| 0 | 左ボタン |
| 1 | 中ボタン（ホイールクリック） |
| 2 | 右ボタン |
| 32 | 左ボタン＋移動（ドラッグ） |
| 33 | 中ボタン＋移動 |
| 34 | 右ボタン＋移動 |
| 64 | スクロールアップ |
| 65 | スクロールダウン |

```
左クリック (col=10, row=5):     ESC[<0;10;5M  (press) + ESC[<0;10;5m (release)
右クリック:                     ESC[<2;10;5M  + ESC[<2;10;5m
スクロールアップ:               ESC[<64;10;5M
スクロールダウン:               ESC[<65;10;5M
ドラッグ (左ボタン):            ESC[<32;10;5M (移動ごとに送信)
```

座標は 1-based（1,1 が左上）。

### レガシーマウス（X10/Normal）

フォーマット: `ESC[M ボタン+32 列+32 行+32`（バイナリ）

```
左クリック (col=10, row=5):     ESC[M \x20 \x2a \x25
```

座標は `+32` オフセットで ASCII 化。上限 223 列/行。

## API 設計

### 基本 API

```typescript
// クリック
conch.click(col, row);                           // 左クリック
conch.click(col, row, { button: "right" });       // 右クリック
conch.click(col, row, { button: "middle" });      // 中クリック

// ダブルクリック（click を短間隔で2回）
conch.doubleClick(col, row);

// スクロール
conch.scroll("up", { col, row });                 // 1行スクロールアップ
conch.scroll("down", { col, row, lines: 5 });     // 5行スクロールダウン

// ドラッグ（テキスト選択等）
conch.drag({ from: [col1, row1], to: [col2, row2] });

// マウス移動（?1003h モード用）
conch.mouseMove(col, row);
```

### Snapshot 連携

```typescript
// 座標指定にテキスト検索を組み合わせ
const matches = conch.findText("Submit");
if (matches.length > 0) {
  await conch.click(matches[0].x, matches[0].y);  // "Submit" の位置をクリック
}

// clickAndSnapshot
const result = await conch.clickAndSnapshot(10, 5, {
  wait: { kind: "change", timeoutMs: 3000 },
});
```

### オプション

```typescript
interface ClickOptions {
  button?: "left" | "right" | "middle";  // default: "left"
  // マウスプロトコル (auto-detect or manual)
  protocol?: "sgr" | "legacy" | "auto";  // default: "auto"
}

interface ScrollOptions {
  col?: number;    // default: 0
  row?: number;    // default: 0
  lines?: number;  // default: 1
}

interface DragOptions {
  from: [col: number, row: number];
  to: [col: number, row: number];
  steps?: number;    // 中間ステップ数 (default: 10)
  intervalMs?: number; // ステップ間の待機 (default: 10)
}
```

### auto-detect

TUI アプリがどのマウスモードを有効化したかは、xterm.js のバッファ状態から検知可能。
Session 層で `ESC[?1000h` 等のシーケンスを監視し、現在のマウスモードを追跡する:

```typescript
// ConchSession 内部
private mouseMode: "none" | "normal" | "button" | "any" = "none";
private mouseEncoding: "legacy" | "sgr" = "legacy";

// xterm parser で監視
this.terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
  if (params[0] === 1000) this.mouseMode = "normal";
  if (params[0] === 1002) this.mouseMode = "button";
  if (params[0] === 1003) this.mouseMode = "any";
  if (params[0] === 1006) this.mouseEncoding = "sgr";
  return false;
});
```

これにより `protocol: "auto"` でアプリに合わせた正しいエンコーディングを自動選択。

## 実装

### エスケープシーケンス生成（~80行）

```typescript
// src/mouse.ts

export function encodeSgrClick(
  button: number,
  col: number,
  row: number,
  press: boolean,
): string {
  // SGR: ESC[<btn;col;rowM (press) or ESC[<btn;col;rowm (release)
  return `\x1b[<${button};${col};${row}${press ? "M" : "m"}`;
}

export function encodeSgrScroll(
  direction: "up" | "down",
  col: number,
  row: number,
): string {
  const button = direction === "up" ? 64 : 65;
  return `\x1b[<${button};${col};${row}M`;
}

export function encodeLegacyClick(
  button: number,
  col: number,
  row: number,
): string {
  // Legacy: ESC[M (button+32) (col+32) (row+32)
  return `\x1b[M${String.fromCharCode(button + 32)}${String.fromCharCode(col + 32)}${String.fromCharCode(row + 32)}`;
}
```

### Conch メソッド（~70行）

```typescript
// src/conch.ts に追加

public click(col: number, row: number, options?: ClickOptions): void {
  this.throwIfDisposed();
  const buttonMap = { left: 0, middle: 1, right: 2 };
  const button = buttonMap[options?.button ?? "left"];
  const seq = encodeSgrClick(button, col + 1, row + 1, true)
            + encodeSgrClick(button, col + 1, row + 1, false);
  this.write(seq);
}

public scroll(
  direction: "up" | "down",
  options?: { col?: number; row?: number; lines?: number },
): void {
  this.throwIfDisposed();
  const col = (options?.col ?? 0) + 1;
  const row = (options?.row ?? 0) + 1;
  const lines = options?.lines ?? 1;
  const seq = encodeSgrScroll(direction, col, row);
  for (let i = 0; i < lines; i++) {
    this.write(seq);
  }
}

public async drag(options: DragOptions): Promise<void> {
  this.throwIfDisposed();
  const [c1, r1] = options.from;
  const [c2, r2] = options.to;
  const steps = options.steps ?? 10;
  const interval = options.intervalMs ?? 10;

  // Press
  this.write(encodeSgrClick(0, c1 + 1, r1 + 1, true));

  // Move
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const col = Math.round(c1 + (c2 - c1) * t) + 1;
    const row = Math.round(r1 + (r2 - r1) * t) + 1;
    this.write(encodeSgrClick(32, col, row, true)); // 32 = drag
    if (interval > 0) await new Promise(r => setTimeout(r, interval));
  }

  // Release
  this.write(encodeSgrClick(0, c2 + 1, r2 + 1, false));
}
```

## ユースケース

### htop でプロセスをクリック選択

```typescript
conch.execute("htop");
await conch.waitForStable({ durationMs: 2000 });

// PID カラムのプロセスをクリック
const matches = conch.findText("node");
if (matches.length > 0) {
  conch.click(matches[0].x, matches[0].y);
  await conch.waitForChange();
}

// F9 で kill メニュー
conch.press("F9");
```

### lazygit でスクロール

```typescript
conch.execute("lazygit");
await conch.waitForStable({ durationMs: 2000 });

// コミットリストをスクロール
conch.scroll("down", { col: 40, row: 10, lines: 5 });
await conch.waitForStable({ durationMs: 300 });
```

### midnight commander でファイルをドラッグ選択

```typescript
conch.execute("mc");
await conch.waitForStable({ durationMs: 2000 });

// ファイルリストをドラッグ選択
await conch.drag({ from: [2, 3], to: [2, 8] });
```

## ファイル構成

```
src/
  mouse.ts              ← エスケープシーケンス生成
  conch.ts              ← click/scroll/drag メソッド追加
tests/
  mouse.test.ts         ← シーケンス生成テスト
  e2e/
    mouse.e2e.test.ts   ← htop/lazygit 等での実機テスト
```

## 見積もり

| カテゴリ | 行数 |
|---|---|
| mouse.ts（シーケンス生成） | ~80行 |
| conch.ts（メソッド追加） | ~70行 |
| session.ts（mouse mode 追跡、optional） | ~30行 |
| テスト | ~60行 |
| ドキュメント | ~30行 |
| **合計** | **~270行** |

## 優先度

**Low-Medium** — press 修飾キー対応の後。キーボード操作でほとんどの TUI は操作可能だが、
htop/lazygit/k9s 等のモダン TUI はマウスを前提とした UI を持つ。
CLI (`conch click 10 5`) としても提供すれば、エージェントからも利用可能。

## 依存関係

- press 修飾キー対応: 不要（独立して実装可能）
- CLI: `conch click`, `conch scroll` コマンドとして公開
- Visual Snapshot: `findText()` → `click()` の連携で「見えているものをクリック」が可能
