# Wrapper invoked inside a freshly-spawned PowerShell window.
# Usage: handoff-runner.ps1 <repo-root> <tool> <branch>

param(
  [Parameter(Mandatory = $true)][string]$RepoRoot,
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

& bun "$RepoRoot/src/cli.ts" cleanup $Branch
$cleanupExit = $LASTEXITCODE

Write-Host ''
Read-Host '[handoff] Press Enter to close this window' | Out-Null
exit $cleanupExit
