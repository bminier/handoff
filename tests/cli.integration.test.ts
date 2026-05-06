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

let repo: TempRepo;
let originalCwd: string;
let homeDir: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let spawn: ScriptedSpawn;
let terminalCalls: TerminalCall[];
let restoreTerminal: () => void;

const REPO_VIEW_ARGV = ['repo', 'view', '--json', 'defaultBranchRef'];
const ISSUE_VIEW_FIELDS = 'number,title,body,labels,url';

beforeEach(() => {
  // Real git, real worktree — but anchored under tempRepo's SUITE_ROOT so
  // teardown is hermetic. The CLI's `gh repo view --json defaultBranchRef`
  // is faked, so the bogus origin URL never gets dialed; remotes still
  // need to be set so the repo *looks* configured (some git versions warn
  // otherwise on `worktree add`).
  repo = createTempRepo({
    remotes: { origin: 'https://example.invalid/test/repo.git' },
  });
  originalCwd = process.cwd();

  // Redirect HOME / USERPROFILE so showFirstRunBanner and the telemetry
  // emit don't read or write the developer's real ~/.handoff/. Without
  // this, the suite would (a) create or mutate the user's config, and (b)
  // pick up state from prior runs, making test order matter.
  homeDir = mkdtempSync(join(tmpdir(), 'handoff-cli-int-home-'));
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
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
  terminalCalls = [];
  restoreTerminal = __setTerminalSpawnForTesting(() => (command, args, options) => {
    terminalCalls.push({ command, args: [...args], options });
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => {};
    return child as unknown as ChildProcess;
  });

  process.chdir(repo.path);
});

afterEach(() => {
  // Restore cwd *before* teardown so the temp dirs aren't pinned by the
  // process — Windows rmSync fails on a directory the process is in.
  process.chdir(originalCwd);
  restoreTerminal();
  spawn.uninstall();

  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;

  rmSync(homeDir, { recursive: true, force: true });
  repo.cleanup();
});

function expectedWorktreePath(branchTail: string): string {
  return join(dirname(repo.path), `${basename(repo.path)}-${branchTail}`);
}

describe('cli integration — happy path', () => {
  it('handoff claude #7: creates worktree + branch, writes PROMPT.md, launches terminal', async () => {
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

describe('cli integration — cleanup', () => {
  it('handoff cleanup <branch> removes the worktree and branch when the PR is merged', async () => {
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
});
