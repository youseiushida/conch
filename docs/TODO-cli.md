それが一番正しいと思う。

結局この議論で分かったのは、リモートでPTY永続化するにはリモートに何かしらのデーモンが要るという物理法則みたいなもので、それを暗黙に送り込む方法は全部セキュリティかポリシーの問題を抱える。tmuxは「既に正統なインストールパスがあるPTY永続化デーモン」として30年の信頼がある。それに乗るのが一番素直。

CLIとしては：

```
$ conch launch --ssh prod --session work

⚡ Connected to prod.example.com
❌ tmux not found on remote host.

Session persistence requires tmux on the remote.
Install with:
  sudo apt install tmux    # Debian/Ubuntu
  sudo yum install tmux    # RHEL/CentOS
  brew install tmux        # macOS

Or run without persistence (session lost on disconnect):
  conch run "npm test" --ssh prod
```

`run`（one-shot、完了待ち）はtmux不要で動く。`launch`/`exec`/`send`のセッション系コマンドはtmux必須。この線引きが明確で、ユーザーにとっても分かりやすい。