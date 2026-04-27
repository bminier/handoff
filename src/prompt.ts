import type { Tool } from './args.ts';

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
     the same comments. The two relevant feeds:
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
  } else if (ctx.freeformDescription) {
    lines.push('## Task');
    lines.push('');
    lines.push(ctx.freeformDescription.trim());
    lines.push('');
  }

  lines.push(ctx.loop ? WORKFLOW_CONTRACT_LOOP : WORKFLOW_CONTRACT);

  return lines.join('\n');
}
