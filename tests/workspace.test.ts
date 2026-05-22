import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  STATE_VERSION,
  WORKSPACE_DIRNAME,
  WorkspaceStateError,
  removeWorkspace,
  readState,
  statePath,
  workspacePath,
  writeState,
  type WorkspaceState,
} from '../src/workspace.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'handoff-workspace-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const sample = (): WorkspaceState => ({
  version: STATE_VERSION,
  tool: 'claude',
  ref: { type: 'issue', number: 7 },
  branch: 'claude/issue-7',
  loop: true,
  createdAt: '2026-04-28T12:00:00.000Z',
  updatedAt: '2026-04-28T12:00:00.000Z',
});

describe('workspacePath / statePath', () => {
  it('places metadata under .handoff/state.json inside the worktree', () => {
    expect(workspacePath(root)).toBe(join(root, WORKSPACE_DIRNAME));
    expect(statePath(root)).toBe(join(root, WORKSPACE_DIRNAME, 'state.json'));
  });
});

describe('writeState / readState', () => {
  it('round-trips a workspace state through disk', () => {
    const state = sample();
    writeState(root, state);

    const onDisk = JSON.parse(readFileSync(statePath(root), 'utf8'));
    expect(onDisk).toEqual(state);

    expect(readState(root)).toEqual(state);
  });

  it('creates the .handoff/ directory if it does not exist', () => {
    expect(existsSync(workspacePath(root))).toBe(false);
    writeState(root, sample());
    expect(existsSync(workspacePath(root))).toBe(true);
  });

  it('overwrites an existing state file', () => {
    writeState(root, sample());
    const updated: WorkspaceState = {
      ...sample(),
      loop: false,
      updatedAt: '2026-04-28T13:00:00.000Z',
    };
    writeState(root, updated);
    expect(readState(root)).toEqual(updated);
  });

  it('returns null when there is no state file', () => {
    expect(readState(root)).toBeNull();
  });

  it('round-trips a PR ref record (#60)', () => {
    const state: WorkspaceState = {
      ...sample(),
      ref: { type: 'pr', number: 12 },
      branch: 'feature/the-thing',
      loop: false,
    };
    writeState(root, state);
    expect(readState(root)).toEqual(state);
  });
});

describe('readState schema-version guard', () => {
  it('throws WorkspaceStateError on a state with a future version', () => {
    writeState(root, sample());
    const future = { ...sample(), version: STATE_VERSION + 1 };
    writeFileSync(statePath(root), JSON.stringify(future), 'utf8');

    expect(() => readState(root)).toThrow(WorkspaceStateError);
  });

  it('rejects a pre-#60 v1 state rather than mis-parsing it', () => {
    // STATE_VERSION moved 1 → 2 when the `pr` ref variant landed. A v1
    // state file (from a worktree created before #60) must be rejected by
    // the version guard, not read as if its schema still matched.
    writeState(root, sample());
    writeFileSync(statePath(root), JSON.stringify({ ...sample(), version: 1 }), 'utf8');

    expect(() => readState(root)).toThrow(WorkspaceStateError);
  });

  it('throws when the file is not an object', () => {
    writeState(root, sample());
    writeFileSync(statePath(root), JSON.stringify('not an object'), 'utf8');
    expect(() => readState(root)).toThrow(WorkspaceStateError);
  });
});

describe('removeWorkspace', () => {
  it('removes the .handoff/ directory entirely', () => {
    writeState(root, sample());
    expect(existsSync(workspacePath(root))).toBe(true);

    removeWorkspace(root);
    expect(existsSync(workspacePath(root))).toBe(false);
  });

  it('is a no-op when .handoff/ does not exist', () => {
    expect(() => removeWorkspace(root)).not.toThrow();
  });
});

describe('readState corrupted-file handling', () => {
  it('wraps JSON parse errors in WorkspaceStateError', () => {
    writeState(root, sample());
    writeFileSync(statePath(root), '{not valid json', 'utf8');

    expect(() => readState(root)).toThrow(WorkspaceStateError);
  });
});
