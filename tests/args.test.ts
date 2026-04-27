import { describe, expect, it } from 'bun:test';
import { ArgsError, parseInvocation } from '../src/args.ts';

describe('parseInvocation', () => {
  it('parses a single #N reference', () => {
    const out = parseInvocation(['claude', '#1']);
    expect(out).toEqual({ tool: 'claude', refs: [{ kind: 'issue', number: 1 }], loop: false });
  });

  it('parses "Issue #N" two-token form', () => {
    const out = parseInvocation(['copilot', 'Issue', '#2']);
    expect(out).toEqual({ tool: 'copilot', refs: [{ kind: 'issue', number: 2 }], loop: false });
  });

  it('parses fleet (multiple #N)', () => {
    const out = parseInvocation(['claude', '#1', '#2', '#3']);
    expect(out).toEqual({
      tool: 'claude',
      refs: [
        { kind: 'issue', number: 1 },
        { kind: 'issue', number: 2 },
        { kind: 'issue', number: 3 },
      ],
      loop: false,
    });
  });

  it('treats anything else as free-form text', () => {
    const out = parseInvocation(['codex', 'fix', 'login', 'redirect', 'bug']);
    expect(out).toEqual({
      tool: 'codex',
      refs: [{ kind: 'freeform', text: 'fix login redirect bug' }],
      loop: false,
    });
  });

  it('parses --loop for claude', () => {
    const out = parseInvocation(['claude', '--loop', '#7']);
    expect(out).toEqual({
      tool: 'claude',
      refs: [{ kind: 'issue', number: 7 }],
      loop: true,
    });
  });

  it('parses --loop with a fleet of refs', () => {
    const out = parseInvocation(['claude', '--loop', '#1', '#2']);
    expect(out).toEqual({
      tool: 'claude',
      refs: [
        { kind: 'issue', number: 1 },
        { kind: 'issue', number: 2 },
      ],
      loop: true,
    });
  });

  it('rejects --loop for codex', () => {
    expect(() => parseInvocation(['codex', '--loop', '#1'])).toThrow(/--loop is only supported/);
  });

  it('rejects --loop for copilot', () => {
    expect(() => parseInvocation(['copilot', '--loop', '#1'])).toThrow(/--loop is only supported/);
  });

  it('keeps --loop literal once free-form text has started', () => {
    // Once a non-flag token appears, later tokens are part of the description verbatim.
    const out = parseInvocation(['claude', 'fix', '--loop', 'edge', 'case']);
    expect(out).toEqual({
      tool: 'claude',
      refs: [{ kind: 'freeform', text: 'fix --loop edge case' }],
      loop: false,
    });
  });

  it('parses cleanup subcommand', () => {
    const out = parseInvocation(['cleanup', 'claude/issue-1']);
    expect(out).toEqual({ command: 'cleanup', branch: 'claude/issue-1' });
  });

  it('rejects unknown tool', () => {
    expect(() => parseInvocation(['bard', '#1'])).toThrow(ArgsError);
  });

  it('rejects empty argv', () => {
    expect(() => parseInvocation([])).toThrow(ArgsError);
  });

  it('rejects tool with no refs', () => {
    expect(() => parseInvocation(['claude'])).toThrow(ArgsError);
  });

  it('rejects cleanup with no branch', () => {
    expect(() => parseInvocation(['cleanup'])).toThrow(ArgsError);
  });
});
