import { existsSync as fsExistsSync } from 'node:fs';
import {
  branchExists as gitBranchExists,
  deleteBranch as gitDeleteBranch,
  removeWorktree as gitRemoveWorktree,
} from './git.ts';
import { branchTail, worktreePath } from './branch.ts';
import { GhError, prMergedFor as ghPrMergedFor } from './github.ts';

export interface CleanupResult {
  status: 'removed' | 'retained' | 'unknown';
  message: string;
}

export interface CleanupDeps {
  prMergedFor: (branch: string) => Promise<boolean>;
  branchExists: (branch: string) => Promise<boolean>;
  removeWorktree: (path: string) => Promise<void>;
  deleteBranch: (branch: string) => Promise<void>;
  existsSync: (path: string) => boolean;
}

/**
 * Build the production deps wired to run from `repoRoot`.
 *
 * The runner scripts launch `handoff cleanup` with cwd set to the worktree
 * being removed. Without pinning cwd, `git worktree remove --force <path>`
 * is invoked from inside that doomed worktree (and `git branch -D <branch>`
 * targets a branch that's still checked out there) — both fail. Bind the
 * git/gh wrappers to `repoRoot` so production cleanup runs from outside
 * the worktree it's deleting.
 */
function buildDefaultDeps(repoRoot: string): CleanupDeps {
  return {
    prMergedFor: (branch) => ghPrMergedFor(branch, { cwd: repoRoot }),
    branchExists: (branch) => gitBranchExists(branch, { cwd: repoRoot }),
    removeWorktree: (path) => gitRemoveWorktree(path, { cwd: repoRoot }),
    deleteBranch: (branch) => gitDeleteBranch(branch, { cwd: repoRoot }),
    existsSync: fsExistsSync,
  };
}

export interface CleanupOpts {
  repoRoot: string;
  /**
   * @internal Test-only injection seam. Production callers should rely on the
   * default deps wired to `git.ts` / `github.ts` / `node:fs`. All-or-nothing
   * by design: a partial set used to silently fall back to the real impls,
   * which let a forgotten fake mutate the developer's actual repo.
   */
  deps?: CleanupDeps;
}

export async function cleanup(branch: string, opts: CleanupOpts): Promise<CleanupResult> {
  const deps: CleanupDeps = opts.deps ?? buildDefaultDeps(opts.repoRoot);
  const path = worktreePath({ repoRoot: opts.repoRoot, branch });

  let merged: boolean;
  try {
    merged = await deps.prMergedFor(branch);
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

  const worktreeExisted = deps.existsSync(path);
  if (worktreeExisted) {
    try {
      await deps.removeWorktree(path);
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
  if (await deps.branchExists(branch)) {
    try {
      await deps.deleteBranch(branch);
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
