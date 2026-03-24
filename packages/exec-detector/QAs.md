# exec-detector 実装前 調査質問集

参考実装 (`references/`) を読んで回答する。
各質問に `[参照ファイル]` を付記。回答は Q の下に A として追記していく。

---

## 1. OSC 133 パーサー (Phase 1)

### Q1.1 A/B/C/D 以外のサブタイプは存在するか？

FinalTerm 仕様では A/B/C/D の 4 種だが、実際の実装で追加のサブタイプ（例: "L", "P" 等）を扱っているものはあるか？
Conch の現行実装は A/B/C/D 以外を無視するが、それで十分か。

- [参照] `vscode-shellIntegrationAddon.ts`
- [参照] `ghostty-osc.zig`
- [参照] `wezterm-osc.rs`

**A1.1: はい、WezTerm が追加サブタイプを実装している。VS Code は A/B/C/D のみ。**

**WezTerm** (`wezterm-osc.rs` 707-833行目) は FinalTerm 仕様の拡張として以下をサポート:

| サブタイプ | 名前 | 説明 |
|---|---|---|
| **L** | `FreshLine` | カーソルが左マージンなら何もせず、そうでなければ `\r\n` 相当 |
| **I** | `MarkEndOfPromptAndStartOfInputUntilEndOfLine` | プロンプト終端、行末までをユーザー入力とする |
| **N** | `MarkEndOfCommandWithFreshLine` | コマンド出力の終了 + FreshLine。`aid`, `cl` パラメータをサポート |
| **P** | `StartPrompt` | プロンプト開始。`k=` パラメータで種類を指定 (`i`=初期, `r`=右, `c`=継続, `s`=セカンダリ) |

```rust
// wezterm-osc.rs 行763, 765
single!(FreshLine, "L");
single!(MarkEndOfPromptAndStartOfInputUntilEndOfLine, "I");
```

**VS Code** (`vscode-shellIntegrationAddon.ts` 62-91行目, 408-438行目) の FinalTerm (OSC 133) ハンドラは **A/B/C/D のみ**。追加サブタイプは処理していない。ただし **OSC 633** (VS Code 独自) では多数の追加サブタイプを定義:
- `E` (CommandLine), `F` (ContinuationStart), `G` (ContinuationEnd), `H` (RightPromptStart), `I` (RightPromptEnd), `P` (Property), `SetMark`, `EnvJson`, `EnvSingleStart/Entry/Delete/End`

**Ghostty** は `parsers.semantic_prompt` モジュール（外部ファイル）に委譲しており、詳細はリファレンス内では不明だが、FinalTerm semantic prompts 仕様に準拠していると推測される。

**exec-detector への示唆**: Phase 1 では A/B/C/D のみで十分だが、WezTerm の L/I/N/P サブタイプの存在を認識しておき、将来の拡張ポイントとして unknown サブタイプを捨てずに保持する設計が望ましい。

---

### Q1.2 OSC 133 D のパラメータ形式のバリエーション

Conch は `D;exitcode` を想定しているが、`D;exitcode;additional` のような追加パラメータを持つ実装はあるか？
VS Code は D にどんなパラメータを期待しているか？

- [参照] `vscode-shellIntegrationAddon.ts`
- [参照] `ghostty-osc.zig`

**A1.2: WezTerm が `D;exitcode;aid=<id>` 形式をサポート。VS Code は `D;exitcode` のみ。**

**VS Code** (`vscode-shellIntegrationAddon.ts` 431-435行目):
```typescript
case FinalTermOscPt.CommandFinished: {
    const exitCode = args.length === 1 ? parseInt(args[0]) : undefined;
    // ...
}
```
`args.length === 1` のチェックにより、**追加パラメータがあると exitCode が `undefined` になる**。つまり `D;0;additional` は exitCode を取得できない。OSC 633 D (行497) は `args[0]` のみを取り、追加パラメータは無視される。

**WezTerm** (`wezterm-osc.rs` 796-809行目) は **`aid` (activity ID) パラメータ**をサポート:
```rust
// D のパース: osc[2] = exitcode, osc[3]以降 = key=value パラメータ
Self::CommandStatus {
    status,
    aid: params.get("aid").map(|&s| s.to_owned()),
}
```
テストケース (1534-1557行目): `133;D;0;aid=23` → `CommandStatus { status: 0, aid: Some("23") }`

さらに Display 実装 (870-878行目) では `err=` パラメータも出力: `D;0;err=0;aid=23`

**exec-detector への示唆**: `D;exitcode` を基本としつつ、残りのパラメータを `key=value` マップとして保持する設計が良い。

---

### Q1.3 OSC 133 A のパラメータ

A マーカーにパラメータ（例: `A;kind=...`）を付ける実装はあるか？

- [参照] `vscode-shellIntegrationAddon.ts`
- [参照] `ghostty-osc.zig`

**A1.3: WezTerm と Ghostty が `aid=` と `cl=` パラメータをサポート。VS Code はパラメータなし。**

**WezTerm** (`wezterm-osc.rs` 780-788行目):
```rust
Self::FreshLineAndStartPrompt {
    aid: params.get("aid").map(|&s| s.to_owned()),
    cl: match params.get("cl") { ... },
}
```
- `aid` = activity ID (プロセスIDなど)
- `cl` = FinalTermClick 型 (`line`, `m`, `v`, `w` のいずれか。カーソル移動の挙動制御)

テストケース: `133;A;aid=12;cl=w` → `FreshLineAndStartPrompt { aid: Some("12"), cl: Some(SmartVertical) }`

**Ghostty** (`ghostty-bash.bash` 245行目) は発行側で `redraw` と `aid` を付加:
```bash
printf "\e]133;A;redraw=last;cl=line;aid=%s\a" "$BASHPID"
```

**VS Code** (`vscode-shellIntegrationAddon.ts` 421-423行目) はパラメータを一切処理しない。

---

### Q1.4 ターミネータの扱い: BEL vs ST

OSC のターミネータとして BEL (`\x07`) と ST (`\x1b\\`) の両方が使われる。
各参考実装はどちらも等価に扱っているか？片方しか受け付けない実装はあるか？
→ パーサーの入力が xterm の `registerOscHandler` 経由ならターミネータはすでに除去されているが、
  raw バイト列から直接パースするケース（extractCommandOutput の正規表現等）で重要。

- [参照] `ghostty-osc.zig` — ステートマシンのターミネータ処理
- [参照] `wezterm-osc.rs`

**A1.4: 全実装が BEL と ST の両方を受理する。Ghostty はレスポンス時にリクエストのターミネータに合わせる。**

**Ghostty** (`ghostty-osc.zig` 248-290行目) は `Terminator` enum で BEL と ST を明示的に区別:
```zig
pub const Terminator = enum {
    st,   // ESC \
    bel,  // 0x07
    pub fn init(ch: ?u8) Terminator {
        return switch (ch orelse return .st) {
            0x07 => .bel,
            else => .st,
        };
    }
};
```
`end()` メソッド (694行目) で `terminator_ch: ?u8` を受け取り、使われたターミネータを記録する。レスポンスを返す OSC (例: OSC 52 クエリ) では、リクエスト時と同じターミネータを使用する。

**WezTerm**: パース層で BEL と ST を等価に処理し、セミコロン区切りの `&[&[u8]]` として `parse()` に渡す。**出力時は常に ST を使用** (617-618行目):
```rust
// Use the longer form ST as neovim doesn't like the BEL version
write!(f, "\x1b\\")?;
```

**VS Code**: xterm.js の `registerOscHandler` が BEL と ST の両方をターミネータとして受け入れ、ハンドラにはターミネータ除去済みの文字列が渡される。ターミネータの種類はハンドラからは不可視。

**exec-detector への示唆**: `extractCommandOutput()` の正規表現は現在 `(?:\x07|\x1b\\)` で両方対応済みで正しい。パーサーとしてはターミネータ情報を保持する必要は Phase 1 では無いが、OSC 52 レスポンス等で必要になる可能性がある。

---

## 2. OSC 633 パーサー (Phase 4)

### Q2.1 OSC 633 E (CommandLine) のエンコーディング

E マーカーで渡されるコマンドライン文字列のエンコード方式は？
特殊文字（`;`, `\x07`, 改行等）はどうエスケープされるか？
VS Code のスクリプトでのエンコード処理と、パーサーでのデコード処理を対応させて確認する。

- [参照] `vscode-shellIntegrationAddon.ts` — E のパース
- [参照] `vscode-shellIntegration-bash.sh` — E の発行
- [参照] `vscode-shellIntegration.ps1` — E の発行

**A2.1: `\xHH` 形式の独自エスケープ方式。**

ドキュメント (`vscode-shellIntegrationAddon.ts` 145-170行目):
```
The command line can escape ascii characters using the `\xAB` format, where AB are the
hexadecimal representation of the character code (case insensitive), and escape the `\`
character using `\\`. It's required to escape semi-colon (`0x3b`) and characters 0x20 and
below.
```

**必須エスケープ対象:**
1. `\` → `\\`
2. `;` (0x3b) → `\x3b`
3. 0x20 以下の全制御文字 (改行 `\n` → `\x0a` 等)

**発行側 (bash, `vscode-shellIntegration-bash.sh` 153-189行目 `__vsc_escape_value()`):**
```bash
for (( i=0; i < "${#str}"; ++i )); do
    byte="${str:$i:1}"
    builtin printf -v val '%d' "'$byte"
    if  (( val < 31 )); then
        builtin printf -v token '\\x%02x' "'$byte"
    elif (( val == 92 )); then  # \
        token="\\\\"
    elif (( val == 59 )); then  # ;
        token="\\x3b"
    else
        token="$byte"
    fi
done
```
2000文字以上の入力では高速版 `__vsc_escape_value_fast()` (144-149行目) が `\` と `;` のみエスケープ。

**発行側 (PowerShell, `vscode-shellIntegration.ps1` 97-106行目):**
```powershell
[regex]::Replace($value, "[$([char]0x00)-$([char]0x1f)\\\n;]", { param($match)
    -Join (
        [System.Text.Encoding]::UTF8.GetBytes($match.Value) | ForEach-Object { '\x{0:x2}' -f $_ }
    )
})
```
PowerShell 版はマルチバイト文字を UTF-8 バイト列に変換して `\xHH` にエンコードする。

**E シーケンスの全体形式 (bash 357行目):**
```bash
builtin printf '\e]633;E;%s;%s\a' "$(__vsc_escape_value "${__vsc_current_command}")" $__vsc_nonce
```
`E;<escaped_command>;<nonce>` の形式。nonce は第2引数。

**パーサー側のデコード (`vscode-shellIntegrationAddon.ts` 803-810行目):**
```typescript
export function deserializeVSCodeOscMessage(message: string): string {
    return message.replaceAll(
        /\\(\\|x([0-9a-f]{2}))/gi,
        (_match, op, hex?) => hex ? String.fromCharCode(parseInt(hex, 16)) : op);
}
```
`\\` → `\`、`\xHH` → 対応文字。大文字小文字を区別しない (`/gi`)。

---

### Q2.2 OSC 633 P (Property) の既知プロパティ一覧

`P;Cwd=...`, `P;IsWindows=...` 以外にどんなプロパティがあるか？
VS Code のコードベースから網羅的にリストアップする。

- [参照] `vscode-shellIntegrationAddon.ts`
- [参照] `vscode-commandDetectionCapability.ts`

**A2.2: 7つのプロパティが確認された。**

| プロパティ名 | 説明 | 発行シェル | 行番号 |
|---|---|---|---|
| `Cwd` | 現在の作業ディレクトリ | bash, zsh, pwsh | addon 571行目 |
| `IsWindows` | Windows (ConPTY) かどうか (`True`/`False`) | bash, pwsh | addon 578行目 |
| `ContinuationPrompt` | 複数行入力時の継続プロンプト文字列 | bash, zsh, pwsh | addon 589行目 |
| `HasRichCommandDetection` | A,B,C,D,E が正確な位置にあるか (`True`/`False`) | bash, zsh, pwsh | addon 591行目 |
| `Prompt` | 現在のプロンプト文字列 (Insiders のみ) | bash, pwsh | addon 595行目 |
| `PromptType` | プロンプトの種類 | bash, zsh, pwsh | addon 601行目 |
| `Task` | タスクモード（コマンドストレージ無効化） | — | addon 605行目 |

**PromptType の既知の値:**
- bash: `starship`, `oh-my-posh`
- zsh: `p10k`, `oh-my-zsh`, `starship`
- pwsh: `starship`, `oh-my-posh`, `posh-git`

---

### Q2.3 nonce 検証の仕組み

VS Code はどのように nonce を生成し、注入スクリプトに渡し、OSC 633 レスポンスで検証するか？
nonce の長さ・文字種・検証タイミングを確認する。
exec-detector で nonce 検証を提供すべきか、それとも呼び出し側に任せるべきか判断材料にする。

- [参照] `vscode-shellIntegrationAddon.ts` — nonce 検証ロジック
- [参照] `vscode-shellIntegration-bash.sh` — nonce の受け渡し

**A2.3: 環境変数で渡し、文字列一致で検証。検証失敗でもデータは受理される（信頼度フラグのみ影響）。**

**生成**: VS Code 本体側で生成（おそらく `crypto.randomUUID()`）。`ShellIntegrationAddon` のコンストラクタ (351行目) が `_nonce: string` を受け取る。

**受け渡し**: 環境変数 `VSCODE_NONCE` としてシェルプロセスに渡す。各スクリプトは即座にローカル変数にコピーして環境変数を削除:
```bash
# bash (行221-222)
__vsc_nonce="$VSCODE_NONCE"
unset VSCODE_NONCE
```
```powershell
# PowerShell (行29-33) — コメントに「PowerShellでは隠すのは不可能」と明記
$Global:__VSCodeState.Nonce = $env:VSCODE_NONCE
$env:VSCODE_NONCE = $null
```

**使用箇所**: OSC 633 E, EnvJson, EnvSingleStart/Entry/End/Delete で送信。

**検証** (`vscode-shellIntegrationAddon.ts` 510行目):
```typescript
this._createOrGetCommandDetection(this._terminal).setCommandLine(commandLine, arg1 === this._nonce);
```
単純な `===` 比較。結果は `isTrusted: boolean` フラグとして capability に渡される。

**検証失敗時** (`vscode-commandDetectionCapability.ts` 444-448行目):
```typescript
setCommandLine(commandLine: string, isTrusted: boolean) {
    this._currentCommand.command = commandLine;
    this._currentCommand.commandLineConfidence = 'high';
    this._currentCommand.isTrusted = isTrusted;  // nonce不一致でもcommandは受理
}
```
nonce 不一致でもコマンドラインは受け入れるが、`isTrusted = false` になる。

**Windows 10 の例外**: PowerShell (225-229行目) では Windows 10 はターミナルに nonce がエコーされる問題があるため nonce を送信しない。

**exec-detector への示唆**: nonce の検証自体は単純な文字列比較なのでライブラリが担う必要は薄い。パーサーが E マーカーの nonce フィールドを型安全に抽出し、検証は呼び出し側に委ねるのが適切。

---

### Q2.4 OSC 633 と OSC 133 の同時発行

VS Code の注入スクリプトは OSC 633 だけを発行するのか、OSC 133 も同時に発行するのか？
両方発行する場合、パーサー側で重複検知は必要か？

- [参照] `vscode-shellIntegration-bash.sh`
- [参照] `vscode-shellIntegration.ps1`

**A2.4: VS Code の注入スクリプトは OSC 633 のみを発行。ただし、パーサーは OSC 133 も受理する。重複検知は未実装。**

VS Code の全注入スクリプト (bash, zsh, pwsh) は `\e]633;` のみを発行。`\e]133;` は一切発行しない。

しかしパーサー側 (`vscode-shellIntegrationAddon.ts` 369-379行目) は **両方のハンドラを登録**:
```typescript
xterm.parser.registerOscHandler(ShellIntegrationOscPs.VSCode, data => this._handleVSCodeSequence(data));
xterm.parser.registerOscHandler(ShellIntegrationOscPs.FinalTerm, data => this._handleFinalTermSequence(data));
```
これは powerlevel10k や starship など他ツールが OSC 133 を発行する場合に対応するため。

重複検知について (413-417行目のコメント):
```typescript
// It was considered to disable the common protocol in order to not confuse the VS Code
// shell integration if both happen for some reason. This doesn't work for powerlevel10k
// when instant prompt is enabled though.
```
**重複検知は意図的に実装されていない。** 両方受信した場合、各 `handle*` メソッドが二重に呼ばれるが、マーカー位置の上書きで吸収される。

OSC 133 B の特殊処理 (424-426行目): FinalTerm 経由の CommandStart は `ignoreCommandLine: true` で呼ばれ、コマンドラインの抽出を信頼しない。

---

## 3. 注入スクリプト — bash (Phase 3)

### Q3.1 bash での OSC 133 A/B/C/D 発行タイミング

WezTerm と Ghostty はそれぞれ何のフック機構（`PROMPT_COMMAND`, `DEBUG` trap, `PS0/PS1` 等）を使って A/B/C/D を発行しているか？
各アプローチの trade-off は何か？

- [参照] `wezterm-shell-integration.sh`
- [参照] `ghostty-bash.bash`
- [参照] `vscode-shellIntegration-bash.sh`

**A3.1: 3つの異なるアプローチが存在する。**

| マーカー | WezTerm | Ghostty (bash 4.4+) | VS Code |
|---|---|---|---|
| **A** | precmd 内で printf (493行目) | precmd 内で printf (245行目) | PS1 に埋め込み (388行目) |
| **B** | PS1 末尾に埋め込み (477行目) | PS1 末尾に埋め込み (202行目) | PS1 末尾に埋め込み (388行目) |
| **C** | preexec 内で printf (506行目) | preexec 内で printf (271行目) | preexec 内で printf (358行目) |
| **D** | 次の precmd 先頭で printf (484行目) | 次の precmd 先頭で printf (234行目) | 次の precmd 先頭で printf (375行目) |

**preexec の実現方法が最も異なる:**

| | WezTerm | Ghostty (bash 4.4+) | VS Code |
|---|---|---|---|
| preexec 手法 | **bash-preexec ライブラリ** (DEBUG trap) | **PS0** | **DEBUG trap** (自前) |
| 外部依存 | bash-preexec 全体を埋め込み (43-426行目) | なし | なし |
| 他ツールとの干渉 | DEBUG trap 競合リスク大 | PS0 は競合が少ない | DEBUG trap 競合 (既存trap保存で緩和) |
| 最低 bash バージョン | 3.1 | 4.4 (PS0導入) | ~3.2 |

**Ghostty の PS0 手法の詳細** (`ghostty-bash.bash` 289-296行目):
```bash
if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3) )); then
    PS0+='${ __ghostty_preexec_hook; }'    # bash 5.3+ function substitution
else
    PS0+='$(__ghostty_preexec_hook >/dev/tty)'  # bash 4.4+ command substitution
fi
```
PS0 は bash がコマンド入力を受理した直後・実行直前に展開されるので、DEBUG trap なしで preexec を実現できる。bash 5.3+ では function substitution `${ cmd; }` でサブシェルを回避。

**exec-detector への示唆**: PS0 手法が最もクリーンだが bash 4.4+ 制限がある。bash-preexec フォールバックとの組み合わせ (Ghostty 方式) が最もバランスが良い。

---

### Q3.2 二重注入防止

すでにシェル統合が注入済みの環境で再度注入されることを防ぐガードの実装方法。
環境変数チェック？関数存在チェック？

- [参照] `wezterm-shell-integration.sh`
- [参照] `ghostty-bash.bash`

**A3.2: 各実装で異なるが、環境変数/シェル変数のチェックが共通パターン。**

| 実装 | ガード方式 | 詳細 |
|---|---|---|
| **WezTerm** | 変数 + PROMPT_COMMAND 内容チェック | `bash_preexec_imported` 変数 (95-98行目) + `PROMPT_COMMAND` に `__bp_precmd_invoke_cmd` が含まれるか (337-339行目)。環境変数 `WEZTERM_SHELL_SKIP_ALL=1` でオプトアウト可 (25-27行目) |
| **Ghostty (bash)** | 環境変数 unset + 内容チェック | `GHOSTTY_BASH_INJECT` を検出後即 `unset` (25-29行目)。PROMPT_COMMAND に `__ghostty_hook` が含まれるか (308行目)、PS0 に `__ghostty_preexec_hook` が含まれるか (289行目) |
| **Ghostty (zsh)** | 状態変数存在チェック | `(( ! $+_ghostty_state )) || builtin return 0` (46行目)。`$+var` で変数の存在を1行でチェック |
| **VS Code** | 環境変数チェック | `VSCODE_SHELL_INTEGRATION` が設定済みなら即 return (9-13行目)。最もシンプル |

**Ghostty の特徴**: 注入に使った環境変数を即座に `unset` するため、子プロセスにフラグが漏れない。

---

### Q3.3 bash バージョン互換性

最低サポート bash バージョンは？`PROMPT_COMMAND` が配列になったのは bash 5.1 からだが、各実装はどう対処しているか？

- [参照] `wezterm-shell-integration.sh`
- [参照] `ghostty-bash.bash`
- [参照] `vscode-shellIntegration-bash.sh`

**A3.3: WezTerm は bash 3.1+、Ghostty は bash 4.4+ (フォールバックで 3.2+)、VS Code は ~bash 3.2+。**

**PROMPT_COMMAND 配列対応 (bash 5.1+):**

| 実装 | 方式 |
|---|---|
| **WezTerm** | 5.1+ は `PROMPT_COMMAND+=('...')`、以前は `PROMPT_COMMAND+=$'\n...'` (386-391行目) |
| **Ghostty** | 5.1+ は配列として設定。既存値の型を `declare -p` で検出して分岐 (310-320行目) |
| **VS Code** | PROMPT_COMMAND を完全に置き換え、元の値を `__vsc_original_prompt_command` に保存して `eval` で実行 (467-477行目)。配列問題を回避 |

**Ghostty の既存 PROMPT_COMMAND 型検出** (`ghostty-bash.bash` 315行目):
```bash
elif [[ $(builtin declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a "* ]]; then
    PROMPT_COMMAND+=("__ghostty_hook 2>/dev/null")
else
    [[ "${PROMPT_COMMAND}" =~ (\;[[:space:]]*|$'\n')$ ]] || PROMPT_COMMAND+=";"
    PROMPT_COMMAND+="__ghostty_hook 2>/dev/null"
fi
```
文字列の場合は末尾にセミコロンまたは改行があるか確認してから連結。

**Ghostty の bash 5.3+ 対応** (290-296行目): function substitution `${ cmd; }` でサブシェルを回避。

**VS Code の bash 4.4+ 対応** (245-249行目): `${parameter@P}` によるプロンプト展開。

---

## 4. 注入スクリプト — zsh (Phase 3)

### Q4.1 zsh のフック機構

`precmd`, `preexec`, `chpwd` の使い分け。
`add-zsh-hook` を使うか、`precmd_functions` 配列に直接追加するか。

- [参照] `wezterm-shell-integration.sh` (bash/zsh 両対応)
- [参照] `ghostty-zsh-integration`
- [参照] `vscode-shellIntegration-rc.zsh`

**A4.1: Ghostty は配列直接追加、VS Code は `add-zsh-hook` を使用。**

| 機能 | Ghostty | VS Code | WezTerm |
|---|---|---|---|
| precmd | `precmd_functions` 直接追加 (91-92行目) | `add-zsh-hook precmd` (326行目) | `precmd_functions` 直接追加 (552行目) |
| preexec | `preexec_functions` 直接追加 (432-433行目) | `add-zsh-hook preexec` (327行目) | `preexec_functions` 直接追加 (553行目) |
| chpwd | `chpwd_functions` 直接追加 (232行目) | 不使用 (precmd内で CWD 更新) | — |
| zle hooks | 手動 widget 置換 (393-427行目) | 不使用 | — |

**`add-zsh-hook` vs 直接追加の Trade-off:**
- `add-zsh-hook` は重複追加を自動防止し、`add-zsh-hook -d` で安全に削除できる
- 配列直接追加は `autoload` 不要で、ユーザー定義関数による上書きを防止。Ghostty は `builtin` プレフィックスを徹底 (37-38行目のコメント)

**Ghostty の遅延初期化パターン** (91-92行目):
```zsh
precmd_functions+=(_ghostty_deferred_init)
```
初回の precmd で `_ghostty_deferred_init` を実行し、他の zsh 初期化が完了した後に統合を行う (95行目のコメント)。初期化完了後に `_ghostty_precmd` に置き換え (438-439行目)。

**Ghostty の zle widget 置換** (393-427行目): `zle-line-init`, `zle-line-finish`, `zle-keymap-select` の3つについて、既存 widget の有無と `add-zle-hook-widget` 由来かどうかで分岐する複雑なロジック。

---

### Q4.2 zsh のプロンプトとの干渉

`RPROMPT`, `PS2` (継続行プロンプト) との干渉は？
右プロンプトにマーカーが混入する問題は報告されているか？

- [参照] `ghostty-zsh-integration`
- [参照] `vscode-shellIntegration-rc.zsh`

**A4.2: VS Code は RPROMPT を明示的に処理。全実装が PS2 にマーカーを埋め込み。PS1 保存・復元パターンが共通。**

**RPROMPT (右プロンプト):**

VS Code のみが専用マーカーシーケンスを持つ (`vscode-shellIntegration-rc.zsh` 264-270行目):
```zsh
__vsc_right_prompt_start() { builtin printf '\e]633;H\a' }
__vsc_right_prompt_end()   { builtin printf '\e]633;I\a' }
```
RPROMPT を `%{H%}$RPROMPT%{I%}` で囲み (292-295行目)、preexec で復元 (319-321行目)。
`NOUNSET` オプション有効時に RPROMPT が未定義でエラーになることも防止 (281-285行目)。

Ghostty と WezTerm は RPROMPT に対処していない。

**PS2 (継続行プロンプト): 全実装が対応。**
```bash
# WezTerm (475行目, zsh)
PS2=$'%{\e]133;P;k=s\a%}'$PS2$'%{\e]133;B\a%}'

# Ghostty (175行目, zsh)
PS2=${mark2}${PS2}${markB}

# VS Code (291行目, zsh) — 独自マーカー
PS2="%{$(__vsc_continuation_start)%}$PS2%{$(__vsc_continuation_end)%}"
```

**マルチラインプロンプトへの対処:**

Ghostty は PS1 内の改行後に secondary マーカーを挿入 (170-172行目):
```zsh
if (( ! ps1_changed )) && [[ $PS1 == *$'\n'* ]]; then
    PS1=${PS1//$'\n'/$'\n'${mark2}}
fi
```
ただし、テーマが PS1 を動的に変更した場合 (`ps1_changed=1`) はスキップ (167-169行目のコメント: "injecting marks into newlines can break pattern matching in themes that strip/rebuild the prompt dynamically (e.g., Pure)")。

**PS1 保存・復元パターン**: 全実装が「precmd でマーカー付き PS1 を設定 → preexec で元の PS1 に復元」というパターンを使用。Ghostty はさらに `_ghostty_marked_ps1` を保存してテーマによる PS1 変更を検出するロジックを持つ (144-151行目)。

---

## 5. 注入スクリプト — fish (Phase 3)

### Q5.1 fish のイベントモデル

`fish_prompt`, `fish_preexec`, `fish_postexec` のどれを使って A/B/C/D を発行するか？
fish のイベントモデルは bash/zsh と根本的に異なるので、マッピングを確認する。

- [参照] `ghostty-fish-integration.fish`
- [参照] `vscode-shellIntegration.fish`

**A5.1: fish は `fish_postexec` があるため D を即座に発行できる。bash/zsh との根本的な違い。**

| マーカー | Ghostty | VS Code |
|---|---|---|
| **A** (PromptStart) | `--on-event fish_prompt` + `--on-event fish_posterror` (207行目) | `fish_prompt` 関数ラップ内 (217行目) |
| **B** (CommandStart) | **発行しない** | `fish_prompt` 関数ラップ末尾 (224行目) |
| **C** (CommandExecuted) | `--on-event fish_preexec` (217行目) | `--on-event fish_preexec` (119行目) |
| **D** (CommandFinished) | `--on-event fish_postexec` (222行目) + `fish_prompt` 内フォールバック (209-211行目) | `--on-event fish_postexec` (140行目) |

**bash/zsh との根本的な違い:**
- fish には `fish_postexec` があるため、D マーカーをコマンド終了直後に発行できる。bash/zsh では次の `precmd` まで待つ必要がある
- Ghostty は `fish_posterror` (パースエラー時) にも A を発行
- Ghostty は D のフォールバックとして `fish_prompt` 内でも `\e]133;D\a` を発行 (空 Enter 等で `fish_postexec` が呼ばれないケースに対応)

---

### Q5.2 fish の `--on-event` vs 関数ラップ

Ghostty と VS Code でアプローチが異なるか？
`functions --copy` で既存関数をラップする方式を使っているか、純粋にイベントハンドラを追加しているか？

- [参照] `ghostty-fish-integration.fish`
- [参照] `vscode-shellIntegration.fish`

**A5.2: 根本的に異なる。Ghostty は純粋なイベントハンドラ、VS Code は `functions --copy` でラップ。**

**Ghostty — 純粋な `--on-event` 方式** (`ghostty-fish-integration.fish`):
```fish
function __ghostty_mark_prompt_start --on-event fish_prompt --on-event fish_posterror  # 207行目
function __ghostty_mark_output_start --on-event fish_preexec   # 217行目
function __ghostty_mark_output_end --on-event fish_postexec    # 222行目
```
`functions --copy` 不使用。ユーザーの `fish_prompt` に一切手を加えない非侵入的アプローチ。
**トレードオフ: B マーカーを発行できない** (プロンプト文字列の末尾に割り込む手段がないため)。

**VS Code — `functions --copy` でラップ** (`vscode-shellIntegration.fish` 156-254行目):
```fish
functions --copy fish_prompt __vsc_fish_prompt         # 162行目: 元のプロンプトをバックアップ
functions --copy fish_mode_prompt __vsc_fish_mode_prompt  # 236行目

# 新しい fish_prompt を定義
function fish_prompt
    __vsc_fish_prompt_start    # -> A マーカー
    __vsc_fish_prompt          # 元のプロンプト
    __vsc_fish_cmd_start       # -> B マーカー
end
```
プロンプト出力を **A ... [元のプロンプト] ... B** でサンドイッチ。`fish_mode_prompt` の有無で分岐するロジックも含む (234-254行目)。

| 側面 | Ghostty | VS Code |
|---|---|---|
| 侵入度 | 低い (既存関数を変更しない) | 高い (fish_prompt を完全に置き換え) |
| B マーカー | 不可 | 可能 |
| `fish_mode_prompt` 対応 | 不要 | 必要 (別途ラップ) |

---

## 6. 注入スクリプト — PowerShell (Phase 3)

### Q6.1 PSReadLine への依存

VS Code の pwsh スクリプトは PSReadLine にどう依存しているか？
PSReadLine なしの環境（例: PowerShell のスクリプトモード）でも動くか？

- [参照] `vscode-shellIntegration.ps1`

**A6.1: PSReadLine なしでも基本的に動くが、E マーカーと C マーカーが発行されない劣化モードになる。**

PSReadLine の検出 (211-213行目):
```powershell
$Global:__VSCodeState.HasPSReadLine = $false
if (Get-Module -Name PSReadLine) {
    $Global:__VSCodeState.HasPSReadLine = $true
```

**PSReadLine がある場合に得られる追加機能:**
1. `HasRichCommandDetection=True` プロパティの通知 (214行目)
2. `PSConsoleHostReadLine` のオーバーライド → E マーカー + C マーカーの発行 (216-240行目)
3. キーバインドのマッピング (281-282行目)
4. ヒストリー制御 (284-291行目)
5. `ContinuationPrompt` の取得 (243-246行目)

**PSReadLine なし時の D マーカー発行ロジック** (117行目):
```powershell
if ($Global:__VSCodeState.LastHistoryId -ne -1 -and
    ($Global:__VSCodeState.HasPSReadLine -eq $false -or $Global:__VSCodeState.IsInExecution -eq $true)) {
```
PSReadLine なしでは `IsInExecution` フラグが設定されないため、`HasPSReadLine -eq $false` 条件で常に D を発行するフォールバック。

**結果**: PSReadLine なしでは「A, B, D は発行されるが、E (コマンドライン内容) と C (コマンド出力開始) は発行されない」。

---

### Q6.2 C マーカーの発行タイミング

pwsh では Enter 押下からコマンド実行までの間に C を発行する必要があるが、
`PSConsoleHostReadLine` のオーバーライドか、`Set-PSReadLineKeyHandler` か、どの方法を使っているか？

- [参照] `vscode-shellIntegration.ps1`

**A6.2: `PSConsoleHostReadLine` のオーバーライドを使用。`Set-PSReadLineKeyHandler` ではない。**

`vscode-shellIntegration.ps1` 216-240行目:
```powershell
$Global:__VSCodeState.OriginalPSConsoleHostReadLine = $function:PSConsoleHostReadLine
function Global:PSConsoleHostReadLine {
    $CommandLine = $Global:__VSCodeState.OriginalPSConsoleHostReadLine.Invoke()
    $Global:__VSCodeState.IsInExecution = $true

    # E マーカー (コマンドライン)
    $Result = "$([char]0x1b)]633;E;"
    $Result += $(__VSCode-Escape-Value $CommandLine)
    if ($Global:__VSCodeState.IsWindows10 -eq $false) {
        $Result += ";$($Global:__VSCodeState.Nonce)"
    }
    $Result += "`a"

    # C マーカー (コマンド実行開始)
    $Result += "$([char]0x1b)]633;C`a"

    [Console]::Write($Result)  # Write-Host ではなく Console.Write で改行を防ぐ
    $CommandLine
}
```

**動作順序:**
1. `Prompt()` → A + B マーカー
2. `PSConsoleHostReadLine` 呼び出し → ユーザーが入力して Enter
3. オリジナル `PSConsoleHostReadLine` が戻り値を返す
4. **この時点で E + C マーカーを `[Console]::Write` で発行** (改行なし)
5. `$CommandLine` を返し、PowerShell がコマンドを実行
6. 次の `Prompt()` で D マーカー

**`Set-PSReadLineKeyHandler` を使わない理由**: 複数行入力やペースト入力のエッジケース、既存キーバインドとの衝突リスクを回避。`PSConsoleHostReadLine` は「入力確定後、実行直前」の正確なタイミングを捉えられる。

**`IsInExecution` フラグ**: PSReadLine ありの場合、空 Enter (コマンドなし) での不要な D マーカー発行を防ぐ。

---

## 7. OSC 7 CWD (Phase 3)

### Q7.1 OSC 7 の URL 形式

`file://hostname/path` の hostname 部分は省略可能か？
各実装は hostname をどう扱っているか（空文字 `file:///path` vs ホスト名付き）？

- [参照] `wezterm-shell-integration.sh` — `__wezterm_osc7()` 関数
- [参照] `ghostty-bash.bash` — `_ghostty_report_pwd`

**A7.1: hostname は空文字列 (`file:///path`) でも受理されるが、各実装は `$HOSTNAME` を常に含める。Ghostty はリモートホストを拒否する。**

**発行側:**
```bash
# WezTerm (459行目)
printf "\033]7;file://%s%s\033\\" "${HOSTNAME}" "${PWD}"

# Ghostty (253行目)
builtin printf "\e]7;kitty-shell-cwd://%s%s\a" "$HOSTNAME" "$PWD"
```
両方とも `$HOSTNAME` を常に含める。

**受信側 (Ghostty, `ghostty-stream_handler.zig` 1158-1184行目):**
- hostname が完全に欠落 → `UriMissingHost` エラーで拒否
- hostname が空文字列 (`file:///path`) → 受理
- `isLocal()` でローカルホストかどうかを検証し、**リモートホストの場合は無視**

**VS Code**: OSC 7 を使用しない。独自の `\e]633;P;Cwd=%s\a` で CWD を報告。

---

### Q7.2 パスのエンコーディング

スペースや日本語文字を含むパスはどうエンコードされるか？
URL エンコード（`%20` 等）を行っているか、raw UTF-8 のままか？

- [参照] `wezterm-shell-integration.sh`
- [参照] `ghostty-bash.bash`
- [参照] `vscode-shellIntegration-bash.sh`

**A7.2: シェルスクリプト側では URL エンコードを行っていない。Ghostty の受信側でスキームにより分岐。**

**発行側**: WezTerm、Ghostty とも `$PWD` をそのまま展開。URL エンコードなし。

**受信側 (Ghostty, `ghostty-stream_handler.zig` 1145行目):**
```zig
.raw_path = std.mem.startsWith(u8, url, "kitty-shell-cwd://"),
```
- `kitty-shell-cwd://` → `.raw_path = true` (パーセントエンコードなしのraw pathとして受理)
- `file://` → `.raw_path = false` (パーセントデコードを行う)

**VS Code** は `__vsc_escape_value` で独自エスケープ (URL エンコードではない)。

**exec-detector への示唆**: パーサーは `file://` スキームの場合にパーセントデコードを行い、`kitty-shell-cwd://` の場合はraw pathとして扱う分岐が必要。

---

### Q7.3 Ghostty の `kitty-shell-cwd://` 形式

Ghostty は標準の `file://` ではなく `kitty-shell-cwd://` を使うという記述が TODO にあるが、これは何か？ kitty 互換？標準の `file://` も同時に発行するか？

- [参照] `ghostty-bash.bash`

**A7.3: Kitty が導入した独自スキーム。Ghostty は `kitty-shell-cwd://` のみ発行し `file://` は発行しないが、受信側は両方を受理する。**

`ghostty-bash.bash` 253行目:
```bash
builtin printf "\e]7;kitty-shell-cwd://%s%s\a" "$HOSTNAME" "$PWD"
```

**設計意図**: パスをパーセントエンコードなしで送れること。`file://` はRFC上パーセントエンコードが必要だが、シェルスクリプトでの実装が煩雑。

**受信側** (`ghostty-stream_handler.zig` 1151-1156行目):
```zig
if (!std.mem.eql(u8, "file", uri.scheme) and
    !std.mem.eql(u8, "kitty-shell-cwd", uri.scheme))
{
    log.warn("OSC 7 scheme must be file or kitty-shell-cwd, got: {s}", .{uri.scheme});
    return;
}
```
`file://` と `kitty-shell-cwd://` の **両方を受け付ける**。

---

## 8. OSC 9 / 777 通知 (Phase 5)

### Q8.1 OSC 9 と OSC 9;4 の区別

TODO にある「OSC 9;4 は iTerm2 のプログレスバー通知と衝突する」問題。
Ghostty はどのようにこの曖昧さを解決しているか？パース時に `;4` を見て分岐するだけか？

- [参照] `ghostty-osc.zig` — OSC 9 パース部分

**A8.1: セミコロン後の数字で ConEmu サブコマンドとして分岐。OSC 9 は実質 ConEmu プロトコルの拡張。**

**Ghostty** (`ghostty-osc.zig` 96-155行目):
```
OSC 9       → show_desktop_notification (通知テキスト)
OSC 9;1     → conemu_sleep (スリープ)
OSC 9;2     → conemu_show_message_box (メッセージボックス)
OSC 9;3     → conemu_change_tab_title (タブタイトル)
OSC 9;4     → conemu_progress_report (プログレスバー)
OSC 9;5     → conemu_wait_input (入力待ち)
OSC 9;6-11  → conemu_guimacro 等
```

**プログレスバーの state 値** (201-213行目):
| State | 値 | 意味 |
|---|---|---|
| remove | 0 | 削除 |
| set | 1 | パーセンテージ設定 |
| error | 2 | エラー |
| indeterminate | 3 | 不確定 |
| pause | 4 | 一時停止 |

**WezTerm** (`wezterm-osc.rs` 321-353行目):
```rust
if osc.len() >= 3 && osc[1] == b"4" {
    // OSC 9;4 → プログレスバー
    match osc[2] { b"0" => None, b"1" => SetPercentage, ... }
}
// それ以外 → デスクトップ通知
```

---

### Q8.2 OSC 777 のサブコマンド

`777;notify;title;body` 以外のサブコマンドはあるか？
Ghostty は `notify` のみサポートとのことだが、他のエミュレータではどうか？

- [参照] `ghostty-osc.zig`

**A8.2: 実用的には `notify` のみ。WezTerm は全パラメータを文字列配列として保持するがサブコマンドを区別しない。**

**Ghostty**: `parsers.rxvt_extension.parse` (762行目) で処理し、`show_desktop_notification` に変換。OSC 9 通知と同じハンドラ `showDesktopNotification` (1434-1450行目) で統一処理。

**WezTerm** (`wezterm-osc.rs` 358-364行目):
```rust
RxvtProprietary => {
    let mut vec = vec![];
    for slice in osc.iter().skip(1) {
        vec.push(String::from_utf8_lossy(slice).to_string());
    }
    Ok(OperatingSystemCommand::RxvtExtension(vec))
}
```
サブコマンドの種類を区別せず、全パラメータを文字列配列として格納するだけ。

---

## 9. OSC 8 ハイパーリンク (Phase 5)

### Q9.1 params の形式

`id=value` 以外にどんなパラメータキーがあるか？
複数パラメータの区切りは `:` か `;` か？

- [参照] `ghostty-osc.zig` — hyperlink パース
- [参照] `osc8-hyperlink-spec.md`
- [参照] `wezterm-osc.rs`

**A9.1: 公式に定義されているのは `id` のみ。パラメータ間は `:` 区切り、パラメータと URI 間は `;` 区切り。**

仕様書 (`osc8-hyperlink-spec.md` 75行目):
> `params` is an optional list of `key=value` assignments, separated by the `:` character. Example: `id=xyz123:foo=bar:baz=quux`. Currently only the **`id`** key is defined.

全体形式: `OSC 8 ; params ; URI ST`
例: `\e]8;id=xyz123:foo=bar;http://example.com\e\\`

**Ghostty** (`ghostty-osc.zig` 102-109行目): `id` パラメータのみ保存、他は無視。
**WezTerm**: `Hyperlink::parse` で `id` を抽出。

---

### Q9.2 リンクの開始と終了の対応

空 URI (`\e]8;;\a`) がリンク終了を意味するが、
終了マーカーなしでリンクが行末まで続く場合の挙動は？

- [参照] `osc8-hyperlink-spec.md`
- [参照] `ghostty-Screen.zig` — hyperlink 適用

**A9.2: ハイパーリンクはテキスト色属性と同じステートマシンモデル。明示的に閉じなくても新しいリンクで暗黙的に切り替わる。**

仕様書 (`osc8-hyperlink-spec.md` 86-91行目):
> It is **perfectly legal to switch from one hyperlink to another without explicitly closing the first one**. It is also **perfectly legal to close a hyperlink when it's not actually open**.

**Ghostty** (`ghostty-Screen.zig`):
- `startHyperlinkOnce()` (2245行目): 新しいリンク開始時にまず `endHyperlink()` を呼んで既存リンクを終了
- `endHyperlink()` (2270行目): `hyperlink_id == 0` なら何もしない（安全に複数回呼べる）

---

## 10. OSC 52 クリップボード (Phase 5)

### Q10.1 クリップボード選択の種類

`c` (clipboard) 以外に `p` (primary), `s` (secondary) 等があるが、
各実装でサポートされている選択の一覧は？

- [参照] `ghostty-osc.zig` — clipboard_kind
- [参照] `wezterm-osc.rs`

**A10.1: WezTerm は全13種、Ghostty は3種 (`c`, `s`, `p`)。**

**WezTerm** (`wezterm-osc.rs` 81-98行目, bitflags):
| 文字 | 意味 |
|---|---|
| `c` | クリップボード (システム) |
| `p` | プライマリ選択 (X11) |
| `s` | セレクション |
| `0`-`9` | カットバッファ 0-9 (X11 レガシー) |

空文字列のデフォルトは `s0` (SELECT + CUT0)。**複数同時指定可能** (ビットフラグ)。

**Ghostty** (`ghostty-stream_handler.zig` 1046-1056行目):
```zig
const clipboard_type: apprt.Clipboard = switch (kind) {
    'c' => .standard,
    's' => .selection,
    'p' => .primary,
    else => .standard,  // それ以外はフォールバック
};
```
カットバッファ (`0`-`9`) は無視して `.standard` にフォールバック。

---

### Q10.2 クエリモード (`?`)

`\e]52;c;?\a` でクリップボード内容を問い合わせるモード。
パーサーとしてクエリとセットを区別する必要があるか？

- [参照] `ghostty-osc.zig`
- [参照] `ghostty-stream_handler.zig`

**A10.2: はい、3つのモード（クエリ、セット、クリア）を区別する必要がある。**

**WezTerm** (`wezterm-osc.rs` 173-186行目):
| シーケンス | パラメータ数 | WezTerm の型 |
|---|---|---|
| `\e]52;c\a` | 2 | `ClearSelection` |
| `\e]52;c;?\a` | 3、データが `?` | `QuerySelection` |
| `\e]52;c;SGVsbG8=\a` | 3、データが base64 | `SetSelection` |

**Ghostty** (`ghostty-stream_handler.zig` 1046-1073行目):
```zig
if (data.len == 1 and data[0] == '?') {
    self.surfaceMessageWriter(.{ .clipboard_read = clipboard_type });  // クエリ
    return;
}
// それ以外 → セット
self.surfaceMessageWriter(.{ .clipboard_write = ... });
```
data が単一の `?` 文字かどうかでクエリとセットを区別。

---

## 11. extractCommandOutput / stripAnsiAndOsc (Phase 1)

### Q11.1 VS Code の出力抽出ロジック

VS Code は commandDetectionCapability でコマンド出力をどう抽出しているか？
xterm のバッファから行単位で取得か、raw テキストからの正規表現抽出か？
Conch の `extractCommandOutput()` アプローチとの違いを把握する。

- [参照] `vscode-commandDetectionCapability.ts`

**A11.1: VS Code は xterm バッファ API からマーカーベースの行単位取得。Conch の raw 正規表現方式とは根本的に異なる。**

**VS Code の `getLinesForCommand()`** (`vscode-commandDetectionCapability.ts` 1027-1069行目):
- 開始位置: `executedMarker.line` (C マーカーの位置)
- 終了位置: `endMarker.line` (D マーカーの位置)
- `buffer.getLine(i).translateToString(true, 0, cols)` で xterm バッファから直接テキスト取得

主な違い:

| 観点 | VS Code | Conch |
|---|---|---|
| データソース | xterm `IBuffer` API | raw PTY ストリーム |
| 範囲指定 | `IMarker` (スクロールバック追従) | C/D 正規表現マッチ |
| 取得タイミング | 遅延的 (必要時にバッファから読み取り) | 受信時にキャプチャ |
| ラップ行の処理 | `isWrapped` プロパティで自動検出 | 改行とラップの区別が困難 |
| ANSI ストリップ | 不要 (バッファは既に解釈済み) | 必要 (`stripAnsiAndOsc()`) |

**コマンドライン信頼度モデル** (3段階):
- `high`: OSC 633 E + nonce 検証済み
- `medium`: マーカー存在 + 単一行 + startX > 0
- `low`: バッファからのフォールバック抽出

---

### Q11.2 ANSI ストリップの網羅性

Conch の `stripAnsiAndOsc()` は 3 つの正規表現（OSC, CSI, ESC 単独）でカバーしているが、
見落としているシーケンスはないか？DCS (`\x1bP...ST`) や APC (`\x1b_...ST`) は？

- [参照] `ghostty-osc.zig` — パース対象のシーケンス種類一覧から逆算

**A11.2: DCS と APC の本体データが残る問題がある。**

Conch の 3 つの正規表現がカバーするシーケンス:
1. **OSC** (`\x1b]...BEL` / `\x1b]...ST`)
2. **CSI** (`\x1b[...` + パラメータ + コマンド)
3. **2文字ESCシーケンス** (`\x1b` + `@`-`Z`, `\`, `-`, `_`)

**見落とされているシーケンス:**

| シーケンス | 開始 | 問題 | リスク |
|---|---|---|---|
| **DCS** | `\x1bP...ST` | `\x1bP` は正規表現3で2文字として消えるが、**本体データが残る** | 中 (tmux パススルー, sixel) |
| **APC** | `\x1b_...ST` | 同上、**本体データが残る** | 低〜中 (Kitty グラフィクス) |
| **PM** | `\x1b^...ST` | 同上 | 低 |
| **SOS** | `\x1bX...ST` | 同上 | 低 |
| **C1 制御コード (8bit)** | `\x9b` (CSI), `\x9d` (OSC) 等 | 一切未処理 | 低 (UTF-8環境ではほぼ出現しない) |

**対策案**: DCS と APC を完全にストリップするには、OSC と同様の正規表現を追加:
```
\x1bP[\s\S]*?(?:\x07|\x1b\\)   ← DCS
\x1b_[\s\S]*?(?:\x07|\x1b\\)   ← APC
```

**Ghostty がパース対象とする OSC コード一覧** (`ghostty-osc.zig` State enum):
0, 1, 2, 4, 5, 7, 8, 9, 10-19, 21, 22, 52, 66, 104, 110-119, **133**, 777, 1337, 3008, 5522

---

## 12. アーキテクチャ・設計判断

### Q12.1 イベントモデル: enum vs tagged union

Conch は `{ type: ShellIntegrationType, params: string[] }` のフラット構造。
VS Code は各マーカーごとに型を分けているか？
Ghostty や WezTerm の内部表現はどうなっているか？
OSC 633 E/P まで含めたとき、フラット構造で十分か、discriminated union にすべきか。

- [参照] `vscode-shellIntegrationAddon.ts`
- [参照] `ghostty-osc.zig` — OSC union type
- [参照] `wezterm-osc.rs` — OperatingSystemCommand enum

**A12.1: 3実装とも型付き判別共用体を採用。exec-detector も discriminated union にすべき。**

**VS Code**: パース結果を型付きオブジェクトとして表現しない。パースとハンドリングが一体化。`data.split(';')` してから `switch (command)` で分岐する完全にフラットな構造。ただしこれはライブラリではなくアプリケーション内部コードであるため。

**Ghostty** (`ghostty-osc.zig` 27-243行目): Zig の tagged union。最も型安全:
```zig
pub const Command = union(Key) {
    semantic_prompt: SemanticPrompt,
    clipboard_contents: struct { kind: u8, data: [:0]const u8 },
    report_pwd: struct { value: [:0]const u8 },
    hyperlink_start: struct { id: ?[:0]const u8 = null, uri: [:0]const u8 },
    hyperlink_end: void,
    // ... 約25バリアント
};
```
各バリアントが固有のペイロード型を持ち、`@sizeOf(Command)` を64バイトに固定 (236-242行目)。

**WezTerm** (`wezterm-osc.rs` 36-58行目): Rust の enum (ADT):
```rust
pub enum OperatingSystemCommand {
    SetHyperlink(Option<Hyperlink>),
    FinalTermSemanticPrompt(FinalTermSemanticPrompt),
    CurrentWorkingDirectory(String),
    Unspecified(Vec<Vec<u8>>),  // フォールバック
    // ...
}
```
`FinalTermSemanticPrompt` 自体もさらに8バリアントの rich enum (706-748行目)。

**フラット構造の問題点 (OSC 633 E/P を含めた場合):**
| イベント | `params: string[]` の問題 |
|---|---|
| `E` | `params[0]` がコマンド文字列、`params[1]` が nonce。利用側がインデックスを覚える必要あり |
| `P` | `params[0]` が `key=value`。さらにパースが必要 |
| `D` | `params[0]` が exit code (数値) だが string 型で渡される。`parseInt` + NaN チェックが毎回必要 |

**discriminated union の利点:**
```typescript
// 例: OSC 633 E
{ type: 'CommandLine', command: string, nonce?: string }
// 例: OSC 633 P
{ type: 'Property', key: string, value: string }
// 例: OSC 133 D
{ type: 'CommandFinished', exitCode?: number }
```
パース時に数値変換とバリデーションが完了し、利用側のボイラープレートが激減する。

---

### Q12.2 コマンドモデルの構築

VS Code の `commandDetectionCapability.ts` はパースイベントからどのようなコマンドモデル（開始行、終了行、exit code、出力テキスト等）を構築しているか？
exec-detector が将来「コマンドモデル構築」まで担うべきか、パースだけに留めるべきかの判断材料。

- [参照] `vscode-commandDetectionCapability.ts`

**A12.2: VS Code のコマンドモデルはターミナルバッファ API に強く依存。exec-detector はパースに留めるべき。**

**VS Code のコマンドモデル (`PartialTerminalCommand`):**
```
promptStartMarker: IMarker        // A の位置
commandStartMarker: IMarker       // B の位置
commandStartX: number             // B のX座標
commandExecutedMarker: IMarker    // C の位置
commandFinishedMarker: IMarker    // D の位置
command: string                   // コマンドライン文字列
commandLineConfidence: 'low'|'medium'|'high'
isTrusted: boolean                // nonce検証済みか
cwd: string                       // 作業ディレクトリ
exitCode?: number
```

**状態遷移:**
```
handlePromptStart (A) → handleCommandStart (B) → handleCommandExecuted (C) → handleCommandFinished (D)
```

**エラーハンドリング:**
- C が来ずに D が来た場合: `handleCommandFinished` 内で自動的に `handleCommandExecuted()` を呼ぶ (388-390行目)
- マーカー欠落: 早期リターン
- 画面クリア (CSI 2J): ビューポート内のコマンドを無効化 + `wasCleared = true`
- カーソル移動による無効化: 500ms デバウンスつき
- Windows ConPTY: 専用の `WindowsPtyHeuristics` クラスに切り替え

**判断**: exec-detector は **パースと型付きイベントの生成** に留めるべき。理由:
1. コマンドモデルは xterm の `IMarker` (バッファ位置追跡) に強く依存 — exec-detector はバッファを持たない
2. `PromptInputModel` によるコマンドライン抽出はターミナル実装と密結合
3. Windows ConPTY ヒューリスティクスはアプリケーション固有
4. ただし、**軽量な状態追跡** (「最後のイベントは何か」「順序が正しいか」) は提供価値がある

---

### Q12.3 Ghostty の動的注入ロジック

`shell_integration.zig` はシェルの種類をどう判定し、どうスクリプトを注入しているか？
Conch の `enableShellIntegration()` と比較して、exec-detector が inject 関数として提供すべき API の参考にする。

- [参照] `ghostty-shell_integration.zig`
- [参照] `ghostty-shell-integration-README.md`

**A12.3: プロセス名で判定し、シェルごとに全く異なる注入戦略を使う。**

**シェル判定** (`detectShell`, 138-168行目): コマンドの第一引数から `basename` でファイル名を取得:
```zig
const exe = std.fs.path.basename(arg0);
if (std.mem.eql(u8, "bash", exe)) { ... return .bash; }
if (std.mem.eql(u8, "zsh", exe)) return .zsh;
if (std.mem.eql(u8, "fish", exe)) return .fish;
// ...
```
macOS の `/bin/bash` (Apple Bash 3.2) は POSIX スタートアップが無効なため `null` を返す。

**注入戦略 (シェルごとに完全に異なる):**

| シェル | 注入方法 | 詳細 |
|---|---|---|
| **bash** | `ENV` 環境変数 + `--posix` フラグ | POSIX モードで起動し `ENV` でスクリプトを読み込ませる。既存 `ENV`, `--rcfile`, `HISTFILE` を退避 |
| **zsh** | `ZDOTDIR` 環境変数 | `ZDOTDIR` を統合ディレクトリに変更。起動時に `$ZDOTDIR/.zshenv` が読み込まれる |
| **fish / elvish** | `XDG_DATA_DIRS` 環境変数 | `XDG_DATA_DIRS` の先頭に統合ディレクトリをプリペンド。fish は `vendor_conf.d/*.fish` を自動ロード |
| **nushell** | `XDG_DATA_DIRS` + `--execute` 引数 | XDG パス設定 + コマンドに `--execute 'use ghostty *'` を追加 |

**環境汚染の最小化**: 全戦略で注入に使った環境変数を後からクリーンアップ:
- bash: `GHOSTTY_BASH_ENV` で元の `ENV` を退避
- zsh: `GHOSTTY_ZSH_ZDOTDIR` で元の `ZDOTDIR` を退避
- fish/elvish: `GHOSTTY_SHELL_INTEGRATION_XDG_DIR` で統合パスを記録し、スクリプト側でクリーンアップ

**非インタラクティブモードの回避**: 全シェルで `-c` (コマンド実行モード) 検出時に注入をスキップ。

**exec-detector への示唆**: `encodeScriptForShell()` は現在 bash と pwsh のみだが、Ghostty の戦略を参考に zsh/fish/elvish/nushell にも対応できる設計にすべき。特に「注入方法はシェルごとに完全に異なる」という事実を API 設計に反映する。

---

## 13. 追加知見

調査中に発見した、QAs に含まれていなかった重要な知見。

### K13.1 WezTerm の `Unspecified` フォールバック

WezTerm (`wezterm-osc.rs` 57行目) は未知の OSC に対して `Unspecified(Vec<Vec<u8>>)` バリアントを用意し、パース失敗時にデータを保持する (159-170行目)。exec-detector でも未知の OSC を捨てずに保持する設計が有用。

### K13.2 VS Code の OSC 633 追加サブタイプ (F/G/H/I)

VS Code は OSC 633 で A-D 以外に以下を定義 (`vscode-shellIntegrationAddon.ts` 180-207行目):
- **F** (ContinuationStart): 行継続プロンプト開始
- **G** (ContinuationEnd): 行継続コマンド開始
- **H** (RightPromptStart): 右プロンプト開始
- **I** (RightPromptEnd): 右プロンプト終了

これらは zsh の RPROMPT や PS2 に対応するためのもの。

### K13.3 VS Code の環境変数送信 (EnvJson / EnvSingle*)

VS Code は OSC 633 で環境変数を送信する機能を持つ (`vscode-shellIntegrationAddon.ts` 255-305行目):
- `EnvJson`: JSON 形式で一括送信
- `EnvSingleStart/Entry/Delete/End`: 個別の環境変数を順次送信

これはデバッグやタスク自動化に使われるが、exec-detector の Phase 4 スコープ外。

### K13.4 WezTerm の FinalTermClick パラメータ

WezTerm (`wezterm-osc.rs` 624-648行目) は `cl=` パラメータで FinalTerm のクリック移動挙動を制御:
- `line`: 同一行内のみ
- `m`: 複数行移動
- `v`: 保守的な上下移動
- `w`: スマートな上下移動

WezTerm と Ghostty のシェルスクリプトは A マーカーに `cl=m` や `cl=line` を付加する。

### K13.5 WezTerm の neovim 互換性

WezTerm (`wezterm-osc.rs` 617-618行目):
```rust
// Use the longer form ST as neovim doesn't like the BEL version
write!(f, "\x1b\\")?;
```
出力時に ST (ESC \\) を使う理由は neovim が BEL 形式を正しく処理しないため。exec-detector が OSC レスポンスを生成する場合の参考。

### K13.6 Ghostty の OSC パーサーが対応する OSC コード網羅リスト

`ghostty-osc.zig` State enum (316-368行目) から:
0, 1, 2, 4, 5, 7, 8, 9, 10-19, 21, 22, 52, 66, 104, 110-119, 133, 777, 1337, 3008, 5522

exec-detector が「ターミナルの OSC パーサーはこのライブラリを使えば良い」ポジションを取るなら、最終的にはこれらの大半をカバーする必要がある。

### K13.7 Ghostty の遅延初期化パターン (zsh)

Ghostty zsh 統合 (`ghostty-zsh-integration` 91-92行目) は `_ghostty_deferred_init` で初期化を遅延させ、他の zsh 初期化ファイル（テーマ等）が完了した後に統合を行う。`precmd_functions` の末尾に自分を移動させるロジック (188行目) も含む。exec-detector の zsh スクリプトでも同様のパターンが必要。

### K13.8 Windows 10 の nonce エコー問題

VS Code の PowerShell スクリプト (`vscode-shellIntegration.ps1` 225-229行目) では Windows 10 で nonce がターミナルにエコーされる問題があるため、Windows 10 では nonce を送信しない:
```powershell
if ($Global:__VSCodeState.IsWindows10 -eq $false) {
    $Result += ";$($Global:__VSCodeState.Nonce)"
}
```
exec-detector が nonce 生成 API を提供する場合、この制限を文書化すべき。

### K13.9 Ghostty の ConEmu プログレスバーサポート (OSC 9;4)

Ghostty は OSC 9;4 を ConEmu 互換のプログレスバーとして完全実装 (`ghostty-osc.zig` 201-213行目)。これはタスクバーのプログレスインジケータ (Windows) や Dock のプログレスバー (macOS) に反映される。exec-detector でもパースすれば、長時間コマンドの進捗をプログラムから取得可能になる。

### K13.10 VS Code の commandDetectionCapability: 同一コマンドの exit code 継承

VS Code (`vscode-commandDetectionCapability.ts` 401-406行目) は exit code が得られなかった場合、同じコマンド文字列の直前の実行結果から exit code をコピーするフォールバックを持つ。これはパーサーの責務ではなく上位レイヤの最適化だが、興味深い設計。

### K13.11 Ghostty の bash 多行プロンプト処理

Ghostty (`ghostty-bash.bash` 210-215行目) は PS1 内の `\n` エスケープの後に secondary マーカーを挿入するが、リテラル改行 (`$'\n'`) はコマンド置換内で構文を壊す可能性があるため置換しない。exec-detector の bash スクリプトでも同様の注意が必要。

### K13.12 VS Code の `deserializeVSCodeOscMessage` / `serializeVSCodeOscMessage` の対称性

`vscode-shellIntegrationAddon.ts` 803-826行目にデシリアライズとシリアライズの両方の関数が公開されている。exec-detector でも OSC 633 E のエンコード/デコードを双方向で提供すべき。
