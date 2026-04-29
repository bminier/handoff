import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

  it('does not leak a temp dir if setup fails', () => {
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('handoff-temprepo-')));

    // `..bad` is rejected by `git branch` with "invalid branch name", which
    // throws partway through setup — after mkdtemp but before the handle is
    // returned. Guard ensures the directory doesn't survive the throw.
    expect(() => createTempRepo({ branches: ['..bad'] })).toThrow();

    // Asserting "no *new* entries appeared" rather than "snapshot unchanged"
    // is robust against bun's cross-file parallelism — sibling tests creating
    // or removing their own `handoff-temprepo-*` dirs during this window
    // shouldn't affect the verdict on whether *our* failed call leaked one.
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith('handoff-temprepo-'));
    const newEntries = after.filter((n) => !before.has(n));
    expect(newEntries).toEqual([]);
  });
});
