import type { Tool } from './args.ts';

export interface PromptContext {
  tool: Tool;
  repoName: string;
  branch: string;
  worktreePath: string;
  parentBranch: string;
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

  lines.push(WORKFLOW_CONTRACT);

  return lines.join('\n');
}
