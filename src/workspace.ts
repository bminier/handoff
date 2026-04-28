import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Tool } from './args.ts';

export const WORKSPACE_DIRNAME = '.handoff';
export const STATE_FILENAME = 'state.json';
export const STATE_VERSION = 1;

export type IssueRefRecord = { type: 'issue'; number: number };
export type FreeformRefRecord = { type: 'freeform'; text: string };
// Note: a PrRefRecord variant will be added when first-class PR handoffs land
// (#10). Until then, only the variants the CLI actually emits live in the
// union, so the schema and the writer can't drift.
export type RefRecord = IssueRefRecord | FreeformRefRecord;

export interface WorkspaceState {
  version: typeof STATE_VERSION;
  tool: Tool;
  ref: RefRecord;
  branch: string;
  loop: boolean;
  createdAt: string;
  updatedAt: string;
}

export class WorkspaceStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceStateError';
  }
}

export function workspacePath(worktreeRoot: string): string {
  return join(worktreeRoot, WORKSPACE_DIRNAME);
}

export function statePath(worktreeRoot: string): string {
  return join(workspacePath(worktreeRoot), STATE_FILENAME);
}

export function readState(worktreeRoot: string): WorkspaceState | null {
  const p = statePath(worktreeRoot);
  if (!existsSync(p)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new WorkspaceStateError(`failed to read workspace state from ${p}: ${reason}`);
  }
  return assertStateVersion(parsed);
}

export function writeState(worktreeRoot: string, state: WorkspaceState): void {
  assertStateVersion(state);
  mkdirSync(workspacePath(worktreeRoot), { recursive: true });
  writeFileSync(statePath(worktreeRoot), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/**
 * Removes the entire `.handoff/` directory. Used on cleanup. Not appropriate
 * for "just forget the state.json" — once #11 lands `REVIEW.md` etc. under
 * the same prefix, callers should reach for individual file deletions.
 */
export function removeWorkspace(worktreeRoot: string): void {
  const dir = workspacePath(worktreeRoot);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/**
 * Validates the part of the state contract this module owns: that the value
 * is an object and that its `version` matches what we know how to read.
 * Field-level validation is deliberately skipped — `state.json` is written
 * only by this CLI, not by users, so a malformed inner shape is a bug we
 * want to surface as a normal TypeError, not paper over with a custom check.
 */
function assertStateVersion(value: unknown): WorkspaceState {
  if (!value || typeof value !== 'object') {
    throw new WorkspaceStateError('workspace state must be an object');
  }
  const v = value as { version?: unknown };
  if (v.version !== STATE_VERSION) {
    throw new WorkspaceStateError(
      `unsupported workspace state version ${JSON.stringify(v.version)} ` +
        `(expected ${STATE_VERSION}). Upgrade or remove the .handoff/ directory.`,
    );
  }
  return value as WorkspaceState;
}
