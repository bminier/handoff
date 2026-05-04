import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { branchExists } from '../../src/git.ts';
import { createTempRepo, type TempRepo } from './tempRepo.ts';

let repo: TempRepo;
let originalCwd: string;

beforeEach(() => {
  repo = createTempRepo({
    branches: ['feature/x', 'fix/y'],
    remotes: { origin: 'https://example.invalid/repo.git' },
  });
  originalCwd = process.cwd();
});

afterEach(() => {
  process.chdir(originalCwd);
  repo.cleanup();
});

describe('tempRepo', () => {
  it('creates a real repo with the requested branches and remotes', () => {
    expect(existsSync(repo.path)).toBe(true);

    const branches = repo
      .git(['branch', '--list', '--format=%(refname:short)'])
      .stdout.split('\n')
      .map((b) => b.trim())
      .filter(Boolean);
    expect(branches.sort()).toEqual(['dev', 'feature/x', 'fix/y']);

    expect(repo.git(['symbolic-ref', '--short', 'HEAD']).stdout.trim()).toBe('dev');
    expect(repo.git(['remote', 'get-url', 'origin']).stdout.trim()).toBe(
      'https://example.invalid/repo.git',
    );
  });

  it('drives src/git.ts through process.chdir into the temp repo', async () => {
    // git.ts uses the process cwd when shelling out, so this is the wiring
    // pattern the per-module tests in #14 will copy.
    process.chdir(repo.path);

    expect(await branchExists('feature/x')).toBe(true);
    expect(await branchExists('does/not/exist')).toBe(false);
  });

  it('cleanup removes the repo from disk and is idempotent', () => {
    const path = repo.path;
    repo.cleanup();
    expect(existsSync(path)).toBe(false);
    expect(() => repo.cleanup()).not.toThrow();
  });

  it('cleanup also removes linked worktrees that landed as siblings', () => {
    // Mimic what src/git.ts createWorktree does: register a sibling worktree
    // off the temp repo. cleanup() should reach it via `git worktree list`,
    // not just rm the main repo and leave the sibling on disk.
    const sibling = join(dirname(repo.path), `${repo.path.split(/[\\/]/).pop()}-feature-x`);
    repo.git(['worktree', 'add', sibling, 'feature/x']);
    expect(existsSync(sibling)).toBe(true);

    repo.cleanup();

    expect(existsSync(repo.path)).toBe(false);
    expect(existsSync(sibling)).toBe(false);
  });

  it('does not leak a temp dir if setup fails', () => {
    // Dedicated prefix isolates from sibling tempRepo callers in this run;
    // the before-snapshot then isolates from stale `*-leakcheck-*` dirs
    // left behind by a previous aborted run on the same machine. Either
    // alone would let unrelated state poison the assertion.
    const prefix = 'handoff-temprepo-leakcheck-';
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith(prefix)));

    // `..bad` is rejected by `git branch` with "invalid branch name", which
    // throws partway through setup — after mkdtemp but before the handle is
    // returned. Guard ensures the directory doesn't survive the throw.
    expect(() => createTempRepo({ tmpPrefix: prefix, branches: ['..bad'] })).toThrow();

    const after = readdirSync(tmpdir()).filter((n) => n.startsWith(prefix));
    const newEntries = after.filter((n) => !before.has(n));
    expect(newEntries).toEqual([]);
  });
});
