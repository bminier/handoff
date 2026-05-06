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

# Move out of the worktree before invoking cleanup. PowerShell holds
# cwd as a real Windows file handle, which blocks `git worktree remove`
# from deleting the directory. Derive the main repo root from git's
# common dir, then cd there. cli.ts has its own best-effort chdir for
# the bun-process side; this handles the parent-shell pin.
$gitCommonDir = (git rev-parse --git-common-dir 2>$null)
if ($LASTEXITCODE -eq 0 -and $gitCommonDir) {
  # Whole block is best-effort — a derivation or cd failure must not
  # block cleanup. cli.ts has its own chdir for the bun-process side,
  # and on failure cleanup will surface a clearer error than a
  # half-applied cwd state would.
  try {
    if (-not [System.IO.Path]::IsPathRooted($gitCommonDir)) {
      $gitCommonDir = Join-Path (Get-Location) $gitCommonDir
    }
    $mainRepoRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $gitCommonDir))
    # Two-step cd is required: Set-Location updates only PowerShell's
    # provider location, while [Directory]::SetCurrentDirectory updates
    # the underlying Windows process CWD that holds the file handle. The
    # OS won't let us delete the worktree until the process CWD has
    # actually moved off it. SetCurrentDirectory throws on invalid
    # paths, hence the wrapping try/catch.
    Set-Location -LiteralPath $mainRepoRoot -ErrorAction SilentlyContinue
    [System.IO.Directory]::SetCurrentDirectory($mainRepoRoot)
  } catch {
    # Silent fallthrough — matches the bash runner's `2>/dev/null || true`.
  }
}

& bun "$HandoffRepo/src/cli.ts" cleanup $Branch
$cleanupExit = $LASTEXITCODE

Write-Host ''
# Only prompt when stdin is an actual console. The runner is launched into
# a fresh PowerShell window in production, but integration tests spawn it
# with a piped stdin and would otherwise block forever on Read-Host.
if (-not [Console]::IsInputRedirected) {
  Read-Host '[handoff] Press Enter to close this window' | Out-Null
}
exit $cleanupExit
