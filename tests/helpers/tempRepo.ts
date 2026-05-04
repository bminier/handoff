/**
 * Real-git temp repo fixture for tests that exercise `src/git.ts`.
 *
 * The contract under test in `git.ts` is git's actual behaviour — `git
 * worktree add`, `branch -D`, etc. — so a scripted-spawn fake would just
 * encode our wrapper's expectations and miss every real divergence. This
 * fixture instead spins up a throwaway repo in `os.tmpdir()` and runs the
 * real `git`. Cleanup removes the directory.
 *
 * Usage:
 *
 * ```ts
 * let repo: TempRepo;
 * beforeEach(() => { repo = createTempRepo({ branches: ['feature/x'] }); });
 * afterEach(() => repo.cleanup());
 * ```
 *
 * Compatibility: uses `git symbolic-ref HEAD` to set the initial branch so the
 * helper works on `git ≥ 2.20` (the documented minimum), pre-dating
 * `git init -b <name>` which arrived in 2.28.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempRepoOptions {
  /** Initial branch name. Defaults to `'dev'` to match this repo's convention. */
  initialBranch?: string;
  /** Additional branches to create off the initial commit. */
  branches?: readonly string[];
  /** Remotes to register. Map of remote name → URL. URL can be any string git accepts. */
  remotes?: Readonly<Record<string, string>>;
  /**
   * `mkdtemp` prefix under `os.tmpdir()`. Defaults to `'handoff-temprepo-'`.
   * Override when a test needs to scan `tmpdir()` for its own dirs without
   * picking up sibling tempRepo callers running in parallel.
   */
  tmpPrefix?: string;
}

export const DEFAULT_TMP_PREFIX = 'handoff-temprepo-';

export interface GitResult {
  stdout: string;
  stderr: string;
}

export interface TempRepo {
  /** Absolute path to the repo's working directory. */
  path: string;
  /** Run a git command inside the repo and return its stdout/stderr. Throws on non-zero exit. */
  git(args: readonly string[]): GitResult;
  /** Remove the repo from disk. Safe to call more than once. */
  cleanup(): void;
}

function runGit(cwd: string, args: readonly string[]): GitResult {
  // Pin a couple of envs so git can't block the test: GIT_TERMINAL_PROMPT=0
  // turns off credential/auth prompts (so a misconfigured remote can't hang),
  // and GIT_OPTIONAL_LOCKS=0 skips advisory locks that occasionally trip on
  // shared CI runners. Signing is disabled separately via `git config
  // commit.gpgsign false` after init.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
  const result = spawnSync('git', args as string[], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (result.error) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(
      `git ${args.join(' ')} failed in ${cwd} (exit ${result.status ?? 'null'}): ${detail}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

export function createTempRepo(opts: TempRepoOptions = {}): TempRepo {
  const initialBranch = opts.initialBranch ?? 'dev';
  const path = mkdtempSync(join(tmpdir(), opts.tmpPrefix ?? DEFAULT_TMP_PREFIX));
  let cleanedUp = false;

  // If any setup step throws (missing git, bad ref name, etc.) the caller
  // never gets a TempRepo handle, so afterEach's cleanup() won't fire and
  // the mkdtemp directory would leak. Catch, scrub, and rethrow.
  try {
    // git init, then point HEAD at the configured initial branch *before* any
    // commit. `git init -b <name>` is the modern shortcut but only landed in
    // 2.28; symbolic-ref works on every supported version.
    runGit(path, ['init', '--quiet']);
    runGit(path, ['symbolic-ref', 'HEAD', `refs/heads/${initialBranch}`]);

    // Point hooksPath at a directory we never create so a developer's global
    // `core.hooksPath` (or template-installed hooks) can't fire on the
    // bootstrap commit, hang the test, or leak side effects into the fixture.
    runGit(path, ['config', 'core.hooksPath', join(path, '.git', 'handoff-no-hooks')]);

    // Local config so `git commit` works on machines without global identity
    // and never tries to sign — signing prompts would hang the test.
    runGit(path, ['config', 'user.email', 'handoff-test@example.invalid']);
    runGit(path, ['config', 'user.name', 'Handoff Test']);
    runGit(path, ['config', 'commit.gpgsign', 'false']);
    runGit(path, ['config', 'tag.gpgsign', 'false']);

    // Empty initial commit so HEAD resolves and `git worktree add` has a base.
    runGit(path, ['commit', '--allow-empty', '-m', 'init', '--no-gpg-sign']);

    for (const branch of opts.branches ?? []) {
      runGit(path, ['branch', branch]);
    }
    for (const [name, url] of Object.entries(opts.remotes ?? {})) {
      runGit(path, ['remote', 'add', name, url]);
    }
  } catch (err) {
    cleanedUp = true;
    rmSync(path, { recursive: true, force: true });
    throw err;
  }

  return {
    path,
    git(args) {
      return runGit(path, args);
    },
    cleanup() {
      if (cleanedUp) return;
      // git.ts's createWorktree puts linked worktrees as *siblings* of the
      // repo root (see worktreePath in src/branch.ts), so rm'ing repo.path
      // alone would leak any worktree the test added. Route removal through
      // `git worktree remove --force` rather than raw rmSync of whatever
      // path git happens to report — a test that called `repo.git(['worktree',
      // 'add', '/some/important/dir', ...])` could otherwise turn this
      // helper into a recursive deleter for unrelated directories. Letting
      // git handle it constrains deletion to paths git itself registered
      // (and unregisters them from the repo's worktree list as a bonus).
      for (const linkedPath of listLinkedWorktrees(path)) {
        try {
          runGit(path, ['worktree', 'remove', '--force', linkedPath]);
        } catch {
          // Best-effort: worktree dir may already be gone, locked, or in
          // some partially-broken state. Don't throw out of cleanup.
        }
      }
      rmSync(path, { recursive: true, force: true });
      // Mark cleaned-up only after rmSync succeeds — if it throws (Windows
      // EBUSY/EPERM, antivirus holding a handle), a subsequent retry from
      // the same `repo.cleanup()` reference can still attempt the work
      // instead of becoming a silent no-op.
      cleanedUp = true;
    },
  };
}

function listLinkedWorktrees(repoPath: string): readonly string[] {
  // Best-effort — cleanup must never throw, so if the repo is in some half-
  // wedged state we just skip the sibling sweep and let rm of repo.path
  // handle whatever's left under the main worktree.
  let stdout: string;
  try {
    stdout = runGit(repoPath, ['worktree', 'list', '--porcelain']).stdout;
  } catch {
    return [];
  }
  const linked: string[] = [];
  let seenMain = false;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    // `git worktree list` always emits the main worktree first; skip it
    // rather than comparing paths (Windows backslashes vs git's forward
    // slashes, macOS /var vs /private/var would all need normalising).
    if (!seenMain) {
      seenMain = true;
      continue;
    }
    const wt = line.slice('worktree '.length).trim();
    if (wt) linked.push(wt);
  }
  return linked;
}
