# Source Code Documentation

Conch のコアロジックが格納されているディレクトリです。

## Directory Structure

- **`session.ts`**: `ConchSession` クラス。
    - バックエンド（プロセス）とフロントエンド（xterm画面）を繋ぐコントローラーです。
    - "Facts"（事実）としてのスナップショット生成、入力の正規化、リサイズ同期などを担当します。
- **`types.ts`**: 共通型定義 (`ITerminalBackend`, `ISnapshot` など)。
- **`keymap.ts`**: キー入力（`press`, `chord`）のためのキーコードマッピング定義。
- **`utils.ts`**: 待機・抽出ユーティリティ。
    - `waitForText`, `waitForStable` などの待機関数。
    - `cropText`, `findText` などのスナップショット解析関数。
- **`backend/`**: PTYの実装アダプター（LocalPtyなど）。
- **`index.ts`**: ライブラリのエントリーポイント。主要なクラスと関数をexportしています。

## Architecture

Conchは「事実（Facts）」と「解釈（Interpretation）」を分離する設計思想を持っています。

```mermaid
graph TD
    subgraph Backend [Backend Adapters]
        LP[LocalPty]
        DP[DockerPty (Future)]
    end

    subgraph Core [Conch Core]
        Session[ConchSession]
        Xterm[xterm-headless]
    end
    
    subgraph Utils [Userland Tools]
        Wait[Wait Utils]
        Locator[Locator Utils]
        Formatter[Formatter]
    end

    Human((Human / Telnet))
    Agent((AI Agent))

    %% Data Flow
    LP -->|onData| Session
    Session -->|write| Xterm
    
    %% Output
    Session -->|onOutput| Human
    
    %% Input
    Human -->|write| Session
    Agent -->|press/type| Session
    
    %% Snapshot & Analysis
    Agent -->|getSnapshot| Session
    Agent -.->|use| Wait
    Agent -.->|use| Locator
    Wait -.->|getSnapshot| Session
    Locator -.->|text/meta| Session
```

### Core Responsibilities
- **Terminal State**: バックエンドからの出力を正確にxtermバッファに反映し維持する。
- **Facts Provider**: スナップショットを通じて、テキストだけでなくカーソル位置、ビューポート情報などの「事実」を提供する。
- **Input Normalization**: `press('Enter')` などの抽象的な操作を、適切なエスケープシーケンスに変換してバックエンドに送る。

### Userland Responsibilities
- **Interpretation**: アプリ固有の意味付け（「ここが選択行である」など）は、CoreではなくUserland（`utils` やユーザーコード）で行う。
- **Formatting**: 行番号の付与や色付けなどの装飾は `formatter` を通じて行う。
