# CLAUDE.md — context for AI agents working in this repo

## What this project is

`handoff` is a small CLI + slash command that delegates a single GitHub issue (or free-form task) to one of three local agents — `claude`, `codex`, or `copilot` — running in an isolated git worktree. See [README.md](./README.md) for the user-facing summary and [docs/requirements.md](./docs/requirements.md) for the v0.1.0 spec.

## Module map

| File                         | Responsibility                                                            | Pure? |
| ---------------------------- | ------------------------------------------------------------------------- | ----- |
| `src/cli.ts`                 | Entrypoint. Parses argv, fans out to subcommands, isolates per-ref errors | no    |
| `src/args.ts`                | Argv → `{ tool, refs[], loop } \| { command: 'cleanup', branch }`         | yes   |
| `src/slug.ts`                | Title → kebab-case slug                                                   | yes   |
| `src/branch.ts`              | Branch + worktree path naming                                             | yes   |
| `src/prompt.ts`              | `PROMPT.md` template renderer                                             | yes   |
| `src/github.ts`              | `gh` wrappers: `fetchIssue`, `defaultBranch`, `prMergedFor`               | I/O   |
| `src/git.ts`                 | `git` wrappers: worktree create/remove, branch ops                        | I/O   |
| `src/terminal.ts`            | Platform-aware terminal spawn (`buildLaunchSpec` is pure)                 | mixed |
| `src/cleanup.ts`             | PR-merged check → remove worktree + branch                                | I/O   |
| `src/run.ts`                 | `spawn` wrapper with structured errors                                    | I/O   |
| `src/workspace.ts`           | `.handoff/state.json` read/write + schema-version guard                   | I/O   |
| `src/config.ts`              | `VERSION`, `HELP`                                                         | yes   |
| `scripts/handoff-runner.sh`  | Bash wrapper: run tool, then `bun … cli.ts cleanup <branch>`              | shell |
| `scripts/handoff-runner.ps1` | PowerShell equivalent for Windows                                         | shell |

Tests live in `tests/` and cover the **pure** modules. I/O modules are smoke-tested manually for v0.1.0; integration tests are out of scope.

## Conventions

- **TypeScript strict + `noUncheckedIndexedAccess`.** `argv[i]` is `string | undefined`; handle it.
- **No shell interpolation in TS.** Use `run.ts` (which uses `spawn` with an argv array). The only places shell strings exist are the runner scripts under `scripts/`.
- **Pure modules import only `node:` builtins and other pure modules.** I/O modules can import `run.ts`.
- **Conventional Commits**, one logical commit per concern.
- **Pre-commit hook** runs prettier + eslint via husky + lint-staged. Don't bypass with `--no-verify`.

## Workflow contract for agents working **on this repo**

1. Read `docs/requirements.md` and `docs/implementation-plan.v0.1.0.md` first.
2. Add tests for any pure-function change.
3. Run `bun test && bun run typecheck && bun run lint` before committing.
4. Cross-platform changes (terminal spawn, runner scripts, paths) need a note in the PR about which platforms you smoke-tested.

## How to add a new adapter

1. Add the tool string to `TOOLS` in `src/args.ts`.
2. Add the tool name to the `case` in `scripts/handoff-runner.sh` and the `ValidateSet` in `scripts/handoff-runner.ps1` (the runner scripts invoke the tool binary directly — currently the tool name == binary name).
3. Update `README.md` requirements list.
4. Add a test for the new tool path in `tests/args.test.ts`.

## The `.handoff/` workspace directory

Every worktree carries a small per-session metadata directory at its root:

```
<worktree-root>/
  PROMPT.md          # initial prompt for the agent (root, not under .handoff/)
  .handoff/
    state.json       # session metadata (see src/workspace.ts)
```

`state.json` is written by `src/cli.ts` on every handoff. Schema:

```jsonc
{
  "version": 1,
  "tool": "claude" | "codex" | "copilot",
  "ref": { "type": "issue", "number": 7 } |
         { "type": "pr",    "number": 12 } |
         { "type": "freeform", "text": "..." },
  "branch": "claude/issue-7",
  "loop": false,
  "createdAt": "2026-04-28T12:00:00.000Z",
  "updatedAt": "2026-04-28T12:00:00.000Z"
}
```

Rules:

- `PROMPT.md` stays at the worktree root for runner-script back-compat. New session artifacts go inside `.handoff/`.
- `.handoff/` is _gitignored at the user-repo level_ (the README tells users to add it to their `.gitignore`). It is removed with the worktree on cleanup.
- Bump `STATE_VERSION` in `src/workspace.ts` when you change the schema. The reader rejects unknown versions rather than silently mis-parsing.
- Future features should add files under `.handoff/` (e.g. `REVIEW.md` for #11, `container/` for #25) rather than scattering them across the worktree.

## How to extend the workflow contract in `PROMPT.md`

Edit the `WORKFLOW_CONTRACT` constant in `src/prompt.ts`. The template is intentionally one big string so it's reviewable as a unit — don't split it into per-tool variants without a strong reason.

There is a second constant, `WORKFLOW_CONTRACT_LOOP`, used when `--loop` is passed (claude only). Keep both as full strings rather than splicing — easier to review the agent's instructions for each mode in one place.

## Out of scope until later

- `--resume` an existing handoff worktree.
- Status dashboard (`handoff list`).
- Non-GitHub issue trackers.
- Containerized worktrees.
- Cross-agent orchestration (one issue handed to `claude`, the review handed to `codex`, etc.). v0.1.0 is parallel-but-independent.
