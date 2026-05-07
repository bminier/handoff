import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Readable } from 'node:stream';

import { debug } from './logger.ts';

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * `run()` always launches with `stdio: ['ignore', 'pipe', 'pipe']`, so both
 * stdout and stderr are guaranteed at runtime. Surfacing that in the type
 * lets `run()` drop its non-null assertions and signals to test-fake authors
 * that piped streams are part of the contract — though TypeScript can't
 * fully enforce this, since a fake can launder the type via
 * `as unknown as PipedChildProcess`. The benefit is the cast is then
 * explicit at the seam, not silently absorbed by `!` inside `run()`.
 */
export type PipedChildProcess = Omit<ChildProcess, 'stdout' | 'stderr'> & {
  stdout: Readable;
  stderr: Readable;
};

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => PipedChildProcess;

const pipedNodeSpawn: SpawnFn = (command, args, options) => {
  // Narrow `node:child_process.spawn`'s nullable streams at the boundary —
  // we always pass `stdio: ['ignore', 'pipe', 'pipe']` below, so the cast
  // is safe at runtime.
  return nodeSpawn(command, args, options) as PipedChildProcess;
};

let spawnImpl: SpawnFn = pipedNodeSpawn;

/**
 * @internal Test-only injection seam. The factory receives the previous
 * spawn impl active at install time so a fixture can fall through to it
 * (the hybrid harness `tests/helpers/scriptedSpawn.ts` uses this for its
 * `passthrough` option). Returns a restore function that puts back that
 * previous impl — *not* unconditionally `nodeSpawn`, so nested fixtures
 * (or sibling tests in the same process) stack installs without clobbering
 * each other when uninstalled in LIFO order. Production code must not call
 * this — see `tests/README.md`.
 */
export function __setSpawnForTesting(factory: (previous: SpawnFn) => SpawnFn): () => void {
  const previous = spawnImpl;
  spawnImpl = factory(previous);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    spawnImpl = previous;
  };
}

export class RunError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;

  constructor(command: string, args: readonly string[], result: RunResult) {
    super(
      `Command failed: ${command} ${args.join(' ')}\n` +
        `  exit ${result.exitCode}\n` +
        (result.stderr ? `  stderr: ${result.stderr.trim()}\n` : '') +
        (result.stdout ? `  stdout: ${result.stdout.trim()}` : ''),
    );
    this.name = 'RunError';
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.exitCode = result.exitCode;
  }
}

export interface RunOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function run(
  command: string,
  args: readonly string[],
  opts: RunOpts = {},
): Promise<RunResult> {
  debug(`spawn: ${command} ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const exitCode = code ?? (signal ? 128 : 0);
      debug(`exit ${exitCode}: ${command} ${args.join(' ')}`);
      const result: RunResult = { stdout, stderr, exitCode };
      if (code !== 0) {
        reject(new RunError(command, args, result));
        return;
      }
      resolve(result);
    });
  });
}
