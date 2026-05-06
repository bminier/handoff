import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanup, type CleanupDeps } from '../src/cleanup.ts';
import { GhError } from '../src/github.ts';
import { createScriptedSpawn } from './helpers/scriptedSpawn.ts';

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

describe('cleanup — production wiring (no opts.deps)', () => {
  // The DI tests above all pass an explicit `deps` object, so the
  // `opts.deps ?? defaultDeps` fallback that production (cli.ts) actually
  // hits is otherwise uncovered. A regression in the defaultDeps mapping
  // — `prMergedFor` swapped, `existsSync` undefined, etc. — would ship
  // unnoticed.
  //
  // We use scriptedSpawn here even though tests/README.md says not to mix
  // it with per-module tests. The carve-out: this is an integration check
  // of the wiring through to the gh subprocess, exactly like the #15
  // CLI-level pattern. We fake the gh call so it fails predictably and
  // assert cleanup() reaches the failure path.
  const spawn = createScriptedSpawn();
  beforeEach(() => spawn.install());
  afterEach(() => spawn.uninstall());

  it('falls through to defaultDeps and reaches the real gh wrapper', async () => {
    const expectedArgv = [
      'pr',
      'list',
      '--head',
      'no-such-branch',
      '--state',
      'merged',
      '--json',
      'number',
      '--limit',
      '1',
    ];
    spawn.expect({
      command: 'gh',
      argv: expectedArgv,
      response: { stderr: 'gh test stub: not authenticated', exitCode: 1 },
    });

    const result = await cleanup('no-such-branch', { repoRoot: '/work/handoff' });

    // Asserting only `status === 'unknown'` would also pass if the wiring
    // missed the registered expectation entirely (scriptedSpawn's
    // unmatched-call path emits an Error which cleanup also surfaces as
    // 'unknown'). Pin both ends of the wire so a regression in either
    // `defaultDeps.prMergedFor` *or* the gh argv contract trips this test:
    //   - spawn.calls confirms cleanup actually shelled out to the
    //     expected `gh pr list ...` invocation
    //   - the message containing the stub's stderr text confirms
    //     cleanup's GhError handling consumed that exact failure
    // cwd MUST be the passed repoRoot, not undefined: the runner scripts
    // invoke `handoff cleanup` from inside the worktree being removed, and
    // an inherited cwd would target the wrong (or doomed) directory once
    // git starts mutating worktrees.
    expect(spawn.calls).toEqual([{ command: 'gh', args: expectedArgv, cwd: '/work/handoff' }]);
    expect(result.status).toBe('unknown');
    expect(result.message).toContain('Could not check PR status');
    expect(result.message).toContain('gh test stub: not authenticated');
  });

  it('drives the merged-PR happy path through every defaultDeps entry', async () => {
    // The error-path test above only exercises `defaultDeps.prMergedFor`.
    // A swap of `branchExists`/`removeWorktree`/`deleteBranch`/`existsSync`
    // in the defaults table would still slip through. This case wires up
    // a real on-disk worktree directory so the production `existsSync`
    // returns true, then registers each gh/git argv the merged path is
    // expected to produce — pinning all five wires by argv shape, not
    // just the prMergedFor slot.
    const parent = mkdtempSync(join(tmpdir(), 'handoff-cleanup-defaults-'));
    const repoRoot = join(parent, 'myrepo');
    const branch = 'claude/issue-9';
    const worktreeDir = join(parent, 'myrepo-issue-9');
    mkdirSync(worktreeDir);
    try {
      // gh pr list → returns a single merged PR → prMergedFor returns true.
      spawn.expectGh(
        ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number', '--limit', '1'],
        [{ number: 9 }],
      );
      // git worktree remove --force <path>
      spawn.expect({
        command: 'git',
        argv: ['worktree', 'remove', '--force', worktreeDir],
        response: { stdout: '' },
      });
      // git show-ref --verify --quiet refs/heads/<branch> → success → branchExists=true
      spawn.expect({
        command: 'git',
        argv: ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
        response: { stdout: '' },
      });
      // git branch -D <branch>
      spawn.expect({
        command: 'git',
        argv: ['branch', '-D', branch],
        response: { stdout: '' },
      });

      const result = await cleanup(branch, { repoRoot });

      expect(result.status).toBe('removed');
      expect(result.message).toContain(`Removed worktree ${worktreeDir}`);
      expect(result.message).toContain(`deleted branch ${branch}`);
      // All four subprocesses were issued in the order cleanup.ts walks
      // them: gh first, then worktree remove (gated by existsSync), then
      // branchExists, then deleteBranch. Every call's cwd must be the
      // passed repoRoot — production cleanup runs from inside the doomed
      // worktree, so a regression that drops the cwd-binding here would
      // re-break merged-PR cleanup the same way the original bug did.
      expect(
        spawn.calls.map((c) => ({ cmd: `${c.command} ${c.args.join(' ')}`, cwd: c.cwd })),
      ).toEqual([
        {
          cmd: `gh pr list --head ${branch} --state merged --json number --limit 1`,
          cwd: repoRoot,
        },
        { cmd: `git worktree remove --force ${worktreeDir}`, cwd: repoRoot },
        { cmd: `git show-ref --verify --quiet refs/heads/${branch}`, cwd: repoRoot },
        { cmd: `git branch -D ${branch}`, cwd: repoRoot },
      ]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
