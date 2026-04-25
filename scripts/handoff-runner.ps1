# Wrapper invoked inside a freshly-spawned PowerShell window.
# Usage: handoff-runner.ps1 <handoff-repo> <tool> <branch>
#
# $HandoffRepo is the path to the handoff CLI's checkout (where src/cli.ts
# lives) — NOT the user's project repo. The cwd of this script is the worktree
# of the user's project; PROMPT.md sits there.

param(
  [Parameter(Mandatory = $true)][string]$HandoffRepo,
  [Parameter(Mandatory = $true)][ValidateSet('claude', 'codex', 'copilot')][string]$Tool,
  [Parameter(Mandatory = $true)][string]$Branch
)

$ErrorActionPreference = 'Continue'

if (-not (Test-Path 'PROMPT.md')) {
  Write-Error "handoff-runner: PROMPT.md not found in $(Get-Location)"
  exit 1
}

$prompt = Get-Content -Path 'PROMPT.md' -Raw

& $Tool $prompt
$toolExit = $LASTEXITCODE

Write-Host ''
Write-Host '----------------------------------------'
Write-Host "[handoff] $Tool exited (code $toolExit). Running cleanup for $Branch..."
Write-Host '----------------------------------------'

& bun "$HandoffRepo/src/cli.ts" cleanup $Branch
$cleanupExit = $LASTEXITCODE

Write-Host ''
Read-Host '[handoff] Press Enter to close this window' | Out-Null
exit $cleanupExit
