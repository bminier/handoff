import { spawn } from 'node:child_process';
import { platform } from 'node:os';

export class TerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalError';
  }
}

export interface OpenTerminalInput {
  /** Directory the new terminal should start in. */
  cwd: string;
  /** Absolute path to the script the terminal should run on launch. */
  scriptPath: string;
  /** Optional argv to pass to the script. */
  args?: readonly string[];
}

export type Platform = 'win32' | 'darwin' | 'linux';

export interface LaunchSpec {
  command: string;
  args: string[];
}

/**
 * Pure: pick the right terminal command for a given platform. Caller is responsible for
 * verifying the chosen command is on PATH (the terminal opener tries fallbacks).
 */
export function buildLaunchSpec(
  plat: Platform,
  input: OpenTerminalInput & { terminal?: string },
): LaunchSpec {
  const scriptArgs = input.args ?? [];

  if (plat === 'win32') {
    const term = input.terminal ?? 'wt';
    if (term === 'wt') {
      return {
        command: 'wt.exe',
        args: [
          '-d',
          input.cwd,
          'powershell.exe',
          '-NoExit',
          '-File',
          input.scriptPath,
          ...scriptArgs,
        ],
      };
    }
    // Fallback: cmd start with PowerShell
    return {
      command: 'cmd.exe',
      args: [
        '/c',
        'start',
        '""',
        '/D',
        input.cwd,
        'powershell.exe',
        '-NoExit',
        '-File',
        input.scriptPath,
        ...scriptArgs,
      ],
    };
  }

  if (plat === 'darwin') {
    const argList = [input.scriptPath, ...scriptArgs].map(quoteForShell).join(' ');
    const cmd = `cd ${quoteForShell(input.cwd)} && ${argList}`;
    return {
      command: 'osascript',
      args: ['-e', `tell application "Terminal" to do script "${escapeForApplescript(cmd)}"`],
    };
  }

  // linux
  const term = input.terminal ?? 'gnome-terminal';
  if (term === 'gnome-terminal') {
    return {
      command: 'gnome-terminal',
      args: ['--working-directory', input.cwd, '--', 'bash', input.scriptPath, ...scriptArgs],
    };
  }
  if (term === 'konsole') {
    return {
      command: 'konsole',
      args: ['--workdir', input.cwd, '-e', 'bash', input.scriptPath, ...scriptArgs],
    };
  }
  return {
    command: 'xterm',
    args: ['-e', `bash ${[input.scriptPath, ...scriptArgs].map(quoteForShell).join(' ')}`],
  };
}

function quoteForShell(s: string): string {
  if (/^[A-Za-z0-9_./@:=+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function escapeForApplescript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export async function openTerminal(input: OpenTerminalInput): Promise<void> {
  const plat = platform();
  if (plat !== 'win32' && plat !== 'darwin' && plat !== 'linux') {
    throw new TerminalError(`Unsupported platform: ${plat}`);
  }

  const candidates: string[] =
    plat === 'win32'
      ? ['wt', 'cmd']
      : plat === 'darwin'
        ? ['terminal']
        : ['gnome-terminal', 'konsole', 'xterm'];

  let lastErr: Error | undefined;
  for (const candidate of candidates) {
    const spec = buildLaunchSpec(plat, { ...input, terminal: candidate });
    try {
      await spawnDetached(spec);
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw new TerminalError(`Failed to open a terminal window. Last error: ${lastErr?.message}`);
}

function spawnDetached(spec: LaunchSpec): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    child.on('error', reject);
    // Give the OS a tick to fail fast on ENOENT before unref'ing.
    setTimeout(() => {
      child.unref();
      resolve();
    }, 50);
  });
}
