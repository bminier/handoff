/** Single source of truth for the package version, mirrored from package.json. */
export const VERSION = '0.1.0';

export const HELP = `handoff v${VERSION}

USAGE
  handoff <tool> [--loop] <ref...> spawn a worktree per ref and launch <tool>
  handoff cleanup <branch>         remove a worktree if its PR has merged
  handoff --help                   show this message
  handoff --version                show version

TOOLS
  claude    Anthropic Claude Code CLI
  codex     OpenAI Codex CLI
  copilot   GitHub Copilot CLI

REFS
  #N             a GitHub issue number (resolved via \`gh issue view\`)
  Issue #N       same as #N
  <free text>    a free-form task description (no issue created)

FLAGS
  --loop         (claude only) keep the agent resident after \`gh pr create\`
                 to triage review feedback and CI, push fixes, and iterate
                 until the PR is merged (or a bail condition trips).

EXAMPLES
  handoff codex #1
  handoff copilot Issue #2
  handoff claude #1 #2 #3                    # fleet: 3 parallel worktrees
  handoff claude --loop #7                   # implement and self-drive review
  handoff claude "tidy up the README"

REQUIREMENTS
  bun, git, gh, and the chosen tool must all be on PATH.
`;
