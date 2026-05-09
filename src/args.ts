export { TOOLS, type Tool } from './tools.ts';
import { TOOLS, type Tool } from './tools.ts';

export interface IssueRef {
  kind: 'issue';
  number: number;
}

export interface FreeFormRef {
  kind: 'freeform';
  text: string;
}

export type Ref = IssueRef | FreeFormRef;

export interface ParsedArgs {
  tool: Tool;
  refs: Ref[];
  loop: boolean;
}

export interface CleanupArgs {
  command: 'cleanup';
  branch: string;
  /**
   * Skip the gh-merged-PR safety check and tear down the worktree +
   * branch unconditionally. Escape hatch for orphan worktrees whose
   * work shipped under a different branch name (rebased, renamed,
   * force-pushed to a sibling) — `gh pr list --head <branch>` returns
   * empty for those, so the default cleanup correctly retains them.
   */
  force: boolean;
}

export const TELEMETRY_SUBCOMMANDS = ['enable', 'disable', 'status', 'log'] as const;
export type TelemetrySubcommand = (typeof TELEMETRY_SUBCOMMANDS)[number];

export type TelemetryArgs =
  | { command: 'telemetry'; sub: 'enable'; endpoint?: string }
  | { command: 'telemetry'; sub: 'disable' }
  | { command: 'telemetry'; sub: 'status' }
  | { command: 'telemetry'; sub: 'log' };

export type CliInvocation = ParsedArgs | CleanupArgs | TelemetryArgs;

import { HandoffError } from './errors.ts';
import { isHandoffBranch } from './branch.ts';

export class ArgsError extends HandoffError {
  constructor(message: string) {
    super(message, 1);
    this.name = 'ArgsError';
  }
}

function isTool(value: string): value is Tool {
  return (TOOLS as readonly string[]).includes(value);
}

function parseIssueToken(
  tokens: string[],
  index: number,
): { ref: IssueRef; consumed: number } | null {
  const tok = tokens[index];
  if (tok === undefined) return null;

  // "#N"
  const hashMatch = tok.match(/^#(\d+)$/);
  if (hashMatch && hashMatch[1] !== undefined) {
    return { ref: { kind: 'issue', number: Number(hashMatch[1]) }, consumed: 1 };
  }

  // "Issue #N" → two tokens
  if (/^issue$/i.test(tok)) {
    const next = tokens[index + 1];
    if (next !== undefined) {
      const m = next.match(/^#?(\d+)$/);
      if (m && m[1] !== undefined) {
        return { ref: { kind: 'issue', number: Number(m[1]) }, consumed: 2 };
      }
    }
  }

  return null;
}

function isGlobalFlag(tok: string): boolean {
  return tok === '--verbose' || tok === '--debug';
}

function stripGlobalFlags(tokens: readonly string[]): string[] {
  return tokens.filter((t) => !isGlobalFlag(t));
}

/**
 * Walk argv with the same scanning-mode logic as parseInvocation and return
 * which global flags were seen **before** free-form mode started. This is the
 * authoritative detection path — rawArgv.includes() would fire even for a
 * literal `--verbose` inside a free-form task description.
 *
 * Mirrors the scanning loop in parseInvocation: leading flags, then
 * `--loop`/`--verbose`/`--debug`/issue-refs in any order, stopping at the
 * first token that triggers free-form mode.
 *
 * For `cleanup` and `telemetry` heads there is no free-form mode, so global
 * flags can appear anywhere in the remaining argv — scan to the end. (This
 * mirrors `parseInvocation`'s wholesale-strip behavior on those branches.)
 */
export function extractGlobalFlags(argv: readonly string[]): { verbose: boolean; debug: boolean } {
  let verbose = false;
  let debug = false;
  let i = 0;

  // Consume leading global flags before the tool/command name.
  while (i < argv.length && isGlobalFlag(argv[i]!)) {
    if (argv[i] === '--verbose') verbose = true;
    else debug = true;
    i++;
  }

  // Skip the tool/command name token.
  if (i >= argv.length) return { verbose, debug };
  const head = argv[i];
  i++;

  // No free-form mode under cleanup / telemetry — scan the whole tail.
  if (head === 'cleanup' || head === 'telemetry') {
    while (i < argv.length) {
      const tok = argv[i]!;
      if (tok === '--verbose') verbose = true;
      else if (tok === '--debug') debug = true;
      i++;
    }
    return { verbose, debug };
  }

  // Tool invocations: scan the refs region — stop at the first free-form token.
  while (i < argv.length) {
    const tok = argv[i]!;
    if (tok === '--verbose') {
      verbose = true;
      i++;
      continue;
    }
    if (tok === '--debug') {
      debug = true;
      i++;
      continue;
    }
    if (tok === '--loop') {
      i++;
      continue;
    }
    // Issue ref: #N
    if (/^#\d+$/.test(tok)) {
      i++;
      continue;
    }
    // Issue ref: "Issue #N" (two tokens)
    if (/^issue$/i.test(tok)) {
      const next = argv[i + 1];
      if (next !== undefined && /^#?\d+$/.test(next)) {
        i += 2;
        continue;
      }
    }
    // Anything else is the start of free-form mode — stop.
    break;
  }

  return { verbose, debug };
}

export function parseInvocation(argv: readonly string[]): CliInvocation {
  // Skip any leading --verbose/--debug before the tool/command name.
  let start = 0;
  while (start < argv.length && isGlobalFlag(argv[start]!)) {
    start += 1;
  }
  const trimmed = start === 0 ? argv : argv.slice(start);

  if (trimmed.length === 0) {
    throw new ArgsError(
      'No arguments provided. Usage: handoff <tool> <ref...> | handoff cleanup <branch>',
    );
  }

  const head = trimmed[0];
  if (head === undefined) {
    throw new ArgsError('Empty arguments.');
  }

  if (head === 'cleanup') {
    // No free-form mode under `cleanup` — global flags can appear anywhere
    // between the subcommand and the branch arg, e.g.
    // `handoff cleanup --verbose <branch>`. Same logic for `--force`,
    // which is cleanup-specific and may sit before or after the branch.
    const tail = stripGlobalFlags(trimmed.slice(1));
    let force = false;
    const positionals: string[] = [];
    for (const tok of tail) {
      if (tok === '--force') {
        force = true;
        continue;
      }
      positionals.push(tok);
    }
    const branch = positionals[0];
    if (branch === undefined || branch.trim() === '') {
      throw new ArgsError('Usage: handoff cleanup [--force] <branch>');
    }
    if (positionals.length > 1) {
      throw new ArgsError(
        `'handoff cleanup' takes a single <branch> argument (got ${positionals.length}).`,
      );
    }
    // --force opts out of the merge-check safety property. Substitute a
    // name-shape check so a typo'd or non-handoff branch can't trigger
    // an unconditional `git branch -D`. Legitimate handoff branches
    // always match `<tool>/issue-<N>`, `<tool>/pr-<N>`, or `<tool>/<slug>`
    // (the shapes branchName() emits). Non-force cleanup remains
    // permissive — the gh-merged-PR check refuses non-handoff branches
    // implicitly.
    if (force && !isHandoffBranch(branch)) {
      throw new ArgsError(
        `'handoff cleanup --force' refused: '${branch}' isn't a handoff branch ` +
          `(expected '<tool>/issue-<N>', '<tool>/pr-<N>', or '<tool>/<slug>' ` +
          `with <tool> in: ${TOOLS.join(', ')}). ` +
          `If you really meant to delete this branch, use \`git branch -D -- ${branch}\` directly.`,
      );
    }
    return { command: 'cleanup', branch, force };
  }

  if (head === 'telemetry') {
    // Same reasoning as cleanup: telemetry has no free-form mode, so global
    // flags can be filtered out anywhere in the subcommand args.
    return parseTelemetry(stripGlobalFlags(trimmed.slice(1)));
  }

  if (!isTool(head)) {
    throw new ArgsError(
      `Unknown tool '${head}'. Expected one of: ${TOOLS.join(', ')}, 'cleanup', or 'telemetry'.`,
    );
  }

  const rest = trimmed.slice(1);
  if (rest.length === 0) {
    throw new ArgsError(
      `Missing reference. Usage: handoff ${head} <ref...> ` +
        `(<ref> = #N, "Issue #N", or a free-form task description).`,
    );
  }

  // Walk tokens once. While we're still in "flag-or-ref" mode, `--loop`,
  // `--verbose`, and `--debug` may appear anywhere among the issue refs.
  // The first token that is neither a flag nor an issue-ref pattern flips us
  // into free-form mode, and from there everything (including a literal
  // `--loop` or `--verbose`) becomes part of the description verbatim.
  let loop = false;
  const refs: Ref[] = [];
  let i = 0;
  while (i < rest.length) {
    const tok = rest[i];
    if (tok === '--loop') {
      loop = true;
      i += 1;
      continue;
    }
    // Global flags consumed silently in scanning mode; main() reads them via
    // extractGlobalFlags() before this function is called.
    if (isGlobalFlag(tok!)) {
      i += 1;
      continue;
    }
    const issue = parseIssueToken(rest, i);
    if (issue) {
      refs.push(issue.ref);
      i += issue.consumed;
      continue;
    }
    // Free-form description: collect all remaining tokens verbatim.
    const text = rest.slice(i).join(' ').trim();
    if (text.length === 0) {
      throw new ArgsError('Empty free-form description.');
    }
    refs.push({ kind: 'freeform', text });
    break;
  }

  if (loop && head !== 'claude') {
    throw new ArgsError(
      `--loop is only supported for the 'claude' tool (got '${head}'). ` +
        `codex and copilot run as ephemeral sessions and don't support staying resident for review cycles.`,
    );
  }

  if (refs.length === 0) {
    throw new ArgsError(
      `Missing reference. Usage: handoff ${head} <ref...> ` +
        `(<ref> = #N, "Issue #N", or a free-form task description).`,
    );
  }

  return { tool: head, refs, loop };
}

function isTelemetrySubcommand(value: string): value is TelemetrySubcommand {
  return (TELEMETRY_SUBCOMMANDS as readonly string[]).includes(value);
}

function parseTelemetry(rest: readonly string[]): TelemetryArgs {
  const sub = rest[0];
  if (sub === undefined || sub.trim() === '') {
    throw new ArgsError(
      `Usage: handoff telemetry <${TELEMETRY_SUBCOMMANDS.join('|')}> ` +
        `('enable' additionally accepts '--endpoint <url>').`,
    );
  }
  if (!isTelemetrySubcommand(sub)) {
    throw new ArgsError(
      `Unknown telemetry subcommand '${sub}'. Expected one of: ${TELEMETRY_SUBCOMMANDS.join(', ')}.`,
    );
  }

  if (sub === 'enable') {
    let endpoint: string | undefined;
    let i = 1;
    while (i < rest.length) {
      const tok = rest[i];
      if (tok === '--endpoint') {
        const value = rest[i + 1];
        if (value === undefined || value.trim() === '') {
          throw new ArgsError('--endpoint requires a URL argument.');
        }
        endpoint = value;
        i += 2;
        continue;
      }
      if (tok !== undefined && tok.startsWith('--endpoint=')) {
        const value = tok.slice('--endpoint='.length);
        if (value.trim() === '') {
          throw new ArgsError('--endpoint requires a URL argument.');
        }
        endpoint = value;
        i += 1;
        continue;
      }
      throw new ArgsError(
        `Unexpected argument '${tok}' to 'handoff telemetry enable'. ` +
          `Only '--endpoint <url>' (or '--endpoint=<url>') is supported.`,
      );
    }
    return endpoint === undefined
      ? { command: 'telemetry', sub: 'enable' }
      : { command: 'telemetry', sub: 'enable', endpoint };
  }

  if (rest.length > 1) {
    throw new ArgsError(`'handoff telemetry ${sub}' takes no arguments.`);
  }
  return { command: 'telemetry', sub };
}
