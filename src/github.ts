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

export type PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED';

export interface PullRequestDetails {
  number: number;
  title: string;
  body: string;
  url: string;
  state: PullRequestState;
  /** The PR's head branch — the branch the agent's commits push back onto. */
  headRefName: string;
  /** The PR's base branch — what it merges into. */
  baseRefName: string;
  isDraft: boolean;
  /** True when the head branch lives on a fork. handoff refuses these (#60). */
  isCrossRepository: boolean;
}

/**
 * `gh pr view --json` field list. A module-level constant so the test fixture
 * can assert the exact argv (scriptedSpawn matches argv element-for-element).
 */
const PR_VIEW_JSON_FIELDS =
  'number,title,body,url,state,headRefName,baseRefName,isDraft,isCrossRepository';

interface RawPullRequestPayload {
  number?: number;
  title?: string;
  body?: string;
  url?: string;
  state?: string;
  headRefName?: string;
  baseRefName?: string;
  isDraft?: boolean;
  isCrossRepository?: boolean;
}

function isPullRequestState(value: unknown): value is PullRequestState {
  return value === 'OPEN' || value === 'CLOSED' || value === 'MERGED';
}

/**
 * Resolve an existing PR's metadata for a PR-as-ref handoff (#60). The agent
 * works *on the PR's own head branch* — `headRefName` — so its pushes land on
 * the PR rather than a synthesized branch.
 */
export async function fetchPullRequest(number: number): Promise<PullRequestDetails> {
  const stdout = await gh(['pr', 'view', String(number), '--json', PR_VIEW_JSON_FIELDS]);
  const parsed = JSON.parse(stdout) as RawPullRequestPayload;
  if (
    typeof parsed.number !== 'number' ||
    typeof parsed.title !== 'string' ||
    typeof parsed.body !== 'string' ||
    typeof parsed.url !== 'string' ||
    !isPullRequestState(parsed.state) ||
    typeof parsed.headRefName !== 'string' ||
    parsed.headRefName.length === 0 ||
    typeof parsed.baseRefName !== 'string' ||
    parsed.baseRefName.length === 0 ||
    typeof parsed.isDraft !== 'boolean' ||
    typeof parsed.isCrossRepository !== 'boolean'
  ) {
    throw new GhError(`Unexpected gh pr payload: ${stdout.slice(0, 200)}`);
  }
  return {
    number: parsed.number,
    title: parsed.title,
    body: parsed.body,
    url: parsed.url,
    state: parsed.state,
    headRefName: parsed.headRefName,
    baseRefName: parsed.baseRefName,
    isDraft: parsed.isDraft,
    isCrossRepository: parsed.isCrossRepository,
  };
}

/**
 * Check the PR's head branch out into the worktree at `cwd` (which must
 * already be a freshly-created detached worktree). `gh pr checkout` handles
 * the fetch, local-branch creation, and push/upstream tracking so the agent's
 * `git push` updates the PR.
 */
export async function checkoutPullRequest(number: number, cwd: string): Promise<void> {
  await gh(['pr', 'checkout', String(number)], { cwd });
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
