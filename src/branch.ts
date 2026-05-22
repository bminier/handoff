import { basename, dirname, join } from 'node:path';
import { TOOLS, type Tool } from './tools.ts';

export interface BranchInput {
  tool: Tool;
  /** Issue number → branch tail `issue-<N>`. */
  issueNumber?: number;
  /** Free-form slug (already slugified). Used when issueNumber is not set. */
  slug?: string;
}

/**
 * Note: PR-as-ref handoffs (issue #60) do **not** synthesize a branch here —
 * they check out the PR's own head branch so the agent's pushes land on the
 * PR. `branchName` only covers issue and free-form refs.
 */
export function branchName({ tool, issueNumber, slug }: BranchInput): string {
  if (issueNumber !== undefined) {
    return `${tool}/issue-${issueNumber}`;
  }
  if (!slug) {
    throw new Error('branchName: must provide issueNumber or slug');
  }
  return `${tool}/${slug}`;
}

/** Tail = everything after the leading `<tool>/` segment. */
export function branchTail(branch: string): string {
  const slash = branch.indexOf('/');
  return slash === -1 ? branch : branch.slice(slash + 1);
}

/**
 * True iff `branch` could have been produced by `branchName()` — i.e. the
 * shape is `<tool>/issue-<N>` or `<tool>/<slug>` with
 * `<tool>` ∈ TOOLS and `<slug>` matching the kebab-case form `slugify()`
 * emits (lowercase alphanumeric tokens joined by single dashes, no
 * leading/trailing dashes, no double dashes).
 *
 * Used by `cleanup --force` as a guard so a typo'd or non-handoff branch
 * name can't trigger an unconditional `git branch -D`. Without `--force`
 * the merge-check is the safety property; with `--force` the user is
 * opting out of that check, so we substitute a name-shape check that
 * legitimate handoff branches always pass.
 */
export function isHandoffBranch(branch: string): boolean {
  return HANDOFF_BRANCH_RE.test(branch);
}

const HANDOFF_BRANCH_RE = (() => {
  const toolAlternation = TOOLS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // Tail forms (matching branchName): issue-<N> or kebab-case slug.
  const tail = String.raw`(?:issue-\d+|[a-z0-9]+(?:-[a-z0-9]+)*)`;
  return new RegExp(`^(?:${toolAlternation})/${tail}$`);
})();

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
