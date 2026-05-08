import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';

import {
  GitError,
  branchExists,
  createWorktree,
  currentRepoRoot,
  deleteBranch,
  mainRepoRoot,
  removeWorktree,
  repoName,
} from '../src/git.ts';
import type { HandoffError } from '../src/errors.ts';
import { createScriptedSpawn, type ScriptedSpawn } from './helpers/scriptedSpawn.ts';
import { worktreePath } from '../src/branch.ts';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.ts';

let repo: TempRepo;
let originalCwd: string;

beforeEach(() => {
  repo = createTempRepo({ branches: ['feature/x'] });
  originalCwd = process.cwd();
});
afterEach(() => {
  // Restore cwd *before* repo.cleanup(): on Windows, rmSync of a directory
  // the process is sitting inside fails with EBUSY.
  process.chdir(originalCwd);
  repo.cleanup();
});

// `git rev-parse` emits forward-slashed paths on Windows; tempRepo paths
// are platform-native. Normalize both ends before comparing so the tests
// don't drift between OSes.
function posix(p: string): string {
  return p.replace(/\\/g, '/');
}

describe('currentRepoRoot', () => {
  it('returns the top-level of the repo we are in', async () => {
    process.chdir(repo.path);
    expect(posix(await currentRepoRoot())).toBe(posix(repo.path));
  });
});

describe('mainRepoRoot', () => {
  it('returns the main worktree root from the main worktree itself', async () => {
    process.chdir(repo.path);
    expect(posix(await mainRepoRoot())).toBe(posix(repo.path));
  });

  it('returns the main worktree root even when called from inside a linked worktree', async () => {
    // The whole reason mainRepoRoot exists rather than currentRepoRoot:
    // worktree-path computation has to anchor on the main repo so a handoff
    // launched from inside a previous handoff's worktree doesn't double up
    // its directory name (`<repo>-issue-7-issue-7`).
    const linked = worktreePath({ repoRoot: repo.path, branch: 'feature/x' });
    repo.git(['worktree', 'add', linked, 'feature/x']);

    process.chdir(linked);
    expect(posix(await mainRepoRoot())).toBe(posix(repo.path));
  });
});

describe('mainRepoRoot — outside a git repo', () => {
  let spawn: ScriptedSpawn;
  beforeEach(() => {
    spawn = createScriptedSpawn();
    spawn.install();
  });
  afterEach(() => spawn.uninstall());

  it('throws GitError(exitCode=2) with a recovery hint when git rev-parse fails', async () => {
    // Simulate being outside a git repo: git exits non-zero.
    spawn.expect({
      command: 'git',
      argv: ['rev-parse', '--git-common-dir'],
      response: { stderr: 'fatal: not a git repository', exitCode: 128 },
    });
    let err: unknown;
    try {
      await mainRepoRoot();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GitError);
    expect((err as HandoffError).exitCode).toBe(2);
    expect((err as HandoffError).hint).toMatch(/git repo/i);
  });
});

describe('repoName', () => {
  it('returns the basename of the main repo root', async () => {
    process.chdir(repo.path);
    // tempRepo provisions under SUITE_ROOT/handoff-temprepo-<rand>; the
    // basename is whatever mkdtemp picked, but it always contains the prefix.
    expect(await repoName()).toMatch(/^handoff-temprepo-/);
  });
});

describe('branchExists', () => {
  it('returns true for a branch that exists', async () => {
    expect(await branchExists('feature/x', { cwd: repo.path })).toBe(true);
  });

  it('returns false for a branch that does not exist (and never the surrounding error)', async () => {
    // `show-ref --verify --quiet` exits non-zero when the ref is missing;
    // run() rejects with RunError, and branchExists swallows it. A
    // regression that let the RunError bubble would crash cleanup() right
    // before the branch-deletion step.
    expect(await branchExists('does-not-exist', { cwd: repo.path })).toBe(false);
  });

  it('honours opts.cwd so callers can pin git operations to a specific repo', async () => {
    // Without cwd binding, branchExists shells out in process.cwd(); the
    // production cleanup path runs from inside the doomed worktree and
    // cwd must be the main repo root for the show-ref to find the branch.
    // Pin the contract so a regression here re-breaks merged-PR cleanup.
    process.chdir(originalCwd);
    expect(await branchExists('feature/x', { cwd: repo.path })).toBe(true);
  });
});

describe('createWorktree', () => {
  it('creates a worktree directory and a new branch off the base', async () => {
    process.chdir(repo.path);
    const linked = worktreePath({ repoRoot: repo.path, branch: 'claude/issue-1' });

    await createWorktree({ branch: 'claude/issue-1', path: linked, base: 'dev' });

    expect(existsSync(linked)).toBe(true);
    // Branch must exist after creation — `worktree add -b` is what creates it.
    expect(await branchExists('claude/issue-1', { cwd: repo.path })).toBe(true);
  });

  it('refuses with a clear GitError when the branch already exists', async () => {
    // The runner scripts assume a fresh branch per handoff; resume support
    // is explicitly out of scope for v0.1.0. Without this guard, `git
    // worktree add -b` would fail with a less-actionable git error mid-flow
    // and leave the cli in an awkward partial state.
    process.chdir(repo.path);
    const linked = worktreePath({ repoRoot: repo.path, branch: 'feature/x' });

    let err: unknown;
    try {
      await createWorktree({ branch: 'feature/x', path: linked, base: 'dev' });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(GitError);
    expect((err as HandoffError).exitCode).toBe(2);
    expect((err as Error).message).toContain("Branch 'feature/x' already exists");
    expect((err as Error).message).toContain('git branch -D feature/x');
    // No partial state on the filesystem — we bailed before `git worktree add`.
    expect(existsSync(linked)).toBe(false);
  });
});

describe('removeWorktree', () => {
  it('removes a linked worktree directory', async () => {
    process.chdir(repo.path);
    const linked = worktreePath({ repoRoot: repo.path, branch: 'claude/issue-2' });
    await createWorktree({ branch: 'claude/issue-2', path: linked, base: 'dev' });
    expect(existsSync(linked)).toBe(true);

    await removeWorktree(linked, { cwd: repo.path });

    expect(existsSync(linked)).toBe(false);
  });

  it('honours opts.cwd so cleanup runs from outside the doomed worktree', async () => {
    // Direct exercise of the bug fixed in #46: `git worktree remove`
    // invoked from inside the worktree being removed fails. Pin the cwd
    // contract by running from a directory that *isn't* the linked
    // worktree, then assert removal succeeded.
    process.chdir(originalCwd);
    const linked = worktreePath({ repoRoot: repo.path, branch: 'claude/issue-3' });
    process.chdir(repo.path);
    await createWorktree({ branch: 'claude/issue-3', path: linked, base: 'dev' });
    process.chdir(originalCwd);

    await removeWorktree(linked, { cwd: repo.path });
    expect(existsSync(linked)).toBe(false);
  });
});

describe('deleteBranch', () => {
  it('deletes an unchecked-out branch', async () => {
    await deleteBranch('feature/x', { cwd: repo.path });
    expect(await branchExists('feature/x', { cwd: repo.path })).toBe(false);
  });

  it('rejects when the branch is currently checked out in a linked worktree', async () => {
    // git refuses `branch -D` on a branch that's checked out *anywhere* in
    // the repo, even in another worktree. This is the exact failure that
    // bit production cleanup before the cwd-binding fix landed: cleanup
    // from inside the doomed worktree tried to delete its own branch and
    // hit this rejection. Lock the behavior so a future "force everything"
    // change doesn't paper over it.
    process.chdir(repo.path);
    const linked = worktreePath({ repoRoot: repo.path, branch: 'claude/issue-4' });
    await createWorktree({ branch: 'claude/issue-4', path: linked, base: 'dev' });

    // git's exact wording varies — older versions say "checked out at",
    // newer ones (and Windows) say "used by worktree at". Match either.
    await expect(deleteBranch('claude/issue-4', { cwd: repo.path })).rejects.toThrow(
      /(checked out at|used by worktree at)/,
    );
    // Branch survived the rejection.
    expect(await branchExists('claude/issue-4', { cwd: repo.path })).toBe(true);
  });
});
