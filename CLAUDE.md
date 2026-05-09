# CLAUDE.md — context for AI agents working in this repo

## What this project is

`handoff` is a small CLI + slash command that delegates a single GitHub issue (or free-form task) to one of three local agents — `claude`, `codex`, or `copilot` — running in an isolated git worktree. See [README.md](./README.md) for the user-facing summary and [docs/requirements.md](./docs/requirements.md) for the v0.1.0 spec.

## Module map

| File                         | Responsibility                                                            | Pure? |
| ---------------------------- | ------------------------------------------------------------------------- | ----- |
| `src/cli.ts`                 | Entrypoint. Parses argv, fans out to subcommands, isolates per-ref errors | no    |
| `src/args.ts`                | Argv → `{ tool, refs[], loop } \| { command: 'cleanup', branch, force }`  | yes   |
| `src/slug.ts`                | Title → kebab-case slug                                                   | yes   |
| `src/branch.ts`              | Branch + worktree path naming                                             | yes   |
| `src/prompt.ts`              | `PROMPT.md` template renderer                                             | yes   |
| `src/github.ts`              | `gh` wrappers: `fetchIssue`, `defaultBranch`, `prMergedFor`               | I/O   |
| `src/git.ts`                 | `git` wrappers: worktree create/remove, branch ops                        | I/O   |
| `src/terminal.ts`            | Platform-aware terminal spawn (`buildLaunchSpec` is pure)                 | mixed |
| `src/cleanup.ts`             | PR-merged check → remove worktree + branch                                | I/O   |
| `src/run.ts`                 | `spawn` wrapper with structured errors                                    | I/O   |
| `src/workspace.ts`           | `.handoff/state.json` read/write + schema-version guard                   | I/O   |
| `src/telemetry.ts`           | `~/.handoff/config.json`, event constructors, fire-and-forget emit        | mixed |
| `src/errors.ts`              | `HandoffError` base — exit-code + recovery-hint contract                  | yes   |
| `src/logger.ts`              | `--verbose`/`--debug` toggles + stderr log helpers                        | mixed |
| `src/config.ts`              | `VERSION`, `HELP`                                                         | yes   |
| `scripts/handoff-runner.sh`  | Bash wrapper: run tool, then `bun … cli.ts cleanup <branch>`              | shell |
| `scripts/handoff-runner.ps1` | PowerShell equivalent for Windows                                         | shell |

Tests live in `tests/`. Pure modules are covered directly with `bun:test`. See the **Testing fixtures** section below for the I/O test contract.

## Testing fixtures

I/O modules pick one of three fixtures — the rules below are the short version; [tests/README.md](./tests/README.md) is the authoritative source (decision matrix, rationale, the `--max-concurrency=1` reasoning, and why `mock.module(...)` on `src/*.ts` is banned).

| You're testing                                  | Use                       |
| ----------------------------------------------- | ------------------------- |
| `run.ts`, `github.ts`                           | `scriptedSpawn`           |
| `git.ts` (worktree create/remove, branch ops)   | `tempRepo`                |
| Multiple I/O collaborators (`cleanup.ts`, etc.) | dependency injection      |
| `terminal.ts` spawn path                        | dependency injection      |
| CLI fan-out (`fetchIssue` + `git` + `terminal`) | hybrid (see tests/README) |

When you add a new I/O module: pick a fixture from the matrix, follow the per-fixture pattern in tests/README.md, and add a row here only if your module doesn't fit any of the existing patterns.

## Conventions

- **TypeScript strict + `noUncheckedIndexedAccess`.** `argv[i]` is `string | undefined`; handle it.
- **No shell interpolation in TS.** Use `run.ts` (which uses `spawn` with an argv array). The only places shell strings exist are the runner scripts under `scripts/`.
- **Pure modules import only `node:` builtins and other pure modules.** I/O modules can import `run.ts`.
- **Errors extend `HandoffError`** (`src/errors.ts`) with an `exitCode` (1 = user, 2 = operational, 3 = internal/unexpected) and optionally a recovery `hint`. `cliMain()` uses the exit code as-is and prints the hint on a `hint:` line; `runHandoffs` aggregates the highest per-ref exit code so multi-ref failures still surface the documented category. Don't throw bare `Error` from CLI-reachable code — wrap it.
- **Conventional Commits**, one logical commit per concern.
- **Pre-commit hook** runs prettier + eslint via husky + lint-staged. Don't bypass with `--no-verify`.

## Workflow contract for agents working **on this repo**

1. Read `docs/requirements.md` and `docs/implementation-plan.v0.1.0.md` first.
2. Add tests for any pure-function change.
3. Run `bun run test && bun run typecheck && bun run lint` before committing. Use `bun run test` (not bare `bun test`) so the package.json `--max-concurrency=1` pin applies — the I/O-test fixtures rely on it.
4. Cross-platform changes (terminal spawn, runner scripts, paths) need a note in the PR about which platforms you smoke-tested.

## How to add a new adapter

1. Add the tool string to `TOOLS` in `src/args.ts`.
2. Add the tool name to the per-tool invocation table in **both** `scripts/handoff-runner.sh` and `scripts/handoff-runner.ps1`, plus the `ValidateSet` in the latter. The runner scripts invoke the tool binary directly (currently the tool name == binary name) — but the argv shape differs per tool (see table below), so a new adapter must declare which shape it uses.
3. Update `README.md` requirements list.
4. Add a test for the new tool path in `tests/args.test.ts`.
5. Add a per-tool argv-shape case to `tests/runner-bash.integration.test.ts` and `tests/runner-ps1.integration.test.ts` so the contract is pinned end-to-end.

### Per-tool invocation table

| Tool      | Argv shape            | Why                                                                                                                                                                                                                                                                                                                                           |
| --------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude`  | `claude <PROMPT>`     | Accepts a positional `[prompt]` (interactive seeded session).                                                                                                                                                                                                                                                                                 |
| `codex`   | `codex <PROMPT>`      | Same — `codex [OPTIONS] [PROMPT]`.                                                                                                                                                                                                                                                                                                            |
| `copilot` | `copilot -i <PROMPT>` | A bare positional is parsed as a subcommand and exits silently (issue #57). `-i, --interactive <prompt>` "starts interactive mode and automatically executes this prompt" — same UX as the others. Avoid `-p/--prompt`: that's non-interactive and exits after completion, which would close the terminal before the user sees what happened. |

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
         { "type": "freeform", "text": "..." },
  // A `{ "type": "pr", "number": 12 }` variant will be added when #10 lands
  // first-class PR handoffs end-to-end.
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

## Telemetry

`src/telemetry.ts` owns opt-in usage stats. The contract is:

- **Off by default.** `handoff telemetry enable [--endpoint <url>]` flips the switch; nothing is sent until both `enabled === true` and `endpoint !== null`.
- **No PII.** Event constructors (`eventStart`, `eventCleanup`, `eventError`) take typed input — issue titles, branch names, repo paths, and usernames have nowhere to land in their argument types. Tests assert the keyset of each payload; do not add fields without updating those tests and the README table.
- **Fire-and-forget.** `emit` is async with a 1s `AbortController` timeout. The CLI calls it via `emitFireAndForget`, which discards the returned promise so the user-visible work doesn't wait on a slow endpoint. The CLI sets `process.exitCode` (rather than calling `process.exit`) so any in-flight emits get a bounded chance to drain before the process exits naturally. Don't reintroduce `process.exit(code)` at the bottom of `cli.ts` — it silently drops the last event of every command for opted-in users. Transport failures, non-2xx responses, and timeouts are all dropped silently.
- **Debug log.** When `HANDOFF_TELEMETRY_DEBUG=1`, every event is appended to `~/.handoff/telemetry-debug.log` _whether or not telemetry is enabled_. This is the audit trail the user is promised.
- **Config file.** `~/.handoff/config.json` (separate from the per-worktree `.handoff/state.json`). Bump `CONFIG_VERSION` if the schema changes; `parseConfig` rejects unknown versions for the same reason `workspace.ts` does.

When you add a new event:

1. Add a typed constructor in `src/telemetry.ts`.
2. Add it to the `Event` union and to the `ALLOWED_KEYS` test table.
3. Document it in the README's `## Telemetry` table.
4. Wire `emitFireAndForget(...)` from the right call site in `src/cli.ts`.

## How to extend the workflow contract in `PROMPT.md`

Edit the `WORKFLOW_CONTRACT` constant in `src/prompt.ts`. The template is intentionally one big string so it's reviewable as a unit — don't split it into per-tool variants without a strong reason.

There is a second constant, `WORKFLOW_CONTRACT_LOOP`, used when `--loop` is passed (claude only). Keep both as full strings rather than splicing — easier to review the agent's instructions for each mode in one place.

## Out of scope until later

- `--resume` an existing handoff worktree.
- Status dashboard (`handoff list`).
- Non-GitHub issue trackers.
- Containerized worktrees.
- Cross-agent orchestration (one issue handed to `claude`, the review handed to `codex`, etc.). v0.1.0 is parallel-but-independent.
