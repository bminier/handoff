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

export type CliInvocation = ParsedArgs | CleanupArgs;

export class ArgsError extends Error {
  constructor(message: string) {
    super(message);
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

export function parseInvocation(argv: readonly string[]): CliInvocation {
  if (argv.length === 0) {
    throw new ArgsError(
      'No arguments provided. Usage: handoff <tool> <ref...> | handoff cleanup <branch>',
    );
  }

  const head = argv[0];
  if (head === undefined) {
    throw new ArgsError('Empty arguments.');
  }

  if (head === 'cleanup') {
    const branch = argv[1];
    if (branch === undefined || branch.trim() === '') {
      throw new ArgsError('Usage: handoff cleanup <branch>');
    }
    return { command: 'cleanup', branch };
  }

  if (!isTool(head)) {
    throw new ArgsError(
      `Unknown tool '${head}'. Expected one of: ${TOOLS.join(', ')}, or 'cleanup'.`,
    );
  }

  // Pull out flags before ref parsing so they can appear anywhere after the tool.
  // Stop flag-extraction at the first non-flag token so flag-looking free-form
  // text (rare) still parses as the start of a description.
  const rest: string[] = [];
  let loop = false;
  let sawNonFlag = false;
  for (const tok of argv.slice(1)) {
    if (!sawNonFlag && tok === '--loop') {
      loop = true;
      continue;
    }
    sawNonFlag = true;
    rest.push(tok);
  }

  if (loop && head !== 'claude') {
    throw new ArgsError(
      `--loop is only supported for the 'claude' tool (got '${head}'). ` +
        `codex and copilot run as ephemeral sessions and don't support staying resident for review cycles.`,
    );
  }

  if (rest.length === 0) {
    throw new ArgsError(`Missing issue reference. Usage: handoff ${head} <ref...>`);
  }

  const refs: Ref[] = [];
  let i = 0;
  while (i < rest.length) {
    const issue = parseIssueToken(rest, i);
    if (issue) {
      refs.push(issue.ref);
      i += issue.consumed;
      continue;
    }
    // Anything else: collect remaining tokens as a single free-form description.
    const text = rest.slice(i).join(' ').trim();
    if (text.length === 0) {
      throw new ArgsError('Empty free-form description.');
    }
    refs.push({ kind: 'freeform', text });
    break;
  }

  return { tool: head, refs, loop };
}
