import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

let spawnImpl: SpawnFn = nodeSpawn;

/**
 * @internal Test-only injection seam. Replace the spawn used by `run()` with
 * a scripted implementation, then pass `null` to restore the real `spawn`.
 * Production code must not call this — see `tests/README.md`.
 */
export function __setSpawnForTesting(impl: SpawnFn | null): void {
  spawnImpl = impl ?? nodeSpawn;
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
    // stdio: ['ignore', 'pipe', 'pipe'] guarantees both streams are present at
    // runtime. The injectable SpawnFn typing widens to ChildProcess, where
    // stdout/stderr are nullable, so assert here rather than every test fake
    // having to retype the return.
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr!.on('data', (chunk: Buffer) => {
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
