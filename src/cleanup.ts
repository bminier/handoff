import { existsSync } from 'node:fs';
import { branchExists, deleteBranch, removeWorktree } from './git.ts';
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

  const worktreeExisted = existsSync(path);
  if (worktreeExisted) {
    try {
      await removeWorktree(path);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        status: 'unknown',
        message:
          `Failed to remove worktree ${path}: ${reason}. ` +
          `Remove it manually with \`git worktree remove --force ${path}\` ` +
          `and then \`git branch -D ${branch}\`.`,
      };
    }
  }

  let removedBranch = false;
  if (await branchExists(branch)) {
    try {
      await deleteBranch(branch);
      removedBranch = true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        status: 'unknown',
        message:
          `${worktreeExisted ? `Removed worktree ${path}, but ` : ''}` +
          `failed to delete branch ${branch}: ${reason}. ` +
          `Delete it manually with \`git branch -D ${branch}\`.`,
      };
    }
  }

  const parts: string[] = [];
  if (worktreeExisted) parts.push(`Removed worktree ${path}`);
  else parts.push(`Worktree ${path} was not present`);
  if (removedBranch) parts.push(`deleted branch ${branch}`);
  else parts.push(`branch ${branch} was already gone`);

  return {
    status: 'removed',
    message: `${parts.join(' and ')} (PR merged). [${branchTail(branch)}]`,
  };
}
