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

1. Renders `.claude/commands/handoff.md` into `~/.claude/commands/handoff.md` with the absolute path to this checkout's `src/cli.ts` baked in, so `/handoff` works in any Claude Code session started after install. The slash command leaves the bun cwd alone so `gh issue view` resolves against the _caller's_ repo, not the handoff checkout.
2. Runs `bun link` so the `handoff` CLI is on your PATH.

Pass `--no-link` to skip the CLI link and install only the slash command. Re-run after moving the checkout — and re-run if you installed before this `cli.ts`-path layout, since older installs pinned `--cwd` to the handoff repo and resolved issues against the wrong remote.

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

### Loop mode (`--loop`, claude only)

```bash
handoff claude --loop #7
```

By default the agent stops the moment `gh pr create` returns. With `--loop`, the prompt instructs Claude Code to **stay resident** after the PR is open and self-drive the review cycle:

- Poll the PR (`gh pr view`, `gh pr checks`) on a 60–180s cadence.
- Triage CI failures and fix them at the source.
- Triage review comments. **Bot reviewers (Copilot, Codex, github-actions) are default-deny** — the agent reads each comment, decides if there's a real underlying problem, and fixes at the source rather than blindly applying suggested patches.
- Commit and push fixes per round.
- Bail with a `[handoff loop] bailing` PR comment if it hits 5 rounds, an unresolvable CI failure, or a merge conflict.

The agent does **not** merge — that's still your call. Once you (or repo automation) merge, it exits and the wrapper cleans up the worktree as usual.

`--loop` is rejected for `codex` and `copilot`: those CLIs run as ephemeral sessions in their own windows and don't have a natural "stay resident and poll" model.

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
├── workspace.ts  — .handoff/state.json read/write
├── telemetry.ts  — opt-in usage stats (off by default)
├── config.ts     — VERSION, HELP
└── run.ts        — typed spawn helper
scripts/
├── handoff-runner.sh   — wrapper for macOS/Linux terminals
└── handoff-runner.ps1  — wrapper for Windows terminals
.claude/commands/handoff.md  — Claude Code slash command
```

A handoff is one PR. Cleanup is conditional on `gh pr list --head <branch> --state merged` returning a result; nothing else will trigger worktree removal.

### The `.handoff/` workspace directory

Every handoff worktree carries a small metadata directory at its root:

```
<worktree-root>/
  PROMPT.md          # initial prompt for the agent
  .handoff/
    state.json       # tool, ref, branch, loop, timestamps
```

It's session metadata, not source — **add `.handoff/` to your repo's `.gitignore`**. The directory is removed along with the worktree when the PR merges. Future features (pre-commit reviews, container metadata, `--resume` state) will live under the same prefix.

## Configuration

None required. Future versions will support `.handoffrc.json` overrides for `defaultBranch`, `worktreeDir`, `terminalCommand`, and `promptTemplate`.

## Telemetry

`handoff` ships with opt-in usage telemetry. **It is off by default and stays off until you flip a switch.** Nothing is sent over the network unless you both (a) enable telemetry and (b) point it at an endpoint URL.

```bash
handoff telemetry status                                # show current state + event shapes
handoff telemetry enable --endpoint https://you.test/t  # turn on, point at your aggregator
handoff telemetry disable                               # turn off
handoff telemetry log                                   # print the local debug log
```

What we collect (and only this — by construction):

| Event             | Payload                                     |
| ----------------- | ------------------------------------------- |
| `handoff.start`   | `{ tool, refType, fleet, loop, sessionId }` |
| `handoff.cleanup` | `{ tool, outcome, durationMs }`             |
| `handoff.error`   | `{ code, module, exitCode }`                |

`refType` is `issue` or `freeform`; `outcome` is `merged` / `retained` / `failed`; `sessionId` is a per-handoff random UUID. There is **no PII**: no issue titles, branch names, repo paths, or usernames are ever transmitted. Event delivery is async fire-and-forget: the CLI never awaits a send at the call site, so a slow or down endpoint doesn't gate user-visible work. The process does wait briefly on exit for any in-flight requests to drain, bounded by a 1s `AbortController` timeout per request. Failures (transport errors, non-2xx, timeout) are dropped silently.

Trust through transparency: set `HANDOFF_TELEMETRY_DEBUG=1` in your environment to capture every event you would have sent to `~/.handoff/telemetry-debug.log`. The log is written **whether or not telemetry is enabled**, so you can audit what the tool would send before turning it on. `handoff telemetry log` prints the file.

Configuration lives at `~/.handoff/config.json`.

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
