export const TOOLS = ['claude', 'codex', 'copilot'] as const;
export type Tool = (typeof TOOLS)[number];

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

export function parseInvocation(argv: readonly string[]): CliInvocation {
  // Skip any leading --verbose/--debug before the tool/command name so
  // `handoff --verbose claude …` works. main() detects these flags via
  // rawArgv.includes() before this call — we just need to not choke on them.
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
    const branch = trimmed[1];
    if (branch === undefined || branch.trim() === '') {
      throw new ArgsError('Usage: handoff cleanup <branch>');
    }
    return { command: 'cleanup', branch };
  }

  if (head === 'telemetry') {
    return parseTelemetry(trimmed.slice(1));
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
    // Global flags consumed silently in scanning mode; main() reads them from
    // rawArgv.includes() before this function is called.
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
