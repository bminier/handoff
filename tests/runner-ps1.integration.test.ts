import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { platform } from 'node:os';

import {
  createRunnerHarness,
  findInterpreter,
  type RunnerHarness,
} from './helpers/runnerHarness.ts';

// PowerShell 7 (`pwsh`) is the modern, cross-platform PS, but the
// runner script targets Windows where `pwsh` is the supported
// interpreter. Skip the suite when not on Windows or when pwsh isn't
// available — bash on Linux/macOS won't interpret the .ps1 syntax.
const pwsh = platform() === 'win32' ? findInterpreter('pwsh') : undefined;
const describePwsh = pwsh ? describe : describe.skip;

let harness: RunnerHarness | undefined;

beforeEach(() => {
  harness = undefined;
});
afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

interface RunOpts {
  toolExit?: number;
  ghPrListResponse?: unknown;
  ghFail?: boolean;
}

function runPwshRunner(h: RunnerHarness, opts: RunOpts = {}) {
  const env: NodeJS.ProcessEnv = {
    ...h.env,
    FAKE_TOOL_EXIT: String(opts.toolExit ?? 0),
    FAKE_GH_PR_LIST_RESPONSE:
      opts.ghPrListResponse === undefined
        ? (h.env.FAKE_GH_PR_LIST_RESPONSE ?? '[]')
        : JSON.stringify(opts.ghPrListResponse),
    ...(opts.ghFail ? { FAKE_GH_FAIL: '1' } : {}),
  };
  // -NoProfile keeps the test hermetic against the user's PowerShell
  // profile. -ExecutionPolicy Bypass avoids the unsigned-script block
  // CI runners sometimes hit on first invocation.
  return spawnSync(
    pwsh!,
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      h.runnerScript,
      h.handoffRepoRoot,
      'claude',
      h.branch,
    ],
    {
      cwd: h.worktreePath,
      env,
      encoding: 'utf8',
      // Pipe stdin so the runner's [Console]::IsInputRedirected guard
      // sees a redirected stream and skips the trailing Read-Host.
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}

function expectExit(
  result: ReturnType<typeof runPwshRunner>,
  expected: number,
  label: string,
): void {
  if (result.status !== expected) {
    console.error(`--- ${label} stdout ---\n${result.stdout ?? ''}`);
    console.error(`--- ${label} stderr ---\n${result.stderr ?? ''}`);
  }
  expect(result.status).toBe(expected);
}

const TIMEOUT_MS = 30000;

describePwsh('handoff-runner.ps1', () => {
  it(
    'PR merged: tool exits 0, runner cleans worktree and branch, exits 0',
    () => {
      harness = createRunnerHarness({ target: 'pwsh', branch: 'claude/issue-7' });
      expect(existsSync(harness.worktreePath)).toBe(true);

      const result = runPwshRunner(harness, {
        toolExit: 0,
        ghPrListResponse: [{ number: 7 }],
      });

      expectExit(result, 0, 'pwsh PR merged');
      expect(result.stdout).toContain('Removed worktree');
      expect(result.stdout).toContain('deleted branch claude/issue-7');
      expect(existsSync(harness.worktreePath)).toBe(false);
      expect(() =>
        harness!.repo.git(['show-ref', '--verify', 'refs/heads/claude/issue-7']),
      ).toThrow();
    },
    TIMEOUT_MS,
  );

  it(
    'PR not merged: prints retention banner, worktree retained, exits 0',
    () => {
      harness = createRunnerHarness({ target: 'pwsh', branch: 'claude/issue-8' });

      const result = runPwshRunner(harness, {
        toolExit: 0,
        ghPrListResponse: [],
      });

      expectExit(result, 0, 'pwsh PR not merged');
      expect(result.stdout).toContain('not merged');
      expect(result.stdout).toContain('Worktree retained');
      expect(existsSync(harness.worktreePath)).toBe(true);
      harness.repo.git(['show-ref', '--verify', '--quiet', 'refs/heads/claude/issue-8']);
    },
    TIMEOUT_MS,
  );

  it(
    'tool exits non-zero: cleanup still runs, runner exit code reflects cleanup',
    () => {
      harness = createRunnerHarness({ target: 'pwsh', branch: 'claude/issue-9' });

      const result = runPwshRunner(harness, {
        toolExit: 5,
        ghPrListResponse: [{ number: 9 }],
      });

      expectExit(result, 0, 'pwsh tool non-zero');
      expect(result.stdout).toContain('claude exited (code 5)');
      expect(result.stdout).toContain('Running cleanup for claude/issue-9');
      expect(existsSync(harness.worktreePath)).toBe(false);
    },
    TIMEOUT_MS,
  );

  it('cleanup unknown-status (e.g. gh unavailable): runner exits 1, retains worktree', () => {
    // Mirrors the bash-matrix counterpart — same observable contract,
    // but exercised through the PS runner so a regression in either
    // script (e.g. wrong $LASTEXITCODE handling) trips its own test.
    harness = createRunnerHarness({ target: 'pwsh', branch: 'claude/issue-10' });

    const result = runPwshRunner(harness, { toolExit: 0, ghFail: true });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Could not check PR status');
    expect(result.stdout).toContain('Re-run `handoff cleanup claude/issue-10`');
    expect(result.stderr).not.toMatch(/at .*src[\\/]cleanup\.ts/);
    expect(existsSync(harness.worktreePath)).toBe(true);
  });

  it('PROMPT.md missing: runner exits 1 before invoking the tool', () => {
    harness = createRunnerHarness({
      target: 'pwsh',
      branch: 'claude/issue-11',
      createWorktree: false,
    });
    mkdirSync(harness.worktreePath, { recursive: true });

    const result = runPwshRunner(harness);

    expect(result.status).toBe(1);
    // PowerShell's Write-Error format includes the message; it lands on
    // stderr or in the stream-merged output depending on host. Match a
    // substring of the message to stay format-agnostic.
    const combined = (result.stdout ?? '') + (result.stderr ?? '');
    expect(combined).toContain('PROMPT.md not found');
  });
});
