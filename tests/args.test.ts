import { describe, expect, it } from 'bun:test';
import { ArgsError, extractGlobalFlags, parseInvocation } from '../src/args.ts';

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

  it('parses --loop after refs', () => {
    // Common typo: flag trails the ref. Should still set loop, not create a
    // phantom freeform handoff with text "--loop".
    const out = parseInvocation(['claude', '#1', '--loop']);
    expect(out).toEqual({
      tool: 'claude',
      refs: [{ kind: 'issue', number: 1 }],
      loop: true,
    });
  });

  it('parses --loop interleaved with refs', () => {
    const out = parseInvocation(['claude', '#1', '--loop', '#2']);
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

  it('rejects --loop with no refs', () => {
    // `claude --loop` extracts the flag but leaves zero refs; should still error.
    expect(() => parseInvocation(['claude', '--loop'])).toThrow(/Missing reference/);
  });

  it('error message names all ref forms, not just issues', () => {
    // Free-form is also a valid ref shape; the error shouldn't imply only #N is accepted.
    try {
      parseInvocation(['claude']);
    } catch (err) {
      expect(err).toBeInstanceOf(ArgsError);
      expect((err as Error).message).toMatch(/Missing reference/);
      expect((err as Error).message).not.toMatch(/Missing issue reference/);
    }
  });

  it('rejects cleanup with no branch', () => {
    expect(() => parseInvocation(['cleanup'])).toThrow(ArgsError);
  });

  describe('telemetry subcommand', () => {
    it('parses enable with no endpoint', () => {
      expect(parseInvocation(['telemetry', 'enable'])).toEqual({
        command: 'telemetry',
        sub: 'enable',
      });
    });

    it('parses enable --endpoint <url> (two-token form)', () => {
      expect(parseInvocation(['telemetry', 'enable', '--endpoint', 'https://x.test/t'])).toEqual({
        command: 'telemetry',
        sub: 'enable',
        endpoint: 'https://x.test/t',
      });
    });

    it('parses enable --endpoint=<url> (single-token form)', () => {
      expect(parseInvocation(['telemetry', 'enable', '--endpoint=https://x.test/t'])).toEqual({
        command: 'telemetry',
        sub: 'enable',
        endpoint: 'https://x.test/t',
      });
    });

    it('parses disable / status / log with no args', () => {
      expect(parseInvocation(['telemetry', 'disable'])).toEqual({
        command: 'telemetry',
        sub: 'disable',
      });
      expect(parseInvocation(['telemetry', 'status'])).toEqual({
        command: 'telemetry',
        sub: 'status',
      });
      expect(parseInvocation(['telemetry', 'log'])).toEqual({
        command: 'telemetry',
        sub: 'log',
      });
    });

    it('rejects unknown subcommand', () => {
      expect(() => parseInvocation(['telemetry', 'turnitup'])).toThrow(/Unknown telemetry/);
    });

    it('rejects missing subcommand', () => {
      expect(() => parseInvocation(['telemetry'])).toThrow(ArgsError);
    });

    it('rejects --endpoint with no URL', () => {
      expect(() => parseInvocation(['telemetry', 'enable', '--endpoint'])).toThrow(
        /--endpoint requires/,
      );
    });

    it('rejects extra args on disable / status / log', () => {
      expect(() => parseInvocation(['telemetry', 'disable', 'extra'])).toThrow(
        /takes no arguments/,
      );
    });

    it('rejects unknown flags on enable', () => {
      expect(() => parseInvocation(['telemetry', 'enable', '--noisy'])).toThrow(
        /Unexpected argument/,
      );
    });
  });

  describe('global flags (--verbose / --debug)', () => {
    it('accepts --verbose before the tool name', () => {
      const out = parseInvocation(['--verbose', 'claude', '#1']);
      expect(out).toEqual({ tool: 'claude', refs: [{ kind: 'issue', number: 1 }], loop: false });
    });

    it('accepts --debug after the tool name and before refs', () => {
      const out = parseInvocation(['claude', '--debug', '#2']);
      expect(out).toEqual({ tool: 'claude', refs: [{ kind: 'issue', number: 2 }], loop: false });
    });

    it('preserves --verbose in a free-form description verbatim', () => {
      // The whole point of this fix: --verbose must NOT be stripped when it
      // appears after the free-form boundary.
      const out = parseInvocation(['claude', 'fix', 'the', '--verbose', 'flag']);
      expect(out).toEqual({
        tool: 'claude',
        refs: [{ kind: 'freeform', text: 'fix the --verbose flag' }],
        loop: false,
      });
    });

    it('accepts multiple global flags mixed with --loop and refs', () => {
      const out = parseInvocation(['--verbose', 'claude', '--debug', '--loop', '#3']);
      expect(out).toEqual({ tool: 'claude', refs: [{ kind: 'issue', number: 3 }], loop: true });
    });

    it('accepts --verbose between cleanup and the branch arg', () => {
      // Regression: cleanup has no free-form mode, so a global flag wedged
      // between `cleanup` and the branch must be filtered, not adopted as
      // the branch name.
      const out = parseInvocation(['cleanup', '--verbose', 'claude/issue-1']);
      expect(out).toEqual({ command: 'cleanup', branch: 'claude/issue-1' });
    });

    it('accepts --debug after cleanup branch arg', () => {
      const out = parseInvocation(['cleanup', 'claude/issue-1', '--debug']);
      expect(out).toEqual({ command: 'cleanup', branch: 'claude/issue-1' });
    });

    it('accepts --verbose between telemetry and its subcommand', () => {
      const out = parseInvocation(['telemetry', '--verbose', 'status']);
      expect(out).toEqual({ command: 'telemetry', sub: 'status' });
    });

    it('accepts --debug interleaved with telemetry enable --endpoint', () => {
      const out = parseInvocation([
        'telemetry',
        '--debug',
        'enable',
        '--endpoint',
        'https://x.test/t',
      ]);
      expect(out).toEqual({
        command: 'telemetry',
        sub: 'enable',
        endpoint: 'https://x.test/t',
      });
    });
  });
});

describe('extractGlobalFlags', () => {
  it('detects --verbose before the tool name', () => {
    expect(extractGlobalFlags(['--verbose', 'claude', '#1'])).toEqual({
      verbose: true,
      debug: false,
    });
  });

  it('detects --debug between tool name and issue ref', () => {
    expect(extractGlobalFlags(['claude', '--debug', '#1'])).toEqual({
      verbose: false,
      debug: true,
    });
  });

  it('does NOT detect --verbose that appears inside a free-form description', () => {
    // "fix the --verbose flag" → freeform starts at "fix"; --verbose is part
    // of the description and must not enable verbose mode.
    expect(extractGlobalFlags(['claude', 'fix', 'the', '--verbose', 'flag'])).toEqual({
      verbose: false,
      debug: false,
    });
  });

  it('detects flags before freeform starts even when freeform contains them too', () => {
    // --verbose before "fix" is a flag; --verbose after is freeform text.
    expect(extractGlobalFlags(['claude', '--verbose', 'fix', 'the', '--verbose', 'flag'])).toEqual({
      verbose: true,
      debug: false,
    });
  });

  it('returns false/false for empty argv', () => {
    expect(extractGlobalFlags([])).toEqual({ verbose: false, debug: false });
  });
});
