# 🐚 Conch
> "In ancient cultures, the conch shell was blown to awaken the ignorant from their slumber. 
> Today, Conch awakens AI agents to see the true state of the terminal."

Like the sacred conch that brings order through its sound, Conch brings order 
to AI-terminal interactions through state management and human intervention.

# 背景とペイン
LLMの開発競争に伴い、LLMの知能指数とそのプログラミング能力は多くの人類を超えるものとなっている。同時にその卓越した能力を利用するため多くのエージェントが開発されている。現状ではコーディングエージェントが主流である。マルチモダリティ、つまり写真や動画を入出力に用いることができる能力が向上すれば数値、文字情報だけでは対応できない別分野のエージェントが現れることは想像できるが、文字情報だけを扱うことがコストパフォーマンスが高い傾向は変わらないだろう。理論上はCLIでできることはすべてエージェントが行うことができることこそがコーディングエージェントがデジタル世界での汎用エージェントとみなせる理由である。しかし、2025年12月現在CLIを完全にエージェントが操作するには1つの大きな障壁が存在する。それは**モーダル/TUI**である。これはVimなどにみられるユーザーの入力を必要としつつも標準入力とは異なる挙動をする状態のことである。Subprocess.runを用いたコマンド実行ではこれらの機能を有するアプリケーションやコマンドを完全に使用できない。Gemini CLIのような一部のコーディングエージェントでは[node-ptyを用いることでこの問題を解決している](https://developers.googleblog.com/ja/say-hello-to-a-new-level-of-interactivity-in-gemini-cli-1/)が、これらの機能はエージェントに密結合しており、汎用的な課題にもかかわらず別のプログラムからそれ単体で呼び出したり埋め込んだりすることが困難である。

# このプロジェクトの役割
このプロジェクトでは`node-pty` (やDocker API, SSH2など) と`@xterm/headless`を用いて第三者のプログラムやエージェントに埋め込まれるCLI実行基盤を提供することを目指している。

- モーダル対応のCLI実行基盤
- コマンド入力とキー入力のAPIを整備し、エージェントがCLIを操作できるようにする
- LLMの絡むロジックは含まない
- ストリームで送られてきたPTYの**出力**をANSI等を適切に解釈して、エージェントが見るscreen state（バッファ/カーソル/サイズ/タイトル/代替バッファ）を提供する
- TCPサーバーを立てて接続できるようにしてユーザーのターミナルからエージェントの見ている画面を共有、介入できるようにする（PlaywrightのCDP接続を参考に。**認証/権限/暗号化は要検討**）
- アダプター（node-pty / docker / ssh2）により同一インターフェースでローカル、コンテナ、VM、リモートサーバーのリソースのどこを作業場所にするか差し替え可能

## 将来的な拡張性 (Interfaces)
本プロジェクトの `ConchSession` (Core) は、インターフェース層 (Interaction Layer) と分離して設計されています。
これにより、将来的に以下のような多様な接続形態をサポート可能です。

- **Telnet**: 人間による監視・介入用 (実装予定)
- **MCP Server**: LLM/Agentへの機能提供用 (ツール呼び出し、リソース取得)
- **WebSocket**: ブラウザベースのUI用
- **VSCode Extension**: IDE統合用
