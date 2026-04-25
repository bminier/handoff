# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

### Added

- CLI: `handoff <tool> <ref...>` and `handoff cleanup <branch>` (`bun src/cli.ts`).
- Tools supported: `claude`, `codex`, `copilot`.
- Refs: `#N`, `Issue #N`, free-form text.
- Fleet mode: multiple `<ref>` args spawn N parallel worktrees + terminal windows.
- Cross-platform terminal launcher: Windows (`wt` → `cmd`), macOS (`osascript`), Linux (`gnome-terminal` → `konsole` → `xterm`).
- Wrapper scripts (`scripts/handoff-runner.{sh,ps1}`) auto-invoke `handoff cleanup` on tool exit.
- `PROMPT.md` template with workflow contract: implement → verify → commit → push → PR → exit.
- Cleanup: removes worktree + branch when `gh pr list --head <branch> --state merged` returns a result.
- Claude Code slash command at `.claude/commands/handoff.md`.
- Pre-commit (husky + lint-staged): prettier + eslint.
- CI (GitHub Actions, Ubuntu): format-check, lint, typecheck, test.
- Docs: `README.md`, `CLAUDE.md`, `docs/requirements.md`, `docs/implementation-plan.v0.1.0.md`.
