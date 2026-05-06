import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { SpawnOptions } from 'node:child_process';

import { __setSpawnForTesting, RunError, run, type PipedChildProcess } from '../src/run.ts';
import { createScriptedSpawn, type ScriptedSpawn } from './helpers/scriptedSpawn.ts';

describe('run() default spawn (production path)', () => {
  it('shells out via the real node:child_process.spawn wrapper', async () => {
    // All the scriptedSpawn tests install a fake spawn in beforeEach, which
    // bypasses `spawnImpl = pipedNodeSpawn`. That's the wiring every CLI
    // caller actually uses, so a regression in the default — the wrapper
    // around node:child_process.spawn that narrows the nullable streams —
    // would ship unnoticed.
    //
    // `git --version` is the most portable real subprocess we have: git is
    // required by tempRepo (so it's already present everywhere this suite
    // runs), the output format is stable, and the call has no side effects
    // on the working tree.
    const result = await run('git', ['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^git version /);
    expect(result.stderr).toBe('');
  });
});

describe('run() — error shapes', () => {
  let spawn: ScriptedSpawn;

  beforeEach(() => {
    spawn = createScriptedSpawn();
    spawn.install();
  });
  afterEach(() => spawn.uninstall());

  it('rejects non-zero exits with RunError that preserves stdout/stderr/exitCode', async () => {
    spawn.expect({
      command: 'gh',
      argv: ['repo', 'view'],
      response: {
        stdout: 'partial output',
        stderr: 'gh: not authenticated',
        exitCode: 4,
      },
    });

    let err: unknown;
    try {
      await run('gh', ['repo', 'view']);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(RunError);
    const re = err as RunError;
    // The fields on RunError are the contract callers like github.ts read
    // (`gh()` checks `err.stderr` for the auth-hint regex). A regression that
    // dropped them or routed through `error.cause` would bypass that branch.
    expect(re.stdout).toBe('partial output');
    expect(re.stderr).toBe('gh: not authenticated');
    expect(re.exitCode).toBe(4);
    expect(re.name).toBe('RunError');
    // Message format pins the renderer — `gh()` already trims and concatenates
    // it; the format is what users read when a subprocess fails outside of the
    // wrapped paths (e.g. a bare git call from cli.ts).
    expect(re.message).toContain('Command failed: gh repo view');
    expect(re.message).toContain('exit 4');
    expect(re.message).toContain('gh: not authenticated');
  });

  it('maps signal-only exits to exitCode 128 (matches Node close-on-signal contract)', async () => {
    // node emits `close` with `code === null, signal === 'SIGTERM'` when a
    // child is killed by a signal. run.ts maps that to exitCode 128 so a
    // signaled subprocess always rejects through the RunError branch.
    spawn.expect({
      command: 'gh',
      argv: ['issue', 'view', '1'],
      response: { signal: 'SIGTERM' },
    });

    let err: unknown;
    try {
      await run('gh', ['issue', 'view', '1']);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(RunError);
    expect((err as RunError).exitCode).toBe(128);
  });

  it('rejects with the raw Error (not RunError) on spawn-level failures', async () => {
    // Node fires only `'error'` (never `'close'`) for ENOENT and friends.
    // Routing those through RunError would lose the `code: 'ENOENT'` marker
    // callers like the terminal-spawn fallback chain rely on to decide
    // whether the next candidate is worth trying.
    const enoent = Object.assign(new Error('spawn no-such-binary ENOENT'), {
      code: 'ENOENT',
    });
    spawn.expect({
      command: 'no-such-binary',
      argv: ['--help'],
      response: { error: enoent },
    });

    const promise = run('no-such-binary', ['--help']);
    await expect(promise).rejects.toBe(enoent);
    await expect(promise).rejects.not.toBeInstanceOf(RunError);
  });
});

describe('run() — spawn options', () => {
  // Capture-only fake: scriptedSpawn focuses on argv + canned responses; for
  // these tests the contract is the *options* arg run() passes to spawn
  // (cwd, env, stdio, shell). Hook __setSpawnForTesting directly so the
  // recorded SpawnOptions are first-class.
  let recorded: SpawnOptions[];
  let restore: (() => void) | null;

  beforeEach(() => {
    recorded = [];
    restore = __setSpawnForTesting((_command, _args, options) => {
      recorded.push(options);
      const child = new EventEmitter();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      setImmediate(() => {
        stdout.end();
        stderr.end();
        child.emit('close', 0, null);
      });
      return Object.assign(child, { stdout, stderr }) as unknown as PipedChildProcess;
    });
  });
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('forwards cwd to the underlying spawn', async () => {
    await run('git', ['status'], { cwd: '/work/some/repo' });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.cwd).toBe('/work/some/repo');
  });

  it('defaults env to process.env when no override is given', async () => {
    await run('git', ['status']);
    expect(recorded[0]?.env).toBe(process.env);
  });

  it('forwards an explicit env override and does not merge process.env', async () => {
    // run() doesn't merge — the caller is responsible for passing a full env
    // if they want one. Pinning this contract guards against a regression
    // that "helpfully" spreads process.env into the override (which would
    // leak surprise vars to subprocesses).
    const env = { PATH: '/test-only', HOME: '/tmp' };
    await run('git', ['status'], { env });
    expect(recorded[0]?.env).toBe(env);
  });

  it('always pipes stdout/stderr and disables shell interpolation', async () => {
    // `shell: false` is a security-relevant default — every caller in src/
    // passes argv arrays, and a regression to `shell: true` would re-open
    // the shell-injection surface CLAUDE.md explicitly forbids ("No shell
    // interpolation in TS"). stdio piping is what makes the .stdout/.stderr
    // streams reachable; without it run() would deadlock on the data
    // listeners.
    await run('git', ['status']);
    expect(recorded[0]?.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(recorded[0]?.shell).toBe(false);
  });
});

describe('run() — output handling', () => {
  // Drive run() with a fake that emits stdout/stderr in multiple chunks
  // before close, so the buffering loop gets exercised — a regression that
  // overwrote instead of concatenating would silently truncate output for
  // any subprocess large enough to span buffer boundaries.
  let restore: (() => void) | null;

  function makeChunkedSpawn(opts: {
    stdoutChunks: string[];
    stderrChunks: string[];
    exitCode: number;
  }) {
    return ((_command: string, _args: readonly string[], _options: SpawnOptions) => {
      const child = new EventEmitter();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      setImmediate(() => {
        for (const chunk of opts.stdoutChunks) stdout.write(Buffer.from(chunk, 'utf8'));
        for (const chunk of opts.stderrChunks) stderr.write(Buffer.from(chunk, 'utf8'));
        stdout.end();
        stderr.end();
        child.emit('close', opts.exitCode, null);
      });
      return Object.assign(child, { stdout, stderr }) as unknown as PipedChildProcess;
    }) satisfies Parameters<typeof __setSpawnForTesting>[0];
  }

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('concatenates multi-chunk stdout/stderr in arrival order', async () => {
    restore = __setSpawnForTesting(
      makeChunkedSpawn({
        stdoutChunks: ['hello, ', 'world', '\n'],
        stderrChunks: ['warn:', ' minor\n'],
        exitCode: 0,
      }),
    );

    const result = await run('echo', ['hi']);
    expect(result.stdout).toBe('hello, world\n');
    expect(result.stderr).toBe('warn: minor\n');
    expect(result.exitCode).toBe(0);
  });

  it('preserves multi-chunk output on the RunError when the process exits non-zero', async () => {
    restore = __setSpawnForTesting(
      makeChunkedSpawn({
        stdoutChunks: ['first', 'second'],
        stderrChunks: ['err-a ', 'err-b'],
        exitCode: 2,
      }),
    );

    let err: unknown;
    try {
      await run('failing', ['--bad']);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(RunError);
    expect((err as RunError).stdout).toBe('firstsecond');
    expect((err as RunError).stderr).toBe('err-a err-b');
    expect((err as RunError).exitCode).toBe(2);
  });
});
