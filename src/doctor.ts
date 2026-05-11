import { run, RunError } from './run.ts';
import { TOOLS, type Tool } from './tools.ts';

export type Severity = 'error' | 'warning';
export type CheckStatus = 'pass' | 'fail';

export interface CheckResult {
  /**
   * Stable machine identifier (kebab-case). Surfaced verbatim in the
   * `--json` output so consumers (CI gates, dashboards) can pin a
   * specific check by name. The JSON shape is a flat array of these
   * records under `results[]`, not a map keyed by name — duplicate
   * names would be a bug, but the format is array-of-objects.
   */
  name: string;
  /**
   * Whether a fail here is a hard error (bumps the process exit code)
   * or a warning (informational; exit 0 still possible).
   */
  severity: Severity;
  status: CheckStatus;
  /** Human-readable result line, with the discovered value if any. */
  message: string;
  /** What the user should do if `status === 'fail'`. Omitted on pass. */
  hint?: string;
}

/**
 * Dependency-injection seam for the per-check probes. Each check is a
 * pure async function over this interface, so tests stub the probe
 * and assert the CheckResult without spawning real subprocesses.
 *
 * Default impl: `defaultProbe()` below uses Bun.which + `run.ts`.
 */
export interface DoctorProbe {
  /** Resolve `cmd` on PATH. Returns the absolute path or null. */
  which(cmd: string): Promise<string | null>;
  /** Run `cmd args` and capture exit code + streams. Never throws. */
  invoke(
    cmd: string,
    args: readonly string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  platform: NodeJS.Platform;
}

export function defaultProbe(): DoctorProbe {
  return {
    async which(cmd) {
      return Bun.which(cmd) ?? null;
    },
    async invoke(cmd, args) {
      try {
        return await run(cmd, [...args]);
      } catch (err) {
        if (err instanceof RunError) {
          return { stdout: err.stdout, stderr: err.stderr, exitCode: err.exitCode };
        }
        return {
          stdout: '',
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: -1,
        };
      }
    },
    platform: process.platform,
  };
}

const MIN_BUN_VERSION = '1.1.0';

function parseSemver(s: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s.trim());
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function gte(actual: [number, number, number], min: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (actual[i]! > min[i]!) return true;
    if (actual[i]! < min[i]!) return false;
  }
  return true;
}

export type CheckFn = (probe: DoctorProbe) => Promise<CheckResult>;

async function checkBunOnPath(probe: DoctorProbe): Promise<CheckResult> {
  const path = await probe.which('bun');
  if (!path) {
    return {
      name: 'bun-on-path',
      severity: 'error',
      status: 'fail',
      message: '`bun` not found on PATH',
      hint: 'Install bun: https://bun.sh',
    };
  }
  const versionRun = await probe.invoke('bun', ['--version']);
  const parsed = parseSemver(versionRun.stdout);
  const min = parseSemver(MIN_BUN_VERSION)!;
  if (versionRun.exitCode !== 0 || !parsed) {
    return {
      name: 'bun-on-path',
      severity: 'error',
      status: 'fail',
      message: `bun found at ${path} but \`bun --version\` failed (exit ${versionRun.exitCode})`,
      hint: 'Reinstall bun or check that the binary is not corrupted.',
    };
  }
  const actual = `${parsed[0]}.${parsed[1]}.${parsed[2]}`;
  if (!gte(parsed, min)) {
    return {
      name: 'bun-on-path',
      severity: 'error',
      status: 'fail',
      message: `bun ${actual} found at ${path}, but handoff requires >=${MIN_BUN_VERSION}`,
      hint: `Upgrade bun to >=${MIN_BUN_VERSION}: \`bun upgrade\` or reinstall from https://bun.sh`,
    };
  }
  return {
    name: 'bun-on-path',
    severity: 'error',
    status: 'pass',
    message: `bun ${actual} at ${path}`,
  };
}

async function checkGitOnPath(probe: DoctorProbe): Promise<CheckResult> {
  const path = await probe.which('git');
  if (!path) {
    return {
      name: 'git-on-path',
      severity: 'error',
      status: 'fail',
      message: '`git` not found on PATH',
      hint: 'Install git: https://git-scm.com/downloads',
    };
  }
  return {
    name: 'git-on-path',
    severity: 'error',
    status: 'pass',
    message: `git at ${path}`,
  };
}

async function checkGhOnPath(probe: DoctorProbe): Promise<CheckResult> {
  const path = await probe.which('gh');
  if (!path) {
    return {
      name: 'gh-on-path',
      severity: 'error',
      status: 'fail',
      message: '`gh` not found on PATH',
      hint: 'Install GitHub CLI: https://cli.github.com',
    };
  }
  return {
    name: 'gh-on-path',
    severity: 'error',
    status: 'pass',
    message: `gh at ${path}`,
  };
}

async function checkGhAuth(probe: DoctorProbe): Promise<CheckResult> {
  // Short-circuit if gh isn't on PATH — otherwise the `gh auth status`
  // spawn fails with exitCode -1 and we'd report a misleading "gh is
  // not authenticated" alongside the upstream `gh-on-path` error.
  // Status stays 'fail' so the doctor surface flags the missing prereq,
  // but the message tells the user the real cause and we skip the
  // `gh auth login` hint (which presumes gh is installed). Severity
  // stays 'error' for consistency with the rest of the gh checks; the
  // total error count reflects two distinct fail lines (one per check),
  // which is the intended granularity — fixing one doesn't fix the other.
  const gh = await probe.which('gh');
  if (!gh) {
    return {
      name: 'gh-auth',
      severity: 'error',
      status: 'fail',
      message: 'cannot check gh auth — gh not on PATH',
      hint: 'See the `gh-on-path` check above.',
    };
  }
  const result = await probe.invoke('gh', ['auth', 'status']);
  if (result.exitCode === 0) {
    return {
      name: 'gh-auth',
      severity: 'error',
      status: 'pass',
      message: 'gh is authenticated',
    };
  }
  return {
    name: 'gh-auth',
    severity: 'error',
    status: 'fail',
    message: 'gh is not authenticated',
    hint: 'Run `gh auth login` and complete the browser flow.',
  };
}

async function checkInsideGitRepo(probe: DoctorProbe): Promise<CheckResult> {
  // Same short-circuit pattern as gh-auth: if git isn't on PATH, the
  // rev-parse spawn fails with exit -1 and "not inside a working tree"
  // would be misleading. Surface the real cause and let the user fix
  // the upstream `git-on-path` failure first.
  const git = await probe.which('git');
  if (!git) {
    return {
      name: 'inside-git-repo',
      severity: 'error',
      status: 'fail',
      message: 'cannot check git working tree — git not on PATH',
      hint: 'See the `git-on-path` check above.',
    };
  }
  const result = await probe.invoke('git', ['rev-parse', '--is-inside-work-tree']);
  if (result.exitCode === 0 && result.stdout.trim() === 'true') {
    return {
      name: 'inside-git-repo',
      severity: 'error',
      status: 'pass',
      message: 'cwd is inside a git working tree',
    };
  }
  return {
    name: 'inside-git-repo',
    severity: 'error',
    status: 'fail',
    message: 'cwd is not inside a git working tree',
    hint: "cd into a git repo before running handoff. (handoff dispatches issues from the caller's repo.)",
  };
}

async function checkTerminal(probe: DoctorProbe): Promise<CheckResult> {
  const candidates =
    probe.platform === 'win32'
      ? ['wt', 'cmd']
      : probe.platform === 'darwin'
        ? ['osascript']
        : ['gnome-terminal', 'konsole', 'xterm'];

  const found: string[] = [];
  for (const c of candidates) {
    if (await probe.which(c)) found.push(c);
  }
  if (found.length === 0) {
    return {
      name: 'terminal',
      severity: 'warning',
      status: 'fail',
      message: `no terminal emulator detected (tried: ${candidates.join(', ')})`,
      hint: 'Install one of the supported terminals, or open the agent in your existing terminal manually.',
    };
  }
  return {
    name: 'terminal',
    severity: 'warning',
    status: 'pass',
    message: `terminal emulator: ${found[0]} (also available: ${found.slice(1).join(', ') || 'none'})`,
  };
}

/**
 * The inner shell each terminal launcher exec's to actually run the
 * runner script. Mirror what `buildLaunchSpec` in src/terminal.ts uses:
 *   win32 → `powershell.exe -NoExit -File <runner.ps1>`
 *   darwin → `bash <runner.sh>` (via osascript)
 *   linux → `bash <runner.sh>`
 * If the inner shell is missing, the terminal window opens and immediately
 * fails — the launch succeeds at the OS level but the runner never starts.
 * Splitting this off from `terminal` (the launcher check) means each
 * failure mode gets a distinct line in the report and consumers can
 * pin them independently via the `name` field.
 */
async function checkTerminalShell(probe: DoctorProbe): Promise<CheckResult> {
  const shell = probe.platform === 'win32' ? 'powershell.exe' : 'bash';
  const path = await probe.which(shell);
  if (!path) {
    return {
      name: 'terminal-shell',
      severity: 'warning',
      status: 'fail',
      message: `terminal shell missing — \`${shell}\` not on PATH`,
      hint:
        probe.platform === 'win32'
          ? 'PowerShell ships with Windows; if it is missing, the WindowsApps PATH entry is likely broken — restore it from System Properties → Environment Variables.'
          : 'Install bash (the runner scripts target POSIX bash).',
    };
  }
  return {
    name: 'terminal-shell',
    severity: 'warning',
    status: 'pass',
    message: `terminal shell: ${shell} at ${path}`,
  };
}

function checkTool(tool: Tool): CheckFn {
  return async (probe) => {
    const path = await probe.which(tool);
    if (!path) {
      return {
        name: `tool-${tool}`,
        severity: 'error',
        status: 'fail',
        message: `\`${tool}\` not found on PATH`,
        hint: HINTS[tool],
      };
    }
    return {
      name: `tool-${tool}`,
      severity: 'error',
      status: 'pass',
      message: `${tool} at ${path}`,
    };
  };
}

const HINTS: Record<Tool, string> = {
  claude: 'Install Claude Code: https://docs.anthropic.com/en/docs/agents-and-tools/claude-code',
  codex: 'Install Codex CLI: https://github.com/openai/codex',
  copilot:
    'Install GitHub Copilot CLI: https://docs.github.com/en/copilot/github-copilot-in-the-cli',
};

const COMMON_CHECKS: readonly CheckFn[] = [
  checkBunOnPath,
  checkGitOnPath,
  checkGhOnPath,
  checkGhAuth,
  checkInsideGitRepo,
  checkTerminal,
  checkTerminalShell,
];

export interface DoctorOptions {
  /**
   * Tools to include in the per-tool PATH checks. Empty list means
   * "all known tools" (the bare `handoff doctor` invocation).
   */
  tools: readonly Tool[];
}

export interface DoctorReport {
  results: CheckResult[];
  errors: number;
  warnings: number;
  passed: number;
}

export async function runDoctor(
  opts: DoctorOptions,
  probe: DoctorProbe = defaultProbe(),
): Promise<DoctorReport> {
  const toolList = opts.tools.length === 0 ? [...TOOLS] : opts.tools;
  const checks: CheckFn[] = [...COMMON_CHECKS, ...toolList.map(checkTool)];

  const results: CheckResult[] = [];
  for (const check of checks) {
    results.push(await check(probe));
  }

  let errors = 0;
  let warnings = 0;
  let passed = 0;
  for (const r of results) {
    if (r.status === 'pass') {
      passed++;
    } else if (r.severity === 'error') {
      errors++;
    } else {
      warnings++;
    }
  }
  return { results, errors, warnings, passed };
}

export function formatReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const r of report.results) {
    const glyph = r.status === 'pass' ? '[ ok ]' : r.severity === 'error' ? '[fail]' : '[warn]';
    lines.push(`${glyph} ${r.message}`);
    if (r.status === 'fail' && r.hint) {
      lines.push(`       hint: ${r.hint}`);
    }
  }
  lines.push('');
  const summary: string[] = [];
  summary.push(`${report.passed} passed`);
  if (report.errors > 0) summary.push(`${report.errors} error${report.errors === 1 ? '' : 's'}`);
  if (report.warnings > 0)
    summary.push(`${report.warnings} warning${report.warnings === 1 ? '' : 's'}`);
  lines.push(summary.join(', '));
  return lines.join('\n');
}
