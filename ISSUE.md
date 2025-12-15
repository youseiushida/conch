# []Terminal.write() の非同期性（Snapshotの整合性 / Drain問題）

## 何が起きる？
- `ConchSession` は `backend.onData` で受けた data を即座に `terminal.write(data)` に渡す。
- ただし xterm の `Terminal.write` は内部でバッファ更新をキューイングすることがあり、**直後に `getSnapshot()` しても反映が間に合わない瞬間**があり得る。

## 影響
- テストがフレークしやすい（onData直後のsnapshotが不安定）。
- `waitForText` のようなポーリングは最終的に吸収できるが、ユニットテストで “今すぐ反映されたはず” という前提が崩れる。

## 今回の対応（2025-12-15）
- **保留**（APIデザインに絡むため後で議論）
- **コード変更なし**

## 対応案
- **A: Drain/Flush API を追加**
  - `write` の callback を使って「xtermへの反映完了」を await できるようにする。
- **B: 現状維持 + テストは waitForText / waitForSilence 前提**
  - APIとして「snapshotは eventually consistent」と割り切る。
- **C: Task6（OSC 133 等）を先行**
  - 完了検知やプロンプト検知と合わせて整合点を増やす（ただし作業量は増える）。

## テスト観点
- `ConchSession` のユニットテストは、`onData` 直後の `getSnapshot()` ではなく、ポーリング/待機ユーティリティを使うか、Drain API 導入後に callback 完了を待つ。

---

# [x]waitForText と RegExp の罠（/g, /y による lastIndex 問題）

## 何が起きる？
- `RegExp.prototype.test` は、`/g` や `/y` が付いていると **内部状態 `lastIndex` が進む**。
- `waitForText` はポーリングで何度も `pattern.test(snapshot.text)` を呼ぶため、
  - 1回目は true
  - 2回目は lastIndex が末尾扱いになって false
  のように挙動が揺れることがある。

## 影響
- `waitForText(session, /foo/g)` のような呼び出しが不安定。

## 今回の対応（2025-12-15）
- `src/utils.ts` の `waitForText` で、`RegExp` の場合に **`pattern.lastIndex = 0` を毎回リセット**するように修正（/g, /y のポーリング不安定を解消）。
- ついでに、タイマー変数を `undefined` 許容にして `clearInterval` をガードし、未初期化参照の読みにくさも軽減。

## 対応案
- test前に `pattern.lastIndex = 0` を毎回リセットする。
- もしくは `/g` と `/y` を除去した正規表現にコピーしてから test する。

## テスト観点
- `RegExp` で `/g` を渡した時でも安定して見つかることをテストする（現状は落ちうる）。

---

# [x]waitForSilence の TypeScript（strict）での危うさ（未初期化タイマー/disposable）

## 何が起きる？
- `waitForSilence` 内で `silenceTimer` や `disposable` が **未代入のまま cleanup される可能性**がある。
- strict だと型としても読み手としても不安が残る（「必ず代入される」保証がコードから読み取りにくい）。

## 影響
- TSのstrict設定や将来の変更で型エラー化する可能性。
- テストを書く時に「どの時点で購読が張られているか」が追いづらい。

## 今回の対応（2025-12-15）
- `src/utils.ts` の `waitForSilence` で、`disposable` / `silenceTimer` / `timeoutId` を **`undefined` 許容 + ガード付き cleanup** に変更し、strictでも安全で読みやすい形にした。

## 対応案
- `let disposable: { dispose: () => void } | undefined` のように明示。
- `let silenceTimer: NodeJS.Timeout | undefined` にして `if (silenceTimer) clearTimeout(silenceTimer)` の形にする。

## テスト観点
- 出力がない場合に duration 経過で resolve
- 出力が来続ける場合に timeout で reject
- disposeが必ず呼ばれる（リークしない）

---

# Backend設計: コンストラクタでの自動起動 vs 明示的な `spawn()` メソッド

## 背景
- 現状の `LocalPty` は `new LocalPty(...)` のコンストラクタ内で `pty.spawn` を実行し、プロセスを即座に起動している。
- これには「手軽」というメリットがあるが、以下のデメリットも指摘されている。

## 問題点 / 懸念
1. **初期出力の取りこぼしリスク**: `new` してから `onData` を登録するまでのごく僅かな間に流れてきたデータを取りこぼす可能性がある（同期処理ならほぼ大丈夫だが、設計として脆弱）。
2. **初期化の非同期制御**: Windowsでの `chcp 65001` 送信など、初期化コマンドの完了を待ちたい場合に `await new LocalPty(...)` とは書けないため制御しにくい。
3. **エラーハンドリング**: コンストラクタで例外が出ると扱いづらい。

## 提案
- `LocalPty` (および将来の `DockerPty`, `SshPty`) は、コンストラクタでは設定保持のみ行い、実際の接続/起動は `spawn()` や `connect()` メソッドに分離する。
- ユーザーコード例:
  ```typescript
  const pty = new LocalPty(...);
  pty.onData(data => ...); // 先にリスナー登録
  await pty.spawn();       // その後で起動
  ```

## 恩恵
- **将来の拡張性**: Dockerコンテナの起動待ちやSSH接続待ちなど、明らかに非同期な処理をバックエンドとして実装する際、`await pty.connect()` という共通インターフェースで統一できる。
- **堅牢性**: リスナー登録を確実に先行できるため、起動直後のロゴやプロンプトをテストする際に「たまに失敗する」を防げる。

## テスト観点
- `spawn()` を呼ぶまではプロセスが起動していないこと。
- `spawn()` 後にデータが流れてくること。

---

# [x]PLAN.md「サイズ同期は呼び出し側」vs 実装 `ConchSession.resize` が両方同期

## 現状
- `PLAN.md` では「呼び出し側が backend と session に同じサイズを指定する前提、セッション内で強制同期しない」と読める。
- 一方で実装は `ConchSession.resize(cols, rows)` が **xterm と backend の両方を同期リサイズ**している。

## 影響
- ドキュメントと実装の“契約”がズレている。
- 利用者が「自分でbackend.resizeも呼ぶべき？」と迷う。

## 今回の対応（2025-12-15）
- **方針**: `ConchSession.resize` を single source of truth とする（実装の挙動に合わせる）。
- **変更**: `PLAN.md` の 1-3 memo にある「セッション内での強制同期は行わない」を、現実の実装（xterm+backend同期）に合わせて修正。
- **コード変更**: なし（`ConchSession.resize` 自体は既に両方同期しているため）。

## どっちが良い？（意思決定ポイント）
- **A: ConchSession が single source of truth**
  - 利用者は `session.resize()` だけ呼べば良い。最も直感的。
- **B: サイズ同期は利用者責務**
  - ConchSession は xterm のみ、backend のみ等、片側だけ操作できる余地を残す。

## テスト観点
- Aなら：`session.resize` が `terminal.resize` と `backend.resize` を1回ずつ呼ぶこと
- Bなら：`session.resize` は存在しない/片側のみ、など契約を明確化してテスト

---

# [x]getSnapshot() の cursor 座標：バッファ絶対 vs スナップショット相対

## 現状
- `range: 'viewport'` のとき `text` は viewport 範囲。
- しかし `cursor: {x, y}` は `buffer.cursorX/Y`（= バッファ全体での絶対座標）。

## 影響
- `text` の行インデックス（0..rows-1）と `cursor.y` が一致せず、利用側が混乱しうる。

## 今回の対応（2025-12-15）
- **保留**（APIデザインに絡むため後で議論）
- **コード変更なし**

## 選択肢
- **A: 絶対座標を維持（solid）**
  - ログ全体/スクロールバック含めた解析では便利。
  - viewportで使う場合は `cursor.y - viewportY` を利用者が計算。
- **B: 相対座標に変更（直感的）**
  - `text` と一致しやすい。
  - ただし `range: 'all'` 等での意味付けを明確にする必要。
- **C: 両方返す**
  - `cursorAbsolute` と `cursorInSnapshot` のように二系統。

## テスト観点
- viewport時の `cursorInSnapshotY = cursorAbsoluteY - viewportY` を期待できるか

---

# []formatter の y：バッファ座標 vs スナップショット相対

## 現状
- `getSnapshot` のループ変数 `i`（バッファ上の行番号）が `formatter(line, i)` に渡される。
- viewport取得だと `i` は `viewportY` から始まる（0始まりではない）。

## 影響
- `USAGE.md` の「行番号を付与」用途で、利用者が期待する “0..N” とズレる可能性。

## 今回の対応（2025-12-15）
- **保留**（APIデザインに絡むため後で議論）
- **コード変更なし**

## 選択肢
- **A: 現状維持（bufferYを渡す）**
  - スクロールバック含めた“世界のどこか”が分かる。
- **B: snapshot相対の y を渡す**
  - viewport利用者に直感的。
- **C: 両方渡せる形にする**
  - 例：`formatter(line, ctx)` にして `{ bufferY, snapshotY }` を渡す。

## テスト観点
- viewport取得で y が 0..rows-1 になることを保証するか、bufferYのままを保証するかを決める

---

# ライブラリの責務（Conch）とユーザー責務（Userland）の線引き（実装提案）

## 目的
- Conch を「Playwright/Selenium for TUI」として成立させるために、コアが保証する **facts（事実）** と、ユーザーが注入する **representation（見せ方）/ interpretation（解釈）** を分離する。

## Conch が担う（Core）
- **Terminal state の正確な維持**: backend(PTY)出力 → xterm 反映 → snapshot 生成。
- **Snapshot の facts 提供**: text だけでなく、座標系メタ（viewportY/startRow等）、カーソル、代替バッファ、サイズなど “事実” を返す。
- **入力の基礎**: `write()`（万能）＋ `press/type/chord` のようなアプリ非依存の入力抽象（キー名→シーケンス変換）。
- **待機プリミティブ**: `waitForText/waitForSilence` に加え、画面変化ベースの `waitForChange/waitForStable` 等。
- **汎用の抽出ユーティリティ（意味付けしない）**: region/crop/find のような純粋関数（= TUI版 locator の下地）。

## ユーザーが担う（Userland）
- **スタイリング/表現**: `formatter` による色タグ付け、行番号付与、LLM向け整形など（representation）。
- **アプリ固有の解釈**: Vim/k9s/VisiData の「選択行」「ステータス領域」「ポップアップ」判定など（interpretation）。
- **意思決定・安全ポリシー・介入**: LLMプロンプト、危険操作ガード、人間介入ルール、動画/ログの保存。

## 実装方針（提案）
- `formatter` は “見せ方” の拡張点として維持し、コアは “事実” を欠かさず提供する（formatterに事実提供を押し付けない）。

---

# 入力API: write/execute に加えて press/type/chord を提供する（実装提案）

## 背景
- Vim/k9s/VisiData/ローグなどは「コマンド実行」より「キー操作」が主。
- `write('\\x1b[A')` のような利用はユーザー体験が悪く、Playwright感が出ない。

## 提案API（例）
- `press(key: KeyName): void`（例: `Enter`, `Esc`, `ArrowUp`, `Backspace`, `Tab`, `PageUp`）
- `type(text: string): void`（insert/filter入力）
- `chord(keys: string[]): void` または `press('Ctrl+W')`（修飾キー）
- `execute(command: string): void` は「コマンド + Enter」の糖衣として維持

## 実装スコープ
- コアは **キー名→エスケープシーケンス** の変換表を持つ（少なくとも xterm 互換の基本キー）。
- `Ctrl+C` 等は `press('Ctrl+C')` → `write('\\x03')` のように落とし込める。

## テスト観点
- `press('Ctrl+C')` が `write('\\x03')` 相当を backend に送る
- `press('ArrowUp')` 等の基本キーが期待シーケンスになる

---

# Snapshot: range 指定を「事実付きの観測」にする（実装提案）

## 背景
- `range: 'viewport' | 'all'` は現状 text の切り出しだけで、座標系が利用側に露出して混乱しやすい。

## 提案: Snapshot メタを増やす（facts）
- `rangeUsed`（実際に使われた range）
- `startRow/endRow`（この snapshot が buffer のどこを切り出したか）
- `viewportY`（取得時点の viewport 先頭）
- `rows/cols`（取得時点のサイズ）
- `cursorAbsolute` と `cursorInSnapshot` を両方（※ 既存の cursor は破壊的変更なので要検討）

## Formatter との関係
- formatter は “見せ方” のみ担当し、座標系メタは snapshot 側で常に提供する。

## テスト観点
- viewportで `startRow === viewportY`、`endRow === startRow + rows` 相当
- `cursorInSnapshot.y === cursorAbsolute.y - viewportY` 相当（viewport時）

---

# Formatter の y: bufferY と snapshotY を両方渡せる形にする（実装提案）

## 背景
- 行番号付与などは snapshot 相対（0..N）が直感的。
- 一方で、解析用途では buffer 絶対座標が欲しい。

## 提案
- `formatter(line, ctx)` に変更し、`ctx = { bufferY, snapshotY }` を渡す。
- 互換性を保つなら、`formatter` をオーバーロードするか、新しい `formatter2` を追加して段階移行。

## テスト観点
- viewport取得時 `snapshotY` が 0 始まり連番になる
- `bufferY` が現在の実装の `i` と一致する

---

# 待機API: waitForText/waitForSilence に加えて waitForChange/waitForStable を用意する（実装提案）

## 背景
- k9s のように常時更新するTUIでは `waitForSilence` が成立しづらい。
- Vim/VisiData でも「文字列が出る」より「画面が変わった/落ち着いた」が待ち条件になる。

## 提案API（例）
- `waitForChange(options?)`: snapshot（または region）に差分が出るまで待つ
- `waitForStable({ duration, timeout, region? })`: 変化が止まるまで待つ

## 実装案
- snapshot の `text` ハッシュ（または region 切り出し）で変化検知。
- `Terminal.write` の非同期性があるため、内部はポーリングでよい（既存 waitForText と整合）。

## テスト観点
- 出力イベントを模した “画面更新” が起きたら change が解決する
- 一定時間変化がなければ stable が解決する

---

# Locator 下地: region/crop/find の純粋関数を提供する（実装提案）

## 背景
- Playwright の強みは locator（どこを見るか）。
- TUIではアプリ固有解釈を避けつつ、汎用の抽出機構があるとユーザーが adapter を書きやすい。

## 提案
- `cropText(snapshot, rect)`（text から矩形抽出）
- `findText(snapshot, regex | string)` → `{ x, y, match }[]`（座標返却）
- `getLine(snapshot, y)` / `getBottomLine(snapshot)` など

## 位置づけ
- ここは “事実の抽出” まで（「それが選択行」などの意味付けは userland）。

---

# パッケージの出口を整える（エントリポイント/exports）（実装提案）

## 背景
- 現状 `tsup` の entry が `src/index.ts`（デモ）で、ライブラリとしての公開APIが確定していない。

## 提案
- `src/index.ts` を **ライブラリの re-export** にする（デモは `examples/` 等へ移動）。
- 公開するのはまず:
  - `ConchSession`
  - `ITerminalBackend` / snapshot types
  - `LocalPty`
  - `waitForText/waitForSilence`（＋追加の wait）

## テスト観点
- `import { ConchSession, LocalPty } from 'conch'` の形を将来保証できる
