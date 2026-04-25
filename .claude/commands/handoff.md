---
description: Hand off a GitHub issue to claude/codex/copilot in a fresh worktree
argument-hint: <claude|codex|copilot> <#N | "free-form text"> [<#N>...]
allowed-tools: Bash
---

Run the handoff CLI with the user's arguments. The CLI creates a worktree, writes
`PROMPT.md`, and spawns a new terminal window running the chosen tool.

!`bun run --cwd "${HANDOFF_REPO:-$(pwd)}" src/cli.ts $ARGUMENTS`

If you got an error about `HANDOFF_REPO`, the user needs to set that env var to the
absolute path of their `handoff` repo checkout (e.g., `export HANDOFF_REPO=~/code/handoff`).
