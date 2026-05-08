import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { cliMain } from '../src/cli.ts';
import { __setTerminalSpawnForTesting } from '../src/terminal.ts';
import { createScriptedSpawn, type ScriptedSpawn } from './helpers/scriptedSpawn.ts';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.ts';

interface TerminalCall {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
}

// Every cleanup-relevant handle is nullable so a partial `beforeEach`
// failure (e.g. `mkdtemp` permission error before `createTempRepo` runs)
// still leaves `afterEach` with a coherent picture of what to undo.
let repo: TempRepo | undefined;
let originalCwd: string | undefined;
let homeDir: string | undefined;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let envSaved = false;
let spawn: ScriptedSpawn | undefined;
let terminalCalls: TerminalCall[];
let restoreTerminal: (() => void) | undefined;

const REPO_VIEW_ARGV = ['repo', 'view', '--json', 'defaultBranchRef'];
const ISSUE_VIEW_FIELDS = 'number,title,body,labels,url';

beforeEach(() => {
  // Reset everything up front so a partial `beforeEach` failure leaves
  // `afterEach` with the same baseline a fresh test would see (the watch
  // runner reuses module state across reruns).
  repo = undefined;
  originalCwd = undefined;
  homeDir = undefined;
  savedHome = undefined;
  savedUserProfile = undefined;
  envSaved = false;
  spawn = undefined;
  terminalCalls = [];
  restoreTerminal = undefined;

  // Capture cwd first so even an early `createTempRepo` throw still has
  // a value to chdir back to in afterEach.
  originalCwd = process.cwd();

  // Real git, real worktree — but anchored under tempRepo's SUITE_ROOT so
  // teardown is hermetic. The CLI's `gh repo view --json defaultBranchRef`
  // is faked, so the bogus origin URL never gets dialed; remotes still
  // need to be set so the repo *looks* configured (some git versions warn
  // otherwise on `worktree add`).
  repo = createTempRepo({
    remotes: { origin: 'https://example.invalid/test/repo.git' },
  });

  // Redirect HOME / USERPROFILE so showFirstRunBanner and the telemetry
  // emit don't read or write the developer's real ~/.handoff/. Without
  // this, the suite would (a) create or mutate the user's config, and (b)
  // pick up state from prior runs, making test order matter. Save *both*
  // env vars before flipping either, then mark `envSaved` so afterEach
  // knows whether the saved values are meaningful.
  homeDir = mkdtempSync(join(tmpdir(), 'handoff-cli-int-home-'));
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  envSaved = true;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  // Hybrid harness: gh is faked, git is passed through to the real spawn
  // so it operates on the tempRepo. The recorded `calls` include both,
  // which keeps assertions grounded in what actually happened.
  spawn = createScriptedSpawn({ passthrough: (cmd) => cmd === 'git' });
  spawn.install();

  // Capture terminal launches in-process. The CLI calls `openTerminal`
  // which would otherwise spawn a real wt/cmd/gnome-terminal/Terminal.app
  // window — disastrous in a test runner.
  restoreTerminal = __setTerminalSpawnForTesting(() => (command, args, options) => {
    terminalCalls.push({ command, args: [...args], options });
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => {};
    return child as unknown as ChildProcess;
  });

  process.chdir(repo.path);
});

afterEach(() => {
  // Run every teardown step independently and capture errors. Without
  // this, a throwing `spawn.uninstall()` (unmatched calls / leftover
  // expectations) would leak env vars and temp dirs into the next test
  // — devastating under `bun test --watch`. Re-throw the first captured
  // error at the end so the failure still surfaces.
  const errors: unknown[] = [];
  const safe = (label: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      errors.push(new Error(`afterEach: ${label} failed: ${(e as Error).message ?? e}`));
    }
  };

  // cwd restore first — Windows rmSync fails on a directory the process
  // is sitting inside, so this needs to land before any temp-dir cleanup.
  if (originalCwd !== undefined) safe('chdir(originalCwd)', () => process.chdir(originalCwd!));

  if (restoreTerminal) safe('restoreTerminal()', () => restoreTerminal!());
  if (spawn) safe('spawn.uninstall()', () => spawn!.uninstall());

  // Env restoration runs unconditionally when the save was completed —
  // these are simple property writes that can't really fail, but being
  // strict about ordering (don't restore if we didn't save) keeps the
  // partial-setup case correct.
  if (envSaved) {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  }

  if (homeDir) safe('rmSync(homeDir)', () => rmSync(homeDir!, { recursive: true, force: true }));
  if (repo) safe('repo.cleanup()', () => repo!.cleanup());

  if (errors.length > 0) throw errors[0];
});

/**
 * Unwrap the nullable fixture handles after `beforeEach`. If either is
 * still undefined, the setup didn't complete — fail the test fast rather
 * than letting a `repo!` blow up halfway through with a less-readable
 * error.
 */
function fixtures(): { repo: TempRepo; spawn: ScriptedSpawn } {
  if (!repo || !spawn) {
    throw new Error('cli.integration: beforeEach did not complete; fixtures are unset');
  }
  return { repo, spawn };
}

function expectedWorktreePath(branchTail: string): string {
  const { repo } = fixtures();
  return join(dirname(repo.path), `${basename(repo.path)}-${branchTail}`);
}

describe('cli integration — happy path', () => {
  it('handoff claude #7: creates worktree + branch, writes PROMPT.md, launches terminal', async () => {
    const { repo, spawn } = fixtures();
    spawn.expectGh(REPO_VIEW_ARGV, { defaultBranchRef: { name: 'dev' } });
    spawn.expectGh(['issue', 'view', '7', '--json', ISSUE_VIEW_FIELDS], {
      number: 7,
      title: 'Loop mode',
      body: 'Issue body content.',
      url: 'https://example.test/issues/7',
      labels: [{ name: 'feature' }],
    });

    const exitCode = await cliMain(['claude', '#7']);
    expect(exitCode).toBe(0);

    const wt = expectedWorktreePath('issue-7');
    expect(existsSync(wt)).toBe(true);

    // Branch exists in the main repo and points at the same commit as dev
    // (worktree add -b creates it off the base ref). show-ref --quiet
    // exits non-zero when the ref is missing — runGit throws on that, so
    // a missing branch would error here rather than producing a misleading
    // "ok" result.
    repo.git(['show-ref', '--verify', '--quiet', 'refs/heads/claude/issue-7']);

    // PROMPT.md interpolations: branch, issue header, body, label.
    const prompt = readFileSync(join(wt, 'PROMPT.md'), 'utf8');
    expect(prompt).toContain('**Branch:** `claude/issue-7`');
    expect(prompt).toContain('**Parent branch:** `dev`');
    expect(prompt).toContain('## Issue #7: Loop mode');
    expect(prompt).toContain('Issue body content.');
    expect(prompt).toContain('`feature`');

    // .handoff/state.json was written so cleanup can later report the
    // tool/ref it was launched with.
    expect(existsSync(join(wt, '.handoff', 'state.json'))).toBe(true);
    const state = JSON.parse(readFileSync(join(wt, '.handoff', 'state.json'), 'utf8'));
    expect(state.tool).toBe('claude');
    expect(state.branch).toBe('claude/issue-7');
    expect(state.ref).toEqual({ type: 'issue', number: 7 });

    // Exactly one terminal launch. The argv shape is OS-dependent (wt on
    // win32, gnome-terminal/etc. on linux, osascript on darwin), but in
    // every case the runner script + tool + branch are part of it — so
    // pin those rather than the platform-specific launcher.
    expect(terminalCalls).toHaveLength(1);
    const launchArgv = terminalCalls[0]?.args.join(' ') ?? '';
    expect(launchArgv).toMatch(/handoff-runner\.(sh|ps1)/);
    expect(launchArgv).toContain('claude');
    expect(launchArgv).toContain('claude/issue-7');
    // The cwd appears in the launch argv (e.g. `wt -d <cwd>`,
    // `gnome-terminal --working-directory <cwd>`, AppleScript `cd <cwd>`),
    // not in spawn options. Pin that the worktree path is in there
    // somewhere.
    expect(launchArgv).toContain(wt);
  });
});

describe('cli integration — fleet mode', () => {
  it('handoff claude #7 #8: creates two worktrees and two terminal launches', async () => {
    const { spawn } = fixtures();
    // defaultBranch is fetched once per invocation, then per-issue fetches
    // happen in order. Each gh expectation consumes FIFO — register all
    // three before running.
    spawn.expectGh(REPO_VIEW_ARGV, { defaultBranchRef: { name: 'dev' } });
    spawn.expectGh(['issue', 'view', '7', '--json', ISSUE_VIEW_FIELDS], {
      number: 7,
      title: 'A',
      body: 'a',
      url: 'https://example.test/7',
      labels: [],
    });
    spawn.expectGh(['issue', 'view', '8', '--json', ISSUE_VIEW_FIELDS], {
      number: 8,
      title: 'B',
      body: 'b',
      url: 'https://example.test/8',
      labels: [],
    });

    const exitCode = await cliMain(['claude', '#7', '#8']);
    expect(exitCode).toBe(0);

    const wt7 = expectedWorktreePath('issue-7');
    const wt8 = expectedWorktreePath('issue-8');
    expect(existsSync(wt7)).toBe(true);
    expect(existsSync(wt8)).toBe(true);

    // One terminal launch per ref — fleet mode is "parallel but
    // independent" (CLAUDE.md), not a single multiplexed session.
    expect(terminalCalls).toHaveLength(2);
    const allArgs = terminalCalls.map((c) => c.args.join(' ')).join('\n');
    expect(allArgs).toContain('claude/issue-7');
    expect(allArgs).toContain('claude/issue-8');
  });
});

describe('cli integration — error exit codes', () => {
  it('propagates GhError exitCode 2 from a single-ref runHandoffs failure', async () => {
    // Regression for the "runHandoffs hard-codes exit 1" Copilot review
    // comment: a non-auth gh failure raises GhError(exitCode=2). Before the
    // fix, the per-ref catch collapsed every failure to 1; now it reports
    // the documented operational-error code.
    const { spawn } = fixtures();
    spawn.expectGh(REPO_VIEW_ARGV, { defaultBranchRef: { name: 'dev' } });
    spawn.expect({
      command: 'gh',
      argv: ['issue', 'view', '7', '--json', ISSUE_VIEW_FIELDS],
      response: { exitCode: 1, stderr: 'GraphQL: Could not resolve to an Issue (issue #7)' },
    });

    const exitCode = await cliMain(['claude', '#7']);
    expect(exitCode).toBe(2);
  });

  it('reports the worst exit code across multi-ref failures', async () => {
    // Two refs, both fail. First with auth error (exitCode 1), second with
    // non-auth (exitCode 2). The worst (highest) wins.
    const { spawn } = fixtures();
    spawn.expectGh(REPO_VIEW_ARGV, { defaultBranchRef: { name: 'dev' } });
    spawn.expect({
      command: 'gh',
      argv: ['issue', 'view', '7', '--json', ISSUE_VIEW_FIELDS],
      response: { exitCode: 4, stderr: 'authentication required' },
    });
    spawn.expect({
      command: 'gh',
      argv: ['issue', 'view', '8', '--json', ISSUE_VIEW_FIELDS],
      response: { exitCode: 1, stderr: 'unknown server error' },
    });

    const exitCode = await cliMain(['claude', '#7', '#8']);
    expect(exitCode).toBe(2);
  });
});

describe('cli integration — global flag routing', () => {
  it('--verbose --help prints help and exits 0', async () => {
    const exitCode = await cliMain(['--verbose', '--help']);
    expect(exitCode).toBe(0);
  });

  it('--debug -h prints help and exits 0', async () => {
    const exitCode = await cliMain(['--debug', '-h']);
    expect(exitCode).toBe(0);
  });

  it('--verbose --version prints version and exits 0', async () => {
    const exitCode = await cliMain(['--verbose', '--version']);
    expect(exitCode).toBe(0);
  });
});

describe('cli integration — cleanup', () => {
  it('handoff cleanup <branch> removes the worktree and branch when the PR is merged', async () => {
    const { repo, spawn } = fixtures();
    // Pre-create the worktree as if a previous handoff had run. We can't
    // ride the same flow as the happy-path test because cliMain returns
    // before the worktree is "released" (the runner script normally calls
    // cleanup after the user-driven tool exits).
    const branch = 'claude/issue-9';
    const wt = expectedWorktreePath('issue-9');
    repo.git(['worktree', 'add', '-b', branch, wt, 'dev']);
    expect(existsSync(wt)).toBe(true);

    spawn.expectGh(
      ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number', '--limit', '1'],
      [{ number: 9 }],
    );

    const exitCode = await cliMain(['cleanup', branch]);
    expect(exitCode).toBe(0);

    expect(existsSync(wt)).toBe(false);
    // Branch is gone — show-ref --verify exits non-zero, runGit throws.
    expect(() => repo.git(['show-ref', '--verify', `refs/heads/${branch}`])).toThrow();
  });

  it('returns operational-error exit code 2 when cleanup status is unknown', async () => {
    // Regression: runCleanup used to map status='unknown' (operational
    // failure — gh/git step failed) to exit 1, conflicting with the
    // documented exit-code categories. It should now be 2.
    const { repo, spawn } = fixtures();
    const branch = 'claude/issue-99';
    const wt = expectedWorktreePath('issue-99');
    repo.git(['worktree', 'add', '-b', branch, wt, 'dev']);

    // Force `gh pr list` to fail — cleanup.ts maps that to status='unknown'.
    spawn.expect({
      command: 'gh',
      argv: [
        'pr',
        'list',
        '--head',
        branch,
        '--state',
        'merged',
        '--json',
        'number',
        '--limit',
        '1',
      ],
      response: { exitCode: 1, stderr: 'API rate limit exceeded' },
    });

    const exitCode = await cliMain(['cleanup', branch]);
    expect(exitCode).toBe(2);
  });
});
