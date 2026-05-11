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

  // #72: `handoff <tool> --force ...` used to slugify "--force <rest>" into a
  // branch name and dispatch an agent with an unparseable prompt. The catch
  // is that --force is a real flag (cleanup-only); rejecting it in tool mode
  // mirrors the --loop rejection above.
  it("rejects --force in tool mode (it's cleanup-only)", () => {
    for (const tool of ['claude', 'codex', 'copilot'] as const) {
      expect(() => parseInvocation([tool, '--force', '#1'])).toThrow(
        /'--force' is only valid for 'handoff cleanup'/,
      );
    }
  });

  it('rejects --force in tool mode even with no other args', () => {
    // Without --force a bare tool invocation throws "Missing reference"; the
    // explicit --force rejection should preempt that since the user's intent
    // was clearly the cleanup subcommand.
    expect(() => parseInvocation(['claude', '--force'])).toThrow(
      /'--force' is only valid for 'handoff cleanup'/,
    );
  });

  it('keeps --force literal once free-form text has started', () => {
    // Free-form catch-all wins as soon as a non-flag/non-ref token appears,
    // so a description like "fix the --force flag" is preserved verbatim.
    const out = parseInvocation(['claude', 'fix', 'the', '--force', 'flag']);
    expect(out).toEqual({
      tool: 'claude',
      refs: [{ kind: 'freeform', text: 'fix the --force flag' }],
      loop: false,
    });
  });

  it('keeps a quoted --force literal in a free-form description', () => {
    // Single quoted-string argv element — never matches the bare `--force` token.
    const out = parseInvocation(['claude', 'fix the --force flag']);
    expect(out).toEqual({
      tool: 'claude',
      refs: [{ kind: 'freeform', text: 'fix the --force flag' }],
      loop: false,
    });
  });

  it('parses cleanup subcommand', () => {
    const out = parseInvocation(['cleanup', 'claude/issue-1']);
    expect(out).toEqual({ command: 'cleanup', branch: 'claude/issue-1', force: false });
  });

  it('parses cleanup --force <branch>', () => {
    const out = parseInvocation(['cleanup', '--force', 'claude/issue-1']);
    expect(out).toEqual({ command: 'cleanup', branch: 'claude/issue-1', force: true });
  });

  it('parses cleanup <branch> --force (trailing position)', () => {
    // --force is position-independent under cleanup: same scanning model
    // as --verbose/--debug since cleanup has no free-form mode.
    const out = parseInvocation(['cleanup', 'claude/issue-1', '--force']);
    expect(out).toEqual({ command: 'cleanup', branch: 'claude/issue-1', force: true });
  });

  it('rejects extra positionals on cleanup', () => {
    // Guards against `handoff cleanup branch-a branch-b` silently dropping
    // the second branch — multi-branch cleanup is out of scope; surface
    // the typo loudly.
    expect(() => parseInvocation(['cleanup', 'a', 'b'])).toThrow(/single <branch>/);
  });

  it('rejects --force on a non-handoff branch', () => {
    // The codex-challenge finding (v0.2.1 follow-up): without this guard,
    // `handoff cleanup --force experiment` would happily `git branch -D
    // experiment`. The merge-check is the safety property without --force;
    // this is its substitute when --force is on.
    expect(() => parseInvocation(['cleanup', '--force', 'experiment'])).toThrow(
      /isn't a handoff branch/,
    );
    expect(() => parseInvocation(['cleanup', '--force', 'main'])).toThrow(/isn't a handoff branch/);
    expect(() => parseInvocation(['cleanup', '--force', 'feature/x'])).toThrow(
      /isn't a handoff branch/,
    );
  });

  it('allows --force on a legitimate handoff branch', () => {
    // The guard above must NOT regress the orphan-cleanup case from #54
    // (handoff branch whose work shipped under a different branch name).
    expect(parseInvocation(['cleanup', '--force', 'claude/issue-7'])).toEqual({
      command: 'cleanup',
      branch: 'claude/issue-7',
      force: true,
    });
    expect(parseInvocation(['cleanup', '--force', 'codex/cleanup-readme'])).toEqual({
      command: 'cleanup',
      branch: 'codex/cleanup-readme',
      force: true,
    });
  });

  it('non-force cleanup still allows arbitrary branch names', () => {
    // Without --force, the merge-check (gh pr list --head) is the safety
    // property — it implicitly refuses non-handoff branches by returning
    // empty. We don't second-guess at the args layer.
    expect(parseInvocation(['cleanup', 'experiment'])).toEqual({
      command: 'cleanup',
      branch: 'experiment',
      force: false,
    });
  });

  // #58: default-tool resolution — bare `handoff #N` / `handoff <free-form>`
  // dispatches to claude. The previous "Unknown tool" hard refusal is gone:
  // any non-tool, non-subcommand argv[0] is now the start of the refs
  // region for DEFAULT_TOOL. See README.md ("Free-form" section) for the
  // typo trade-off and the recommended quoting habit.
  it('defaults to claude when the tool is omitted with a #N ref', () => {
    expect(parseInvocation(['#5'])).toEqual({
      tool: 'claude',
      refs: [{ kind: 'issue', number: 5 }],
      loop: false,
    });
  });

  it('defaults to claude when omitted with an "Issue N" ref', () => {
    expect(parseInvocation(['Issue', '5'])).toEqual({
      tool: 'claude',
      refs: [{ kind: 'issue', number: 5 }],
      loop: false,
    });
  });

  it('defaults to claude when omitted with multiple #N refs', () => {
    expect(parseInvocation(['#1', '#2', '#3'])).toEqual({
      tool: 'claude',
      refs: [
        { kind: 'issue', number: 1 },
        { kind: 'issue', number: 2 },
        { kind: 'issue', number: 3 },
      ],
      loop: false,
    });
  });

  it('defaults to claude for a quoted free-form description', () => {
    expect(parseInvocation(['fix the readme typo'])).toEqual({
      tool: 'claude',
      refs: [{ kind: 'freeform', text: 'fix the readme typo' }],
      loop: false,
    });
  });

  it('defaults to claude for a multi-token free-form description', () => {
    // `handoff fix the readme typo` — argv[0] isn't a tool, so the whole
    // argv joins into the free-form description for the default tool.
    expect(parseInvocation(['fix', 'the', 'readme', 'typo'])).toEqual({
      tool: 'claude',
      refs: [{ kind: 'freeform', text: 'fix the readme typo' }],
      loop: false,
    });
  });

  it('accepts --loop with the default tool', () => {
    // The --loop rejection guard is "loop && tool !== 'claude'" — and the
    // default tool IS claude, so --loop works in bare invocations.
    expect(parseInvocation(['--loop', '#7'])).toEqual({
      tool: 'claude',
      refs: [{ kind: 'issue', number: 7 }],
      loop: true,
    });
  });

  it('a typo for a tool name parses as free-form (documented trade-off)', () => {
    // `handoff calude #1` is unfortunately not detected as a typo for
    // `claude` — it parses as free-form "calude #1" for the default tool.
    // README documents quoting (`handoff "<task>"`) as the way to keep
    // intent unambiguous. This test pins the trade-off so a future
    // typo-guard PR has to update both the behavior and this test
    // together.
    expect(parseInvocation(['calude', '#1'])).toEqual({
      tool: 'claude',
      refs: [{ kind: 'freeform', text: 'calude #1' }],
      loop: false,
    });
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
      expect(out).toEqual({ command: 'cleanup', branch: 'claude/issue-1', force: false });
    });

    it('accepts --debug after cleanup branch arg', () => {
      const out = parseInvocation(['cleanup', 'claude/issue-1', '--debug']);
      expect(out).toEqual({ command: 'cleanup', branch: 'claude/issue-1', force: false });
    });

    it('accepts --verbose --force <branch> together', () => {
      const out = parseInvocation(['cleanup', '--verbose', '--force', 'claude/issue-1']);
      expect(out).toEqual({ command: 'cleanup', branch: 'claude/issue-1', force: true });
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

  it('detects --debug after the cleanup branch arg', () => {
    // No free-form mode under cleanup, so flags placed after the branch
    // must still toggle logging — otherwise parseInvocation accepts them
    // (and the stripped invocation runs) but verbosity is silently off.
    expect(extractGlobalFlags(['cleanup', 'claude/issue-1', '--debug'])).toEqual({
      verbose: false,
      debug: true,
    });
  });

  it('detects --verbose interleaved through telemetry args', () => {
    expect(
      extractGlobalFlags(['telemetry', 'enable', '--verbose', '--endpoint', 'https://x.test/t']),
    ).toEqual({ verbose: true, debug: false });
  });
});
