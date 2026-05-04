/**
 * Scripted-spawn fixture for I/O modules that shell out via `run.ts`.
 *
 * Each `expect()` registers a `(command, argv) → response` mapping.
 * Matching is *consuming* and FIFO: a call matches the first registered
 * expectation that fits, and the expectation is removed once it fires.
 * If the same subprocess is expected twice, register two expectations.
 * If a call has no matching expectation — including a duplicate that
 * already consumed its match — the spawn emits an `error` event and the
 * test fails loudly. `uninstall()` also throws if any expectations were
 * never consumed, so a "this should have happened but didn't" bug
 * doesn't slip through as a silently-passing test.
 *
 * Usage:
 *
 * ```ts
 * const spawn = createScriptedSpawn();
 * spawn.install();
 * spawn.expect({ command: 'gh', argv: ['repo', 'view'], response: { stdout: '...' } });
 * // ...exercise code that calls run('gh', ['repo', 'view'])...
 * spawn.uninstall();
 * ```
 *
 * For tests that exercise `git.ts` directly — where the contract under test
 * is git's actual behaviour, not the wrapper — use `tempRepo.ts` instead.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { __setSpawnForTesting, type PipedChildProcess } from '../../src/run.ts';

export interface ScriptedResponse {
  stdout?: string;
  stderr?: string;
  /** Defaults to 0 (success). Non-zero causes `run()` to reject with `RunError`. */
  exitCode?: number;
  /** Optional emitted signal (rare; use for SIGTERM-style tests). */
  signal?: NodeJS.Signals;
  /**
   * Drive `run()`'s `child.on('error', ...)` path instead of `close` —
   * the branch Node fires for spawn-level failures like ENOENT (binary not
   * on PATH). Mutually exclusive with stdout/stderr/exitCode/signal; if set,
   * those are ignored. Use this for tests that need to assert the wrapper's
   * behaviour when the subprocess never starts.
   */
  error?: Error;
}

export interface ScriptedExpectation {
  command: string;
  argv: readonly string[];
  response: ScriptedResponse;
}

export interface ScriptedCall {
  command: string;
  args: readonly string[];
  cwd: string | undefined;
}

export interface ScriptedSpawn {
  /**
   * Replace the spawn used by `run.ts` and reset recorded `calls` plus any
   * registered `expectations`. Idempotent: a second `install()` with no
   * intervening `uninstall()` is a no-op (state is *not* re-cleared).
   */
  install(): void;
  /**
   * Pop this fixture's spawn override. Restores whatever impl was active
   * when `install()` ran — which is the real `spawn` for a single-fixture
   * test, but a sibling scripted-spawn fixture under stacked use. Always
   * call from `afterEach` so the override doesn't leak past the test.
   *
   * Throws if any registered expectations were never consumed. An
   * unconsumed expectation means the test claimed a subprocess would run
   * and it didn't — surfacing that loudly catches "the code stopped
   * spawning what we expected" regressions that a passive call-count
   * assertion would miss.
   */
  uninstall(): void;
  /**
   * Register a `(command, argv) → response` mapping. Each `expect()` adds
   * one ticket; calls consume tickets FIFO. Register N times to allow N
   * matching invocations.
   */
  expect(expectation: ScriptedExpectation): void;
  /** Register a `gh` invocation that returns a JSON payload as stdout. */
  expectGh(argv: readonly string[], jsonBody: unknown): void;
  /** Calls observed since the most recent `install()`, in order. */
  calls: ScriptedCall[];
}

function argvEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function consumeExpectation(
  expectations: ScriptedExpectation[],
  command: string,
  args: readonly string[],
): ScriptedExpectation | undefined {
  // FIFO: the first registered expectation that matches wins, and is
  // removed so a second identical call has to find its own ticket. Tests
  // that legitimately need N invocations register N expectations.
  for (let i = 0; i < expectations.length; i += 1) {
    const e = expectations[i];
    if (e && e.command === command && argvEqual(e.argv, args)) {
      expectations.splice(i, 1);
      return e;
    }
  }
  return undefined;
}

function fakeChild(response: ScriptedResponse): PipedChildProcess {
  const child = new EventEmitter();
  // PassThrough is a real `stream.Readable` (and Writable), so the cast
  // below isn't lying about the contract: any future `run()` change that
  // uses standard stream APIs (`.pipe()`, `.read()`, `for await`) keeps
  // working against the fake. `run()` only listens for `'data'` today,
  // but the fixture is shared infra and shouldn't be the brittle hop.
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  // setImmediate ensures the test code has a chance to attach 'data' / 'close'
  // listeners before we emit. (`run.ts` attaches synchronously after spawn,
  // but that's an implementation detail we don't want this fixture to rely on.)
  setImmediate(() => {
    if (response.error) {
      // Spawn-level failure (ENOENT etc.): Node only fires 'error', never
      // 'close', so end the streams as part of the synthetic-failure
      // exit and skip the close event — `run()` rejects straight from
      // its 'error' handler.
      stdout.end();
      stderr.end();
      child.emit('error', response.error);
      return;
    }
    if (response.stdout) stdout.write(Buffer.from(response.stdout, 'utf8'));
    if (response.stderr) stderr.write(Buffer.from(response.stderr, 'utf8'));
    stdout.end();
    stderr.end();
    // Match Node's contract: when a child is terminated by a signal, `close`
    // fires with `code === null`. Otherwise it fires with the explicit exit
    // code (or 0). Without this branch a `response: { signal: 'SIGTERM' }`
    // test would resolve in run.ts as if the process had exited cleanly.
    const code = response.signal ? null : (response.exitCode ?? 0);
    child.emit('close', code, response.signal ?? null);
  });

  return Object.assign(child, { stdout, stderr }) as unknown as PipedChildProcess;
}

function unmatchedChild(command: string, args: readonly string[]): PipedChildProcess {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  setImmediate(() => {
    stdout.end();
    stderr.end();
    child.emit(
      'error',
      new Error(
        `scriptedSpawn: no expectation matched ${command} ${args.join(' ')}\n` +
          `  Register one with spawn.expect({ command, argv, response })`,
      ),
    );
  });

  return Object.assign(child, { stdout, stderr }) as unknown as PipedChildProcess;
}

export function createScriptedSpawn(): ScriptedSpawn {
  const expectations: ScriptedExpectation[] = [];
  const calls: ScriptedCall[] = [];
  let restore: (() => void) | null = null;

  const fixture: ScriptedSpawn = {
    calls,
    install() {
      if (restore) return;
      // Reset on every fresh install so a fixture reused across phases
      // (uninstall + reinstall) honours the documented "calls since the
      // most recent install()" contract instead of accumulating state from
      // earlier phases. Mutate in place — `fixture.calls` is a reference.
      expectations.length = 0;
      calls.length = 0;
      restore = __setSpawnForTesting((command, args, options) => {
        calls.push({ command, args: [...args], cwd: options.cwd as string | undefined });
        const match = consumeExpectation(expectations, command, args);
        return match ? fakeChild(match.response) : unmatchedChild(command, args);
      });
    },
    uninstall() {
      if (!restore) return;
      restore();
      restore = null;
      // Strict teardown: an `expect()` registration that never fires is a
      // silent test bug — the test claimed "this subprocess will happen"
      // and would still pass if the code stopped spawning it. Drain the
      // queue *before* throwing so a subsequent `install()` starts clean
      // even if afterEach fails here. Spawn is already restored above, so
      // unrelated tests aren't polluted by this throw.
      const leftovers = expectations.splice(0);
      if (leftovers.length > 0) {
        const detail = leftovers.map((e) => `${e.command} ${e.argv.join(' ')}`).join('; ');
        throw new Error(
          `scriptedSpawn: ${leftovers.length} unconsumed expectation(s) at uninstall: ${detail}`,
        );
      }
    },
    expect(expectation) {
      expectations.push({
        command: expectation.command,
        argv: [...expectation.argv],
        response: { ...expectation.response },
      });
    },
    expectGh(argv, jsonBody) {
      fixture.expect({
        command: 'gh',
        argv,
        response: { stdout: JSON.stringify(jsonBody) },
      });
    },
  };

  return fixture;
}
