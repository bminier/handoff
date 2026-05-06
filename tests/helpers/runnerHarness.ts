/**
 * Runner-script integration harness.
 *
 * Sets up everything `scripts/handoff-runner.sh` and
 * `scripts/handoff-runner.ps1` need to run end-to-end in a test:
 *
 *   - A real `tempRepo` with a real linked worktree (cleanup must touch
 *     real git or it isn't testing the runner).
 *   - A `PROMPT.md` at the worktree root (the runner refuses to start
 *     without one).
 *   - A temp bin directory with platform-correct `claude` and `gh`
 *     shims, prepended to PATH so the runner's `"$TOOL" ...` and the
 *     CLI's internal `gh pr list` resolve to fakes.
 *   - A redirected HOME / USERPROFILE so the bun-cli subprocess
 *     spawned by the runner can't touch the developer's `~/.handoff/`.
 *
 * Production callers don't use this — only the runner-script tests.
 */

import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { worktreePath } from '../../src/branch.ts';
import { createTempRepo, type TempRepo } from './tempRepo.ts';

export interface RunnerHarnessOptions {
  /**
   * Which runner script to test. Determines both the script path and
   * the shim style: `'bash'` uses unix-shebang shims (Git Bash on
   * Windows reads them via the shebang too), `'pwsh'` uses `.cmd` shims
   * because PowerShell resolves binaries through PATHEXT.
   */
  target: 'bash' | 'pwsh';
  /**
   * Branch to hand off and clean up. Convention: `<tool>/issue-<N>`,
   * matching what `branchName()` would produce.
   */
  branch: string;
  /** Default branch the worktree is created off of. Matches tempRepo's `dev` default. */
  base?: string;
  /**
   * Body of `PROMPT.md` — the runner doesn't parse it, just `cat`s and
   * passes it to the tool. Default is a one-line stub.
   */
  promptBody?: string;
  /**
   * Whether the worktree should actually exist on disk + be registered
   * with git. Default: `true`. Set `false` to test the "PROMPT.md not
   * found" early-exit branch.
   */
  createWorktree?: boolean;
}

export interface RunnerHarness {
  repo: TempRepo;
  /** Absolute path to the linked worktree (or the bare dir, depending on opts). */
  worktreePath: string;
  /** Branch the runner will be invoked for. */
  branch: string;
  /** Absolute path to the directory holding the platform-specific tool/gh shims. */
  fakeBinDir: string;
  /** Path to the runner script that matches the host platform. */
  runnerScript: string;
  /** Absolute path to the handoff repo root (passed as the runner's first arg). */
  handoffRepoRoot: string;
  /**
   * Env to pass to the spawned runner. Already includes:
   *  - `PATH` with `fakeBinDir` prepended (so the shims win)
   *  - `HOME` / `USERPROFILE` redirected to a temp dir
   *  - any extra entries the test passes via `extraEnv`
   * Tests typically tweak `FAKE_TOOL_EXIT` / `FAKE_GH_PR_LIST_RESPONSE`
   * here per case.
   */
  env: NodeJS.ProcessEnv;
  /**
   * Tear down everything this harness allocated. Safe to call multiple
   * times; safe to call even after partial setup (each step is gated
   * on what was actually created).
   */
  cleanup(): void;
}

// fileURLToPath handles the leading-slash quirk that
// `new URL(...).pathname` introduces for Windows file URLs (`/C:/...`).
const HANDOFF_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function createRunnerHarness(opts: RunnerHarnessOptions): RunnerHarness {
  const base = opts.base ?? 'dev';
  const promptBody = opts.promptBody ?? '# Handoff stub prompt\n';
  const createWorktree = opts.createWorktree ?? true;

  // Real tempRepo (under SUITE_ROOT, hermetic, exit-time swept) so the
  // runner exercises real git via the bun-cli subprocess.
  const repo = createTempRepo({
    remotes: { origin: 'https://example.invalid/test/repo.git' },
  });

  // Use the production worktreePath contract so cleanup paths line up
  // exactly with what the CLI computes when invoked for the same branch.
  const wt = worktreePath({ repoRoot: repo.path, branch: opts.branch });

  // tempRepo.cleanup() sweeps `<repo.path>-*` siblings under SUITE_ROOT,
  // but not the temp HOME or fakeBin dirs — those need their own cleanup
  // tracking so a test that throws mid-setup still releases them.
  const homeDir = mkdtempSync(join(tmpdir(), 'handoff-runner-home-'));
  const fakeBinDir = mkdtempSync(join(tmpdir(), 'handoff-runner-bin-'));

  let cleanedUp = false;
  const harness: RunnerHarness = {
    repo,
    worktreePath: wt,
    branch: opts.branch,
    fakeBinDir,
    runnerScript: join(
      HANDOFF_REPO_ROOT,
      'scripts',
      opts.target === 'pwsh' ? 'handoff-runner.ps1' : 'handoff-runner.sh',
    ),
    handoffRepoRoot: HANDOFF_REPO_ROOT,
    env: {},
    cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      // Each step independent — a failure in one shouldn't block the
      // others. The exit-time SUITE_ROOT sweep is the backstop for
      // tempRepo state if repo.cleanup throws.
      const safe = (fn: () => void) => {
        try {
          fn();
        } catch {
          /* best-effort */
        }
      };
      safe(() => rmSync(fakeBinDir, { recursive: true, force: true }));
      safe(() => rmSync(homeDir, { recursive: true, force: true }));
      safe(() => repo.cleanup());
    },
  };

  try {
    if (createWorktree) {
      // -b creates the branch; the runner's cleanup is what later removes
      // both worktree and branch. Use repo.git so we're operating in the
      // main worktree (cwd doesn't get pinned by the test).
      repo.git(['worktree', 'add', '-b', opts.branch, wt, base]);
      writeFileSync(join(wt, 'PROMPT.md'), promptBody, 'utf8');
    }
    // When createWorktree is false the test is responsible for whatever
    // state it wants at `wt` (e.g. mkdir'ing an empty directory to
    // exercise the "PROMPT.md not found" branch).

    writeFakeShims({ fakeBinDir, target: opts.target });

    // On Windows, environment variables are case-insensitive in the OS
    // but spread of `process.env` produces a plain object with whatever
    // case the original key happened to have. If the original env has
    // `Path` (mixed case, common on Windows) and we overwrite `PATH`
    // (uppercase), the spawned subprocess sees *both* keys and Windows
    // picks one — usually not ours. Strip every casing variant first,
    // then set the canonical `PATH`. Same hazard for any other env var
    // we override.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      const lower = key.toLowerCase();
      if (lower === 'path' || lower === 'home' || lower === 'userprofile') {
        delete env[key];
      }
    }
    env.PATH = `${fakeBinDir}${delimiter}${process.env.PATH ?? ''}`;
    env.HOME = homeDir;
    env.USERPROFILE = homeDir;
    // Default both fake responses to the merged-PR happy path; tests
    // override per-case before spawning. Empty string (instead of
    // unset) so the shims don't hit a "variable not set" branch.
    env.FAKE_TOOL_EXIT = '0';
    env.FAKE_GH_PR_LIST_RESPONSE = JSON.stringify([{ number: 1 }]);
    harness.env = env;

    return harness;
  } catch (err) {
    harness.cleanup();
    throw err;
  }
}

function writeFakeShims(opts: { fakeBinDir: string; target: 'bash' | 'pwsh' }): void {
  const isWin = process.platform === 'win32';
  // The fake-shim pattern: a thin platform-native wrapper that delegates
  // to bun running a TS file. Two reasons:
  //   1. The TS impl is one source of truth for shim behaviour, regardless
  //      of which interpreter spawns it (bash → bash shim → bun, cmd →
  //      cmd shim → bun).
  //   2. Behaviour is configured by env vars the test sets, so we don't
  //      have to write a new shim per test case.
  const fakeGhImpl = join(opts.fakeBinDir, 'fake-gh-impl.ts');
  const fakeToolImpl = join(opts.fakeBinDir, 'fake-tool-impl.ts');

  writeFileSync(
    fakeGhImpl,
    [
      `// Fake gh: handles \`gh pr list --head <branch> --state merged --json number --limit 1\`.`,
      `// FAKE_GH_FAIL=1 forces a non-zero exit with a canned stderr — drives`,
      `// cleanup's status:'unknown' path without needing a network failure.`,
      `// Any other gh subcommand exits non-zero so a wrong call is loud.`,
      `const argv = process.argv.slice(2);`,
      `if (process.env.FAKE_GH_FAIL === '1') {`,
      `  process.stderr.write('fake-gh: forced failure (FAKE_GH_FAIL=1)\\n');`,
      `  process.exit(2);`,
      `}`,
      `if (argv[0] === 'pr' && argv[1] === 'list') {`,
      `  process.stdout.write(process.env.FAKE_GH_PR_LIST_RESPONSE ?? '[]');`,
      `  process.exit(0);`,
      `}`,
      `process.stderr.write('fake-gh: unexpected argv: ' + argv.join(' ') + '\\n');`,
      `process.exit(2);`,
      ``,
    ].join('\n'),
    'utf8',
  );

  writeFileSync(
    fakeToolImpl,
    [
      `// Fake tool (claude/codex/copilot): exits with FAKE_TOOL_EXIT.`,
      `// Argv is ignored — the runner passes PROMPT.md content as one`,
      `// arg, but tests don't care about the prompt body.`,
      `const code = Number(process.env.FAKE_TOOL_EXIT ?? '0');`,
      `process.exit(Number.isFinite(code) ? code : 0);`,
      ``,
    ].join('\n'),
    'utf8',
  );

  // Both shim styles are written every time. Two consumers, two lookup
  // strategies, both have to be satisfied:
  //
  //   - Git Bash on Windows does *not* walk PATHEXT — it tries the
  //     literal name only — so it needs the no-extension shebang shim
  //     to find `claude`/`gh`. Without it, bash falls through to the
  //     user's real claude.exe/gh.exe (whatever PATH offers) and the
  //     test isn't actually testing the runner against a fake.
  //   - The bun-cli subprocess that the runner spawns is a Win32
  //     process whose `spawn(...)` walks PATHEXT — so on Windows it
  //     resolves `gh` to `gh.cmd`. The .cmd shim is what serves bun's
  //     gh lookups during cleanup.
  //
  // Both files coexist with different filenames; bash picks the
  // shebang one, bun picks the .cmd one. On Unix the .cmd is just
  // dead weight (PATHEXT isn't a thing) but harmless.
  writeFileSync(
    join(opts.fakeBinDir, 'gh'),
    `#!/usr/bin/env bash\nexec bun "${fakeGhImpl}" "$@"\n`,
    'utf8',
  );
  writeFileSync(
    join(opts.fakeBinDir, 'claude'),
    `#!/usr/bin/env bash\nexec bun "${fakeToolImpl}" "$@"\n`,
    'utf8',
  );
  if (isWin) {
    writeFileSync(
      join(opts.fakeBinDir, 'gh.cmd'),
      `@echo off\r\nbun "${fakeGhImpl}" %*\r\n`,
      'utf8',
    );
    writeFileSync(
      join(opts.fakeBinDir, 'claude.cmd'),
      `@echo off\r\nbun "${fakeToolImpl}" %*\r\n`,
      'utf8',
    );
  }
  chmodSync(join(opts.fakeBinDir, 'gh'), 0o755);
  chmodSync(join(opts.fakeBinDir, 'claude'), 0o755);
}

/**
 * Try to locate a usable interpreter. Returns the absolute path or
 * `undefined` if none was found. Tests skip when undefined so a CI
 * runner missing bash (very rare) or pwsh (linux/mac default) doesn't
 * fail the suite.
 *
 * On Windows, prefer Git Bash explicitly over `Bun.which('bash')`.
 * The GH Actions windows-latest image has *both* Git Bash and WSL
 * bash on PATH; PATH ordering can land on WSL bash, which lives in
 * its own filesystem world (`/mnt/c/...`), can't execute `.cmd`
 * shims, and converts PATH inheritance in ways that drop the
 * Windows-style fakeBinDir we prepend. Git Bash (MSYS2) handles all
 * of that natively. Production callers don't go through this — only
 * the runner-script tests.
 */
export function findInterpreter(name: 'bash' | 'pwsh'): string | undefined {
  if (name === 'bash' && process.platform === 'win32') {
    const gitBashCandidates = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ];
    for (const candidate of gitBashCandidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  // Bun.which respects PATH and PATHEXT correctly on Windows.
  const found = Bun.which(name);
  if (found && existsSync(found)) return found;
  return undefined;
}
