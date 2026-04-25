import { basename, dirname, join } from 'node:path';
import type { Tool } from './args.ts';

export interface BranchInput {
  tool: Tool;
  issueNumber?: number;
  slug: string;
}

export function branchName({ tool, issueNumber, slug }: BranchInput): string {
  const tail = issueNumber !== undefined ? `${issueNumber}-${slug}` : slug;
  return `handoff/${tool}/${tail}`;
}

export function branchTail(branch: string): string {
  return branch.split('/').slice(2).join('/') || branch;
}

export interface WorktreePathInput {
  repoRoot: string;
  branch: string;
}

export function worktreePath({ repoRoot, branch }: WorktreePathInput): string {
  const parent = dirname(repoRoot);
  const repoName = basename(repoRoot);
  const tail = branchTail(branch).replace(/\//g, '-');
  return join(parent, `${repoName}-handoff-${tail}`);
}
