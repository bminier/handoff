import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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
  /**
   * Tool name to invoke. Defaults to `'claude'` so existing tests stay
   * untouched; per-tool argv-shape tests pass `'codex'` / `'copilot'`.
   */
  tool?: 'claude' | 'codex' | 'copilot';
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
  const tool = opts.tool ?? 'claude';
  // -NoProfile keeps the test hermetic against the user's PowerShell
  // profile. -ExecutionPolicy Bypass avoids the unsigned-script block
  // CI runners sometimes hit on first invocation.
  //
  // Set cwd via `Set-Location` inside the command rather than
  // `spawnSync({ cwd })` — on Windows, bun's spawnSync holds the cwd
  // it's given for the duration of the parent's life, which pins the
  // worktree directory and breaks the later `git worktree remove`.
  // The bash matrix has the same fix and the same justification.
  //
  // Escape single quotes in interpolated paths: PS's single-quoted
  // string literal escape is `''` (two single quotes). A raw `'`
  // inside a temp path (rare but possible — e.g. a Windows username
  // like `O'Connor`) would otherwise close the literal early and
  // corrupt the command.
  return spawnSync(
    pwsh!,
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Set-Location -LiteralPath '${psQuote(h.worktreePath)}'; ` +
        `& '${psQuote(h.runnerScript)}' '${psQuote(h.handoffRepoRoot)}' '${tool}' '${psQuote(h.branch)}'; ` +
        `exit $LASTEXITCODE`,
    ],
    {
      env,
      encoding: 'utf8',
      // Pipe stdin so the runner's [Console]::IsInputRedirected guard
      // sees a redirected stream and skips the trailing Read-Host.
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}

function psQuote(s: string): string {
  return s.replace(/'/g, "''");
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
      expect(result.stdout).toContain('No merged PR has claude/issue-8 as its head');
      expect(result.stdout).toContain('Worktree retained');
      // Issue #54: pin the --force discoverability hint so it doesn't
      // get copy-edited away unnoticed (mirrored in the bash matrix).
      expect(result.stdout).toContain('handoff cleanup --force claude/issue-8');
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

  it('cleanup unknown-status (e.g. gh unavailable): runner exits 2 (operational), retains worktree', () => {
    // Mirrors the bash-matrix counterpart — same observable contract,
    // but exercised through the PS runner so a regression in either
    // script (e.g. wrong $LASTEXITCODE handling) trips its own test.
    harness = createRunnerHarness({ target: 'pwsh', branch: 'claude/issue-10' });

    const result = runPwshRunner(harness, { toolExit: 0, ghFail: true });

    expect(result.status).toBe(2);
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

  // Per-tool argv shape — the regression behind issue #57. claude/codex
  // take the prompt as a positional arg; copilot needs `-i <prompt>`
  // because a bare positional is parsed as a subcommand and exits
  // silently. Mirrors the bash matrix; runs against the .ps1 runner so
  // a divergence between the two scripts trips here.
  //
  // Prompt body is intentionally single-line: the shim chain on Windows
  // is `pwsh → .cmd → bun → fake-tool-impl.ts`, and `%*` in a .cmd file
  // is reparsed by cmd.exe, where newlines act as command separators
  // and truncate multi-line args. Production calls real `copilot.exe`,
  // which parses its own Win32 command line and is unaffected. The
  // contract we're pinning is per-tool argv shape (positional vs `-i`),
  // not multi-line prompt preservation.
  for (const tool of ['claude', 'codex', 'copilot'] as const) {
    it(
      `${tool}: runner passes PROMPT.md content with the right argv shape`,
      () => {
        const promptBody = `seed prompt for ${tool}`;
        harness = createRunnerHarness({
          target: 'pwsh',
          branch: `${tool}/issue-57`,
          promptBody,
        });

        const result = runPwshRunner(harness, {
          tool,
          toolExit: 0,
          ghPrListResponse: [{ number: 57 }],
        });
        expectExit(result, 0, `pwsh ${tool} argv`);

        const calls = readArgvLog(harness.argvLogPath);
        expect(calls.length).toBe(1);
        const argv = calls[0]!;
        if (tool === 'copilot') {
          expect(argv).toEqual(['-i', promptBody]);
        } else {
          expect(argv).toEqual([promptBody]);
        }
      },
      TIMEOUT_MS,
    );
  }
});
