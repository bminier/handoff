import { HandoffError } from './errors.ts';
import { RunError, run } from './run.ts';

export class GhError extends HandoffError {
  constructor(message: string, exitCode: 1 | 2 = 2) {
    super(message, exitCode);
    this.name = 'GhError';
  }
}

export interface IssueDetails {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
}

export interface GhOpts {
  cwd?: string;
}

async function gh(args: readonly string[], opts: GhOpts = {}): Promise<string> {
  try {
    const { stdout } = await run('gh', args, opts.cwd === undefined ? {} : { cwd: opts.cwd });
    return stdout;
  } catch (err) {
    if (err instanceof RunError) {
      const isAuthFailure = /authentication/i.test(err.stderr);
      const hint = isAuthFailure ? ' (run `gh auth login`)' : '';
      throw new GhError(
        `gh ${args.join(' ')} failed${hint}: ${err.stderr.trim() || err.stdout.trim()}`,
        isAuthFailure ? 1 : 2,
      );
    }
    throw err;
  }
}

interface RawIssuePayload {
  number?: number;
  title?: string;
  body?: string;
  url?: string;
  labels?: Array<{ name?: string } | null>;
}

export async function fetchIssue(number: number): Promise<IssueDetails> {
  const stdout = await gh([
    'issue',
    'view',
    String(number),
    '--json',
    'number,title,body,labels,url',
  ]);
  const parsed = JSON.parse(stdout) as RawIssuePayload;
  if (
    typeof parsed.number !== 'number' ||
    typeof parsed.title !== 'string' ||
    typeof parsed.body !== 'string' ||
    typeof parsed.url !== 'string'
  ) {
    throw new GhError(`Unexpected gh issue payload: ${stdout.slice(0, 200)}`);
  }
  const labels = Array.isArray(parsed.labels)
    ? parsed.labels.flatMap((l) => (l && typeof l.name === 'string' ? [l.name] : []))
    : [];
  return {
    number: parsed.number,
    title: parsed.title,
    body: parsed.body,
    url: parsed.url,
    labels,
  };
}

export async function defaultBranch(): Promise<string> {
  const stdout = await gh(['repo', 'view', '--json', 'defaultBranchRef']);
  const parsed = JSON.parse(stdout) as { defaultBranchRef?: { name?: string } };
  const name = parsed.defaultBranchRef?.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new GhError('Could not resolve default branch from `gh repo view`.');
  }
  return name;
}

export async function prMergedFor(branch: string, opts: GhOpts = {}): Promise<boolean> {
  const stdout = await gh(
    ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number', '--limit', '1'],
    opts,
  );
  const parsed = JSON.parse(stdout) as Array<{ number: number }>;
  return Array.isArray(parsed) && parsed.length > 0;
}
