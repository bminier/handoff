/** Process exit code semantics for handoff CLI errors. */
export type ProcessExitCode = 1 | 2 | 3;

/**
 * Base class for all user-visible handoff errors. Carries a numeric exit
 * code and an optional recovery hint that cli.ts prints after the message.
 *
 *  1 — user error (bad args, unknown tool, unauthenticated gh)
 *  2 — operational failure (worktree exists, git/gh command failed)
 *  3 — internal / unexpected error
 */
export class HandoffError extends Error {
  constructor(
    message: string,
    readonly exitCode: ProcessExitCode,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'HandoffError';
  }
}
