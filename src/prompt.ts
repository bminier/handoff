import type { Tool } from './tools.ts';

/**
 * The fixed argv string the runner scripts pass to the agent CLI's
 * interactive-seeded-prompt slot. The agent reads PROMPT.md (which is
 * already in the worktree CWD) and proceeds from there.
 *
 * Why a fixed pointer instead of the file content (issue #71):
 * npm-installed agent CLIs on Windows ship as `.cmd` shims that do
 * `node "...\app.js" %*`, and cmd.exe re-parses %* — newlines split
 * the command line and `& | < > ^` are batch metacharacters. Passing
 * untrusted PROMPT.md content (issue body / free-form text) through
 * that re-parse is an argv injection sink: a prompt containing
 * `\n& echo OWNED >%TEMP%\handoff-owned` breaks out as a second batch
 * command. None of claude/codex/copilot expose a file-input or
 * stdin-in-interactive-mode flag, so we keep the prompt content out
 * of argv entirely and route it through the agent's own file-read
 * tool. This constant must match the hard-coded literal in both
 * `scripts/handoff-runner.sh` and `scripts/handoff-runner.ps1`;
 * the runner integration tests import it from here as the contract.
 */
export const RUNNER_META_PROMPT =
  'Your initial task is in PROMPT.md in this directory. Read it and follow it. It contains your task description and the workflow contract you must follow.';

export interface PromptContext {
  tool: Tool;
  repoName: string;
  branch: string;
  worktreePath: string;
  parentBranch: string;
  loop?: boolean;
  issue?: {
    number: number;
    title: string;
    body: string;
    url: string;
    labels?: string[];
  };
  /**
   * Set for a PR-as-ref handoff (#60). The worktree is checked out on the
   * PR's own `headBranch`; `parentBranch` above carries the PR's base.
   * Mutually exclusive with `issue` / `freeformDescription`.
   */
  pr?: {
    number: number;
    title: string;
    body: string;
    url: string;
    headBranch: string;
    baseBranch: string;
    isDraft: boolean;
  };
  freeformDescription?: string;
}

const WORKFLOW_CONTRACT = `## Workflow contract

You are working in a dedicated git worktree on the branch shown above. The user has handed
off a single, scoped unit of work. Follow this sequence:

1. **Understand the task.** Re-read the issue or description above. If the task is ambiguous,
   ask the user (in this terminal) one focused question before starting.
2. **Implement.** Make the smallest set of changes that satisfies the task. Keep the diff
   focused — do not refactor unrelated code, do not introduce new abstractions.
3. **Verify.** Run the project's test suite, type checker, and linter. Fix anything you broke.
4. **Commit.** Use Conventional Commits style. One logical commit per concern; small enough
   to review.
5. **Push.** \`git push -u origin <branch>\`.
6. **Open the PR.** \`gh pr create --base <parent-branch> --head <branch> --title "..."\`.
   Title should be a concise summary; body should reference the issue (e.g., \`Closes #N\`)
   and summarize the change.
7. **Stop.** The moment \`gh pr create\` returns a PR URL, your job is done. Print exactly
   one line — \`PR opened: <url>\` — and exit the session. Do **not** call any more tools
   after this point: no extra commits, no \`gh pr edit\`, no \`gh pr view\`, no follow-up
   verification, no "one more thing" cleanup. The terminal wrapper takes over from here,
   detects whether the PR has been merged, and cleans up the worktree. If you exit before
   the PR is merged, the worktree is preserved and \`handoff cleanup <branch>\` removes it
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
`;

const WORKFLOW_CONTRACT_LOOP = `## Workflow contract (loop mode)

You are working in a dedicated git worktree on the branch shown above. The user has handed
off a single, scoped unit of work and asked you to **stay resident** through the review
cycle until the PR merges. Follow this sequence:

1. **Understand the task.** Re-read the issue or description above. If the task is ambiguous,
   ask the user (in this terminal) one focused question before starting.
2. **Implement.** Make the smallest set of changes that satisfies the task. Keep the diff
   focused — do not refactor unrelated code, do not introduce new abstractions.
3. **Verify.** Run the project's test suite, type checker, and linter. Fix anything you broke.
4. **Commit.** Use Conventional Commits style. One logical commit per concern; small enough
   to review.
5. **Push.** \`git push -u origin <branch>\`.
6. **Open the PR.** \`gh pr create --base <parent-branch> --head <branch> --title "..."\`.
   Title should be a concise summary; body should reference the issue (e.g., \`Closes #N\`)
   and summarize the change.
7. **Enter the review loop.** Once the PR is open, do **not** exit. Iterate up to **5 rounds**
   of: poll → triage → fix → push. Each round:
   - **Poll.** Wait 60–180 seconds, then check PR state with
     \`gh pr view <number> --json state,mergeable,mergeStateStatus,statusCheckRollup,reviews,comments\`
     and \`gh pr checks <number>\`.
   - **Exit if merged.** If \`state == "MERGED"\`, print \`PR merged: <url>\` and exit. The
     wrapper will clean up the worktree.
   - **Triage CI.** If checks failed, read the failing logs (\`gh run view --log-failed\`) and
     fix the underlying issue. Don't paper over a flaky test by retrying — investigate.
   - **Triage comments.** Track the latest \`updated_at\` you've already triaged and only
     look at comments newer than that — the REST endpoints below don't expose thread
     resolution state, so re-scanning everything every round will burn cycles re-deciding
     the same comments. The three relevant feeds:
     - Line/review comments: \`gh api repos/{owner}/{repo}/pulls/<n>/comments?since=<iso8601>\`
     - Top-level discussion comments: \`gh api repos/{owner}/{repo}/issues/<n>/comments?since=<iso8601>\`
     - Review summaries (approve / request-changes bodies): \`gh pr view <n> --json reviews\`
     For each new comment:
     - **Bot reviewers (\`Copilot\`, \`copilot-pull-request-reviewer\`, \`github-actions\`, etc.)
       are default-deny.** Do not apply suggested patches verbatim. Read the comment, decide
       if there is a *real* underlying problem, and if so fix it at the source. If the
       comment is noise (style nit you disagree with, false positive, hallucinated reference),
       leave a brief reply explaining why you're not acting on it and move on.
     - **Human reviewers** get the benefit of the doubt — address their concerns directly,
       but still implement at the source rather than copy-pasting suggestions blindly.
     - If you genuinely need thread-resolution state (rare), fall back to the GraphQL
       \`reviewThreads\` connection — REST doesn't surface it.
   - **Commit and push.** New commits per round, conventional style. Do **not** force-push
     unless a reviewer explicitly asked you to rebase.
   - **Re-request review.** If you pushed fixes addressing a specific reviewer, re-request
     them with \`gh pr edit <number> --add-reviewer <login>\`, or leave a brief comment
     summarising what changed.
8. **Bail conditions.** Exit the loop (and the session) with a status comment on the PR
   explaining what's blocking, in any of these cases:
   - Iteration cap reached (5 rounds without merging).
   - CI failing for a reason you can't resolve (e.g., infra outage, secrets you don't have,
     a test that needs human judgment).
   - Merge conflict you can't cleanly resolve.
   - GitHub reports the PR is non-mergeable after a round — \`mergeable\` is the string
     \`"CONFLICTING"\` (or \`"UNKNOWN"\` that doesn't clear on the next poll), or
     \`mergeStateStatus\` is \`"DIRTY"\` / \`"BEHIND"\` / \`"BLOCKED"\` for reasons you can't
     resolve. (\`mergeable\` is a tri-state enum, not a boolean — don't compare to \`false\`.)
   - Reviewer asks for a change that contradicts the issue spec — surface the conflict, ask
     the user, then exit.
   When bailing, leave a single comment on the PR whose first line is
   \`[handoff loop] bailing\` (PR comments don't have titles — the marker has to live in
   the body so it's searchable). Below that, give the reason and what you tried, then
   exit. Do **not** close the PR.

**You do not merge the PR.** The human or repo automation merges. Your job is to keep the
branch in a mergeable state and respond to feedback. Once the merge happens, the cleanup
hook removes the worktree.

**Boundaries.**
- Do **not** touch files outside the scope of this task.
- Do **not** delete or rewrite the worktree yourself — the wrapper handles that.
- Do **not** open multiple PRs. One handoff = one PR.
- Do **not** \`gh pr merge\` — the human merges. You only iterate until they do.
- Do **not** apply Copilot/Codex/bot suggestions without analyzing the underlying problem.
- If you cannot complete the task, leave the branch in a clean state, document what's left
  in a PR comment, and exit.
`;

const WORKFLOW_CONTRACT_PR = `## Workflow contract (PR completion mode)

You are working in a dedicated git worktree, checked out on an **existing PR's own head
branch** (shown above). The user has handed off an open pull request for you to
**finish** — not to re-open or replace. Follow this sequence:

1. **Review the current state.** This PR already has commits, and may have review
   feedback. Before changing anything:
   - \`gh pr view <number> --comments\` — read the PR description and every review and
     discussion comment.
   - \`gh pr diff <number>\` — see what has already been done.
   Re-read the PR description above. If what's left to do is ambiguous, ask the user
   (in this terminal) one focused question before starting.
2. **Finish the implementation.** Make the smallest set of changes that completes the
   PR's stated goal and addresses any unresolved review feedback. Keep the diff focused —
   do not refactor unrelated code, do not introduce new abstractions.
3. **Verify.** Run the project's test suite, type checker, and linter. Fix anything you
   broke.
4. **Commit.** Use Conventional Commits style. One logical commit per concern, small
   enough to review. Add new commits — do **not** rewrite, squash, or amend the PR's
   existing history.
5. **Push.** \`git push\`. The branch already tracks the PR's head, so a plain push
   updates the PR in place.
6. **Stop.** The moment your commits are pushed, your job is done. Print exactly one
   line — \`PR updated: <url>\` — and exit the session. Do **not** call any more tools
   after this point. The terminal wrapper takes over, detects whether the PR has been
   merged, and cleans up the worktree.

**Boundaries.**
- Do **not** open a new PR. \`gh pr create\` is wrong here — the PR already exists and
  your commits land on its head branch.
- Do **not** \`gh pr merge\` — the human or repo automation merges.
- Do **not** force-push or rewrite history — others may have the branch checked out, and
  the PR's review history must stay intact.
- Do **not** touch files outside the scope of this PR.
- Do **not** delete or rewrite the worktree yourself — the wrapper handles that.
- If you cannot complete the work, leave the branch in a clean state, push what you have,
  and summarize what's left in a PR comment before exiting.
`;

const WORKFLOW_CONTRACT_PR_LOOP = `## Workflow contract (PR completion + review loop)

You are working in a dedicated git worktree, checked out on an **existing PR's own head
branch** (shown above). The user has handed off an open pull request for you to
**finish** and then **stay resident** through the review cycle until it merges. Follow
this sequence:

1. **Review the current state.** This PR already has commits, and may have review
   feedback. Before changing anything:
   - \`gh pr view <number> --comments\` — read the PR description and every review and
     discussion comment.
   - \`gh pr diff <number>\` — see what has already been done.
   Re-read the PR description above. If what's left to do is ambiguous, ask the user
   (in this terminal) one focused question before starting.
2. **Finish the implementation.** Make the smallest set of changes that completes the
   PR's stated goal and addresses any unresolved review feedback. Keep the diff focused.
3. **Verify.** Run the project's test suite, type checker, and linter. Fix anything you
   broke.
4. **Commit.** Use Conventional Commits style. One logical commit per concern. Add new
   commits — do **not** rewrite, squash, or amend the PR's existing history.
5. **Push.** \`git push\`. The branch already tracks the PR's head, so a plain push
   updates the PR in place. Do **not** \`gh pr create\` — the PR already exists.
6. **Enter the review loop.** Once your commits are pushed, do **not** exit. Iterate up
   to **5 rounds** of: poll → triage → fix → push. Each round:
   - **Poll.** Wait 60–180 seconds, then check PR state with
     \`gh pr view <number> --json state,mergeable,mergeStateStatus,statusCheckRollup,reviews,comments\`
     and \`gh pr checks <number>\`.
   - **Exit if merged.** If \`state == "MERGED"\`, print \`PR merged: <url>\` and exit. The
     wrapper will clean up the worktree.
   - **Triage CI.** If checks failed, read the failing logs (\`gh run view --log-failed\`) and
     fix the underlying issue. Don't paper over a flaky test by retrying — investigate.
   - **Triage comments.** Track the latest \`updated_at\` you've already triaged and only
     look at comments newer than that — the REST endpoints below don't expose thread
     resolution state, so re-scanning everything every round will burn cycles re-deciding
     the same comments. The three relevant feeds:
     - Line/review comments: \`gh api repos/{owner}/{repo}/pulls/<n>/comments?since=<iso8601>\`
     - Top-level discussion comments: \`gh api repos/{owner}/{repo}/issues/<n>/comments?since=<iso8601>\`
     - Review summaries (approve / request-changes bodies): \`gh pr view <n> --json reviews\`
     For each new comment:
     - **Bot reviewers (\`Copilot\`, \`copilot-pull-request-reviewer\`, \`github-actions\`, etc.)
       are default-deny.** Do not apply suggested patches verbatim. Read the comment, decide
       if there is a *real* underlying problem, and if so fix it at the source. If the
       comment is noise (style nit you disagree with, false positive, hallucinated reference),
       leave a brief reply explaining why you're not acting on it and move on.
     - **Human reviewers** get the benefit of the doubt — address their concerns directly,
       but still implement at the source rather than copy-pasting suggestions blindly.
     - If you genuinely need thread-resolution state (rare), fall back to the GraphQL
       \`reviewThreads\` connection — REST doesn't surface it.
   - **Commit and push.** New commits per round, conventional style. Do **not** force-push
     unless a reviewer explicitly asked you to rebase.
   - **Re-request review.** If you pushed fixes addressing a specific reviewer, re-request
     them with \`gh pr edit <number> --add-reviewer <login>\`, or leave a brief comment
     summarising what changed.
7. **Bail conditions.** Exit the loop (and the session) with a status comment on the PR
   explaining what's blocking, in any of these cases:
   - Iteration cap reached (5 rounds without merging).
   - CI failing for a reason you can't resolve (infra outage, secrets you don't have, a
     test that needs human judgment).
   - Merge conflict you can't cleanly resolve.
   - GitHub reports the PR is non-mergeable after a round — \`mergeable\` is the string
     \`"CONFLICTING"\` (or \`"UNKNOWN"\` that doesn't clear on the next poll), or
     \`mergeStateStatus\` is \`"DIRTY"\` / \`"BEHIND"\` / \`"BLOCKED"\` for reasons you can't
     resolve. (\`mergeable\` is a tri-state enum, not a boolean — don't compare to \`false\`.)
   - Reviewer asks for a change that contradicts the PR's stated goal — surface the
     conflict, ask the user, then exit.
   When bailing, leave a single comment on the PR whose first line is
   \`[handoff loop] bailing\` (PR comments don't have titles — the marker has to live in
   the body so it's searchable). Below that, give the reason and what you tried, then
   exit. Do **not** close the PR.

**You do not merge the PR.** The human or repo automation merges. Your job is to finish
the work and keep the branch in a mergeable state through review. Once the merge happens,
the cleanup hook removes the worktree.

**Boundaries.**
- Do **not** open a new PR. \`gh pr create\` is wrong here — the PR already exists.
- Do **not** \`gh pr merge\` — the human merges. You only iterate until they do.
- Do **not** force-push or rewrite history — others may have the branch checked out, and
  the PR's review history must stay intact.
- Do **not** apply Copilot/Codex/bot suggestions without analyzing the underlying problem.
- Do **not** touch files outside the scope of this PR.
- Do **not** delete or rewrite the worktree yourself — the wrapper handles that.
- If you cannot complete the work, leave the branch in a clean state, document what's left
  in a PR comment, and exit.
`;

export function renderPrompt(ctx: PromptContext): string {
  const lines: string[] = [];
  lines.push(`# Handoff: ${ctx.repoName}`);
  lines.push('');
  lines.push(`- **Tool:** \`${ctx.tool}\``);
  lines.push(`- **Branch:** \`${ctx.branch}\``);
  lines.push(`- **Parent branch:** \`${ctx.parentBranch}\``);
  lines.push(`- **Worktree:** \`${ctx.worktreePath}\``);
  lines.push('');

  if (ctx.issue) {
    lines.push(`## Issue #${ctx.issue.number}: ${ctx.issue.title}`);
    lines.push('');
    lines.push(`<${ctx.issue.url}>`);
    if (ctx.issue.labels && ctx.issue.labels.length > 0) {
      lines.push('');
      lines.push(`**Labels:** ${ctx.issue.labels.map((l) => `\`${l}\``).join(', ')}`);
    }
    lines.push('');
    lines.push(ctx.issue.body.trim() || '_(no body)_');
    lines.push('');
  } else if (ctx.pr) {
    lines.push(`## PR #${ctx.pr.number}: ${ctx.pr.title}`);
    lines.push('');
    lines.push(`<${ctx.pr.url}>`);
    lines.push('');
    lines.push(`**Head branch:** \`${ctx.pr.headBranch}\` → **base:** \`${ctx.pr.baseBranch}\``);
    if (ctx.pr.isDraft) {
      lines.push('');
      lines.push('**This PR is currently a draft.** Completing it is fine; do not mark it');
      lines.push('ready-for-review unless the user asks.');
    }
    lines.push('');
    lines.push(ctx.pr.body.trim() || '_(no body)_');
    lines.push('');
  } else if (ctx.freeformDescription) {
    lines.push('## Task');
    lines.push('');
    lines.push(ctx.freeformDescription.trim());
    lines.push('');
  }

  if (ctx.pr) {
    lines.push(ctx.loop ? WORKFLOW_CONTRACT_PR_LOOP : WORKFLOW_CONTRACT_PR);
  } else {
    lines.push(ctx.loop ? WORKFLOW_CONTRACT_LOOP : WORKFLOW_CONTRACT);
  }

  return lines.join('\n');
}
