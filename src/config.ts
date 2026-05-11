import { DEFAULT_TOOL } from './tools.ts';

/** Single source of truth for the package version, mirrored from package.json. */
export const VERSION = '0.3.0-dev';

// Build the TOOLS section with a `(default when omitted)` marker on the
// row that matches DEFAULT_TOOL. Centralizes the default so a future
// change to DEFAULT_TOOL (or to its source in #20's config work) doesn't
// require a parallel edit to HELP. Two-space gap before the marker
// matches the existing column rhythm in this section.
const TOOL_ROWS: Record<string, string> = {
  claude: '  claude    Anthropic Claude Code CLI',
  codex: '  codex     OpenAI Codex CLI',
  copilot: '  copilot   GitHub Copilot CLI',
};
const TOOLS_SECTION = Object.entries(TOOL_ROWS)
  .map(([tool, row]) => (tool === DEFAULT_TOOL ? `${row}  (default when omitted)` : row))
  .join('\n');

export const HELP = `handoff v${VERSION}

USAGE
  handoff [<tool>] <ref...>        spawn a worktree per ref and launch <tool>
                                   (<tool> defaults to ${DEFAULT_TOOL} when omitted)
  handoff [${DEFAULT_TOOL}] [--loop] <ref...>
                                   ${DEFAULT_TOOL} (or default): stay resident through review (see FLAGS)
  handoff cleanup [--force] <branch>
                                   remove a worktree if its PR has merged
                                   (--force skips the merge check; see FLAGS)
  handoff telemetry <subcommand>   manage opt-in usage telemetry (see TELEMETRY)
  handoff --help                   show this message
  handoff --version                show version

TOOLS
${TOOLS_SECTION}

REFS
  #N             a GitHub issue number (resolved via \`gh issue view\`)
  Issue #N       same as #N
  <free text>    a free-form task description (no issue created)

FLAGS
  --loop         (claude only) keep the agent resident after \`gh pr create\`
                 to triage review feedback and CI, push fixes, and iterate
                 until the PR is merged (or a bail condition trips).
  --force        (cleanup only) skip the merged-PR safety check and tear
                 down the worktree + branch unconditionally. Use when the
                 work shipped under a different branch (rebased, renamed,
                 force-pushed sibling) and the worktree is orphaned.
  --verbose      print info-level traces to stderr (branch, worktree path,
                 terminal launch)
  --debug        print raw subprocess invocations and exit codes to stderr
                 (implies --verbose)

TELEMETRY
  Off by default. Nothing is sent until both telemetry is enabled and an
  endpoint URL is configured. No PII (no issue titles, branch names, repo
  paths, or usernames) is ever transmitted; see \`handoff telemetry status\`
  for the exact event payloads.

  handoff telemetry enable [--endpoint <url>]   turn on, optionally pointing
                                                at a self-hosted aggregator
  handoff telemetry disable                     turn off
  handoff telemetry status                      show current state and event
                                                shapes
  handoff telemetry log                         print the local debug log (set
                                                HANDOFF_TELEMETRY_DEBUG=1 to
                                                populate it)

EXAMPLES
  handoff #1                                 # ${DEFAULT_TOOL} (default) on issue #1
  handoff codex #1                           # explicit tool
  handoff copilot Issue #2
  handoff #1 #2 #3                           # fleet: 3 parallel ${DEFAULT_TOOL} worktrees
  handoff --loop #7                          # implement and self-drive review
  handoff "tidy up the README"               # free-form, default tool

EXIT CODES
  0  success
  1  user error (bad args, missing reference, unauthenticated gh)
  2  operational failure (worktree exists, git/gh command failed)
  3  internal / unexpected error

REQUIREMENTS
  bun, git, gh, and the chosen tool must all be on PATH.
`;
