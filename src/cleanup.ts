import { existsSync } from 'node:fs';
import { deleteBranch, removeWorktree } from './git.ts';
import { branchTail, worktreePath } from './branch.ts';
import { GhError, prMergedFor } from './github.ts';

export interface CleanupResult {
  status: 'removed' | 'retained' | 'unknown';
  message: string;
}

export async function cleanup(branch: string, opts: { repoRoot: string }): Promise<CleanupResult> {
  const path = worktreePath({ repoRoot: opts.repoRoot, branch });

  let merged: boolean;
  try {
    merged = await prMergedFor(branch);
  } catch (err) {
    const reason = err instanceof GhError ? err.message : String(err);
    return {
      status: 'unknown',
      message:
        `Could not check PR status for ${branch} (${reason}). Worktree retained at ${path}. ` +
        `Re-run \`handoff cleanup ${branch}\` once \`gh\` works.`,
    };
  }

  if (!merged) {
    return {
      status: 'retained',
      message:
        `PR for ${branch} is not merged. Worktree retained at ${path}. ` +
        `Run \`handoff cleanup ${branch}\` after merging to remove it.`,
    };
  }

  if (existsSync(path)) {
    await removeWorktree(path);
  }
  await deleteBranch(branch).catch(() => {
    // Branch may already be gone if the worktree removal pruned it; ignore.
  });

  return {
    status: 'removed',
    message: `Removed worktree ${path} and deleted branch ${branch} (PR merged). [${branchTail(branch)}]`,
  };
}
