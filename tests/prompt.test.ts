import { describe, expect, it } from 'bun:test';
import { renderPrompt } from '../src/prompt.ts';

describe('renderPrompt', () => {
  it('renders an issue-backed handoff', () => {
    const out = renderPrompt({
      tool: 'claude',
      repoName: 'handoff',
      branch: 'claude/issue-1',
      parentBranch: 'dev',
      worktreePath: '/work/handoff-handoff-1-fix-login',
      issue: {
        number: 1,
        title: 'Fix login redirect',
        body: 'After SSO, users are sent to /dashboard instead of the original URL.',
        url: 'https://github.com/x/y/issues/1',
        labels: ['bug', 'auth'],
      },
    });
    expect(out).toContain('# Handoff: handoff');
    expect(out).toContain('## Issue #1: Fix login redirect');
    expect(out).toContain('After SSO, users are sent to /dashboard');
    expect(out).toContain('Workflow contract');
    expect(out).toContain('claude/issue-1');
    expect(out).toContain('**Labels:** `bug`, `auth`');
  });

  it('omits the Labels line when there are no labels', () => {
    const out = renderPrompt({
      tool: 'claude',
      repoName: 'handoff',
      branch: 'claude/issue-1',
      parentBranch: 'dev',
      worktreePath: '/tmp/x',
      issue: {
        number: 1,
        title: 'X',
        body: 'body',
        url: 'https://github.com/x/y/issues/1',
        labels: [],
      },
    });
    expect(out).not.toContain('**Labels:**');
  });

  it('renders a free-form handoff', () => {
    const out = renderPrompt({
      tool: 'codex',
      repoName: 'handoff',
      branch: 'codex/cleanup-readme',
      parentBranch: 'dev',
      worktreePath: '/work/handoff-cleanup-readme',
      freeformDescription: 'Tidy up the README and add a usage example.',
    });
    expect(out).toContain('## Task');
    expect(out).toContain('Tidy up the README');
    expect(out).not.toContain('## Issue');
  });

  it('handles an empty issue body gracefully', () => {
    const out = renderPrompt({
      tool: 'copilot',
      repoName: 'handoff',
      branch: 'copilot/issue-2',
      parentBranch: 'dev',
      worktreePath: '/tmp/x',
      issue: {
        number: 2,
        title: 'Noop',
        body: '',
        url: 'https://github.com/x/y/issues/2',
      },
    });
    expect(out).toContain('_(no body)_');
  });
});
