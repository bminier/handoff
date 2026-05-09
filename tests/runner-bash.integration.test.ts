import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

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
  /**
   * Tool name to invoke through the runner. Defaults to `'claude'` to
   * keep existing tests untouched; per-tool argv-shape tests pass
   * `'codex'` / `'copilot'` to exercise the runner's per-tool switch.
   */
  tool?: 'claude' | 'codex' | 'copilot';
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
  const tool = opts.tool ?? 'claude';
  // Set cwd by `cd`-ing inside the bash command rather than passing it
  // through `spawnSync({ cwd })`. On Windows, bun's spawnSync holds a
  // handle on the cwd it was given for the duration of its own
  // process, which pins the worktree directory and makes
  // `git worktree remove --force` later fail with "Permission denied".
  // Confirmed via minimal repro: cwd-less spawn + bash-side cd
  // succeeds; spawnSync(cwd:wt) fails.
  //
  // Use `bash <runner>` rather than direct invocation: scripts/handoff-
  // runner.sh isn't committed with the +x bit (production calls it via
  // `bash <script>` from openTerminal), and direct `<runner>` requires
  // it. `bash <runner>` works regardless of file mode.
  const wt = h.worktreePath.replace(/\\/g, '/');
  const runner = h.runnerScript.replace(/\\/g, '/');
  const cmd = `cd "${wt}" && bash "${runner}" "${h.handoffRepoRoot}" ${tool} "${h.branch}"`;
  return spawnSync(bash!, ['-c', cmd], {
    env,
    encoding: 'utf8',
    // Pipe stdin so the runner's `[ -t 0 ]` guard sees a non-TTY and
    // skips the trailing prompt.
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Read the JSON-per-line argv log left by fake-tool-impl.ts. */
function readArgvLog(path: string): string[][] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

function expectExit(
  result: ReturnType<typeof runBashRunner>,
  expected: number,
  label: string,
): void {
  if (result.status !== expected) {
    // Dump everything we can about the spawn. The bash matrix has hit
    // empty-stdout/empty-stderr failures on CI where status alone
    // wasn't enough to tell whether the spawn errored vs the runner
    // exited early.
    console.error(`--- ${label} status: ${String(result.status)} ---`);
    console.error(`--- ${label} signal: ${String(result.signal)} ---`);
    console.error(`--- ${label} error: ${String(result.error)} ---`);
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

  it('cleanup unknown-status (e.g. gh unavailable): runner exits 2 (operational), retains worktree', () => {
    // The 62c1611 contract at the runner level: when cleanup returns
    // status:'unknown' (worktree-removal failure, gh failure, branch
    // deletion failure — all map to the same 'unknown' status), the
    // runner must propagate cli.ts's operational-error exit code (2)
    // with the cleanup message intact and *no* stack-trace dump from
    // the bun process.
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

    expect(result.status).toBe(2);
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

  // Per-tool argv shape — the regression behind issue #57. Three tools,
  // two shapes: claude/codex take the prompt as a positional arg;
  // copilot needs `-i <prompt>` because a bare positional is parsed as
  // a subcommand and exits silently. The runner table is the source of
  // truth; these tests pin the contract.
  for (const tool of ['claude', 'codex', 'copilot'] as const) {
    it(
      `${tool}: runner passes PROMPT.md content with the right argv shape`,
      () => {
        const promptBody = `# seed prompt for ${tool}\nDo the thing.\n`;
        harness = createRunnerHarness({
          target: 'bash',
          branch: `${tool}/issue-57`,
          promptBody,
        });

        const result = runBashRunner(harness, {
          tool,
          toolExit: 0,
          ghPrListResponse: [{ number: 57 }],
        });
        expectExit(result, 0, `bash ${tool} argv`);

        const calls = readArgvLog(harness.argvLogPath);
        expect(calls.length).toBe(1);
        const argv = calls[0]!;
        if (tool === 'copilot') {
          // Trailing newline is preserved because PROMPT="$(cat …)"
          // strips trailing newlines in bash (POSIX-mandated for
          // command substitution). The body the tool sees is the
          // newline-trimmed prompt.
          expect(argv).toEqual(['-i', promptBody.replace(/\n+$/, '')]);
        } else {
          expect(argv).toEqual([promptBody.replace(/\n+$/, '')]);
        }
      },
      TIMEOUT_MS,
    );
  }
});
