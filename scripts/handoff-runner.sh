#!/usr/bin/env bash
# Wrapper invoked inside a freshly-spawned terminal window.
# Usage: handoff-runner.sh <handoff-repo> <tool> <branch>
#
# <handoff-repo> is the path to the handoff CLI's checkout (where src/cli.ts
# lives) — NOT the user's project repo. The cwd of this script is the worktree
# of the user's project; PROMPT.md sits there.
#
# Runs the chosen tool with PROMPT.md as the seed prompt, then on exit invokes
# `bun <handoff-repo>/src/cli.ts cleanup <branch>` which removes the worktree
# iff the PR has been merged.

set -uo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: handoff-runner.sh <handoff-repo> <tool> <branch>" >&2
  exit 64
fi

HANDOFF_REPO="$1"
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

# Move out of the worktree before invoking cleanup. On Windows the
# worktree directory can't be removed while a parent process holds it as
# cwd, so the bun cli alone can't release this — we have to do it from
# the shell. Derive the main repo root from git's common dir (works
# from inside any linked worktree), then cd there. If anything in the
# derivation fails we fall through silently; cli.ts has its own
# best-effort chdir for the bun-process side of the pin.
GIT_COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null || true)
if [ -n "$GIT_COMMON_DIR" ]; then
  case "$GIT_COMMON_DIR" in
    /* | [A-Za-z]:*) ;;
    *) GIT_COMMON_DIR="$(pwd)/$GIT_COMMON_DIR" ;;
  esac
  MAIN_REPO_ROOT=$(dirname "$GIT_COMMON_DIR")
  cd "$MAIN_REPO_ROOT" 2>/dev/null || true
fi

bun "$HANDOFF_REPO/src/cli.ts" cleanup "$BRANCH"
CLEANUP_EXIT=$?

echo
read -r -p "[handoff] Press Enter to close this window..." _
exit "$CLEANUP_EXIT"
