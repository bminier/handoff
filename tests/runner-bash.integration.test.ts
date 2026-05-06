import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

import {
  createRunnerHarness,
  findInterpreter,
  type RunnerHarness,
} from './helpers/runnerHarness.ts';

const bash = findInterpreter('bash');
const describeBash = bash ? describe : describe.skip;

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
  /** Force the fake gh to exit non-zero (drives cleanup's unknown-status path). */
  ghFail?: boolean;
}

function runBashRunner(h: RunnerHarness, opts: RunOpts = {}) {
  const env: NodeJS.ProcessEnv = {
    ...h.env,
    FAKE_TOOL_EXIT: String(opts.toolExit ?? 0),
    FAKE_GH_PR_LIST_RESPONSE:
      opts.ghPrListResponse === undefined
        ? (h.env.FAKE_GH_PR_LIST_RESPONSE ?? '[]')
        : JSON.stringify(opts.ghPrListResponse),
    ...(opts.ghFail ? { FAKE_GH_FAIL: '1' } : {}),
  };
  // Set cwd by `cd`-ing inside the bash command rather than passing it
  // through `spawnSync({ cwd })`. On Windows, bun's spawnSync holds a
  // handle on the cwd it was given for the duration of its own
  // process, which pins the worktree directory and makes
  // `git worktree remove --force` later fail with "Permission denied".
  // Confirmed via minimal repro: cwd-less spawn + bash-side cd
  // succeeds; spawnSync(cwd:wt) fails. cd-ing inside the shell command
  // instead lets the worktree be deleted normally.
  const wt = h.worktreePath.replace(/\\/g, '/');
  const runner = h.runnerScript.replace(/\\/g, '/');
  const cmd = `cd "${wt}" && exec "${runner}" "${h.handoffRepoRoot}" claude "${h.branch}"`;
  return spawnSync(bash!, ['-c', cmd], {
    env,
    encoding: 'utf8',
    // Pipe stdin so the runner's `[ -t 0 ]` guard sees a non-TTY and
    // skips the trailing prompt.
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function expectExit(
  result: ReturnType<typeof runBashRunner>,
  expected: number,
  label: string,
): void {
  if (result.status !== expected) {
    // Surface stdout/stderr in CI logs whenever the runner doesn't
    // match the expected exit. Without this the assertion failure
    // shows only "Expected 0 / Received 1" and we have no way to tell
    // why cleanup returned unknown.
    console.error(`--- ${label} stdout ---\n${result.stdout ?? ''}`);
    console.error(`--- ${label} stderr ---\n${result.stderr ?? ''}`);
  }
  expect(result.status).toBe(expected);
}

// Generous per-test timeout: cold-start bun on Windows GH Actions
// runners can take several seconds for the first few subprocess
// spawns (the runner test forks bash → cmd shim → bun → bun → git in
// quick succession). The default 5s isn't enough for the first test.
const TIMEOUT_MS = 30000;

describeBash('handoff-runner.sh', () => {
  it(
    'PR merged: tool exits 0, runner cleans worktree and branch, exits 0',
    () => {
      harness = createRunnerHarness({ target: 'bash', branch: 'claude/issue-7' });
      expect(existsSync(harness.worktreePath)).toBe(true);

      const result = runBashRunner(harness, {
        toolExit: 0,
        ghPrListResponse: [{ number: 7 }],
      });

      expectExit(result, 0, 'bash PR merged');
      // The runner prints the cleanup result via cli.ts; the merged-PR
      // path uses "Removed worktree" / "deleted branch".
      expect(result.stdout).toContain('Removed worktree');
      expect(result.stdout).toContain('deleted branch claude/issue-7');
      // Worktree directory and branch ref are both gone after cleanup.
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
      harness = createRunnerHarness({ target: 'bash', branch: 'claude/issue-8' });

      const result = runBashRunner(harness, {
        toolExit: 0,
        // gh pr list --state merged returns [] for both "no PR" and
        // "PR open" — the retention path is the same in either case.
        ghPrListResponse: [],
      });

      expectExit(result, 0, 'bash PR not merged');
      expect(result.stdout).toContain('not merged');
      expect(result.stdout).toContain('Worktree retained');
      expect(existsSync(harness.worktreePath)).toBe(true);
      // Branch must survive — the agent might come back to push more
      // commits before the PR finally merges.
      harness.repo.git(['show-ref', '--verify', '--quiet', 'refs/heads/claude/issue-8']);
    },
    TIMEOUT_MS,
  );

  it(
    'tool exits non-zero: cleanup still runs, runner exit code reflects cleanup',
    () => {
      // Production behaviour pin: the tool failed, but if the PR is somehow
      // still merged we should clean up — and the runner's exit code comes
      // from cleanup, not the tool. (Real-world case: the user merged the
      // PR manually before quitting the agent.)
      harness = createRunnerHarness({ target: 'bash', branch: 'claude/issue-9' });

      const result = runBashRunner(harness, {
        toolExit: 5,
        ghPrListResponse: [{ number: 9 }],
      });

      // Tool exit is reported in stdout (the "[handoff] $TOOL exited
      // (code 5)" banner) but the script's final exit is from cleanup,
      // which succeeded → 0.
      expectExit(result, 0, 'bash tool non-zero');
      expect(result.stdout).toContain('claude exited (code 5)');
      expect(result.stdout).toContain('Running cleanup for claude/issue-9');
      expect(existsSync(harness.worktreePath)).toBe(false);
    },
    TIMEOUT_MS,
  );

  it('cleanup unknown-status (e.g. gh unavailable): runner exits 1, retains worktree', () => {
    // The 62c1611 contract at the runner level: when cleanup returns
    // status:'unknown' (worktree-removal failure, gh failure, branch
    // deletion failure — all map to the same 'unknown' status), the
    // runner must exit 1 with the cleanup message intact and *no*
    // stack-trace dump from the bun process.
    //
    // We drive this through a forced gh failure because the
    // worktree-removal-failure path is hard to set up reliably here
    // (cli.ts's `mainRepoRoot()` needs cwd to be a real linked
    // worktree). The observable runner-level behaviour is identical
    // across the three 'unknown' triggers — same exit code, same
    // message passthrough, same no-stack-trace property. The unit
    // tests in tests/cleanup.test.ts pin the worktree-removal and
    // branch-deletion branches directly.
    harness = createRunnerHarness({ target: 'bash', branch: 'claude/issue-10' });
    expect(existsSync(harness.worktreePath)).toBe(true);

    const result = runBashRunner(harness, { toolExit: 0, ghFail: true });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Could not check PR status');
    expect(result.stdout).toContain('Re-run `handoff cleanup claude/issue-10`');
    // No raw bun stack trace bleeding to the user. cleanup() catches
    // GhError and returns status:'unknown' with a friendly message.
    expect(result.stderr).not.toContain('at runCleanup');
    expect(result.stderr).not.toMatch(/at .*src[\\/]cleanup\.ts/);
    // Worktree retained — cleanup never reached the removal step.
    expect(existsSync(harness.worktreePath)).toBe(true);
  });

  it('PROMPT.md missing: runner exits 1 before invoking the tool', () => {
    // The runner refuses to start without PROMPT.md so a misconfigured
    // launch can't accidentally hand the user's terminal an empty
    // prompt. Pin that early-exit explicitly.
    harness = createRunnerHarness({
      target: 'bash',
      branch: 'claude/issue-11',
      createWorktree: false,
    });
    // Make a worktree dir but no PROMPT.md inside.
    mkdirSync(harness.worktreePath, { recursive: true });

    const result = runBashRunner(harness);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PROMPT.md not found');
  });
});
