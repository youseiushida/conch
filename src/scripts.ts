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

// Bash: Use PROMPT_COMMAND
// OSC 133;A - Prompt Start
// OSC 133;D - Command Finished
// Fixes applied:
// 1. Cleaner PROMPT_COMMAND appending using parameter expansion to avoid leading/trailing semicolons.
export const BASH_INTEGRATION_SCRIPT = `
__conch_prompt_start() {
    printf "\\033]133;D;%s\\007" "$?"
    printf "\\033]133;A\\007"
}

if [[ ! "$PROMPT_COMMAND" == *"__conch_prompt_start"* ]]; then
    PROMPT_COMMAND="\${PROMPT_COMMAND:+\$PROMPT_COMMAND; }__conch_prompt_start"
fi
`;
