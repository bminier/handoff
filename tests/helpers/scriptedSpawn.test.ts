import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { fetchIssue } from '../../src/github.ts';
import { RunError, run } from '../../src/run.ts';
import { createScriptedSpawn, type ScriptedSpawn } from './scriptedSpawn.ts';

let spawn: ScriptedSpawn;

beforeEach(() => {
  spawn = createScriptedSpawn();
  spawn.install();
});

afterEach(() => {
  spawn.uninstall();
});

describe('scriptedSpawn', () => {
  it('returns scripted stdout for a matching argv', async () => {
    spawn.expect({
      command: 'git',
      argv: ['rev-parse', '--show-toplevel'],
      response: { stdout: '/tmp/some/repo\n' },
    });

    const result = await run('git', ['rev-parse', '--show-toplevel']);

    expect(result.stdout).toBe('/tmp/some/repo\n');
    expect(result.exitCode).toBe(0);
    expect(spawn.calls).toEqual([
      { command: 'git', args: ['rev-parse', '--show-toplevel'], cwd: undefined },
    ]);
  });

  it('rejects with RunError when the scripted exitCode is non-zero', async () => {
    spawn.expect({
      command: 'gh',
      argv: ['repo', 'view'],
      response: { stderr: 'gh: not authenticated', exitCode: 1 },
    });

    await expect(run('gh', ['repo', 'view'])).rejects.toBeInstanceOf(RunError);
  });

  it('fails loudly when no expectation matches the call', async () => {
    await expect(run('git', ['status'])).rejects.toThrow(/no expectation matched git status/);
    // The teardown check would otherwise re-throw on this same record;
    // we already asserted on the in-flight error, so drain it.
    expect(spawn.clearUnmatchedCalls().map((c) => c.args)).toEqual([['status']]);
  });

  it('uninstall throws when an unmatched call was swallowed by the caller', async () => {
    // The per-call 'error' event already fails an awaiting test — the case
    // this guards is when the code under test catches the error (e.g. a
    // cleanup() that maps subprocess failures to an 'unknown' result) and
    // keeps going. Without the teardown check, the test would pass with no
    // hint that an unsanctioned subprocess fired. Manage the fixture
    // locally so the outer afterEach doesn't see the leftover.
    const local = createScriptedSpawn();
    local.install();
    // Caller swallows the spawn-time error.
    await run('git', ['status']).catch(() => undefined);

    expect(() => local.uninstall()).toThrow(/unmatched call\(s\).*git status/);
    // Drained on throw — a follow-up uninstall must be a clean no-op.
    expect(() => local.uninstall()).not.toThrow();
  });

  it('uninstall throws when expectations were registered but never consumed', () => {
    // The test infra carve-out: this `it` manages its own fixture so the
    // outer beforeEach/afterEach pair (which would re-throw on a clean
    // teardown of the leftover) doesn't double-fire. A test that says
    // "this subprocess must run" and then never triggers it is exactly
    // the silent-pass bug strict uninstall is here to surface.
    const local = createScriptedSpawn();
    local.install();
    local.expect({
      command: 'gh',
      argv: ['repo', 'view'],
      response: { stdout: '{}' },
    });

    expect(() => local.uninstall()).toThrow(/unconsumed expectation\(s\).*gh repo view/);
    // Drained on throw — a follow-up uninstall must be a clean no-op so
    // the next `install()` (or a sibling fixture's teardown) doesn't
    // re-trip on the same leftovers.
    expect(() => local.uninstall()).not.toThrow();
  });

  it('consumes each expectation on match — a second identical call needs its own', async () => {
    // Pins the FIFO/consuming contract documented at the top of
    // scriptedSpawn.ts: registering one ticket allows exactly one
    // matching call, and a duplicate spawn fails the same way an
    // un-registered call would. Without this test, a regression that
    // reverted to non-consuming matching ("first registration satisfies
    // all calls") would silently let test code re-spawn the same
    // subprocess unnoticed.
    spawn.expect({
      command: 'git',
      argv: ['status'],
      response: { stdout: 'first\n' },
    });

    const first = await run('git', ['status']);
    expect(first.stdout).toBe('first\n');

    await expect(run('git', ['status'])).rejects.toThrow(/no expectation matched git status/);
    spawn.clearUnmatchedCalls();

    // Two registrations → two matching calls allowed, in registration order.
    spawn.expect({ command: 'git', argv: ['status'], response: { stdout: 'a\n' } });
    spawn.expect({ command: 'git', argv: ['status'], response: { stdout: 'b\n' } });
    expect((await run('git', ['status'])).stdout).toBe('a\n');
    expect((await run('git', ['status'])).stdout).toBe('b\n');
  });

  it('install() resets expectations and calls so reused fixtures start clean', async () => {
    spawn.expect({
      command: 'git',
      argv: ['status'],
      response: { stdout: 'phase one\n' },
    });
    await run('git', ['status']);
    expect(spawn.calls).toHaveLength(1);

    // Phase two: uninstall, reinstall same fixture. The phase-one expectation
    // and the phase-one recorded call should both be gone.
    spawn.uninstall();
    spawn.install();
    expect(spawn.calls).toEqual([]);
    await expect(run('git', ['status'])).rejects.toThrow(/no expectation matched/);
    spawn.clearUnmatchedCalls();
  });

  it("drives run()'s spawn-error path when response.error is set", async () => {
    // Synthetic ENOENT: the binary isn't on PATH. Node fires 'error' (never
    // 'close') and `run()` rejects with the raw Error — *not* a RunError,
    // since RunError is built from a close-event RunResult.
    const enoent = Object.assign(new Error('spawn handoff-nonexistent ENOENT'), {
      code: 'ENOENT',
    });
    spawn.expect({
      command: 'handoff-nonexistent',
      argv: ['--help'],
      response: { error: enoent },
    });

    const promise = run('handoff-nonexistent', ['--help']);
    await expect(promise).rejects.toBe(enoent);
    await expect(promise).rejects.not.toBeInstanceOf(RunError);
  });

  it('rejects with RunError when only a signal is set (matches Node close-on-signal)', async () => {
    spawn.expect({
      command: 'gh',
      argv: ['repo', 'view'],
      response: { signal: 'SIGTERM' },
    });

    await expect(run('gh', ['repo', 'view'])).rejects.toBeInstanceOf(RunError);
  });

  it('uninstall restores the previously-installed impl, not always real spawn', async () => {
    // The seam in run.ts saves the *previous* spawn at install time and
    // restores that — not unconditionally `nodeSpawn`. Without this test,
    // a regression that always restored the real spawn would still pass
    // every other case in this file (which only ever installs once) but
    // would silently let scriptedSpawn's afterEach clobber a sibling
    // fixture's install in any future stacked use.
    const fixtureA = createScriptedSpawn();
    fixtureA.install();
    fixtureA.expect({ command: 'git', argv: ['a'], response: { stdout: 'A\n' } });

    const fixtureB = createScriptedSpawn();
    fixtureB.install();
    fixtureB.expect({ command: 'git', argv: ['b'], response: { stdout: 'B\n' } });

    // While B is on top, calls go to B.
    await run('git', ['b']);
    expect(fixtureB.calls.map((c) => c.args)).toEqual([['b']]);
    expect(fixtureA.calls).toEqual([]);

    // Uninstall B — A must be active again, not the real spawn (which would
    // try to shell out to git for real and likely succeed, masking the bug).
    fixtureB.uninstall();
    await run('git', ['a']);
    expect(fixtureA.calls.map((c) => c.args)).toEqual([['a']]);

    fixtureA.uninstall();
  });

  it('expectGh wires a JSON response into a github.ts call', async () => {
    spawn.expectGh(['issue', 'view', '7', '--json', 'number,title,body,labels,url'], {
      number: 7,
      title: 'Loop mode',
      body: 'body',
      url: 'https://example.test/7',
      labels: [{ name: 'feature' }],
    });

    const issue = await fetchIssue(7);

    expect(issue).toEqual({
      number: 7,
      title: 'Loop mode',
      body: 'body',
      url: 'https://example.test/7',
      labels: ['feature'],
    });
  });
});
