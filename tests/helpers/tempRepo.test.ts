import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { branchExists } from '../../src/git.ts';
import { __getSuiteRootForTesting, createTempRepo, type TempRepo } from './tempRepo.ts';

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

  it('honours an initialBranch override', () => {
    // Documented contract — without this test, a regression in the
    // `symbolic-ref HEAD refs/heads/<name>` setup would only surface when a
    // future test happened to ask for a non-default branch.
    const custom = createTempRepo({
      tmpPrefix: 'handoff-temprepo-initbr-',
      initialBranch: 'trunk',
    });
    try {
      expect(custom.git(['symbolic-ref', '--short', 'HEAD']).stdout.trim()).toBe('trunk');
    } finally {
      custom.cleanup();
    }
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

  it('cleanup does not rm worktree paths outside the repo namespace', () => {
    // A test that registered a worktree at an arbitrary path (rogue or
    // typo'd absolute path) must not have its target deleted by cleanup.
    // Stand up an unrelated temp dir, register it as a worktree on the
    // fixture, and assert cleanup leaves it intact.
    const outsider = mkdtempSync(join(tmpdir(), 'handoff-temprepo-outsider-'));
    try {
      repo.git(['worktree', 'add', outsider, 'feature/x']);
      expect(existsSync(outsider)).toBe(true);

      repo.cleanup();

      expect(existsSync(repo.path)).toBe(false);
      expect(existsSync(outsider)).toBe(true);
    } finally {
      rmSync(outsider, { recursive: true, force: true });
    }
  });

  it('rejects a tmpPrefix that would escape the suite root', () => {
    // Four escape modes the guard must catch (each broke a previous
    // iteration of this check):
    //   - separators: would land the fixture in a sub-tree of the root
    //   - trailing separator (`'nested/'`): a dirname-equals-root check
    //     passes here because dirname strips the trailing separator, but
    //     mkdtemp still creates the fixture under `<root>/nested/`
    //   - '.': collapses to the root, so mkdtemp creates `<root>XXXXXX`
    //     (a sibling of the root, not a child)
    //   - '..': escapes to the root's parent
    // The suite-root realpath gate would already refuse to rmSync any of
    // these, but failing fast at creation gives a clearer error than
    // letting a confusingly-named directory get created and orphaned.
    expect(() => createTempRepo({ tmpPrefix: '../foo-' })).toThrow(/A-Za-z0-9/);
    expect(() => createTempRepo({ tmpPrefix: 'a/b-' })).toThrow(/A-Za-z0-9/);
    expect(() => createTempRepo({ tmpPrefix: 'nested/' })).toThrow(/A-Za-z0-9/);
    expect(() => createTempRepo({ tmpPrefix: '.' })).toThrow(/A-Za-z0-9/);
    expect(() => createTempRepo({ tmpPrefix: '..' })).toThrow(/A-Za-z0-9/);
  });

  it('does not leak a temp dir if setup fails', () => {
    // Scope the leak check to the suite root, not os.tmpdir(): every
    // `createTempRepo` mkdtemps under the root, so a setup that throws
    // can only orphan a directory there. A dedicated prefix then isolates
    // this assertion from sibling tempRepo callers in the same run.
    const prefix = 'handoff-temprepo-leakcheck-';
    const root = __getSuiteRootForTesting();
    const before = new Set(readdirSync(root).filter((n) => n.startsWith(prefix)));

    // `..bad` is rejected by `git branch` with "invalid branch name", which
    // throws partway through setup — after mkdtemp but before the handle is
    // returned. Guard ensures the directory doesn't survive the throw.
    expect(() => createTempRepo({ tmpPrefix: prefix, branches: ['..bad'] })).toThrow();

    const after = readdirSync(root).filter((n) => n.startsWith(prefix));
    const newEntries = after.filter((n) => !before.has(n));
    expect(newEntries).toEqual([]);
  });
});
