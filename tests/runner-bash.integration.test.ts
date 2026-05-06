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
  return spawnSync(bash!, [h.runnerScript, h.handoffRepoRoot, 'claude', h.branch], {
    cwd: h.worktreePath,
    env,
    encoding: 'utf8',
    // Pipe stdin so the runner's `[ -t 0 ]` guard sees a non-TTY and
    // skips the trailing prompt.
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

describeBash('handoff-runner.sh', () => {
  it('PR merged: tool exits 0, runner cleans worktree and branch, exits 0', () => {
    harness = createRunnerHarness({ target: 'bash', branch: 'claude/issue-7' });
    expect(existsSync(harness.worktreePath)).toBe(true);

    const result = runBashRunner(harness, {
      toolExit: 0,
      ghPrListResponse: [{ number: 7 }],
    });

    expect(result.status).toBe(0);
    // The runner prints the cleanup result via cli.ts; the merged-PR
    // path uses "Removed worktree" / "deleted branch".
    expect(result.stdout).toContain('Removed worktree');
    expect(result.stdout).toContain('deleted branch claude/issue-7');
    // Worktree directory and branch ref are both gone after cleanup.
    expect(existsSync(harness.worktreePath)).toBe(false);
    expect(() =>
      harness!.repo.git(['show-ref', '--verify', 'refs/heads/claude/issue-7']),
    ).toThrow();
  });

  it('PR not merged: prints retention banner, worktree retained, exits 0', () => {
    harness = createRunnerHarness({ target: 'bash', branch: 'claude/issue-8' });

    const result = runBashRunner(harness, {
      toolExit: 0,
      // gh pr list --state merged returns [] for both "no PR" and
      // "PR open" — the retention path is the same in either case.
      ghPrListResponse: [],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('not merged');
    expect(result.stdout).toContain('Worktree retained');
    expect(existsSync(harness.worktreePath)).toBe(true);
    // Branch must survive — the agent might come back to push more
    // commits before the PR finally merges.
    harness.repo.git(['show-ref', '--verify', '--quiet', 'refs/heads/claude/issue-8']);
  });

  it('tool exits non-zero: cleanup still runs, runner exit code reflects cleanup', () => {
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
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('claude exited (code 5)');
    expect(result.stdout).toContain('Running cleanup for claude/issue-9');
    expect(existsSync(harness.worktreePath)).toBe(false);
  });

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
