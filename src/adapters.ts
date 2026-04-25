import type { Tool } from './args.ts';

/** Returns the binary name for the given tool. All three accept a positional prompt. */
export function toolBinary(tool: Tool): string {
  switch (tool) {
    case 'claude':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'copilot':
      return 'copilot';
  }
}
