import { describe, expect, it } from 'bun:test';
import { ArgsError, parseInvocation } from '../src/args.ts';

describe('parseInvocation', () => {
  it('parses a single #N reference', () => {
    const out = parseInvocation(['claude', '#1']);
    expect(out).toEqual({ tool: 'claude', refs: [{ kind: 'issue', number: 1 }] });
  });

  it('parses "Issue #N" two-token form', () => {
    const out = parseInvocation(['copilot', 'Issue', '#2']);
    expect(out).toEqual({ tool: 'copilot', refs: [{ kind: 'issue', number: 2 }] });
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
    });
  });

  it('treats anything else as free-form text', () => {
    const out = parseInvocation(['codex', 'fix', 'login', 'redirect', 'bug']);
    expect(out).toEqual({
      tool: 'codex',
      refs: [{ kind: 'freeform', text: 'fix login redirect bug' }],
    });
  });

  it('parses cleanup subcommand', () => {
    const out = parseInvocation(['cleanup', 'handoff/claude/1-foo']);
    expect(out).toEqual({ command: 'cleanup', branch: 'handoff/claude/1-foo' });
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
