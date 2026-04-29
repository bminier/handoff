import { beforeEach, describe, expect, it } from 'bun:test';

import { cleanup, type CleanupDeps } from '../src/cleanup.ts';
import { GhError } from '../src/github.ts';

interface FakeState {
  mergedReturn: boolean | Error;
  branchExistsReturn: boolean;
  removeWorktreeError: Error | null;
  deleteBranchError: Error | null;
  worktreeOnDisk: boolean;
  calls: {
    prMergedFor: string[];
    removeWorktree: string[];
    branchExists: string[];
    deleteBranch: string[];
  };
}

function newState(): FakeState {
  return {
    mergedReturn: false,
    branchExistsReturn: true,
    removeWorktreeError: null,
    deleteBranchError: null,
    worktreeOnDisk: true,
    calls: {
      prMergedFor: [],
      removeWorktree: [],
      branchExists: [],
      deleteBranch: [],
    },
  };
}

function fakeDeps(state: FakeState): CleanupDeps {
  return {
    prMergedFor: async (branch: string) => {
      state.calls.prMergedFor.push(branch);
      if (state.mergedReturn instanceof Error) throw state.mergedReturn;
      return state.mergedReturn;
    },
    branchExists: async (branch: string) => {
      state.calls.branchExists.push(branch);
      return state.branchExistsReturn;
    },
    removeWorktree: async (path: string) => {
      state.calls.removeWorktree.push(path);
      if (state.removeWorktreeError) throw state.removeWorktreeError;
    },
    deleteBranch: async (branch: string) => {
      state.calls.deleteBranch.push(branch);
      if (state.deleteBranchError) throw state.deleteBranchError;
    },
    existsSync: (p: string) => {
      const norm = String(p).replace(/\\/g, '/');
      // The cleanup tests use '/work/...' synthetic paths; only stub those.
      if (norm.startsWith('/work/')) return state.worktreeOnDisk;
      throw new Error(`unexpected existsSync path in cleanup test: ${p}`);
    },
  };
}

let state: FakeState;
let deps: CleanupDeps;

beforeEach(() => {
  state = newState();
  deps = fakeDeps(state);
});

describe('cleanup', () => {
  it('removes worktree and branch when PR is merged', async () => {
    state.mergedReturn = true;
    state.worktreeOnDisk = true;
    state.branchExistsReturn = true;

    const result = await cleanup('claude/issue-7', { repoRoot: '/work/handoff', deps });

    expect(result.status).toBe('removed');
    expect(result.message).toContain('Removed worktree');
    expect(result.message).toContain('deleted branch claude/issue-7');
    expect(state.calls.prMergedFor).toEqual(['claude/issue-7']);
    expect(state.calls.removeWorktree.length).toBe(1);
    expect(state.calls.deleteBranch).toEqual(['claude/issue-7']);
  });

  it('reports cleanly when worktree and branch are already gone', async () => {
    state.mergedReturn = true;
    state.worktreeOnDisk = false;
    state.branchExistsReturn = false;

    const result = await cleanup('codex/issue-9', { repoRoot: '/work/handoff', deps });

    expect(result.status).toBe('removed');
    expect(result.message).toContain('was not present');
    expect(result.message).toContain('branch codex/issue-9 was already gone');
    expect(state.calls.removeWorktree.length).toBe(0);
    expect(state.calls.deleteBranch.length).toBe(0);
  });

  it('retains the worktree when the PR is not merged', async () => {
    state.mergedReturn = false;

    const result = await cleanup('claude/issue-1', { repoRoot: '/work/handoff', deps });

    expect(result.status).toBe('retained');
    expect(result.message).toContain('not merged');
    expect(result.message).toContain('Worktree retained');
    expect(state.calls.removeWorktree.length).toBe(0);
    expect(state.calls.deleteBranch.length).toBe(0);
  });

  it('returns "unknown" when gh fails', async () => {
    state.mergedReturn = new GhError('gh pr list failed: not authenticated');

    const result = await cleanup('claude/issue-3', { repoRoot: '/work/handoff', deps });

    expect(result.status).toBe('unknown');
    expect(result.message).toContain('Could not check PR status');
    expect(result.message).toContain('not authenticated');
    expect(result.message).toContain('Re-run');
    expect(state.calls.removeWorktree.length).toBe(0);
    expect(state.calls.deleteBranch.length).toBe(0);
  });

  it('returns "unknown" when worktree removal fails', async () => {
    state.mergedReturn = true;
    state.worktreeOnDisk = true;
    state.removeWorktreeError = new Error('worktree is locked');

    const result = await cleanup('claude/issue-4', { repoRoot: '/work/handoff', deps });

    expect(result.status).toBe('unknown');
    expect(result.message).toContain('Failed to remove worktree');
    expect(result.message).toContain('locked');
    expect(result.message).toContain('git worktree remove --force');
    expect(result.message).toContain('git branch -D claude/issue-4');
    expect(state.calls.removeWorktree.length).toBe(1);
    expect(state.calls.deleteBranch.length).toBe(0);
  });

  it('returns "unknown" when branch deletion fails after worktree removal', async () => {
    state.mergedReturn = true;
    state.worktreeOnDisk = true;
    state.branchExistsReturn = true;
    state.deleteBranchError = new Error('branch is checked out somewhere');

    const result = await cleanup('claude/issue-5', { repoRoot: '/work/handoff', deps });

    expect(result.status).toBe('unknown');
    expect(result.message).toContain('Removed worktree');
    expect(result.message).toContain('failed to delete branch');
    expect(result.message).toContain('git branch -D claude/issue-5');
    expect(state.calls.removeWorktree.length).toBe(1);
  });

  it('skips branch deletion when the branch no longer exists', async () => {
    state.mergedReturn = true;
    state.worktreeOnDisk = true;
    state.branchExistsReturn = false;

    const result = await cleanup('codex/issue-11', { repoRoot: '/work/handoff', deps });

    expect(result.status).toBe('removed');
    expect(result.message).toContain('Removed worktree');
    expect(result.message).toContain('branch codex/issue-11 was already gone');
    expect(state.calls.deleteBranch.length).toBe(0);
  });
});
