import { describe, expect, it } from 'bun:test';
import { branchName, branchTail, worktreePath } from '../src/branch.ts';

describe('branchName', () => {
  it('builds an issue branch as <tool>/issue-<N>', () => {
    expect(branchName({ tool: 'claude', issueNumber: 7 })).toBe('claude/issue-7');
  });

  it('builds a PR branch as <tool>/pr-<N>', () => {
    expect(branchName({ tool: 'codex', prNumber: 12 })).toBe('codex/pr-12');
  });

  it('builds a free-form branch as <tool>/<slug>', () => {
    expect(branchName({ tool: 'codex', slug: 'cleanup-readme' })).toBe('codex/cleanup-readme');
  });

  it('throws when given neither issueNumber nor prNumber nor slug', () => {
    expect(() => branchName({ tool: 'claude' })).toThrow();
  });
});

describe('branchTail', () => {
  it('extracts everything after the first slash', () => {
    expect(branchTail('claude/issue-7')).toBe('issue-7');
    expect(branchTail('codex/pr-12')).toBe('pr-12');
    expect(branchTail('claude/cleanup-readme')).toBe('cleanup-readme');
  });

  it('returns the input unchanged when there is no slash', () => {
    expect(branchTail('rogue')).toBe('rogue');
  });
});

describe('worktreePath', () => {
  it('places the worktree as a sibling of the repo, named <repo>-<branch-tail>', () => {
    const out = worktreePath({
      repoRoot: '/work/handoff',
      branch: 'claude/issue-7',
    });
    expect(out.replace(/\\/g, '/')).toBe('/work/handoff-issue-7');
  });

  it('handles PR branches', () => {
    const out = worktreePath({
      repoRoot: '/work/scope',
      branch: 'codex/pr-12',
    });
    expect(out.replace(/\\/g, '/')).toBe('/work/scope-pr-12');
  });
});
