import { basename, dirname, join } from 'node:path';
import type { Tool } from './args.ts';

export interface BranchInput {
  tool: Tool;
  /** Issue number → branch tail `issue-<N>`. */
  issueNumber?: number;
  /** PR number → branch tail `pr-<N>`. */
  prNumber?: number;
  /** Free-form slug (already slugified). Used when neither issueNumber nor prNumber is set. */
  slug?: string;
}

export function branchName({ tool, issueNumber, prNumber, slug }: BranchInput): string {
  if (issueNumber !== undefined) {
    return `${tool}/issue-${issueNumber}`;
  }
  if (prNumber !== undefined) {
    return `${tool}/pr-${prNumber}`;
  }
  if (!slug) {
    throw new Error('branchName: must provide issueNumber, prNumber, or slug');
  }
  return `${tool}/${slug}`;
}

/** Tail = everything after the leading `<tool>/` segment. */
export function branchTail(branch: string): string {
  const slash = branch.indexOf('/');
  return slash === -1 ? branch : branch.slice(slash + 1);
}

export interface WorktreePathInput {
  repoRoot: string;
  branch: string;
}

export function worktreePath({ repoRoot, branch }: WorktreePathInput): string {
  const parent = dirname(repoRoot);
  const repoName = basename(repoRoot);
  const tail = branchTail(branch).replace(/\//g, '-');
  return join(parent, `${repoName}-${tail}`);
}
