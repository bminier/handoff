export const TOOLS = ['claude', 'codex', 'copilot'] as const;
export type Tool = (typeof TOOLS)[number];

/**
 * Tool used when `<tool>` is omitted from the command line
 * (e.g. `handoff #5` → `handoff claude #5`). Claude is the dominant
 * use case, so optimizing for the bare invocation is the win.
 * Configurable default lives in #20's broader config-surface work —
 * when that lands, this constant becomes the fallback for users
 * with no override set.
 */
export const DEFAULT_TOOL: Tool = 'claude';
