#!/usr/bin/env python3
"""Install handoff for global use.

1. Renders .claude/commands/handoff.md into ~/.claude/commands/handoff.md
   with this checkout's absolute path baked in (no env var needed).
2. Runs `bun link` so the `handoff` CLI is on PATH (skip with --no-link).

Re-run this after moving the checkout.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE_CMD = REPO_ROOT / ".claude" / "commands" / "handoff.md"
TARGET_DIR = Path.home() / ".claude" / "commands"
TARGET_CMD = TARGET_DIR / "handoff.md"

PLACEHOLDER = "${HANDOFF_REPO:-$(pwd)}"


def install_command() -> None:
    if not SOURCE_CMD.is_file():
        sys.exit(f"error: source slash command not found at {SOURCE_CMD}")

    body = SOURCE_CMD.read_text(encoding="utf-8")
    if PLACEHOLDER not in body:
        sys.exit(
            f"error: expected {PLACEHOLDER!r} in {SOURCE_CMD}; "
            "the install script needs to be updated."
        )

    repo_path = REPO_ROOT.as_posix()
    rendered = body.replace(PLACEHOLDER, repo_path)

    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    TARGET_CMD.write_text(rendered, encoding="utf-8")
    print(f"[install] wrote slash command -> {TARGET_CMD}")
    print(f"          repo path baked in : {repo_path}")


def link_bin() -> None:
    bun = shutil.which("bun")
    if bun is None:
        print("[install] WARNING: `bun` not found on PATH; skipping `bun link`.")
        return
    try:
        subprocess.run([bun, "link"], cwd=REPO_ROOT, check=True)
    except subprocess.CalledProcessError as exc:
        print(f"[install] WARNING: `bun link` exited {exc.returncode}.")
        return
    print("[install] `bun link` succeeded; `handoff` should be on PATH.")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Install handoff (slash command + CLI) for the current user."
    )
    parser.add_argument(
        "--no-link",
        action="store_true",
        help="skip `bun link` (install slash command only)",
    )
    args = parser.parse_args()

    install_command()
    if not args.no_link:
        link_bin()

    print()
    print("Done. Restart Claude Code (slash commands are loaded at session start),")
    print("then run `/handoff` in any repo.")


if __name__ == "__main__":
    main()
