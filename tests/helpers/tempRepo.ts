/**
 * Real-git temp repo fixture for tests that exercise `src/git.ts`.
 *
 * The contract under test in `git.ts` is git's actual behaviour — `git
 * worktree add`, `branch -D`, etc. — so a scripted-spawn fake would just
 * encode our wrapper's expectations and miss every real divergence. This
 * fixture instead spins up a throwaway repo under a suite-owned root in
 * `os.tmpdir()` and runs the real `git`. Cleanup removes the directory.
 *
 * Path safety: every repo lives under a single per-process root (`SUITE_ROOT`
 * below). `cleanup()` will only `rmSync` paths whose realpath resolves
 * under that root, so a test that registers a stray worktree path —
 * accidentally or otherwise — cannot turn this helper into a recursive
 * deleter for a directory outside its own namespace.
 *
 * Usage:
 *
 * ```ts
 * let repo: TempRepo;
 * beforeEach(() => { repo = createTempRepo({ branches: ['feature/x'] }); });
 * afterEach(() => repo.cleanup());
 * ```
 *
 * If a test calls `process.chdir(repo.path)` to drive `git.ts` (which
 * shells out in `process.cwd()`), restore the original cwd in the same
 * `afterEach` *before* `repo.cleanup()`. On Windows, `rmSync` of a
 * directory the process is sitting inside will fail. See
 * `tests/README.md` for the full chdir + restore pattern.
 *
 * Compatibility: uses `git symbolic-ref HEAD` to set the initial branch so the
 * helper works on `git ≥ 2.20` (the documented minimum), pre-dating
 * `git init -b <name>` which arrived in 2.28.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

export interface TempRepoOptions {
  /** Initial branch name. Defaults to `'dev'` to match this repo's convention. */
  initialBranch?: string;
  /** Additional branches to create off the initial commit. */
  branches?: readonly string[];
  /** Remotes to register. Map of remote name → URL. URL can be any string git accepts. */
  remotes?: Readonly<Record<string, string>>;
  /**
   * `mkdtemp` prefix under the suite root. Defaults to `'handoff-temprepo-'`.
   * Override when a test needs to scan the suite root for its own dirs
   * without picking up sibling tempRepo callers in the same run.
   */
  tmpPrefix?: string;
}

export const DEFAULT_TMP_PREFIX = 'handoff-temprepo-';

// Suite-owned root: every tempRepo lives under this single mkdtemp'd
// directory, and `cleanup()` refuses to rmSync any path that doesn't
// resolve under it. The realpath anchor — not a basename predicate — is
// the safety boundary against "a test typo'd a worktree path and cleanup
// deleted an unrelated directory." Everything destructive in this file
// gates on `isInRepoNamespace()` below, which combines the SUITE_ROOT
// anchor with the per-repo `<repoPath>-<tail>` createWorktree contract.
//
// realpath both ends so macOS `/var` ↔ `/private/var` and Windows 8.3
// short names normalize. realpathSync.native goes through the OS's own
// realpath, which is the variant that resolves Windows short names
// reliably.
const SUITE_ROOT = realpathSync.native(mkdtempSync(join(tmpdir(), 'handoff-test-suite-')));

// Sweep at process exit. Under normal flow each test's `cleanup()` already
// removed its own repo, but if a `beforeEach` throws after `mkdtemp` and
// the local try/catch ever regresses, the orphan still lives under
// SUITE_ROOT — which the exit handler will tear down.
process.on('exit', () => {
  try {
    rmSync(SUITE_ROOT, { recursive: true, force: true });
  } catch {
    /* exit-time cleanup is best-effort */
  }
});

function isInRepoNamespace(candidate: string, repoPath: string): boolean {
  let resolved: string;
  try {
    resolved = realpathSync.native(candidate);
  } catch {
    // Path doesn't exist (already removed) or unreadable. Don't fall back
    // to a raw `startsWith` — without realpath we can't tell `/var/...`
    // apart from `/private/var/...` on macOS, and a permissive fallback
    // would defeat the boundary. Caller treats `false` as "leave it
    // alone," which is the safe choice.
    return false;
  }
  // Two boundaries, both required:
  //   1. Outer: must be under SUITE_ROOT. Defense in depth — if (2)
  //      regresses, the realpath gate still blocks deletes outside the
  //      per-process root.
  //   2. Inner: must match `createWorktree`'s contract — a sibling at
  //      `<repoPath>-<tail>` (see `src/branch.ts:worktreePath`). Without
  //      this, a sibling test's repo or any unrelated dir under
  //      SUITE_ROOT would be a delete candidate just by being in the
  //      same process. The fixture only owns paths that match the
  //      production worktreePath contract.
  if (!resolved.startsWith(SUITE_ROOT + sep)) return false;
  return resolved.startsWith(`${repoPath}-`);
}

/**
 * @internal Test-only accessor for the suite root. Tests that need to
 * scan the root directly (e.g. leak-check) read it through this.
 * Production code has no business knowing the path.
 */
export function __getSuiteRootForTesting(): string {
  return SUITE_ROOT;
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
  // Scrub repo-selection env vars so a developer who has e.g. `GIT_DIR`
  // exported in their shell doesn't have this fixture silently start
  // operating on (and potentially deleting branches/worktrees in) their
  // real repo. cwd plus an empty repo-selection environment leaves git no
  // ambiguity about which repo it's working with.
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  delete env.GIT_CEILING_DIRECTORIES;
  delete env.GIT_DISCOVERY_ACROSS_FILESYSTEM;
  delete env.GIT_NAMESPACE;
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
  const tmpPrefix = opts.tmpPrefix ?? DEFAULT_TMP_PREFIX;
  // Strict allowlist: alphanumerics, underscore, hyphen. The namespace
  // gate (`isInRepoNamespace`) is the load-bearing guarantee against
  // out-of-namespace deletions, but rejecting weird prefixes here also
  // fails fast — separators (`'a/b-'`), trailing separators
  // (`'nested/'`), and dot segments (`'.'`, `'..'`) are all rejected
  // before mkdtemp gets a chance to land somewhere surprising under
  // SUITE_ROOT.
  if (!/^[A-Za-z0-9_-]+$/.test(tmpPrefix)) {
    throw new Error(
      `tmpPrefix must match /^[A-Za-z0-9_-]+$/ to stay safely inside the suite root; got: ${JSON.stringify(tmpPrefix)}`,
    );
  }
  // Canonicalise: mkdtemp returns the platform-native form (case, short
  // names on Windows, /var↔/private/var on macOS). `git worktree list`
  // emits its own canonicalisation, and the namespace check below
  // realpaths each candidate before comparison — so the *base* it
  // compares against (this `path`) has to be canonical too.
  const path = realpathSync.native(mkdtempSync(join(SUITE_ROOT, tmpPrefix)));
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
    // Best-effort scrub: don't let an rmSync failure (Windows EBUSY/EPERM,
    // antivirus holding a handle) overwrite the underlying setup error
    // the caller actually needs to diagnose. SUITE_ROOT's exit-time sweep
    // is the backstop for any orphan that survives this attempt.
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* swallow — surface the original setup failure below */
    }
    throw err;
  }

  return {
    path,
    git(args) {
      return runGit(path, args);
    },
    cleanup() {
      if (cleanedUp) return;
      // git.ts's createWorktree puts linked worktrees at
      // `<repo.path>-<branch-tail>` (see worktreePath in src/branch.ts),
      // so rm'ing repo.path alone would leak any worktree the test added.
      // We sweep them via `git worktree list --porcelain`, but every
      // candidate is gated through `isInRepoNamespace`: realpath under
      // SUITE_ROOT *and* matching the `<repo.path>-<tail>` createWorktree
      // pattern. `git worktree list` is untrusted input — a test can
      // register an arbitrary absolute path, or even another fixture's
      // path running in the same process — and only paths that match
      // the production contract are this fixture's to delete.
      //
      // Earlier iterations routed this through `git worktree remove
      // --force`, but git's removal can fail (locked file, dir already
      // gone) and orphaned the worktree once we proceeded to rm the main
      // repo. Direct rmSync is more reliable (`force: true` no-ops on
      // missing) and the namespace gate gives us the path-safety
      // guarantee a basename predicate could not.
      for (const linkedPath of listLinkedWorktrees(path)) {
        if (isInRepoNamespace(linkedPath, path)) {
          rmSync(linkedPath, { recursive: true, force: true });
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
