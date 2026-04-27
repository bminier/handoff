---
description: Hand off a GitHub issue to claude/codex/copilot in a fresh worktree
argument-hint: <claude|codex|copilot> <#N | "free-form text"> [<#N>...]
allowed-tools: Bash
---

Run the handoff CLI with the user's arguments. The CLI creates a worktree, writes
`PROMPT.md`, and spawns a new terminal window running the chosen tool.

The CLI **inherits the slash command's cwd** — that is intentional. `gh issue view`,
`git rev-parse`, and worktree placement all resolve relative to the caller's repo, so
pinning cwd to the handoff checkout would make every handoff target the wrong repo.
`scripts/install.py` rewrites `${HANDOFF_CLI:-src/cli.ts}` below to the absolute path
of `src/cli.ts` in this checkout; locally (un-installed) the fallback assumes you
ran the slash command from inside the handoff repo.

!`xargs bun run "${HANDOFF_CLI:-src/cli.ts}" <<< "$ARGUMENTS"`
