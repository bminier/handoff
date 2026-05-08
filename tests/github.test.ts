import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { GhError, defaultBranch, fetchIssue, prMergedFor } from '../src/github.ts';
import type { HandoffError } from '../src/errors.ts';
import { createScriptedSpawn, type ScriptedSpawn } from './helpers/scriptedSpawn.ts';

let spawn: ScriptedSpawn;

beforeEach(() => {
  spawn = createScriptedSpawn();
  spawn.install();
});

afterEach(() => spawn.uninstall());

describe('fetchIssue', () => {
  const ARGV = ['issue', 'view', '7', '--json', 'number,title,body,labels,url'];

  it('parses a complete issue payload and flattens labels to names', async () => {
    spawn.expectGh(ARGV, {
      number: 7,
      title: 'Loop mode',
      body: 'body text',
      url: 'https://example.test/issues/7',
      labels: [{ name: 'feature' }, { name: 'good first issue' }],
    });

    const issue = await fetchIssue(7);

    expect(issue).toEqual({
      number: 7,
      title: 'Loop mode',
      body: 'body text',
      url: 'https://example.test/issues/7',
      labels: ['feature', 'good first issue'],
    });
  });

  it('drops malformed label entries instead of crashing', async () => {
    // gh has historically returned label entries as `{ name: '...' }` objects,
    // but the response is JSON parsed without a schema validator — a future
    // gh version emitting `null`, an unnamed entry, or a non-string `name`
    // would otherwise crash the caller. The flatMap path drops anything that
    // doesn't fit the contract; pin that here so a "helpful" simplification
    // back to `.map(l => l.name)` regresses noisily.
    spawn.expectGh(ARGV, {
      number: 7,
      title: 't',
      body: '',
      url: 'https://example.test/7',
      labels: [{ name: 'ok' }, null, { name: 42 }, {}, { name: 'also-ok' }],
    });

    const issue = await fetchIssue(7);
    expect(issue.labels).toEqual(['ok', 'also-ok']);
  });

  it('throws GhError when gh exits non-zero (e.g. issue not found)', async () => {
    spawn.expect({
      command: 'gh',
      argv: ARGV,
      response: { stderr: 'GraphQL: Could not resolve to an Issue (HTTP 404)', exitCode: 1 },
    });

    let err: unknown;
    try {
      await fetchIssue(7);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(GhError);
    expect((err as HandoffError).exitCode).toBe(2);
    expect((err as Error).message).toContain('gh issue view 7');
    expect((err as Error).message).toContain('Could not resolve to an Issue');
    // No auth-hint on a 404 — the regex looks for /authentication/i in stderr.
    expect((err as Error).message).not.toContain('gh auth login');
  });

  it('decorates auth failures with a `gh auth login` hint', async () => {
    // The hint is for the most common cause of `gh` exiting non-zero on a
    // dev box (authentication missing/expired). It nudges the user to fix
    // the env without a stack trace dive.
    spawn.expect({
      command: 'gh',
      argv: ARGV,
      response: { stderr: 'gh: authentication required', exitCode: 4 },
    });

    let err: unknown;
    try {
      await fetchIssue(7);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(GhError);
    expect((err as HandoffError).exitCode).toBe(1);
    expect((err as Error).message).toContain('(run `gh auth login`)');
  });

  it('throws GhError when the payload is missing required fields', async () => {
    // Defensive parsing: the stdout might be valid JSON but missing a field
    // (e.g. an old gh schema, or `gh` returning an empty object on a
    // permission-shaped failure). Without this branch the caller would
    // continue with `undefined` properties and crash later in renderPrompt
    // or branchName — much harder to diagnose than a clean GhError.
    spawn.expectGh(ARGV, { number: 7, title: 'no body' });

    let err: unknown;
    try {
      await fetchIssue(7);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(GhError);
    expect((err as Error).message).toContain('Unexpected gh issue payload');
  });

  it('returns an empty labels array when the field is omitted', async () => {
    spawn.expectGh(ARGV, {
      number: 7,
      title: 't',
      body: '',
      url: 'https://example.test/7',
      // no labels field at all
    });
    const issue = await fetchIssue(7);
    expect(issue.labels).toEqual([]);
  });
});

describe('defaultBranch', () => {
  const ARGV = ['repo', 'view', '--json', 'defaultBranchRef'];

  it('extracts the branch name from `gh repo view`', async () => {
    spawn.expectGh(ARGV, { defaultBranchRef: { name: 'dev' } });
    expect(await defaultBranch()).toBe('dev');
  });

  it('throws GhError when defaultBranchRef.name is missing', async () => {
    // Mirrors the fetchIssue defensive-parse case: a present-but-empty
    // payload should not silently produce an empty branch name that later
    // gets concatenated into a worktree path.
    spawn.expectGh(ARGV, { defaultBranchRef: {} });

    let err: unknown;
    try {
      await defaultBranch();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GhError);
    expect((err as Error).message).toContain('Could not resolve default branch');
  });

  it('throws GhError when the name is an empty string', async () => {
    spawn.expectGh(ARGV, { defaultBranchRef: { name: '' } });
    await expect(defaultBranch()).rejects.toBeInstanceOf(GhError);
  });
});

describe('prMergedFor', () => {
  function argvFor(branch: string): readonly string[] {
    return [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'merged',
      '--json',
      'number',
      '--limit',
      '1',
    ];
  }

  it('returns true when gh lists at least one merged PR for the branch', async () => {
    spawn.expectGh(argvFor('claude/issue-7'), [{ number: 12 }]);
    expect(await prMergedFor('claude/issue-7')).toBe(true);
  });

  it('returns false when gh returns an empty array (no merged PR)', async () => {
    // Either no PR exists at all, or one exists but is still open. With
    // `--state merged --limit 1`, gh emits `[]` for both cases — cleanup.ts
    // relies on that to keep the worktree retained until the PR actually
    // merges.
    spawn.expectGh(argvFor('codex/issue-9'), []);
    expect(await prMergedFor('codex/issue-9')).toBe(false);
  });

  it('forwards the cwd opt to gh so production cleanup runs from outside the doomed worktree', async () => {
    // The cleanup-from-worktree fix in #46 wires opts.cwd through every
    // gh/git call. If a regression dropped it from prMergedFor, the
    // production runner would shell out to gh from inside a directory
    // that's about to be removed — once `git worktree remove` succeeds the
    // cwd points at nothing.
    spawn.expectGh(argvFor('claude/issue-1'), [{ number: 1 }]);
    await prMergedFor('claude/issue-1', { cwd: '/work/repo' });
    expect(spawn.calls).toEqual([
      { command: 'gh', args: [...argvFor('claude/issue-1')], cwd: '/work/repo' },
    ]);
  });

  it('surfaces a GhError when gh fails (e.g. not authenticated)', async () => {
    spawn.expect({
      command: 'gh',
      argv: argvFor('claude/issue-1'),
      response: { stderr: 'authentication required', exitCode: 4 },
    });

    let err: unknown;
    try {
      await prMergedFor('claude/issue-1');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GhError);
    expect((err as Error).message).toContain('gh auth login');
  });
});
