export const TOOLS = ['claude', 'codex', 'copilot'] as const;
export type Tool = (typeof TOOLS)[number];
