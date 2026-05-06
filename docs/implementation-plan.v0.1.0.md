# Implementation Plan — v0.1.0

One PR into `dev` lands all of v0.1.0. Commits below are the intended sequence inside that PR; the PR is opened only after the final commit.

## Phase 0 — Repo bootstrap

**Commit:** `chore: bootstrap repo (gitignore, license, editorconfig)`

- `.gitignore` (Node + Bun + OS junk + worktree dirs)
- `LICENSE` (MIT)
- `.editorconfig`
- Empty `README.md` placeholder
- Initial commit lands on `dev`; subsequent work is layered on top.

## Phase 1 — Toolchain

**Commit:** `chore: add toolchain (bun, typescript, prettier, eslint, husky)`

- `package.json` — `name: handoff`, `type: module`, scripts (`dev`, `build`, `lint`, `format`, `typecheck`, `test`), `bin: { handoff: "src/cli.ts" }`
- `tsconfig.json` — strict, `moduleResolution: bundler`, `noEmit: true`
- `.prettierrc.json`, `.prettierignore`
- `eslint.config.js` (flat config, TS-aware)
- `bun.lockb` from `bun install`
- `.husky/pre-commit` → `bunx lint-staged`
- `lint-staged` config in `package.json`: prettier + eslint on `*.{ts,js,json,md}`, `bun run typecheck` on `*.ts`

## Phase 2 — Pure modules + tests

**Commit:** `feat(core): slug, args parser, prompt template`

- `src/slug.ts` — `slugify(title, { maxLen=40 })`; strips non-`[a-z0-9-]`, collapses dashes.
- `src/args.ts` — `parseArgs(argv): { tool, refs[] }`. Tool whitelist; refs are `#N`, `Issue #N`, or free text.
- `src/prompt.ts` — `renderPrompt(ctx): string`. Pure function over a `PromptContext` shape.
- `src/branch.ts` — `branchName({ tool, issueNumber, slug })`, `worktreePath({ repoRoot, branch })`.
- `tests/slug.test.ts`, `tests/args.test.ts`, `tests/prompt.test.ts`, `tests/branch.test.ts` (`bun test`).

## Phase 3 — External integrations

**Commit:** `feat(io): github + git wrappers`

- `src/github.ts` — `fetchIssue(n)`, `defaultBranch()`, `prMergedFor(branch)`. Each shells out to `gh` and parses JSON; throws typed errors on auth/network failure.
- `src/git.ts` — `currentRepoRoot()`, `createWorktree({ branch, path, base })`, `removeWorktree(path)`, `deleteBranch(branch)`. Wraps `git` with `execa`-style child_process.
- I/O is unit-tested via the `tests/helpers/` fixtures (`scriptedSpawn` for `run`/`github`, `tempRepo` for `git`, dependency injection for modules with multiple collaborators). Per-module `git`/`github`/`terminal` test files are in flight under #14; cross-CLI integration coverage is tracked in #15. See `tests/README.md` for the fixture-selection guide.

## Phase 4 — Terminal launcher

**Commit:** `feat(terminal): cross-platform window spawn`

- `src/terminal.ts` — `openTerminal({ cwd, command })`:
  - Win32: `wt.exe -d <cwd> -- <shell> -c "<command>"`; fallback `cmd /c start "" cmd /k "<command>"`.
  - Darwin: `osascript` to open Terminal.app with the command.
  - Linux: try `gnome-terminal` → `konsole` → `xterm` in order.
- Detached spawn so the parent CLI returns immediately (fleet support).

## Phase 5 — Adapters + wrapper script

**Commit:** `feat(adapters): claude/codex/copilot dispatch + runner`

- `src/adapters.ts` — `buildToolCommand(tool, promptPath)`:
  - claude: `claude "$(cat PROMPT.md)"`
  - codex: `codex "$(cat PROMPT.md)"`
  - copilot: `copilot "$(cat PROMPT.md)"`
- `scripts/handoff-runner.sh` (bash) and `scripts/handoff-runner.ps1` (PowerShell, for Win32 default shell): generic wrapper that takes `<tool>` and `<branch>`, runs the tool, then invokes `bun <repo>/src/cli.ts cleanup <branch>` on exit.
- `src/cleanup.ts` — `cleanup(branch)`: queries `prMergedFor(branch)`; on merged removes worktree + branch. On not-merged prints retention banner.

## Phase 6 — CLI orchestration

**Commit:** `feat(cli): wire dispatch, fleet, cleanup subcommand`

- `src/cli.ts`:
  1. `parseArgs(process.argv)` → tool + refs
  2. For each ref: resolve issue → branch → worktree → PROMPT.md → spawn terminal
  3. `cleanup <branch>` subcommand
  4. `--help` / `--version` flags
- Stderr-friendly error messages; non-zero exit on failure.

## Phase 7 — Slash command + docs

**Commit:** `docs: slash command, README, CLAUDE.md`

- `.claude/commands/handoff.md` — frontmatter + body that runs `!bun run --cwd <repo-root> src/cli.ts $ARGUMENTS`.
- `README.md` — install, requirements (`bun`, `gh`, target CLIs), usage, examples, troubleshooting.
- `CLAUDE.md` — architecture overview, module map, conventions, "how to add a new adapter".

## Phase 8 — CI + release prep

**Commit:** `ci: github actions (lint, typecheck, test)`

- `.github/workflows/ci.yml` — matrix of `ubuntu-latest`, `macos-latest`, `windows-latest` via `oven-sh/setup-bun`. Each runner does `bun install`, `bun run typecheck`, and `bun run test` (the script pins `--max-concurrency=1` so the I/O fixtures' single-threaded assumption holds — see `tests/README.md`). Format-check and lint are gated to the ubuntu runner since their output is invariant. Triggers on push to `dev` / `prerelease/**` / `release/**` and PRs into the same.
- `CHANGELOG.md` with v0.1.0 entry.
- Bump version in `package.json` to `0.1.0`.

## Phase 9 — Open the PR

- Push the working branch and `dev` to `origin`.
- `gh pr create --base dev --head <feature-branch> --title "feat: handoff v0.1.0"` with a body that links to `docs/requirements.md` and lists acceptance criteria.

## Risks / decisions deferred

- **Windows runner script**: if `wt.exe` is unavailable in the user's PATH the fallback uses `cmd`. We're not detecting Windows Terminal vs ConEmu vs Hyper — keeping it simple and documenting overrides via `terminalCommand` config.
- **PR-merged detection race**: the cleanup hook polls once on agent exit. If the user closes their terminal _before_ merging the PR, cleanup is skipped — `handoff cleanup <branch>` covers that.
- **Free-form refs**: argument boundary is naive (single shell-quoted string). Multiple free-form tasks in one fleet call are not supported in v0.1.0.
