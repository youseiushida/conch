// OSC 133 + OSC 633 + OSC 7 Shell Integration Scripts
//
// All scripts emit:
// - OSC 133 A/B/C/D (FinalTerm — broad terminal support)
// - OSC 633 E (CommandLine — VS Code / Cline / Roo Code compat)
// - OSC 633 P;Cwd (current working directory — VS Code compat)
// - OSC 7 (CWD — iTerm2 / WezTerm / GNOME Terminal compat)
//
// OSC 633 E escaping: '\' → '\\', ';' → '\x3b', control chars → '\xHH'

// ============================================================
// PowerShell
// ============================================================
export const PWSH_INTEGRATION_SCRIPT = `
if (-not (Test-Path function:__conch_original_prompt)) {
    if (Test-Path function:prompt) {
        $__conch_original_prompt = $function:prompt
        Set-Item function:__conch_original_prompt $__conch_original_prompt
    } else {
        function __conch_original_prompt { "PS > " }
    }
}

function __conch_escape_633 {
    param([string]$value)
    $value -replace '\\\\', '\\\\\\\\' -replace ';', '\\x3b' -replace '\\n', '\\x0a' -replace '\\r', '\\x0d'
}

function prompt {
    $lastExitCode = $LASTEXITCODE
    [Console]::Out.Write("$([char]27)]133;D;$lastExitCode$([char]7)")
    [Console]::Out.Write("$([char]27)]133;A$([char]7)")
    & __conch_original_prompt
    [Console]::Out.Write("$([char]27)]133;B$([char]7)")
    # OSC 633 P;Cwd
    [Console]::Out.Write("$([char]27)]633;P;Cwd=$($PWD.Path)$([char]7)")
    # OSC 7 CWD
    [Console]::Out.Write("$([char]27)]7;file://$([System.Net.Dns]::GetHostName())$($PWD.Path)$([char]7)")
}

if (-not $global:__conch_psrl_hooked) {
    if (Get-Command Set-PSReadLineKeyHandler -ErrorAction SilentlyContinue) {
        Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
            $line = $null
            [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$null)
            $escaped = __conch_escape_633 $line
            # OSC 633 E (CommandLine)
            [Console]::Out.Write("$([char]27)]633;E;$escaped$([char]7)")
            # OSC 133 C (CommandExecuted)
            [Console]::Out.Write("$([char]27)]133;C$([char]7)")
            [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
        }
        $global:__conch_psrl_hooked = $true
    }
}
`;

// ============================================================
// Bash
// ============================================================
export const BASH_INTEGRATION_SCRIPT = `
__conch_cmd_executed=""

# Minimal OSC 633 E escape: backslash and semicolon only (fast path)
__conch_escape_633() {
    local out="\${1//\\\\/\\\\\\\\}"
    printf '%s' "\${out//;/\\\\x3b}"
}

__conch_prompt_cmd() {
    local __conch_ec="$?"
    if [[ -n "$__conch_cmd_executed" ]]; then
        printf "\\033]133;D;%s\\007" "$__conch_ec"
    fi
    __conch_cmd_executed=""
    printf "\\033]133;A\\007"
    # OSC 633 P;Cwd
    printf "\\033]633;P;Cwd=%s\\007" "$PWD"
    # OSC 7 CWD
    printf "\\033]7;file://%s%s\\007" "\${HOSTNAME:-localhost}" "$PWD"
}

if [[ ! "$PROMPT_COMMAND" == *"__conch_prompt_cmd"* ]]; then
    PROMPT_COMMAND="__conch_prompt_cmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi

if [[ ! "$PS1" == *'133;B'* ]]; then
    PS1="\${PS1}\\[\\033]133;B\\007\\]"
fi

__conch_preexec() {
    [[ -n "$__conch_cmd_executed" ]] && return
    case "$BASH_COMMAND" in
        __conch_prompt_cmd|__conch_preexec|__conch_escape_633) return ;;
    esac
    __conch_cmd_executed=1
    # OSC 633 E (CommandLine)
    printf "\\033]633;E;%s\\007" "$(__conch_escape_633 "$BASH_COMMAND")"
    # OSC 133 C (CommandExecuted)
    printf "\\033]133;C\\007"
}

trap '__conch_preexec' DEBUG
`;

// ============================================================
// Zsh
// ============================================================
export const ZSH_INTEGRATION_SCRIPT = `
[[ -n "\${__eid_injected:-}" ]] && return
__eid_injected=1
__eid_cmd_executed=""
__eid_current_command=""

__eid_escape_633() {
    local out="\${1//\\\\/\\\\\\\\}"
    printf '%s' "\${out//;/\\\\x3b}"
}

__eid_precmd() {
    local ec="$?"
    if [[ -n "$__eid_cmd_executed" ]]; then
        printf '\\e]133;D;%s\\a' "$ec"
    fi
    __eid_cmd_executed=""
    __eid_current_command=""
    printf '\\e]133;A\\a'
    printf '\\e]633;P;Cwd=%s\\a' "$PWD"
    printf '\\e]7;file://%s%s\\a' "\${HOST:-\$(hostname)}" "$PWD"
}

__eid_preexec() {
    __eid_cmd_executed=1
    __eid_current_command="$1"
    # OSC 633 E (CommandLine) — zsh preexec receives the command as $1
    printf '\\e]633;E;%s\\a' "$(__eid_escape_633 "$1")"
    printf '\\e]133;C\\a'
}

precmd_functions+=(__eid_precmd)
preexec_functions+=(__eid_preexec)

if [[ "$PS1" != *'133;B'* ]]; then
    PS1="\${PS1}%{$(printf '\\e]133;B\\a')%}"
fi
`;

// ============================================================
// Fish
// ============================================================
export const FISH_INTEGRATION_SCRIPT = `
if set -q __eid_injected
    exit 0
end
set -g __eid_injected 1
set -g __eid_prompt_state initial

function __eid_escape_633
    string replace -a '\\\\' '\\\\\\\\' -- $argv[1] | string replace -a ';' '\\\\x3b'
end

function __eid_mark_prompt_start --on-event fish_prompt --on-event fish_posterror
    if test "$__eid_prompt_state" != prompt-start
        echo -en "\\e]133;D\\a"
    end
    set -g __eid_prompt_state prompt-start
    echo -en "\\e]133;A\\a"
    echo -en "\\e]633;P;Cwd=$PWD\\a"
    echo -en "\\e]7;file://"(hostname)"$PWD\\a"
end

function __eid_mark_output_start --on-event fish_preexec
    set -g __eid_prompt_state preexec
    # OSC 633 E (CommandLine) — fish preexec receives the command as $argv
    echo -en "\\e]633;E;"(__eid_escape_633 "$argv")"\\a"
    echo -en "\\e]133;C\\a"
end

function __eid_mark_output_end --on-event fish_postexec
    set -g __eid_prompt_state postexec
    echo -en "\\e]133;D;$status\\a"
end

if functions -q fish_prompt
    functions --copy fish_prompt __eid_original_fish_prompt
    function fish_prompt
        __eid_original_fish_prompt
        echo -en "\\e]133;B\\a"
    end
else
    function fish_prompt
        echo -en "\\e]133;B\\a"
    end
end
`;

// ============================================================
// Elvish
// ============================================================
// Based on Ghostty ghostty-integration.elv pattern.
// Note: OSC 133 B cannot be reliably emitted in Elvish at script level
// (prompt output is escaped, and /dev/tty has timing issues).
// See: https://github.com/elves/elvish/pull/1917
export const ELVISH_INTEGRATION_SCRIPT = `
{
  use platform

  var cmd-executed = $false

  fn mark-prompt-start {
    if $cmd-executed {
      # D is emitted by mark-output-end; this handles empty Enter
    } elif (not-eq (get-env __eid_prompt_state) 'prompt-start') {
      printf "\\e]133;D\\a"
    }
    set-env __eid_prompt_state 'prompt-start'
    set cmd-executed = $false
    printf "\\e]133;A\\a"
    printf "\\e]633;P;Cwd=%s\\a" $pwd
    printf "\\e]7;file://%s%s\\a" (platform:hostname) $pwd
  }

  fn mark-output-start {|cmd|
    set cmd-executed = $true
    set-env __eid_prompt_state 'pre-exec'
    # OSC 633 E — elvish after-readline receives the command string
    var escaped = (echo $cmd | sed 's/\\\\\\\\/\\\\\\\\\\\\\\\\/g; s/;/\\\\x3b/g' | slurp)
    printf "\\e]633;E;%s\\a" $escaped
    printf "\\e]133;C\\a"
  }

  fn mark-output-end {|cmd-info|
    set-env __eid_prompt_state 'post-exec'
    var exit-status = 0
    if (not-eq $nil $cmd-info[error]) {
      set exit-status = 1
      if (has-key $cmd-info[error] reason) {
        if (has-key $cmd-info[error][reason] exit-status) {
          set exit-status = $cmd-info[error][reason][exit-status]
        }
      }
    }
    printf "\\e]133;D;%s\\a" $exit-status
  }

  # Initial prompt
  defer { mark-prompt-start }

  # Register hooks
  set edit:before-readline = (conj $edit:before-readline $mark-prompt-start~)
  set edit:after-readline  = (conj $edit:after-readline $mark-output-start~)
  set edit:after-command   = (conj $edit:after-command $mark-output-end~)

  # CWD change reporting
  set after-chdir = (conj $after-chdir {|_|
    printf "\\e]7;file://%s%s\\a" (platform:hostname) $pwd
  })
}
`;

// ============================================================
// Nushell
// ============================================================
// Nushell uses $env.config.hooks for shell integration.
// pre_prompt fires before prompt display, pre_execution before command runs.
// Note: Nushell's prompt is configured via $env.PROMPT_COMMAND, not via hooks,
// so B marker is emitted at the end of PROMPT_COMMAND.
export const NUSHELL_INTEGRATION_SCRIPT = `
# OSC 133/633 shell integration for Nushell

$env.__eid_cmd_executed = false

# Helper: escape for OSC 633 E
def __eid_escape_633 [value: string] -> string {
    $value | str replace --all '\\\\' '\\\\\\\\' | str replace --all ';' '\\x3b'
}

# Append to pre_prompt hook (fires before prompt display)
$env.config = ($env.config | upsert hooks.pre_prompt (
    $env.config.hooks.pre_prompt? | default [] | append {||
        if $env.__eid_cmd_executed {
            # D was already emitted by post_execution; reset flag
        } else {
            print -n $"\\e]133;D\\a"
        }
        $env.__eid_cmd_executed = false
        print -n $"\\e]133;A\\a"
        print -n $"\\e]633;P;Cwd=($env.PWD)\\a"
        print -n $"\\e]7;file://(hostname)($env.PWD)\\a"
    }
))

# Append to pre_execution hook (fires before command runs)
$env.config = ($env.config | upsert hooks.pre_execution (
    $env.config.hooks.pre_execution? | default [] | append {||
        $env.__eid_cmd_executed = true
        # Note: Nushell does not pass the command string to pre_execution hooks.
        # OSC 633 E cannot be emitted here. Use display_output or external workaround.
        print -n $"\\e]133;C\\a"
    }
))

# B marker via PROMPT_INDICATOR suffix
$env.PROMPT_INDICATOR = ($env.PROMPT_INDICATOR? | default "> " | append $"\\e]133;B\\a")
`;
