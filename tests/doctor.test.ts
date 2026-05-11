import { describe, expect, it } from 'bun:test';

import { defaultProbe, formatReport, runDoctor, type DoctorProbe } from '../src/doctor.ts';

interface ProbeOpts {
  /** Map of cmd → resolved path. Missing key = which() returns null. */
  paths?: Record<string, string>;
  /**
   * Map of `cmd args.join(' ')` → run result. Missing key returns
   * exit -1 (simulating spawn failure / not on PATH).
   */
  runs?: Record<string, { exitCode: number; stdout?: string; stderr?: string }>;
  platform?: NodeJS.Platform;
}

function fakeProbe(opts: ProbeOpts = {}): DoctorProbe {
  return {
    async which(cmd) {
      return opts.paths?.[cmd] ?? null;
    },
    async invoke(cmd, args) {
      const key = [cmd, ...args].join(' ');
      const r = opts.runs?.[key];
      if (!r) return { exitCode: -1, stdout: '', stderr: `not in fixture: ${key}` };
      return { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    platform: opts.platform ?? 'linux',
  };
}

// All-pass fixture used as a baseline — individual tests then drop one
// expectation at a time to exercise the per-check failure paths.
function happyProbe(): DoctorProbe {
  return fakeProbe({
    paths: {
      bun: '/usr/local/bin/bun',
      git: '/usr/bin/git',
      gh: '/usr/local/bin/gh',
      'gnome-terminal': '/usr/bin/gnome-terminal',
      claude: '/home/u/.local/bin/claude',
      codex: '/home/u/.local/bin/codex',
      copilot: '/home/u/.local/bin/copilot',
    },
    runs: {
      'bun --version': { exitCode: 0, stdout: '1.2.21\n' },
      'gh auth status': { exitCode: 0, stdout: 'Logged in to github.com\n' },
      'git rev-parse --is-inside-work-tree': { exitCode: 0, stdout: 'true\n' },
    },
    platform: 'linux',
  });
}

describe('runDoctor', () => {
  it('reports all-pass on a fully provisioned environment', async () => {
    const report = await runDoctor({ tools: [] }, happyProbe());
    expect(report.errors).toBe(0);
    expect(report.warnings).toBe(0);
    // 6 common + 3 tools = 9 checks total when tools=[] (all tools).
    expect(report.passed).toBe(9);
    expect(report.results.map((r) => r.name)).toEqual([
      'bun-on-path',
      'git-on-path',
      'gh-on-path',
      'gh-auth',
      'inside-git-repo',
      'terminal',
      'tool-claude',
      'tool-codex',
      'tool-copilot',
    ]);
  });

  it('narrows the per-tool checks when tools is non-empty', async () => {
    // `handoff doctor claude` → 6 common + 1 tool. The other two tools
    // are not checked even if they happen to be missing.
    const probe = fakeProbe({
      ...{
        paths: {
          bun: '/usr/local/bin/bun',
          git: '/usr/bin/git',
          gh: '/usr/local/bin/gh',
          'gnome-terminal': '/usr/bin/gnome-terminal',
          claude: '/home/u/.local/bin/claude',
          // codex + copilot intentionally absent
        },
        runs: {
          'bun --version': { exitCode: 0, stdout: '1.2.21\n' },
          'gh auth status': { exitCode: 0, stdout: 'ok' },
          'git rev-parse --is-inside-work-tree': { exitCode: 0, stdout: 'true' },
        },
      },
    });
    const report = await runDoctor({ tools: ['claude'] }, probe);
    expect(report.errors).toBe(0);
    expect(report.passed).toBe(7);
    expect(report.results.map((r) => r.name).filter((n) => n.startsWith('tool-'))).toEqual([
      'tool-claude',
    ]);
  });
});

describe('individual checks', () => {
  it('bun missing → error', async () => {
    const probe = fakeProbe({});
    const report = await runDoctor({ tools: [] }, probe);
    const bun = report.results.find((r) => r.name === 'bun-on-path')!;
    expect(bun.status).toBe('fail');
    expect(bun.severity).toBe('error');
    expect(bun.hint).toMatch(/bun\.sh/);
  });

  it('bun present but below minimum version → error', async () => {
    const probe = fakeProbe({
      paths: { bun: '/usr/local/bin/bun' },
      runs: { 'bun --version': { exitCode: 0, stdout: '1.0.5\n' } },
    });
    const report = await runDoctor({ tools: [] }, probe);
    const bun = report.results.find((r) => r.name === 'bun-on-path')!;
    expect(bun.status).toBe('fail');
    expect(bun.message).toContain('1.0.5');
    expect(bun.message).toContain('>=1.1.0');
  });

  it('bun present and version OK → pass', async () => {
    const probe = fakeProbe({
      paths: { bun: '/usr/local/bin/bun' },
      runs: { 'bun --version': { exitCode: 0, stdout: '1.2.21\n' } },
    });
    const report = await runDoctor({ tools: [] }, probe);
    const bun = report.results.find((r) => r.name === 'bun-on-path')!;
    expect(bun.status).toBe('pass');
    expect(bun.message).toMatch(/bun 1\.2\.21 at /);
  });

  it('gh unauthenticated → error with `gh auth login` hint', async () => {
    const probe = fakeProbe({
      paths: { gh: '/usr/local/bin/gh' },
      runs: { 'gh auth status': { exitCode: 1, stderr: 'You are not logged in.' } },
    });
    const report = await runDoctor({ tools: [] }, probe);
    const auth = report.results.find((r) => r.name === 'gh-auth')!;
    expect(auth.status).toBe('fail');
    expect(auth.hint).toMatch(/gh auth login/);
  });

  it('not inside a git working tree → error', async () => {
    const probe = fakeProbe({
      paths: { git: '/usr/bin/git' },
      runs: {
        'git rev-parse --is-inside-work-tree': {
          exitCode: 128,
          stderr: 'fatal: not a git repository',
        },
      },
    });
    const report = await runDoctor({ tools: [] }, probe);
    const repo = report.results.find((r) => r.name === 'inside-git-repo')!;
    expect(repo.status).toBe('fail');
    expect(repo.hint).toMatch(/cd into a git repo/);
  });

  it('no terminal emulator → warning, not error', async () => {
    // Warnings don't bump the exit code — pin that contract.
    const probe = fakeProbe({ platform: 'linux' });
    const report = await runDoctor({ tools: [] }, probe);
    const term = report.results.find((r) => r.name === 'terminal')!;
    expect(term.status).toBe('fail');
    expect(term.severity).toBe('warning');
    expect(report.warnings).toBeGreaterThan(0);
    // The errors counter still reflects missing bun/git/gh, but the
    // terminal failure itself is a warning.
  });

  it('terminal report names the first-available candidate', async () => {
    // Mirror openTerminal()'s fallback chain: when both gnome-terminal
    // and xterm exist, gnome-terminal wins. (Pinning the order here
    // means changing src/terminal.ts's candidates list trips this
    // test, prompting a doctor update to match.)
    const probe = fakeProbe({
      paths: {
        'gnome-terminal': '/usr/bin/gnome-terminal',
        xterm: '/usr/bin/xterm',
      },
      platform: 'linux',
    });
    const report = await runDoctor({ tools: [] }, probe);
    const term = report.results.find((r) => r.name === 'terminal')!;
    expect(term.status).toBe('pass');
    expect(term.message).toContain('gnome-terminal');
    expect(term.message).toContain('xterm');
  });

  it('tool missing → error with install URL hint', async () => {
    const probe = fakeProbe({});
    const report = await runDoctor({ tools: ['claude'] }, probe);
    const tool = report.results.find((r) => r.name === 'tool-claude')!;
    expect(tool.status).toBe('fail');
    expect(tool.hint).toMatch(/anthropic\.com/);
  });
});

describe('exit code semantics', () => {
  it("errors=0 + warnings>0 still allows exit 0 (warnings don't fail)", async () => {
    // Pin that doctor's contract is "exit 0 if no error-severity
    // failures". A warning-only run should still let the caller
    // proceed (issue #27 acceptance criteria).
    const probe = fakeProbe({
      paths: {
        bun: '/usr/local/bin/bun',
        git: '/usr/bin/git',
        gh: '/usr/local/bin/gh',
        claude: '/u/claude',
        codex: '/u/codex',
        copilot: '/u/copilot',
        // No terminal emulators on PATH → warning, not error.
      },
      runs: {
        'bun --version': { exitCode: 0, stdout: '1.2.21\n' },
        'gh auth status': { exitCode: 0 },
        'git rev-parse --is-inside-work-tree': { exitCode: 0, stdout: 'true' },
      },
      platform: 'linux',
    });
    const report = await runDoctor({ tools: [] }, probe);
    expect(report.errors).toBe(0);
    expect(report.warnings).toBe(1);
  });
});

describe('formatReport', () => {
  it('uses ASCII glyphs and a summary line', async () => {
    const report = await runDoctor({ tools: ['claude'] }, happyProbe());
    const text = formatReport(report);
    expect(text).toContain('[ ok ]');
    expect(text).not.toContain('[fail]');
    expect(text).toMatch(/\d+ passed/);
  });

  it('includes the hint on failure', async () => {
    const probe = fakeProbe({
      paths: { bun: '/usr/local/bin/bun', git: '/usr/bin/git' },
      runs: {
        'bun --version': { exitCode: 0, stdout: '1.2.21\n' },
        'git rev-parse --is-inside-work-tree': { exitCode: 0, stdout: 'true' },
      },
      platform: 'linux',
    });
    const report = await runDoctor({ tools: [] }, probe);
    const text = formatReport(report);
    expect(text).toContain('[fail]');
    expect(text).toMatch(/^ +hint: /m);
    expect(text).toContain('cli.github.com');
  });
});

describe('defaultProbe', () => {
  // The defaultProbe is the only non-pure surface in this module —
  // its existence is asserted, but the actual subprocess invocations
  // live in run.ts and are covered by run.test.ts. This test just
  // pins the shape so refactors that drop one of the three methods
  // are caught.
  it('exposes which / invoke / platform', () => {
    const p = defaultProbe();
    expect(typeof p.which).toBe('function');
    expect(typeof p.invoke).toBe('function');
    expect(typeof p.platform).toBe('string');
  });
});
