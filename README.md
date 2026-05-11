# handoff

Delegate a GitHub issue (or a free-form task) to **`claude`**, **`codex`**, or **`copilot`** in an isolated git worktree, with a generated `PROMPT.md` as the starting context. The agent works to completion (commits, push, PR) in its own terminal window. When the PR merges, the worktree self-cleans.

```
/handoff #1                       # claude (default) on issue #1
/handoff codex #1                 # explicit tool
/handoff copilot Issue #2
/handoff #3 #4 #5                 # fleet — three parallel claude worktrees
/handoff "fix login redirect bug" # free-form, default tool
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

### Verify the install

```bash
handoff doctor          # checks bun, git, gh, gh auth, git working tree, terminal, all agents
handoff doctor claude   # narrow the per-tool check to one agent
handoff doctor --json   # machine-readable
```

Exit code is `0` when every error-severity check passes (warnings are informational and don't fail the run). Run this first thing after install to surface missing prereqs before they ambush a real handoff.

## Usage

### Single issue

```bash
handoff #42          # claude is the default tool
handoff claude #42   # equivalent — explicit
handoff codex #42    # different agent
```

This:

1. Resolves the GitHub issue title + body via `gh issue view 42`.
2. Creates branch `<tool>/issue-42` off the repo's default branch (e.g. `claude/issue-42`).
3. Adds a worktree as a sibling directory: `<repo-parent>/<repo>-issue-42`.
4. Writes `PROMPT.md` to the worktree with the issue, the branch, and a workflow contract.
5. Spawns a new terminal window in that worktree and runs the chosen tool, instructing the agent to read `PROMPT.md` and follow it. (The agent reads the file via its own file tool rather than receiving the content via argv; see `src/prompt.ts` and issue #71 for why.) The per-tool argv table lives in `scripts/handoff-runner.{sh,ps1}`.

The agent does the work, commits, pushes, opens a PR. When it exits, the wrapper checks `gh pr list --head <branch> --state merged` — if the PR has merged, the worktree and branch are removed.

### Fleet

```bash
handoff #1 #2 #3
```

Three independent worktrees + three terminal windows, in parallel. Each opens its own PR. Add a tool prefix (`handoff codex #1 #2 #3`) to use a different agent.

### Free-form

```bash
handoff "tighten error messages in the API client"
handoff codex "tighten error messages in the API client"
```

No issue lookup. The text is passed as the task description in `PROMPT.md`. The branch becomes `<tool>/<short-slug>` (slug capped at 20 chars).

> **Quote free-form descriptions to avoid typo ambiguity.** A leading token that isn't a known tool name (`claude` / `codex` / `copilot`) or subcommand (`cleanup` / `telemetry`) parses as the start of a free-form description for the default tool. So an unquoted typo like `handoff calude #1` becomes the free-form task `"calude #1"` (for claude) instead of being caught. Quoting intentional free-form (`handoff "fix the bug"`) makes the intent unambiguous.

### Loop mode (`--loop`, claude only)

```bash
handoff --loop #7        # default tool is claude, so this is fine
handoff claude --loop #7 # equivalent
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

If the work shipped under a different branch (rebased, renamed, force-pushed to a sibling), `gh pr list --head <branch>` returns empty and the worktree is correctly retained — the merge-check has no proof. Use `--force` to remove the orphan worktree without the safety check:

```bash
handoff cleanup --force claude/issue-42
```

`--force` is also the escape hatch when `gh` itself is broken (rate-limited, unauthenticated). Reach for it when you've verified the work is shipped, not as a default — the merge-check exists to keep `handoff cleanup` from eating in-progress work.

### Verbose / debug logging

Two global flags for when you want to see what `handoff` is doing under the hood:

```bash
handoff --verbose claude #7    # info traces (branch, worktree path, terminal launch)
handoff --debug claude #7      # subprocess invocations + exit codes (implies --verbose)
```

Both write to stderr so they don't pollute scriptable stdout. They can sit before the tool, after it, or before/after subcommands (`handoff cleanup --verbose <branch>`); they're stripped from free-form descriptions verbatim, so `handoff claude "fix the --verbose flag"` still works.

## Exit codes

| Code | Meaning                                                                  |
| ---- | ------------------------------------------------------------------------ |
| `0`  | success                                                                  |
| `1`  | user error — bad args, missing reference, unauthenticated `gh`           |
| `2`  | operational failure — worktree already exists, `git`/`gh` command failed |
| `3`  | internal / unexpected error                                              |

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

A handoff is one PR. Cleanup is conditional on `gh pr list --head <branch> --state merged` returning a result — that's the safety property. The one opt-in escape hatch is `handoff cleanup --force <branch>`, which skips the merge check for orphan worktrees whose work shipped under a different branch (see [Cleanup](#cleanup) above). `--force` is restricted to handoff-shaped branch names so a typo can't unconditionally delete unrelated local branches.

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

`refType` is `issue` or `freeform`; `outcome` is `merged` / `forced` / `retained` / `failed` (`forced` is when the user passed `handoff cleanup --force` — distinguished so analytics can track how often the merge-check safety is bypassed); `sessionId` is a per-handoff random UUID. There is **no PII**: no issue titles, branch names, repo paths, or usernames are ever transmitted. Event delivery is async fire-and-forget: the CLI never awaits a send at the call site, so a slow or down endpoint doesn't gate user-visible work. The process does wait briefly on exit for any in-flight requests to drain, bounded by a 1s `AbortController` timeout per request. Failures (transport errors, non-2xx, timeout) are dropped silently.

Trust through transparency: set `HANDOFF_TELEMETRY_DEBUG=1` in your environment to capture every event you would have sent to `~/.handoff/telemetry-debug.log`. The log is written **whether or not telemetry is enabled**, so you can audit what the tool would send before turning it on. `handoff telemetry log` prints the file.

Configuration lives at `~/.handoff/config.json`.

## Development

```bash
bun install
bun run test
bun run typecheck
bun run lint
bun run format
```

Pre-commit runs prettier + eslint via husky + lint-staged.

## Testing

Run the full suite with `bun run test`, **not** bare `bun test` — the script pins `--max-concurrency=1` so the I/O fixtures (which depend on process-global state) can't race a future `test.concurrent()` marker.

```bash
bun run test                              # everything
bun run test tests/args.test.ts           # one file
bun test --watch                          # iterate (skips the concurrency pin; safe for pure-module work)
```

Three test layers, each with its own conventions:

- **Pure modules** (`args`, `slug`, `branch`, `prompt`, parts of `workspace` and `terminal`) — direct `bun:test`, no fixtures.
- **I/O modules** (`run`, `github`, `git`, `cleanup`, `terminal` spawn) — one of three fixtures under `tests/helpers/`: `scriptedSpawn` for spawn-shaped contracts, `tempRepo` for real-`git` behaviour, dependency injection when a module has multiple I/O collaborators.
- **Integration** — `tests/cli.integration.test.ts` for the end-to-end CLI happy path (hybrid fixture: faked `gh`, real `git`, faked terminal); `tests/runner-bash.integration.test.ts` and `tests/runner-ps1.integration.test.ts` for the wrapper scripts; `scripts/install.py` is covered by pytest in `tests/install_test.py` (run with `uv run pytest tests/install_test.py` — same command CI uses).

Adding a test for a new I/O module: pick the fixture from `tests/README.md`'s decision matrix, follow the per-fixture pattern there. Don't reach for `mock.module(...)` on `src/*.ts` — Bun's `mock.module` is process-global and pollutes other test files.

## License

MIT — see [LICENSE](./LICENSE).
