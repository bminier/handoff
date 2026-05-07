import { dirname, resolve } from 'node:path';
import { HandoffError } from './errors.ts';
import { run, RunError, type RunOpts } from './run.ts';

export class GitError extends HandoffError {
  constructor(message: string, hint?: string) {
    super(message, 2, hint);
    this.name = 'GitError';
  }
}

/**
 * Optional cwd for git invocations. Cleanup runs from inside the worktree
 * being removed, where `git worktree remove` and `git branch -D` would fail
 * against the current repo state — the caller pins cwd to the main repo
 * root so those operations target the correct worktree from outside it.
 */
export interface GitOpts {
  cwd?: string;
}

function cwdOpts(opts: GitOpts): RunOpts {
  return opts.cwd === undefined ? {} : { cwd: opts.cwd };
}

export async function currentRepoRoot(): Promise<string> {
  const { stdout } = await run('git', ['rev-parse', '--show-toplevel']);
  return stdout.trim();
}

/**
 * Root of the *main* worktree, even when called from inside a linked worktree.
 * `currentRepoRoot()` returns whatever worktree we happen to be in, which makes
 * worktree-path computation double up (e.g. `<repo>-issue-64-issue-64`) when
 * handoff is invoked from inside a previous handoff's worktree.
 */
export async function mainRepoRoot(): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await run('git', ['rev-parse', '--git-common-dir']));
  } catch (err) {
    if (err instanceof RunError) {
      throw new GitError(
        'not inside a git repository',
        'Run handoff from inside a git repo (cd into one, or `git init`).',
      );
    }
    throw err;
  }
  const gitDir = stdout.trim();
  if (!gitDir) throw new GitError('git rev-parse --git-common-dir returned empty output');
  // Pre-2.31, git returns this relative to cwd; resolve in TS to stay
  // compatible with the documented `git ≥ 2.20` minimum.
  return dirname(resolve(process.cwd(), gitDir));
}

export async function repoName(): Promise<string> {
  const root = await mainRepoRoot();
  const parts = root.replace(/\\/g, '/').split('/');
  const last = parts[parts.length - 1];
  if (!last) throw new GitError(`Could not derive repo name from ${root}`);
  return last;
}

export async function branchExists(branch: string, opts: GitOpts = {}): Promise<boolean> {
  try {
    await run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], cwdOpts(opts));
    return true;
  } catch {
    return false;
  }
}

export interface CreateWorktreeInput {
  branch: string;
  path: string;
  base: string;
}

export async function createWorktree(input: CreateWorktreeInput): Promise<void> {
  if (await branchExists(input.branch)) {
    throw new GitError(
      `Branch '${input.branch}' already exists. Resume support is planned for a later release; ` +
        `for now, delete the branch with \`git branch -D ${input.branch}\` or use a different ref.`,
    );
  }
  await run('git', ['worktree', 'add', '-b', input.branch, input.path, input.base]);
}

export async function removeWorktree(path: string, opts: GitOpts = {}): Promise<void> {
  await run('git', ['worktree', 'remove', '--force', path], cwdOpts(opts));
}

export async function deleteBranch(branch: string, opts: GitOpts = {}): Promise<void> {
  await run('git', ['branch', '-D', branch], cwdOpts(opts));
}
