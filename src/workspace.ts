import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Tool } from './args.ts';

export const WORKSPACE_DIRNAME = '.handoff';
export const STATE_FILENAME = 'state.json';
export const STATE_VERSION = 1;

export type IssueRefRecord = { type: 'issue'; number: number };
export type PrRefRecord = { type: 'pr'; number: number };
export type FreeformRefRecord = { type: 'freeform'; text: string };
export type RefRecord = IssueRefRecord | PrRefRecord | FreeformRefRecord;

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
  const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
  return assertState(parsed);
}

export function writeState(worktreeRoot: string, state: WorkspaceState): void {
  assertState(state);
  mkdirSync(workspacePath(worktreeRoot), { recursive: true });
  writeFileSync(statePath(worktreeRoot), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function clearState(worktreeRoot: string): void {
  const dir = workspacePath(worktreeRoot);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function assertState(value: unknown): WorkspaceState {
  if (!value || typeof value !== 'object') {
    throw new WorkspaceStateError('workspace state must be an object');
  }
  const v = value as { version?: unknown };
  // Forward-compat guard: if a future handoff writes version 2 and an older
  // CLI reads it, refuse rather than silently mis-parsing.
  if (v.version !== STATE_VERSION) {
    throw new WorkspaceStateError(
      `unsupported workspace state version ${JSON.stringify(v.version)} ` +
        `(expected ${STATE_VERSION}). Upgrade or remove the .handoff/ directory.`,
    );
  }
  return value as WorkspaceState;
}
