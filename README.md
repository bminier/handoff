# handoff

Delegate a GitHub issue (or a free-form task) to **`claude`**, **`codex`**, or **`copilot`** in an isolated git worktree, with a generated `PROMPT.md` as the starting context. The agent works to completion (commits, push, PR) in its own terminal window. When the PR merges, the worktree self-cleans.

```
/handoff codex #1
/handoff copilot Issue #2
/handoff claude #3 #4 #5          # fleet — three parallel worktrees
/handoff claude "fix login redirect bug"
```

## Why

You have a backlog. You have three different agents you'd like to try on it. You don't want them stomping on each other in the same checkout, and you don't want to babysit the bookkeeping. `handoff` gives each task its own worktree, branch, and terminal window, and tears it down when the PR lands.

## Requirements

- [bun](https://bun.sh) ≥ 1.1
- `git` ≥ 2.20 (for `git worktree`)
- [`gh`](https://cli.github.com) authenticated (`gh auth login`)
- Python ≥ 3.8 (only for `scripts/install.py` — invoke as `python3` on macOS/Linux, `py -3` on Windows if `python` isn't on PATH)
- The agent CLI you want to dispatch to:
  - `claude` → [Anthropic Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code)
  - `codex` → [OpenAI Codex CLI](https://github.com/openai/codex)
  - `copilot` → [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli)

Cross-platform: Windows (Windows Terminal preferred, falls back to `cmd`), macOS, Linux (gnome-terminal → konsole → xterm).

## Install

```bash
git clone git@github.com:bminier/handoff.git
cd handoff
bun install
```

Then run the installer:

```bash
python scripts/install.py
```

This:

1. Renders `.claude/commands/handoff.md` into `~/.claude/commands/handoff.md` with this checkout's absolute path baked in, so `/handoff` works in any Claude Code session started after install.
2. Runs `bun link` so the `handoff` CLI is on your PATH.

Pass `--no-link` to skip the CLI link and install only the slash command. Re-run after moving the checkout.

> **Restart Claude Code after installing.** Slash commands under `~/.claude/commands/` are read at session start, so any sessions that were already open won't see `/handoff` until they're restarted.

## Usage

### Single issue

```bash
handoff claude #42
```

This:

1. Resolves the GitHub issue title + body via `gh issue view 42`.
2. Creates branch `claude/issue-42` off the repo's default branch.
3. Adds a worktree as a sibling directory: `<repo-parent>/<repo>-issue-42`.
4. Writes `PROMPT.md` to the worktree with the issue, the branch, and a workflow contract.
5. Spawns a new terminal window in that worktree, running `claude "$(cat PROMPT.md)"`.

The agent does the work, commits, pushes, opens a PR. When it exits, the wrapper checks `gh pr list --head <branch> --state merged` — if the PR has merged, the worktree and branch are removed.

### Fleet

```bash
handoff claude #1 #2 #3
```

Three independent worktrees + three terminal windows, in parallel. Each opens its own PR.

### Free-form

```bash
handoff codex "tighten error messages in the API client"
```

No issue lookup. The text is passed as the task description in `PROMPT.md`. The branch becomes `codex/<short-slug>` (slug capped at 20 chars).

### Cleanup

If the wrapper missed cleanup (you closed the terminal before merging the PR, you ran `gh` while offline, etc.):

```bash
handoff cleanup claude/issue-42
```

This re-checks the PR state and removes the worktree + branch if merged.

## Architecture

```
src/
├── cli.ts        — entrypoint, fleet loop
├── args.ts       — parse <tool> <ref...>
├── slug.ts       — title → kebab-case
├── branch.ts     — branch + worktree path naming
├── prompt.ts     — PROMPT.md template
├── github.ts     — gh wrappers
├── git.ts        — git worktree wrappers
├── terminal.ts   — cross-platform window spawn
├── cleanup.ts    — PR-merged check + worktree teardown
├── config.ts     — VERSION, HELP
└── run.ts        — typed spawn helper
scripts/
├── handoff-runner.sh   — wrapper for macOS/Linux terminals
└── handoff-runner.ps1  — wrapper for Windows terminals
.claude/commands/handoff.md  — Claude Code slash command
```

A handoff is one PR. Cleanup is conditional on `gh pr list --head <branch> --state merged` returning a result; nothing else will trigger worktree removal.

## Configuration

None required. Future versions will support `.handoffrc.json` overrides for `defaultBranch`, `worktreeDir`, `terminalCommand`, and `promptTemplate`.

## Development

```bash
bun install
bun test
bun run typecheck
bun run lint
bun run format
```

Pre-commit runs prettier + eslint via husky + lint-staged.

## License

MIT — see [LICENSE](./LICENSE).
