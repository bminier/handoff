import { dirname } from 'node:path';
import { run } from './run.ts';

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
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
  const { stdout } = await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const gitDir = stdout.trim();
  if (!gitDir) throw new GitError('git rev-parse --git-common-dir returned empty output');
  return dirname(gitDir);
}

export async function repoName(): Promise<string> {
  const root = await mainRepoRoot();
  const parts = root.replace(/\\/g, '/').split('/');
  const last = parts[parts.length - 1];
  if (!last) throw new GitError(`Could not derive repo name from ${root}`);
  return last;
}

export async function branchExists(branch: string): Promise<boolean> {
  try {
    await run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
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

export async function removeWorktree(path: string): Promise<void> {
  await run('git', ['worktree', 'remove', '--force', path]);
}

export async function deleteBranch(branch: string): Promise<void> {
  await run('git', ['branch', '-D', branch]);
}
