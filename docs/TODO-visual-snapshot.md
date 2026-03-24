# TODO: Visual Snapshot — ターミナル画面の画像キャプチャ

## 概要

xterm.js headless のバッファからセルレベルの色・属性情報を読み取り、
ターミナル画面を SVG/PNG 画像としてレンダリングする機能。

## 動機

現在の `getSnapshot()` はプレーンテキストのみ返す。色、太字、下線などの
視覚情報は捨てられている。画像スナップショットにより:

- **デバッグ**: TUI が実際にどう描画されているかを目視確認
- **ドキュメント**: README やレポートにターミナルスクリーンショットを貼れる
- **ビジュアルリグレッションテスト**: Playwright の `toMatchSnapshot()` 的な画面比較
- **マルチモーダル LLM**: 画面キャプチャを GPT-4o / Claude の vision API に渡して判断させる

## xterm.js headless が持つ情報

`IBufferCell` API で各セルの完全な属性情報が取得可能:

```typescript
const buffer = terminal.buffer.active;
const line = buffer.getLine(row);
const cell = line.getCell(col);

// 文字
cell.getChars();        // "A", "日", "" (空)
cell.getWidth();        // 1 (半角), 2 (全角)

// 色
cell.getFgColor();      // 前景色 (palette index or RGB value)
cell.getBgColor();      // 背景色
cell.getFgColorMode();  // DEFAULT(0), PALETTE(16+256色), RGB(24bit)
cell.getBgColorMode();

// 属性
cell.isBold();
cell.isItalic();
cell.isUnderline();
cell.isStrikethrough();
cell.isDim();
cell.isInverse();       // 前景/背景反転
cell.isBlink();
cell.isOverline();
```

**画像レンダリングに必要な情報は全て揃っている。**

## 設計

### API

```typescript
// テキストスナップショット（既存）
const text = conch.getSnapshot();
// → { text: "...", cursor: {...}, meta: {...} }

// SVG スナップショット（新規）
const svg = conch.getVisualSnapshot({ format: "svg" });
// → "<svg xmlns=...>...</svg>"

// PNG スナップショット（optional dependency: sharp or resvg-js）
const png = conch.getVisualSnapshot({ format: "png" });
// → Buffer (PNG binary)

// オプション
const svg = conch.getVisualSnapshot({
  format: "svg",
  range: "viewport",     // or "all"
  theme: "dark",         // or "light", or custom palette
  fontSize: 14,          // px
  fontFamily: "monospace",
  showCursor: true,
  padding: 8,            // px
});
```

CLI 連携:
```bash
conch snapshot --format svg --session my-session > screenshot.svg
conch snapshot --format png --session my-session > screenshot.png
```

### 実装方式: SVG 生成（推奨）

外部依存ゼロでターミナル画面を正確にレンダリングできる。

#### SVG 構造

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="384"
     style="background:#1e1e1e">
  <!-- 行ごとにグループ -->
  <g transform="translate(8, 22)">
    <!-- セルごとにテキスト要素 -->
    <text x="0" fill="#cccccc" font-family="monospace" font-size="14">$</text>
    <text x="8.4" fill="#cccccc" font-family="monospace" font-size="14"> </text>
    <text x="16.8" fill="#4ec9b0" font-family="monospace" font-size="14"
          font-weight="bold">echo</text>
    <!-- 背景色があるセルは rect + text -->
    <rect x="42" y="-14" width="8.4" height="18" fill="#264f78"/>
    <text x="42" fill="#ffffff" font-family="monospace" font-size="14">h</text>
  </g>
  <!-- カーソル -->
  <rect x="8" y="22" width="8.4" height="18" fill="#ffffff" opacity="0.7"/>
</svg>
```

#### カラーパレット

xterm 256 色パレットの変換テーブルが必要:

```typescript
// 0-7: 標準色
// 8-15: 明るい色
// 16-231: 6x6x6 RGB キューブ
// 232-255: グレースケール
function paletteToHex(index: number): string {
  if (index < 16) return STANDARD_COLORS[index];
  if (index < 232) {
    const i = index - 16;
    const r = Math.floor(i / 36) * 51;
    const g = Math.floor((i % 36) / 6) * 51;
    const b = (i % 6) * 51;
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }
  const gray = (index - 232) * 10 + 8;
  return `#${hex(gray)}${hex(gray)}${hex(gray)}`;
}
```

#### テーマ

```typescript
interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  // xterm 16色のカスタムマッピング
  palette: [string, string, string, string,  // black, red, green, yellow
            string, string, string, string,  // blue, magenta, cyan, white
            string, string, string, string,  // bright variants
            string, string, string, string];
}

const DARK_THEME: TerminalTheme = {
  background: "#1e1e1e",
  foreground: "#cccccc",
  cursor: "#ffffff",
  palette: [
    "#000000", "#cd3131", "#0dbc79", "#e5e510",
    "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
    "#666666", "#f14c4c", "#23d18b", "#f5f543",
    "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
  ],
};
```

## ファイル構成

```
src/
  snapshot/
    svg-renderer.ts       ← SVG 生成エンジン
    color-palette.ts      ← xterm 256色 → hex 変換
    themes.ts             ← dark/light テーマ定義
    index.ts              ← export
  conch.ts                ← getVisualSnapshot() メソッド追加
tests/
  snapshot/
    svg-renderer.test.ts  ← SVG 生成のユニットテスト
    color-palette.test.ts ← カラー変換テスト
```

## 代替方式

### node-canvas（高品質だが重い）

```typescript
import { createCanvas } from "canvas";

const canvas = createCanvas(cols * charWidth, rows * charHeight);
const ctx = canvas.getContext("2d");
ctx.font = "14px monospace";

for (let row = 0; row < rows; row++) {
  for (let col = 0; col < cols; col++) {
    const cell = buffer.getLine(row).getCell(col);
    ctx.fillStyle = fgColor;
    ctx.fillText(cell.getChars(), col * charWidth, row * charHeight);
  }
}

return canvas.toBuffer("image/png");
```

利点: フォントレンダリングが正確（カーニング、リガチャ対応）
欠点: `canvas` パッケージはネイティブバインディング（ビルドが面倒）

### SVG → PNG 変換（optional）

SVG 生成後に PNG が必要なら:

```typescript
// resvg-js (Rust ベース、高速)
import { Resvg } from "@resvg/resvg-js";
const resvg = new Resvg(svgString);
const png = resvg.render().asPng();

// sharp (多機能画像処理)
import sharp from "sharp";
const png = await sharp(Buffer.from(svgString)).png().toBuffer();
```

これらは peerDependency (optional) として提供。SVG のみなら依存ゼロ。

## 全角文字の扱い

日本語等の全角文字は `cell.getWidth() === 2` で幅2セル分を占める。
SVG レンダリングでは:

```typescript
const charWidth = fontSize * 0.6; // 半角の幅
const x = col * charWidth;
const width = cell.getWidth() * charWidth; // 全角は2倍幅

// 背景 rect
if (bgColor) {
  svg += `<rect x="${x}" width="${width}" .../>`;
}
// テキスト
svg += `<text x="${x}" ...>${escapeXml(cell.getChars())}</text>`;
```

## 優先度

**Low-Medium** — テキストスナップショットで LLM エージェントの主要ユースケースはカバーできる。
画像スナップショットは以下の場面で価値がある:

- マルチモーダル LLM に画面をそのまま渡したい場合
- ビジュアルリグレッションテスト
- ドキュメント/デモ用のスクリーンショット自動生成
- デバッグ時の「実際にどう見えているか」の確認

CLI の `conch snapshot --format svg` として提供すれば、
既存のワークフロー（CLI → エージェント）に自然に統合できる。
