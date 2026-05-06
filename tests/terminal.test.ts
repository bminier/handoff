import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import {
  TerminalError,
  buildLaunchSpec,
  openTerminalOn,
  type TerminalSpawnFn,
} from '../src/terminal.ts';

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

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
}

/**
 * Build a spawn fake that records every invocation. Each entry in
 * `failOrder` is consumed FIFO: `null` succeeds (fake child stays
 * silent — `spawnDetached` resolves on its 50ms unref timer), and an
 * `Error` is emitted asynchronously so `child.on('error', reject)`
 * fires the rejection branch in `spawnDetached`. Anything past the
 * scripted prefix succeeds by default.
 */
function recordingSpawn(failOrder: ReadonlyArray<Error | null>): {
  spawn: TerminalSpawnFn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  let i = 0;
  const spawn: TerminalSpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => {};
    const outcome = i < failOrder.length ? failOrder[i] : null;
    i += 1;
    if (outcome) {
      // Emit on the next tick so the caller's `child.on('error', ...)`
      // listener is wired up before the event fires (matches real Node).
      setImmediate(() => child.emit('error', outcome));
    }
    return child as unknown as ChildProcess;
  };
  return { spawn, calls };
}

describe('openTerminalOn (spawn wiring)', () => {
  const baseInput = {
    cwd: '/work/repo',
    scriptPath: '/work/repo/runner.sh',
    args: ['claude', 'claude/issue-1'],
  };

  it('linux: spawns gnome-terminal first with the buildLaunchSpec argv', async () => {
    const { spawn, calls } = recordingSpawn([]);
    await openTerminalOn('linux', { ...baseInput, spawn });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('gnome-terminal');
    expect(calls[0]?.args).toEqual([
      '--working-directory',
      '/work/repo',
      '--',
      'bash',
      '/work/repo/runner.sh',
      'claude',
      'claude/issue-1',
    ]);
    // Detached + stdio:'ignore' is what makes the spawned terminal survive
    // after the CLI exits; shell:false avoids the shell-injection surface.
    expect(calls[0]?.options.detached).toBe(true);
    expect(calls[0]?.options.stdio).toBe('ignore');
    expect(calls[0]?.options.shell).toBe(false);
  });

  it('linux: falls back to konsole, then xterm, when earlier candidates ENOENT', async () => {
    // Many CI hosts only have `xterm`; the fallback chain is what makes
    // openTerminal usable in those environments. Pin it: each prior
    // candidate must be tried before settling on the one that exists.
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const { spawn, calls } = recordingSpawn([enoent, enoent]);
    await openTerminalOn('linux', { ...baseInput, spawn });

    expect(calls.map((c) => c.command)).toEqual(['gnome-terminal', 'konsole', 'xterm']);
    // The xterm leg uses `-e program args...` (separate argv items, not
    // a shell string) — buildLaunchSpec covers this in unit tests above,
    // but pinning it through the spawn boundary catches a regression in
    // the candidate-loop wiring even if buildLaunchSpec stays correct.
    expect(calls[2]?.args).toEqual([
      '-e',
      'bash',
      '/work/repo/runner.sh',
      'claude',
      'claude/issue-1',
    ]);
  });

  it('win32: spawns wt.exe first; falls back to cmd.exe when wt is missing', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const { spawn, calls } = recordingSpawn([enoent]);
    await openTerminalOn('win32', {
      cwd: 'C:\\work\\repo',
      scriptPath: 'C:\\work\\repo\\runner.ps1',
      args: ['claude', 'claude/issue-1'],
      spawn,
    });

    expect(calls.map((c) => c.command)).toEqual(['wt.exe', 'cmd.exe']);
    expect(calls[0]?.args).toContain('powershell.exe');
    expect(calls[0]?.args).toContain('C:\\work\\repo\\runner.ps1');
    // cmd fallback uses `start ""` so the new window doesn't inherit the
    // parent console — pin that argv shape so a regression doesn't
    // silently turn the launch into a foreground process.
    expect(calls[1]?.args.slice(0, 3)).toEqual(['/c', 'start', '""']);
  });

  it('darwin: spawns osascript with the AppleScript do-script payload', async () => {
    const { spawn, calls } = recordingSpawn([]);
    await openTerminalOn('darwin', {
      cwd: '/Users/x/repo',
      scriptPath: '/Users/x/repo/runner.sh',
      args: ['codex', 'codex/issue-2'],
      spawn,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('osascript');
    expect(calls[0]?.args[0]).toBe('-e');
    const script = calls[0]?.args[1] ?? '';
    expect(script).toContain('tell application "Terminal"');
    expect(script).toContain('/Users/x/repo/runner.sh');
    expect(script).toContain('codex');
  });

  it('throws TerminalError carrying the last spawn error when every candidate fails', async () => {
    const errA = new Error('gnome-terminal: ENOENT');
    const errB = new Error('konsole: ENOENT');
    const errC = new Error('xterm: ENOENT');
    const { spawn } = recordingSpawn([errA, errB, errC]);

    let err: unknown;
    try {
      await openTerminalOn('linux', { ...baseInput, spawn });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(TerminalError);
    // Surface the last error: openTerminal can't usefully tell the user
    // about all three (they're usually the same ENOENT shape) but the
    // tail is the one most likely to point at a real config issue.
    expect((err as Error).message).toContain('xterm: ENOENT');
  });

  it('throws TerminalError on an unsupported platform without invoking spawn', async () => {
    const { spawn, calls } = recordingSpawn([]);
    await expect(
      openTerminalOn('aix' as NodeJS.Platform, { ...baseInput, spawn }),
    ).rejects.toBeInstanceOf(TerminalError);
    expect(calls).toEqual([]);
  });
});
