# Source Code Documentation

Conch のコアロジックが格納されているディレクトリです。

## Directory Structure

- **`session.ts`**: `ConchSession` クラス。バックエンド（プロセス）とフロントエンド（xterm画面）を繋ぐコントローラー。
- **`types.ts`**: 共通インターフェース定義 (`ITerminalBackend` など)。
- **`backend/`**: PTYの実装アダプター（Local, Docker, SSH...）。
- **`index.ts`**: エントリーポイント（現在はデモ用スクリプトが混在、将来的に整理予定）。

## Architecture

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

    Human((Human / Telnet))
    Agent((AI Agent))

    LP -->|onData| Session
    Session -->|write| Xterm
    
    Session -->|onOutput| Human
    Human -->|write| Session
    
    Agent -->|getSnapshot| Session
    Agent -->|execute| Session
```
