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
