/**
 * Scripted-spawn fixture for I/O modules that shell out via `run.ts`.
 *
 * Each expectation matches one `(command, argv)` invocation exactly. The
 * fixture records calls in order, in case the test wants to assert which
 * subprocesses were spawned and with what arguments.
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
import type { ChildProcess } from 'node:child_process';

import { __setSpawnForTesting } from '../../src/run.ts';

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
  /** Restore the real spawn. Always call from `afterEach`. */
  uninstall(): void;
  /** Register a `(command, argv) → response` mapping. Last write wins. */
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

function findExpectation(
  expectations: readonly ScriptedExpectation[],
  command: string,
  args: readonly string[],
): ScriptedExpectation | undefined {
  // Walk in reverse so a later-registered expectation overrides an earlier one
  // for the same (command, argv) pair — matches "last write wins".
  for (let i = expectations.length - 1; i >= 0; i -= 1) {
    const e = expectations[i];
    if (e && e.command === command && argvEqual(e.argv, args)) return e;
  }
  return undefined;
}

function fakeChild(response: ScriptedResponse): ChildProcess {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  // setImmediate ensures the test code has a chance to attach 'data' / 'close'
  // listeners before we emit. (`run.ts` attaches synchronously after spawn,
  // but that's an implementation detail we don't want this fixture to rely on.)
  setImmediate(() => {
    if (response.error) {
      // Spawn-level failure (ENOENT etc.): Node only fires 'error', never
      // 'close', so don't emit any stdout/stderr/close — `run()` rejects
      // straight from its 'error' handler.
      child.emit('error', response.error);
      return;
    }
    if (response.stdout) stdout.emit('data', Buffer.from(response.stdout, 'utf8'));
    if (response.stderr) stderr.emit('data', Buffer.from(response.stderr, 'utf8'));
    // Match Node's contract: when a child is terminated by a signal, `close`
    // fires with `code === null`. Otherwise it fires with the explicit exit
    // code (or 0). Without this branch a `response: { signal: 'SIGTERM' }`
    // test would resolve in run.ts as if the process had exited cleanly.
    const code = response.signal ? null : (response.exitCode ?? 0);
    child.emit('close', code, response.signal ?? null);
  });

  return Object.assign(child, { stdout, stderr }) as unknown as ChildProcess;
}

function unmatchedChild(command: string, args: readonly string[]): ChildProcess {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  setImmediate(() => {
    child.emit(
      'error',
      new Error(
        `scriptedSpawn: no expectation matched ${command} ${args.join(' ')}\n` +
          `  Register one with spawn.expect({ command, argv, response })`,
      ),
    );
  });

  return Object.assign(child, { stdout, stderr }) as unknown as ChildProcess;
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
        const match = findExpectation(expectations, command, args);
        return match ? fakeChild(match.response) : unmatchedChild(command, args);
      });
    },
    uninstall() {
      if (!restore) return;
      restore();
      restore = null;
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
