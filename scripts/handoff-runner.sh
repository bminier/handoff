#!/usr/bin/env bash
# Wrapper invoked inside a freshly-spawned terminal window.
# Usage: handoff-runner.sh <repo-root> <tool> <branch>
#
# Runs the chosen tool with PROMPT.md (in cwd) as the seed prompt, then on
# exit invokes `bun <repo-root>/src/cli.ts cleanup <branch>` which removes
# the worktree iff the PR has been merged.

set -uo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: handoff-runner.sh <repo-root> <tool> <branch>" >&2
  exit 64
fi

REPO_ROOT="$1"
TOOL="$2"
BRANCH="$3"

if [ ! -f "PROMPT.md" ]; then
  echo "handoff-runner: PROMPT.md not found in $(pwd)" >&2
  exit 1
fi

PROMPT="$(cat PROMPT.md)"

case "$TOOL" in
  claude|codex|copilot)
    "$TOOL" "$PROMPT"
    ;;
  *)
    echo "handoff-runner: unknown tool '$TOOL'" >&2
    exit 64
    ;;
esac

TOOL_EXIT=$?

echo
echo "----------------------------------------"
echo "[handoff] $TOOL exited (code $TOOL_EXIT). Running cleanup for $BRANCH..."
echo "----------------------------------------"

bun "$REPO_ROOT/src/cli.ts" cleanup "$BRANCH"
CLEANUP_EXIT=$?

echo
read -r -p "[handoff] Press Enter to close this window..." _
exit "$CLEANUP_EXIT"
