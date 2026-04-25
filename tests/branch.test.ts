import { describe, expect, it } from 'bun:test';
import { branchName, branchTail, worktreePath } from '../src/branch.ts';

describe('branchName', () => {
  it('builds an issue branch with number prefix', () => {
    expect(branchName({ tool: 'claude', issueNumber: 7, slug: 'fix-login' })).toBe(
      'handoff/claude/7-fix-login',
    );
  });

  it('builds a freeform branch without number', () => {
    expect(branchName({ tool: 'codex', slug: 'cleanup-readme' })).toBe(
      'handoff/codex/cleanup-readme',
    );
  });
});

describe('branchTail', () => {
  it('extracts everything after handoff/<tool>/', () => {
    expect(branchTail('handoff/claude/7-fix-login')).toBe('7-fix-login');
  });
});

describe('worktreePath', () => {
  it('places the worktree as a sibling of the repo', () => {
    const out = worktreePath({
      repoRoot: '/work/handoff',
      branch: 'handoff/claude/7-fix-login',
    });
    expect(out.replace(/\\/g, '/')).toBe('/work/handoff-handoff-7-fix-login');
  });
});
