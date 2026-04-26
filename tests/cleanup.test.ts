import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

let mergedReturn: boolean | Error = false;
let branchExistsReturn = true;
let removeWorktreeError: Error | null = null;
let deleteBranchError: Error | null = null;
let worktreeOnDisk = true;

const calls = {
  prMergedFor: [] as string[],
  removeWorktree: [] as string[],
  branchExists: [] as string[],
  deleteBranch: [] as string[],
};

mock.module('node:fs', () => ({
  existsSync: (_p: string) => worktreeOnDisk,
}));

mock.module('../src/github.ts', () => ({
  GhError: class GhError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'GhError';
    }
  },
  prMergedFor: async (branch: string) => {
    calls.prMergedFor.push(branch);
    if (mergedReturn instanceof Error) throw mergedReturn;
    return mergedReturn;
  },
}));

mock.module('../src/git.ts', () => ({
  branchExists: async (branch: string) => {
    calls.branchExists.push(branch);
    return branchExistsReturn;
  },
  removeWorktree: async (path: string) => {
    calls.removeWorktree.push(path);
    if (removeWorktreeError) throw removeWorktreeError;
  },
  deleteBranch: async (branch: string) => {
    calls.deleteBranch.push(branch);
    if (deleteBranchError) throw deleteBranchError;
  },
}));

const { cleanup } = await import('../src/cleanup.ts');
const { GhError } = await import('../src/github.ts');

beforeEach(() => {
  mergedReturn = false;
  branchExistsReturn = true;
  removeWorktreeError = null;
  deleteBranchError = null;
  worktreeOnDisk = true;
  calls.prMergedFor.length = 0;
  calls.removeWorktree.length = 0;
  calls.branchExists.length = 0;
  calls.deleteBranch.length = 0;
});

afterEach(() => {
  // mock state reset by beforeEach; nothing to do here
});

describe('cleanup', () => {
  it('removes worktree and branch when PR is merged', async () => {
    mergedReturn = true;
    worktreeOnDisk = true;
    branchExistsReturn = true;

    const result = await cleanup('claude/issue-7', { repoRoot: '/work/handoff' });

    expect(result.status).toBe('removed');
    expect(result.message).toContain('Removed worktree');
    expect(result.message).toContain('deleted branch claude/issue-7');
    expect(calls.prMergedFor).toEqual(['claude/issue-7']);
    expect(calls.removeWorktree.length).toBe(1);
    expect(calls.deleteBranch).toEqual(['claude/issue-7']);
  });

  it('reports cleanly when worktree and branch are already gone', async () => {
    mergedReturn = true;
    worktreeOnDisk = false;
    branchExistsReturn = false;

    const result = await cleanup('codex/issue-9', { repoRoot: '/work/handoff' });

    expect(result.status).toBe('removed');
    expect(result.message).toContain('was not present');
    expect(result.message).toContain('branch codex/issue-9 was already gone');
    expect(calls.removeWorktree.length).toBe(0);
    expect(calls.deleteBranch.length).toBe(0);
  });

  it('retains the worktree when the PR is not merged', async () => {
    mergedReturn = false;

    const result = await cleanup('claude/issue-1', { repoRoot: '/work/handoff' });

    expect(result.status).toBe('retained');
    expect(result.message).toContain('not merged');
    expect(result.message).toContain('Worktree retained');
    expect(calls.removeWorktree.length).toBe(0);
    expect(calls.deleteBranch.length).toBe(0);
  });

  it('returns "unknown" when gh fails', async () => {
    mergedReturn = new GhError('gh pr list failed: not authenticated');

    const result = await cleanup('claude/issue-3', { repoRoot: '/work/handoff' });

    expect(result.status).toBe('unknown');
    expect(result.message).toContain('Could not check PR status');
    expect(result.message).toContain('not authenticated');
    expect(result.message).toContain('Re-run');
    expect(calls.removeWorktree.length).toBe(0);
    expect(calls.deleteBranch.length).toBe(0);
  });

  it('returns "unknown" when branch deletion fails after worktree removal', async () => {
    mergedReturn = true;
    worktreeOnDisk = true;
    branchExistsReturn = true;
    deleteBranchError = new Error('branch is checked out somewhere');

    const result = await cleanup('claude/issue-5', { repoRoot: '/work/handoff' });

    expect(result.status).toBe('unknown');
    expect(result.message).toContain('Removed worktree');
    expect(result.message).toContain('failed to delete branch');
    expect(result.message).toContain('git branch -D claude/issue-5');
    expect(calls.removeWorktree.length).toBe(1);
  });

  it('skips branch deletion when the branch no longer exists', async () => {
    mergedReturn = true;
    worktreeOnDisk = true;
    branchExistsReturn = false;

    const result = await cleanup('codex/issue-11', { repoRoot: '/work/handoff' });

    expect(result.status).toBe('removed');
    expect(result.message).toContain('Removed worktree');
    expect(result.message).toContain('branch codex/issue-11 was already gone');
    expect(calls.deleteBranch.length).toBe(0);
  });
});
