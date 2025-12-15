# Development Roadmap


## 1-1. インターフェース定義 (`types.ts`)
- [x] `IPty` (または `ITerminalBackend`) インターフェースを定義する
- [x] `write`, `resize`, `onData`, `dispose` などの必須メソッドを決定する
- 必須メソッド: `write`(UTF-8 string), `resize`(cols, rows), `dispose`(終了/切断)
- イベント: `onData`(stdout/stderr混合), `onExit`(終了コード)
- ID: PIDだけでなくコンテナID等も考慮し `string | number`
- 初期化: 接続確立後のインスタンスを扱う前提（Connectは含まない）

## 1-2. 基底クラス/アダプター作成
- [x] `node-pty` をラップして上記インターフェースに適合させる `LocalPty` クラスを作成する
- [x] 将来的な Docker/SSH 対応を見据えた構造にする
- `LocalPty` は `node-pty` 専用アダプタであり、Docker/SSH等は別クラスで `ITerminalBackend` を実装する（継承関係ではない）。
- コンストラクタ引数は `shell` と共通オプション `cols, rows, env, cwd` に絞り、`node-pty` への依存を隠蔽する。
- Windows環境での `chcp 65001` (UTF-8化) は、ドメイン知識として `LocalPty` クラス内部（spawn直後）に隠蔽する。

## 1-3. セッションクラスの雛形作成 (`session.ts`)
- [x] `ConchSession` クラスを作成する
- [x] コンストラクタで `IPty` と `@xterm/headless` の `Terminal` インスタンスを初期化する
- 設計方針: 依存性注入(DI)を採用。コンストラクタで `ITerminalBackend` インスタンスを受け取る。
- 責務: バックエンド(Pty)とフロントエンド(xterm)のパイプライン接続を管理するコントローラー。
- サイズ同期: `ConchSession.resize(cols, rows)` を single source of truth とし、xterm と backend の両方を同期してリサイズする（最小値は 1 にクランプする）。

## 1-4. パイプラインの接続
- [x] `IPty.onData` のイベントリスナー内で `Terminal.write` を呼び出す
- [x] バックエンドの出力をヘッドレス端末に流し込む処理を実装する
- バック圧制御: 現状は無視。xterm.jsの内部キューに依存する。
- パイプライン: `backend.onData` -> `terminal.write` の単純接続。

## 1-5. ライフサイクル管理
- [x] `dispose()` メソッドを実装する
- [x] プロセス、xtermインスタンス、イベントリスナーを適切に破棄・解除する処理を書く
- プロセス終了時: `ConchSession` は自動で破棄しない（ログ閲覧のため）。`dispose()` は明示的に呼び出す設計。

# タスク2: プログラム向け操作API (`I/O Interface`) の実装

## 2-1. `write` メソッドの実装
- [x] `ConchSession` に `write(data: string)` を追加する
- [x] バックエンド (IPty) へデータを送信する基本メソッドを作る

## 2-2. OS判定と改行コード定数の導入
- [x] 実行環境 (Windows/Posix) に応じた改行コード (`\r` or `\n`) を保持する定数または設定を持たせる
- 以前の議論では `newline` プロパティの導入を検討したが、**入力（コマンド実行）においては `\r` (CR) が全OS共通で安全** であるため、一旦プロパティ化は見送り、`\r` 固定で実装する方針に変更（YAGNI）。

## 2-3. `execute` (コマンド実行) メソッドの実装
- [x] 文字列を受け取り、末尾に適切な改行コードを付与して `write` を呼ぶコンビニエンスメソッドを作る
- **完了検知について**:
    - 本PoCでは「コマンド完了待ち」は実装しない（エージェントがスナップショットを見て判断するWait & See方式）。
    - 将来的な拡張として、VSCodeのような「Shell Integration (OSC 133;A 等の不可視シーケンスによるプロンプト検知)」の導入を検討する（タスク6）。

## 2-4. `resize` メソッドの実装
- [x] `ConchSession` に `resize(cols, rows)` を追加する
- [x] xterm と IPty 両方のサイズを同期して変更する処理を書く

## 2-5. エラーハンドリング
- [x] プロセスが既に終了している場合に書き込もうとした際の例外処理を追加する
- [x] 必要であれば書き込みバッファ溢れの考慮を追加する
- `LocalPty.write` および `resize` 内で `try-catch` し、例外発生時（プロセス終了後など）は `console.warn` でログ出力のみ行い、上位には伝播させない方針を採用。

# タスク3: 「人間の景色」生成API (`Snapshot Engine`) の開発
- **レビュアー指摘反映**:
    - `getSnapshot` に `formatter` 引数を追加し、行番号付与や色判定などの拡張性を確保する。
    - バッファ範囲指定（`range: 'viewport' | 'all'`）を考慮する。

## 3-1. バッファ取得ロジックの実装
- [x] `ConchSession` に `getSnapshot(options?: SnapshotOptions)` メソッドを追加する
- [x] xterm の `buffer.active` から行データをループで取り出す基本ロジックを実装する
- [x] `SnapshotOptions` に `formatter: (line: IBufferLine, y: number) => string` を定義する

## 3-2. 行レンダリングの調整
- [x] `line.translateToString()` のオプション引数 (`trimRight` 等) を検討する
- [x] デフォルトでは `trimRight: true` とし、見た目を維持しつつ扱いやすい文字列形式にする

## 3-3. カーソル位置とメタデータの取得
- [x] `buffer.active.cursorX`, `buffer.active.cursorY` を取得する
- [x] `isAlternateBuffer` (代替バッファ利用中かどうか) などのメタデータを取得する
- [x] 戻り値を `{ text: string, cursor: { x, y }, meta: { isAlternate: boolean } }` の形にする

## 3-4. ビューポート制御 (スクロール対応)
- [x] `SnapshotOptions` に `range` オプションを追加する
- [x] デフォルトは「現在のビューポート」とし、オプションで全バッファ取得も可能にする

## 3-5. 戻り値の構造化と仕上げ
- [x] 型定義 (`ISnapshot`, `SnapshotOptions`) を `types.ts` に集約する
- [x] 実装を完了させ、動作確認用のログ出力を追加する

# タスク3.5: 待機ユーティリティの実装 (Wait Utils)
- レビュアー指摘および ISSUE 対応: エージェント実装やTUI操作に必須となる待機ロジックを拡充した。

## 3.5-1. `waitForText` の実装
- [x] `src/utils.ts` を作成する
- [x] `waitForText(session, regex, options)` を実装する（指定文字列が出るまでポーリング）
- [x] 正規表現の `/g` フラグ対応など、`ISSUE.md` で指摘されたバグ修正を実施済み

## 3.5-2. `waitForSilence` の実装
- [x] `waitForSilence(session, duration)` を実装する（出力が止まるまで待つ）
- [x] strictモードでの安全性向上を実施済み

## 3.5-3. 画面変化による待機 (ISSUE対応) [NEW]
- [x] `waitForChange(session, options?)` を実装する（スナップショット変化待ち）
- [x] `waitForStable(session, duration)` を実装する（画面が落ち着くまで待つ）

# タスク3.6: 高度な入力API (Input Simulation) [NEW]
- `ISSUE.md` 対応: TUI操作をより人間に近づけるための入力抽象化レイヤー。

## 3.6-1. キー入力メソッドの実装
- [x] `press(key: KeyName)`: キー名（Enter, Esc, ArrowUp等）による入力
- [x] `type(text: string)`: 文字列のそのままの入力
- [x] `chord(keys: string[])`: 同時押し（Ctrl+C等）

## 3.6-2. キーマップの実装
- [x] `src/keymap.ts` を作成し、キー名とエスケープシーケンスの変換表を定義

# タスク3.7: Locatorプリミティブ (Locator Primitives) [NEW]
- `ISSUE.md` 対応: Playwrightライクな要素特定のための純粋関数群。

## 3.7-1. 抽出ユーティリティの実装
- [x] `cropText(snapshot, rect)`: テキストからの矩形抽出
- [x] `findText(snapshot, query)`: 文字列/正規表現による座標検索

# タスク3.8: パッケージ構成の整理 [NEW]
- `ISSUE.md` 対応: ライブラリとしての公開APIを明確化。

## 3.8-1. エントリポイントの分離
- [x] `src/index.ts` をライブラリの export ポイントに変更
- [x] `ConchSession`, `LocalPty`, `utils` 等を export

## 3.8-2. デモの移動
- [x] 動作確認用コードを `examples/demo.ts` に移動

# タスク4: Telnetサーバーの「介入・監視」機能の統合
- **レビュアー指摘反映**: アーキテクチャの根幹に関わる「イベント通知」と「整合性確保」を先行して実装する。

## 4-0. 共通インターフェース基盤の設計 (Interaction Layer)
- [ ] `ConchSession` が外部からの操作を受け入れるための抽象化レイヤーを設計する
- [ ] `IInteractionHandler` (仮) のようなインターフェースを検討し、Telnet/WebSocket/MCP が共通して依存できる形にする
- [ ] 入力ソース（Human vs Agent）のタグ付けや排他制御（TakeOver）の概念を設計に含める
- **案2 (InteractionManager/Proxy) を採用**:
    - `ConchSession` はFatにせず、純粋なI/O装置として保つ。
    - 外部接続（Telnet等）は `InteractionManager` 等の調停者を介して操作する。
    - まずはインターフェース定義のみ行い、実装はタスク4-3以降で具体化する。

## 4-1. イベント駆動アーキテクチャの整備
- [x] `ConchSession` に `onOutput(listener)` を実装し、PTYからの生データ（Raw Output）を購読可能にする
- [x] `ConchSession` に `onExit(listener)` を実装し、バックエンド終了を通知できるようにする
- [x] `flush` / `drain` の仕組みを実装する（xtermへの書き込み完了保証）
- `drain()` メソッドを実装済み。`Terminal.write` のコールバックを監視し、バッファ反映完了を `await` できるようにした。
- これにより、`waitForText` などのポーリング前に `await session.drain()` することで、より確実なテストが可能になる。

## 4-2. イベントエミッターの整備
- [ ] `ConchSession` のイベント機能を使い、外部（Telnet等）へのブロードキャストを確認する

## 4-3. Telnetサーバークラスの分離
- [ ] `src/server/TelnetServer.ts` (仮) としてサーバークラスを作成する
- [ ] 複数のクライアント接続を管理できるようにする

## 4-4. 接続ハンドラーの実装
- [ ] クライアント接続時に `ConchSession` の `onOutput` を購読し、セッションの出力をソケットに流す処理を書く

## 4-5. 入力の割り込み処理
- [ ] ソケットからの入力（人間が打ったキー）を `ConchSession.write()` に流し込み、エージェント操作と混在させる処理を書く

## 4-6. Telnet特有の処理 (NVT)
- [ ] Windows/Telnetクライアント特有の改行コード変換を実装する
- [ ] 基本的なTelnetネゴシエーション（ローカルエコーOFFなど）をサーバークラス内にカプセル化する

# タスク5: 結合テスト（PoCデモ）の作成

## 5-1. デモスクリプトの改修 (`examples/demo.ts`)
- [x] 基本的な自動操作デモは作成済み
- [ ] TelnetServer を組み込み、外部接続を受け入れる形に拡張する

## 5-2. 自動操作シナリオの拡張
- [x] `waitForStable` 等を使った堅牢なシナリオを実装済み
- [ ] 対話型コマンド（TUIアプリ等）の操作シナリオを追加検討

## 5-3. スナップショット監視の実装
- [x] デモ内で `getSnapshot()` の出力を確認済み

## 5-4. Telnet接続確認
- [ ] デモ稼働中に手元のターミナルから接続し、自動操作の様子が見えるか確認する
- [ ] キー入力で操作に干渉できるかを確認する

## 5-5. ドキュメント整備とクリーンアップ
- [ ] `README.md` に使い方を追記する
- [x] `src/index.ts` の整理（実施済み）

# タスク6: 高度なシェル統合と完了検知 (Future)
- OSC 133 (Shell Integration) のハンドラを実装し、コマンド完了イベントを正確に検知できるようにする。
- アーキテクチャの大幅変更は不要で、`ConchSession` にパーサーフックを追加する形で実装可能。
