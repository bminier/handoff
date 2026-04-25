# Initial Prompt

> Verbatim (lightly cleaned: fixed copy-paste artifacts like `&#x20;`, `\##`, and stray line breaks). Original lives at `../PROMPT.md`.

---

Please create for me a simple self-contained skill that will create a new git worktree of the current repo, set it up, create a `PROMPT.md`, and launch one of the following: `claude`, `codex`, or `copilot` using the `PROMPT.md` as the starting point in a new interactive terminal window. This should be tailored toward feature branches and bug fixes, where the expectation is that work will be done, commit(s) will be generated, PRs created, and upon completion of the PR it should exit and clean up its worktree.

Ask questions if anything needs clarification. Create `./docs/requirements.md` and `./docs/implementation-plan.v0.1.0.md`. There should be 1 pull request, and that is when v0.1.0's implementation plan is complete.

Follow best practices: install pre-commit hooks, an appropriate DevOps pipeline, create a `README.md`, `CLAUDE.md`, all the expected goodness.

Use bun/typescript for any scripting required.

## Use cases

- `/handoff codex Issue #1`
- `/handoff copilot Issue #2`

## Question

- Can `claude` handle fleets, so we could hand off Issues 1–3 all at once?

## Process note

First, review this prompt to clean it up with anything I've forgotten or new information and save it to `docs/initial-prompt.md`.
