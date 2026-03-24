# TODO: press() 修飾キー対応の強化

## 概要

現在の `press()` は `Ctrl+文字` のみ対応。`Alt`, `Shift`, `Ctrl+Shift` 等の修飾キーの組み合わせや、修飾キー付き矢印/F キーに対応する。

## 現状の問題

### できること（Ctrl+文字のみ）

```typescript
press("Ctrl+C")     // ✅ → \x03
press("Ctrl+Z")     // ✅ → \x1a
press("Enter")      // ✅ → \r
press("ArrowUp")    // ✅ → ESC[A
press("F1")         // ✅ → ESC OP
```

### できないこと

```typescript
press("Alt+D")           // ❌ warn: Unsupported chord
press("Ctrl+Shift+A")    // ❌ warn: Unsupported chord
press("Shift+ArrowUp")   // ❌ warn: Unsupported chord
press("Ctrl+ArrowRight") // ❌ warn: Unsupported chord
press("Ctrl+Alt+Delete") // ❌ warn: Unsupported chord
press("Ctrl++")          // ❌ "+" がパース区切りと衝突
```

### 根本原因

`chord()` が `Ctrl+1文字` のハードコード:

```typescript
// src/session.ts
public chord(keys: string[]): void {
    const hasCtrl = keys.some(k => k.toLowerCase() === "ctrl");
    const charKey = keys[keys.length - 1];
    if (hasCtrl && charKey.length === 1) {
        this.write(getCtrlChar(charKey));  // これしかない
        return;
    }
    console.warn(`Unsupported chord: ${keys.join("+")}`);
}
```

## 設計

### API 変更: `string | string[]` オーバーロード

```typescript
// 既存互換（全て動く）
press("Enter")
press("Ctrl+C")
press("ArrowUp")

// 新規: 配列形式（曖昧さゼロ）
press(["Ctrl", "Shift", "A"])
press(["Alt", "D"])
press(["Ctrl", "ArrowRight"])
press(["Ctrl", "+"])            // "+" キーとの衝突なし
press(["Shift", "F3"])
```

`pressAndSnapshot()` も同様に `string | string[]` を受け取る。

### エスケープシーケンス仕様

xterm の修飾キー付きキーは `CSI 1;{modifier} {final}` 形式:

| 修飾キー | modifier 値 |
|---|---|
| Shift | 2 |
| Alt | 3 |
| Shift+Alt | 4 |
| Ctrl | 5 |
| Ctrl+Shift | 6 |
| Ctrl+Alt | 7 |
| Ctrl+Shift+Alt | 8 |

計算式: `modifier = 1 + (Shift ? 1 : 0) + (Alt ? 2 : 0) + (Ctrl ? 4 : 0)`

#### 修飾キー付き矢印キー

```
Shift+ArrowUp    → ESC[1;2A
Alt+ArrowUp      → ESC[1;3A
Ctrl+ArrowUp     → ESC[1;5A
Ctrl+Shift+Up    → ESC[1;6A
```

#### 修飾キー付き F キー

```
Shift+F3         → ESC[1;2R
Ctrl+F5          → ESC[15;5~
```

#### Alt+文字 (Meta prefix)

```
Alt+D            → ESC d     (ESC を prefix として送信)
Alt+Backspace    → ESC DEL   (ESC + \x7f)
```

#### Ctrl+Shift+文字

ターミナルによって挙動が異なる。xterm 標準:
```
Ctrl+Shift+A     → 未定義（多くのターミナルで区別不可）
```

ただし kitty keyboard protocol (CSI u) 対応ターミナルでは:
```
Ctrl+Shift+A     → ESC[65;6u
```

**方針: xterm 標準のみ対応。kitty protocol は将来のオプション。**

## 変更対象ファイル

### コア（~100行）

#### `src/keymap.ts`（+60行）

```typescript
// 追加: 修飾キーコードマップ
const MODIFIER_SHIFT = 1;
const MODIFIER_ALT = 2;
const MODIFIER_CTRL = 4;

// 追加: 修飾キー付きエスケープシーケンス生成
export function buildModifiedKey(
  baseKey: string,
  modifiers: { shift?: boolean; alt?: boolean; ctrl?: boolean },
): string | undefined {
  // ...
}

// 既存: getCtrlChar は残す（後方互換）
```

#### `src/session.ts`（~30行変更）

```typescript
// Before
public press(key: string): void {
    if (key.includes("+")) {
        this.chord(key.split("+"));
        return;
    }
    // ...
}

// After
public press(keyOrKeys: string | string[]): void {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : this.parseKeyString(keyOrKeys);
    if (keys.length === 1) {
        // 単一キー
        const seq = SpecialKeys[keys[0]];
        if (seq) { this.write(seq); return; }
        if (keys[0].length === 1) { this.write(keys[0]); return; }
        console.warn(`Unknown key: ${keys[0]}`);
    } else {
        this.chord(keys);
    }
}

// chord() を全面書き換え
private chord(keys: string[]): void {
    const modifiers = extractModifiers(keys); // { shift, alt, ctrl, baseKey }
    const seq = buildModifiedKey(modifiers.baseKey, modifiers);
    if (seq) {
        this.write(seq);
    } else {
        console.warn(`Unsupported chord: ${keys.join("+")}`);
    }
}

// "Ctrl+Shift+ArrowUp" → ["Ctrl", "Shift", "ArrowUp"]
// "Ctrl++" → ["Ctrl", "+"] (最後の + はキー)
private parseKeyString(key: string): string[] {
    // "+" 区切りだが最後の要素が空なら "+" キー
    // ...
}
```

#### `src/conch.ts`（2行）

```typescript
// シグネチャのみ変更
public press(key: string | string[]): void {
    this.throwIfDisposed();
    this.session.press(key);
}

public pressAndSnapshot(
    key: string | string[],
    options?: ConchActionOptions,
): Promise<ActionResult> {
    // ...
}
```

### テスト（~50行追加）

#### `tests/keymap.test.ts`

```typescript
it("buildModifiedKey: Shift+ArrowUp", () => {
    expect(buildModifiedKey("ArrowUp", { shift: true })).toBe("\x1b[1;2A");
});
it("buildModifiedKey: Ctrl+ArrowRight", () => {
    expect(buildModifiedKey("ArrowRight", { ctrl: true })).toBe("\x1b[1;5C");
});
it("buildModifiedKey: Alt+D", () => {
    expect(buildModifiedKey("D", { alt: true })).toBe("\x1bd");
});
```

#### `tests/session.test.ts`

```typescript
it("press(['Ctrl', 'Shift', 'A'])", () => { ... });
it("press(['Alt', 'D'])", () => { ... });
it("press('Ctrl+C') still works", () => { ... }); // 後方互換
```

### ドキュメント（~20行追記）

- `docs/API.md` + `API.ja.md`: `press()` のシグネチャ更新、修飾キー一覧表
- `docs/USAGE.md` + `USAGE.ja.md`: 修飾キーの使い方例

## 後方互換性

**既存コード破壊ゼロ。**

`press("Enter")`, `press("Ctrl+C")`, `press("ArrowUp")` 等の既存呼び出しは全てそのまま動く。
`string` を受け取るパスが残り、内部で `parseKeyString()` → `chord()` に変換される。

## 対応しないもの（将来検討）

- **kitty keyboard protocol** (`CSI u` 形式): 対応ターミナルが限られる
- **マウスイベント**: 別の API として設計すべき
- **キーリピート/長押し**: ターミナルでは意味がない（auto-repeat は OS 側）
- **IME 入力**: `type()` で対応（`press()` の範囲外）

## 見積もり

| カテゴリ | 行数 |
|---|---|
| コア（keymap.ts + session.ts + conch.ts） | ~100行 |
| テスト | ~50行 |
| ドキュメント | ~20行 |
| **合計** | **~170行** |

## 優先度

**Medium** — MCP Server や TmuxHelper より後。ただし MCP 経由で LLM がターミナルを操作する際、
vim のペイン移動（`Ctrl+W` + `j`）や tmux の prefix（`Ctrl+B`）等で必要になる場面がある。
