# Requirements — `handoff`

## Purpose

`handoff` delegates a unit of work (a GitHub issue or a free-form task) to one of three coding agents — `claude`, `codex`, or `copilot` — running in an isolated **git worktree** with a generated `PROMPT.md` as context. The agent works to completion (commits, push, PR) in a dedicated terminal window. When the PR merges, the worktree self-cleans.

## Use cases

```
/handoff codex #1
/handoff copilot Issue #2
/handoff claude #3 #4 #5          # fleet — three parallel worktrees
/handoff claude "fix login redirect bug"   # free-form, no issue
```

## Functional requirements

### F1. Slash command surface

- A Claude Code slash command at `.claude/commands/handoff.md` invokes the bun CLI with `$ARGUMENTS`.
- Args: `<tool> <ref...>` where `<tool>` ∈ {`claude`, `codex`, `copilot`} and `<ref>` is one or more of: `#N`, `Issue #N`, or a quoted free-form description.

### F2. Issue resolution

- For `#N` / `Issue #N`: fetch title + body via `gh issue view N --json number,title,body,labels,url`.
- For free-form text: use it verbatim as the task description; no issue number.
- Fail fast with a clear error if `gh` is unauthenticated when an issue ref is given.

### F3. Worktree creation

- Branch name: `<tool>/issue-<N>` (issue), `<tool>/pr-<N>` (PR), or `<tool>/<slug>` (free-form). Slug is kebab-cased description, capped at 20 chars.
- Worktree path: sibling to the repo, `<parent>/<repo>-<branch-tail>` (e.g. `<repo>-issue-7`, `<repo>-pr-12`, `<repo>-cleanup-readme`).
- Branch off the repo's default branch (resolved via `gh repo view --json defaultBranchRef`), not the current HEAD.
- Refuse to create a worktree for a branch that already exists; suggest re-running with `--resume` (post-v0.1.0).

### F4. PROMPT.md generation

- Template injects: issue number, title, body, URL, branch, worktree path, target tool, repo name, parent branch, and a fixed "Workflow contract" section.
- Workflow contract instructs the agent to: implement, run tests, commit conventionally, push, open a PR via `gh pr create --base <default-branch>`, and exit cleanly. The cleanup hook (F6) handles worktree removal — the agent does not.

### F5. Terminal spawn

- Open one new interactive terminal window per handoff, in the worktree directory.
- Platform support priority: **Windows (`wt.exe`, fallback `cmd /c start`)** → macOS (`osascript`/Terminal) → Linux (`gnome-terminal` → `konsole` → `xterm`).
- The window runs a wrapper script that: `cd`'s into the worktree, runs `<tool>` with the PROMPT.md contents as the initial prompt, then on tool exit invokes the cleanup hook.

### F6. Cleanup hook

- After the agent process exits, the wrapper:
  1. Checks `gh pr list --head <branch> --state merged --json number` for the worktree's branch.
  2. If a merged PR exists → `git worktree remove <path>` and `git branch -D <branch>` from the parent repo.
  3. If no merged PR → leave the worktree, print a banner: "PR not yet merged — worktree retained at `<path>`. Run `handoff cleanup <branch>` to remove manually."
- A `handoff cleanup <branch>` subcommand provides manual cleanup.

### F7. Fleet mode

- When multiple `<ref>` args are passed, spawn N worktrees + N terminal windows in parallel. Each is fully independent (own branch, own PROMPT.md, own cleanup).
- The CLI returns once all terminals are launched (does not block on agent completion).

### F8. Configuration

- Zero-config default. Optional `.handoffrc.json` (or `package.json#handoff`) at repo root may override:
  - `defaultBranch` — fallback if `gh repo view` fails (e.g. offline)
  - `worktreeDir` — alternative parent for worktrees
  - `terminalCommand` — override the platform launcher
  - `promptTemplate` — path to a custom template

## Non-functional requirements

- **Language**: TypeScript, run via `bun`. No transpile step for the CLI; published as source + `package.json#bin` entry running `bun src/cli.ts`.
- **Cross-platform**: must work on Windows, macOS, Linux. CI runs the lint/typecheck/test gauntlet on `ubuntu-latest`, `macos-latest`, and `windows-latest`; format-check and lint are gated to ubuntu since their output is invariant. Windows-specific path handling is exercised by unit tests on the Windows runner, not by E2E.
- **Tests**: pure functions (slug, args, prompt rendering, branch naming) covered directly with `bun:test`. I/O modules have fixtures available under `tests/helpers/` (see `tests/README.md`); `cleanup` and `run` are wired up, the per-module tests for `git`/`github`/`terminal` spawn are in flight (#14). Cross-CLI integration tests still out of scope until #15. Run the suite with `bun run test` — the `--max-concurrency=1` pin matters; see `tests/README.md` for why.
- **Performance**: a single handoff completes its setup in under 5 seconds (excluding `gh` network latency).
- **Security**:
  - Never write secrets into PROMPT.md or branch names.
  - Free-form descriptions are passed as a single argv item — no shell interpolation.
  - Slug generator strips non-`[a-z0-9-]` characters.

## Out of scope for v0.1.0

- `--resume` / re-attaching to an existing handoff worktree.
- Status dashboard listing active handoffs.
- Non-GitHub issue trackers.
- Codex Cloud / Copilot remote agents (only local CLIs).
- Auto-detecting tool capability and routing (e.g., "give to whichever agent is idle").
- Containerized / VM-isolated worktrees.

## Answer to the open question

**Yes, `claude` (and the others) can be handed multiple issues at once.** Fleet mode (F7) covers this in v0.1.0 by spawning N independent terminal sessions. There is no orchestration _between_ the parallel agents — each is self-contained, each opens its own PR. A future version could add a coordinator that fans-out from a single tracking issue, but v0.1.0 keeps it as parallel-but-independent for safety and simplicity.

## Acceptance criteria for v0.1.0

1. `bun src/cli.ts claude #N` on a clean repo creates a worktree, writes PROMPT.md, opens a new terminal, and launches `claude` with the prompt.
2. Same for `codex` and `copilot`.
3. `bun src/cli.ts claude #1 #2` spawns two worktrees + two windows.
4. After the agent exits in the spawned terminal, if the PR is merged, the worktree is removed.
5. `handoff cleanup <branch>` removes a leftover worktree.
6. CI green: lint, type-check, test on push and PR.
7. Pre-commit hook runs prettier + eslint + tsc on staged files.
8. README and CLAUDE.md cover install, usage, and architecture.
