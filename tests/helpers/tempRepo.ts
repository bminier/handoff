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
}

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
  // Pin a couple of envs so the repo behaves the same across developer
  // machines: don't pick up the user's commit-signing config, don't prompt.
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
  const path = mkdtempSync(join(tmpdir(), 'handoff-temprepo-'));
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
      cleanedUp = true;
      rmSync(path, { recursive: true, force: true });
    },
  };
}
