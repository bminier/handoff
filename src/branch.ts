import { basename, dirname, join } from 'node:path';
import { TOOLS, type Tool } from './args.ts';

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

/**
 * True iff `branch` could have been produced by `branchName()` — i.e. the
 * shape is `<tool>/issue-<N>`, `<tool>/pr-<N>`, or `<tool>/<slug>` with
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
  return handoffBranchRe().test(branch);
}

let _handoffBranchRe: RegExp | undefined;

// Lazy-built so we don't read TOOLS at module-load time. args.ts and
// branch.ts have a circular import (args.ts → isHandoffBranch ← branch.ts
// ← TOOLS) — building the regex inside the function defers TOOLS access
// until first call, by which time both modules have finished initializing.
function handoffBranchRe(): RegExp {
  if (_handoffBranchRe) return _handoffBranchRe;
  const toolAlternation = TOOLS.map(escapeForRegex).join('|');
  // Tail forms (matching branchName):
  //   issue-<N>, pr-<N>  — N is one or more decimal digits
  //   <slug>             — kebab-case alphanumeric per slugify()
  const tail = String.raw`(?:issue-\d+|pr-\d+|[a-z0-9]+(?:-[a-z0-9]+)*)`;
  _handoffBranchRe = new RegExp(`^(?:${toolAlternation})/${tail}$`);
  return _handoffBranchRe;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
