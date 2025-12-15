# テスト計画書

本ドキュメントでは、Conchライブラリの品質を担保するためのテスト計画を定義する。
各モジュールの責務に基づき、正常系・異常系・境界値のテストケースを網羅する。

## 1. `src/session.ts` (ConchSession)

Coreロジックであり、バックエンドとフロントエンドの連携、および「事実（Facts）」の提供を検証する。

### 正常系
- [x] **インスタンス化と破棄**: `new` して `dispose` するまでのライフサイクルがエラーなく完結すること。
- [x] **パイプライン接続**: `backend.onData` に流れたデータが `terminal` に反映され、`onOutput` リスナーにも届くこと。
- [x] **Programmatic I/O**:
    - `write` がバックエンドにデータを送ること。
    - `execute` が改行コード `\r` を付与して送ること。
    - `resize` が `terminal` と `backend` の両方のサイズを変更すること。
- [x] **Snapshot取得 (Viewport)**:
    - `range: 'viewport'` で、画面に見えている範囲だけが取得されること。
    - `cursorSnapshot` が相対座標 (0..rows-1) に変換されていること。
    - `meta.viewportY` が正しいオフセットを示していること。
- [x] **Snapshot取得 (All)**:
    - `range: 'all'` でスクロールバックを含む全バッファが取得されること。
- [x] **Input Simulation**:
    - `press('Enter')` が `\r` を送ること。
    - `type('abc')` が `abc` を送ること。
    - `chord(['Ctrl', 'C'])` が `\x03` を送ること。

### 異常系・境界値
- [x] **Dispose後の操作**: `dispose()` 後に `write` や `resize` を呼んでも例外が落ちず、安全に無視される（または適切なログが出る）こと。
- [x] **リサイズ最小値**: `cols: 0, rows: 0` を指定しても `2x1` (xterm仕様) にクランプされること。
- [x] **空行の扱い**: バッファに空行が含まれる場合、Snapshotにも空文字が含まれ、行数がズレないこと。

## 2. `src/backend/LocalPty.ts` (LocalPty)

実際のプロセス起動を伴うため、モックを利用したテストと、実プロセスを用いた統合テストを区別する。

### 正常系
- [x] **Spawn (非同期)**: `spawn()` を呼ぶまではプロセスが起動せず、呼んだ後に起動すること。
- [x] **Windows初期化**: Windows環境において `chcp 65001` が送信されること（モック等で検証）。
- [x] **データ受信**: プロセスの標準出力が `onData` イベントとして発火すること。
- [x] **終了検知**: プロセス終了時に `onExit` が発火すること。

### 異常系
- [x] **二重Spawn**: 既に `spawn` 済みのインスタンスで再度 `spawn()` を呼ぶとエラーになること。
- [x] **Dispose後のSpawn**: `dispose()` 済みのインスタンスで `spawn()` を呼ぶとエラーになること。
- [x] **Spawn前のWrite**: `spawn()` 前に `write()` してもエラーにならず（警告ログのみ）、プロセスがない状態で安全であること。

## 3. `src/utils.ts` (Wait & Locator Utils)

非同期処理と文字列解析のロジックを検証する。

### Wait Functions
- [x] **waitForText**:
    - 指定文字列が出現したら resolve すること。
    - タイムアウトしたら reject すること。
    - 正規表現 (`/foo/g`) を渡しても `lastIndex` 問題で失敗せず、正しく検知できること。
- [x] **waitForSilence**:
    - 出力が止まって指定時間経過したら resolve すること。
    - 出力が止まらなければタイムアウトすること。
- [x] **waitForChange**:
    - Snapshotの内容が変化したら resolve すること。
- [x] **waitForStable**:
    - Snapshotの変化が止まって指定時間経過したら resolve すること。

### Locator Functions
- [x] **cropText**:
    - 指定した矩形範囲のテキストだけが切り出されること。
    - 範囲外（out of bounds）を指定しても落ちずに空文字等を返すこと。
- [x] **findText**:
    - 文字列検索で正しい座標 `(x, y)` が返ること。
    - 正規表現検索で正しい座標が返ること。
    - 見つからない場合は空配列が返ること。

## 4. `src/keymap.ts`

静的なマッピング定義の整合性を検証する。

### 正常系
- [x] **特殊キー**: `Enter`, `Esc`, `ArrowUp` など主要なキーのエスケープシーケンスが正しいこと。
- [x] **Ctrl変換**: `getCtrlChar('c')` が `\x03`、`getCtrlChar('z')` が `\x1a` を返すこと。
- [x] **Ctrl変換 (小文字)**: `getCtrlChar('C')` でも同様に機能すること。

## 5. 動作検証デモ (Manual Verification)

`examples/demo.ts` を実行し、実際のシェル環境での動作を確認する。
CI等での自動実行は困難なため、開発時のマニュアル検証とする。

- [ ] **Hello World**: `echo "hello"` を実行し、`waitForText` で "hello" を検知して終了できるか。
- [ ] **Interactive**: `cat` コマンド等を起動し、`type` で入力してエコーバックを確認できるか。
- [ ] **Stability**: `dir` / `ls -R` 等の大量出力コマンドを実行し、`waitForStable` で出力完了を待てるか。
