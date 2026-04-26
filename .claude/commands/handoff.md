---
description: Hand off a GitHub issue to claude/codex/copilot in a fresh worktree
argument-hint: <claude|codex|copilot> <#N | "free-form text"> [<#N>...]
allowed-tools: Bash
---

Run the handoff CLI with the user's arguments. The CLI creates a worktree, writes
`PROMPT.md`, and spawns a new terminal window running the chosen tool.

!`IFS=' ' read -ra ARGS <<< "$ARGUMENTS" && bun run --cwd "${HANDOFF_REPO:-$(pwd)}" src/cli.ts "${ARGS[@]}"`
