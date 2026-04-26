#!/usr/bin/env python3
"""One-command installer for the handoff CLI and its Claude Code slash command.

Renders the slash command into ~/.claude/commands/handoff.md with the absolute
path of this checkout baked in (no HANDOFF_REPO env var required), then runs
`bun link` so the `handoff` binary lands on PATH.

Usage:
    python scripts/install.py            # slash command + bun link
    python scripts/install.py --no-link  # slash command only (no bun link)

Notes:
    - Re-runs are safe: the slash command file is overwritten in place.
    - Claude Code reads slash commands once at session start, so existing
      sessions will not see /handoff until they are restarted.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


SLASH_COMMAND_TEMPLATE = """\
---
description: Hand off a GitHub issue to claude/codex/copilot in a fresh worktree
argument-hint: <claude|codex|copilot> <#N | "free-form text"> [<#N>...]
allowed-tools: Bash
---

Run the handoff CLI with the user's arguments. The CLI creates a worktree, writes
`PROMPT.md`, and spawns a new terminal window running the chosen tool.

!`bun run --cwd "{repo_root}" src/cli.ts $ARGUMENTS`
"""


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def write_slash_command(root: Path) -> Path:
    target_dir = Path.home() / ".claude" / "commands"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / "handoff.md"
    target.write_text(
        SLASH_COMMAND_TEMPLATE.format(repo_root=root.as_posix()),
        encoding="utf-8",
    )
    return target


def run_bun_link(root: Path) -> None:
    bun = shutil.which("bun")
    if bun is None:
        raise SystemExit(
            "error: `bun` not found on PATH. Install bun (https://bun.sh) or "
            "re-run with --no-link to skip the CLI install."
        )
    subprocess.run([bun, "link"], cwd=root, check=True)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Install the handoff CLI and slash command.")
    parser.add_argument(
        "--no-link",
        action="store_true",
        help="skip `bun link` and install the slash command only",
    )
    args = parser.parse_args(argv)

    root = repo_root()
    slash_target = write_slash_command(root)
    print(f"installed slash command: {slash_target}")
    print(f"  -> bound to checkout: {root}")

    if args.no_link:
        print("skipped `bun link` (--no-link).")
    else:
        run_bun_link(root)
        print("ran `bun link` — `handoff` should now be on your PATH.")

    print()
    print("Restart any open Claude Code sessions to pick up the /handoff command.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
