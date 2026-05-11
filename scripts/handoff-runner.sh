#!/usr/bin/env bash
# Wrapper invoked inside a freshly-spawned terminal window.
# Usage: handoff-runner.sh <handoff-repo> <tool> <branch>
#
# <handoff-repo> is the path to the handoff CLI's checkout (where src/cli.ts
# lives) — NOT the user's project repo. The cwd of this script is the worktree
# of the user's project; PROMPT.md sits there.
#
# Launches the chosen tool with a fixed RUNNER_META_PROMPT pointer string
# (the agent reads PROMPT.md via its own file-read tool — see issue #71
# and src/prompt.ts for why content never goes through argv). On exit
# invokes `bun <handoff-repo>/src/cli.ts cleanup <branch>` which removes
# the worktree iff the PR has been merged.

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

# Fixed pointer prompt — never pass PROMPT.md content through argv
# (issue #71). On Windows, npm-installed agent CLIs ship as .cmd
# shims that do `node "...\app.js" %*`, and cmd.exe re-parses %* with
# newlines as command separators and `& | < > ^` as metacharacters.
# A malicious PROMPT.md could break out as a batch command. We sidestep
# the entire class by keeping PROMPT.md content out of argv and letting
# the agent read the file via its own file-read tool. POSIX shells
# don't have the same hazard, but we use the same shape on both
# runners for consistency. SOURCE OF TRUTH: `RUNNER_META_PROMPT` in
# src/prompt.ts — keep this literal in sync; the runner integration
# tests import the TS constant and assert this exact string reaches
# the tool's argv.
META_PROMPT="Your initial task is in PROMPT.md in this directory. Read it and follow it. It contains your task description and the workflow contract you must follow."

# Per-tool invocation table. claude and codex both accept a positional
# [PROMPT] for interactive seeded sessions. copilot does NOT — it parses
# a bare positional as a subcommand and exits silently. Use copilot's
# `-i, --interactive <prompt>` flag, which starts interactive mode and
# automatically executes the seed prompt — same UX as claude/codex.
# When you add a new tool, mirror the change in handoff-runner.ps1 and
# the per-tool table in CLAUDE.md ("How to add a new adapter").
case "$TOOL" in
  claude|codex)
    "$TOOL" "$META_PROMPT"
    ;;
  copilot)
    "$TOOL" -i "$META_PROMPT"
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
# Only prompt when stdin is an actual TTY. The runner is launched into a
# fresh terminal window in production (TTY present), but the integration
# tests in tests/runner-bash.integration.test.ts spawn it with a piped
# stdin and would otherwise block forever on `read`.
if [ -t 0 ]; then
  read -r -p "[handoff] Press Enter to close this window..." _
fi
exit "$CLEANUP_EXIT"
