// OSC 133 Shell Integration Scripts

// PowerShell: Full OSC 133 A/B/C/D integration
//   A: Prompt Start        (prompt function, before prompt display)
//   B: Command Start       (prompt function, after prompt display)
//   C: Command Executed    (PSReadLine Enter handler, fires just before AcceptLine)
//   D: Command Finished    (prompt function, with $LASTEXITCODE of previous command)
//
// C is emitted via Set-PSReadLineKeyHandler for the Enter key.
// PSReadLine intercepts the Enter keystroke before the command runs, making it
// the natural place to emit C — equivalent to bash's DEBUG trap.
//
// If PSReadLine is unavailable (non-interactive / minimal environment), the
// guard silently skips C registration. In that case run() will time out rather
// than silently accept wrong output; use strict:false to tolerate it.
//
// The guard variable $global:__conch_psrl_hooked prevents double-registration
// when enableShellIntegration is called more than once in the same session.
export const PWSH_INTEGRATION_SCRIPT = `
if (-not (Test-Path function:__original_prompt)) {
    if (Test-Path function:prompt) {
        $__original_prompt = $function:prompt
        Set-Item function:__original_prompt $__original_prompt
    } else {
        function __original_prompt { "PS > " }
    }
}

function prompt {
    $lastExitCode = $LASTEXITCODE
    [Console]::Out.Write("$([char]27)]133;D;$lastExitCode$([char]7)")
    [Console]::Out.Write("$([char]27)]133;A$([char]7)")
    & __original_prompt
    [Console]::Out.Write("$([char]27)]133;B$([char]7)")
}

if (-not $global:__conch_psrl_hooked) {
    if (Get-Command Set-PSReadLineKeyHandler -ErrorAction SilentlyContinue) {
        Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
            [Console]::Out.Write("$([char]27)]133;C$([char]7)")
            [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
        }
        $global:__conch_psrl_hooked = $true
    }
}
`;

// Bash: Full OSC 133 A/B/C/D integration
//   A: Prompt Start        (PROMPT_COMMAND, before prompt display)
//   B: Command Start       (appended to PS1, marks end of prompt / start of user input)
//   C: Command Executed    (DEBUG trap, fires just before user command runs)
//   D: Command Finished    (PROMPT_COMMAND, with $? exit code of previous command)
//
// The DEBUG trap fires before every simple command, including those inside
// PROMPT_COMMAND. We use two guards to prevent spurious C emission:
//   - __conch_cmd_executed: ensures C fires only once per command line
//   - BASH_COMMAND check: skips our own internal functions
//
// PROMPT_COMMAND ordering: ours runs FIRST to capture $? before other
// PROMPT_COMMAND entries can clobber it.
export const BASH_INTEGRATION_SCRIPT = `
__conch_cmd_executed=""

__conch_prompt_cmd() {
    local __conch_ec="$?"
    if [[ -n "$__conch_cmd_executed" ]]; then
        printf "\\033]133;D;%s\\007" "$__conch_ec"
    fi
    __conch_cmd_executed=""
    printf "\\033]133;A\\007"
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
        __conch_prompt_cmd|__conch_preexec) return ;;
    esac
    __conch_cmd_executed=1
    printf "\\033]133;C\\007"
}

trap '__conch_preexec' DEBUG
`;
