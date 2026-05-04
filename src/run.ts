import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Readable } from 'node:stream';

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * `run()` always launches with `stdio: ['ignore', 'pipe', 'pipe']`, so both
 * stdout and stderr are guaranteed at runtime. Surface that in the type so
 * scripted-spawn fakes have to provide piped streams (compile error, not a
 * mid-test `TypeError` on `.on('data', ...)`) and `run()` itself can drop
 * the non-null assertions.
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
 * @internal Test-only injection seam. Replaces the spawn used by `run()` and
 * returns a restore function that puts back whatever impl was active before
 * this call — *not* unconditionally `nodeSpawn`. That lets nested fixtures
 * (or sibling tests in the same process) stack installs without clobbering
 * each other when uninstalled in LIFO order. Production code must not call
 * this — see `tests/README.md`.
 */
export function __setSpawnForTesting(impl: SpawnFn): () => void {
  const previous = spawnImpl;
  spawnImpl = impl;
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
      const result: RunResult = { stdout, stderr, exitCode };
      if (code !== 0) {
        reject(new RunError(command, args, result));
        return;
      }
      resolve(result);
    });
  });
}
