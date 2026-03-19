// OSC 133 Shell Integration Scripts

// PowerShell: Wrap prompt to emit OSC 133
// A: Prompt Start
// B: Command Start (handled by PSReadLine usually, but we inject here for fallback)
// C: Command Output Start (handled by preexec)
// D: Command Finished (handled by prompt)
// Note: PSReadLine integration is better for B/C, but this simple wrapper handles A/D which are critical for prompt detection.
// Fixes applied:
// 1. Use $function:prompt to save ScriptBlock correctly (Get-Content returns string).
// 2. Use [Console]::Out.Write to avoid host dependencies (Write-Host).
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
