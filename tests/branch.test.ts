import { describe, expect, it } from 'bun:test';
import { branchName, branchTail, isHandoffBranch, worktreePath } from '../src/branch.ts';
import { slugify } from '../src/slug.ts';

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

describe('isHandoffBranch', () => {
  // Source-of-truth contract: the branch name is one branchName() could
  // have produced. Used by `cleanup --force` to refuse arbitrary branches
  // — the merge-check is the safety property without --force; this is
  // the substitute when --force is on.

  it('accepts every issue-form branch from branchName()', () => {
    for (const tool of ['claude', 'codex', 'copilot'] as const) {
      expect(isHandoffBranch(branchName({ tool, issueNumber: 1 }))).toBe(true);
      expect(isHandoffBranch(branchName({ tool, issueNumber: 9999 }))).toBe(true);
    }
  });

  it('accepts every pr-form branch from branchName()', () => {
    for (const tool of ['claude', 'codex', 'copilot'] as const) {
      expect(isHandoffBranch(branchName({ tool, prNumber: 42 }))).toBe(true);
    }
  });

  it('accepts free-form slug branches that branchName + slugify could emit', () => {
    // The contract is "isHandoffBranch is true iff branchName() could have
    // produced this string". slugify() emits kebab-case; round-trip a
    // representative sample of titles through both to pin the contract.
    const titles = [
      'Fix the README typo',
      'cleanup-readme', // already-slugged
      'feature 2 — something',
      'Numbers 123 in title',
    ];
    for (const title of titles) {
      const slug = slugify(title, { maxLen: 20 });
      const branch = branchName({ tool: 'claude', slug });
      expect(isHandoffBranch(branch)).toBe(true);
    }
  });

  it('rejects an unrelated local branch name (the cleanup --force foot-gun)', () => {
    // The codex-challenge finding: `handoff cleanup --force experiment`
    // would have happily run `git branch -D experiment`. Refusal here
    // is what stops it at the args layer.
    expect(isHandoffBranch('experiment')).toBe(false);
    expect(isHandoffBranch('main')).toBe(false);
    expect(isHandoffBranch('dev')).toBe(false);
    expect(isHandoffBranch('feature/login-redirect')).toBe(false);
  });

  it('rejects unknown tool prefixes', () => {
    // Prevents future name collisions and "looks-like-a-handoff" typos.
    expect(isHandoffBranch('cursor/issue-7')).toBe(false);
    expect(isHandoffBranch('ai/issue-7')).toBe(false);
  });

  it('rejects malformed tails', () => {
    expect(isHandoffBranch('claude/')).toBe(false); // empty tail
    expect(isHandoffBranch('claude/-leading-dash')).toBe(false); // leading dash in slug
    expect(isHandoffBranch('claude/trailing-dash-')).toBe(false); // trailing dash
    expect(isHandoffBranch('claude/double--dash')).toBe(false); // slugify never emits these
    expect(isHandoffBranch('claude/UPPERCASE')).toBe(false); // slugify lowercases
    // Note: `claude/issue-abc` and `claude/issue-` are NOT in this list
    // because they're valid *slug-form* branches (a user running
    // `handoff claude "issue abc"` would slugify to `issue-abc`). The
    // issue-form (`issue-<N>`) requires digits, but the slug alternation
    // legitimately covers strings that visually look issue-like.
  });

  it('rejects empty / whitespace / leading or trailing slash', () => {
    expect(isHandoffBranch('')).toBe(false);
    expect(isHandoffBranch(' ')).toBe(false);
    expect(isHandoffBranch('/claude/issue-7')).toBe(false);
    expect(isHandoffBranch('claude/issue-7/')).toBe(false);
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
