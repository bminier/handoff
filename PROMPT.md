# Handoff: handoff

- **Tool:** `claude`
- **Branch:** `claude/pr`
- **Parent branch:** `dev`
- **Worktree:** `D:\bminier\handoff-pr`

## Task

PR

## Workflow contract

You are working in a dedicated git worktree on the branch shown above. The user has handed
off a single, scoped unit of work. Follow this sequence:

1. **Understand the task.** Re-read the issue or description above. If the task is ambiguous,
   ask the user (in this terminal) one focused question before starting.
2. **Implement.** Make the smallest set of changes that satisfies the task. Keep the diff
   focused — do not refactor unrelated code, do not introduce new abstractions.
3. **Verify.** Run the project's test suite, type checker, and linter. Fix anything you broke.
4. **Commit.** Use Conventional Commits style. One logical commit per concern; small enough
   to review.
5. **Push.** `git push -u origin <branch>`.
6. **Open the PR.** `gh pr create --base <parent-branch> --head <branch> --title "..."`.
   Title should be a concise summary; body should reference the issue (e.g., `Closes #N`)
   and summarize the change.
7. **Stop.** The moment `gh pr create` returns a PR URL, your job is done. Print exactly
   one line — `PR opened: <url>` — and exit the session. Do **not** call any more tools
   after this point: no extra commits, no `gh pr edit`, no `gh pr view`, no follow-up
   verification, no "one more thing" cleanup. The terminal wrapper takes over from here,
   detects whether the PR has been merged, and cleans up the worktree. If you exit before
   the PR is merged, the worktree is preserved and `handoff cleanup <branch>` removes it
   later.

   If you find yourself thinking "but I should also..." after the PR is open — stop. File
   it as a follow-up comment on the PR *only* if it's a real issue you discovered; otherwise
   leave it alone. The user explicitly does not want you to keep iterating after handoff.

**Boundaries.**
- Do **not** touch files outside the scope of this task.
- Do **not** delete or rewrite the worktree yourself — the wrapper handles that.
- Do **not** open multiple PRs. One handoff = one PR.
- If you cannot complete the task, leave the branch in a clean state, document what's left
  in the PR description (or in a comment if the PR isn't open yet), and exit.
