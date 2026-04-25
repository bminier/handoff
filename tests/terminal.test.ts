import { describe, expect, it } from 'bun:test';
import { buildLaunchSpec } from '../src/terminal.ts';

describe('buildLaunchSpec', () => {
  it('builds Windows Terminal launch spec', () => {
    const spec = buildLaunchSpec('win32', {
      cwd: 'C:\\work\\repo',
      scriptPath: 'C:\\work\\repo\\runner.ps1',
      args: ['claude', 'claude/issue-1'],
    });
    expect(spec.command).toBe('wt.exe');
    expect(spec.args).toContain('-d');
    expect(spec.args).toContain('C:\\work\\repo');
    expect(spec.args).toContain('powershell.exe');
    expect(spec.args).toContain('C:\\work\\repo\\runner.ps1');
    expect(spec.args).toContain('claude');
  });

  it('falls back to cmd on Windows when terminal=cmd', () => {
    const spec = buildLaunchSpec('win32', {
      cwd: 'C:\\x',
      scriptPath: 'C:\\x\\r.ps1',
      terminal: 'cmd',
    });
    expect(spec.command).toBe('cmd.exe');
    expect(spec.args[0]).toBe('/c');
  });

  it('builds gnome-terminal launch spec on linux', () => {
    const spec = buildLaunchSpec('linux', {
      cwd: '/work/repo',
      scriptPath: '/work/repo/runner.sh',
      args: ['codex', 'codex/issue-2'],
      terminal: 'gnome-terminal',
    });
    expect(spec.command).toBe('gnome-terminal');
    expect(spec.args).toContain('--working-directory');
    expect(spec.args).toContain('/work/repo');
    expect(spec.args).toContain('bash');
  });

  it('builds osascript launch spec on darwin', () => {
    const spec = buildLaunchSpec('darwin', {
      cwd: '/Users/x/repo',
      scriptPath: '/Users/x/repo/runner.sh',
    });
    expect(spec.command).toBe('osascript');
    expect(spec.args[0]).toBe('-e');
    expect(spec.args[1]).toContain('Terminal');
    expect(spec.args[1]).toContain('runner.sh');
    // Invoke via bash explicitly so the script doesn't need the +x bit set.
    expect(spec.args[1]).toContain('bash');
  });

  it('falls back to xterm on linux with separate argv items for -e', () => {
    const spec = buildLaunchSpec('linux', {
      cwd: '/x',
      scriptPath: '/x/r.sh',
      args: ['claude', 'claude/issue-3'],
      terminal: 'xterm',
    });
    expect(spec.command).toBe('xterm');
    // xterm -e expects the program and its args as separate argv items, not a single string.
    expect(spec.args).toEqual(['-e', 'bash', '/x/r.sh', 'claude', 'claude/issue-3']);
  });
});
