"""Tests for scripts/install.py — rendering and path-quoting logic.

`bun link` is never called; all filesystem mutation is confined to
pytest's `tmp_path` fixture.
"""
from __future__ import annotations

import importlib.util
import shlex
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

import pytest

# Load install.py via importlib so we don't mutate sys.path globally.
_INSTALL_PATH = Path(__file__).resolve().parent.parent / "scripts" / "install.py"
_REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_install():
    spec = importlib.util.spec_from_file_location("handoff_install", _INSTALL_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


install = _load_install()

PLACEHOLDER = install.PLACEHOLDER


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _source(tmp_path: Path, body: str | None = None) -> Path:
    """Write a minimal source template to tmp_path and return its path."""
    p = tmp_path / "handoff.md"
    p.write_text(
        body if body is not None else f"before {PLACEHOLDER} after",
        encoding="utf-8",
    )
    return p


def _patch_globals(source_cmd: Path, repo_root: Path, target_dir: Path) -> ExitStack:
    """Return an ExitStack that patches install's four module-level globals."""
    stack = ExitStack()
    for attr, val in [
        ("SOURCE_CMD", source_cmd),
        ("REPO_ROOT", repo_root),
        ("TARGET_DIR", target_dir),
        ("TARGET_CMD", target_dir / "handoff.md"),
    ]:
        stack.enter_context(patch.object(install, attr, val))
    return stack


def _run(
    tmp_path: Path,
    *,
    repo_root: Path,
    source_cmd: Path | None = None,
) -> str:
    """Run install_command() with patched globals; return the rendered output."""
    src = source_cmd if source_cmd is not None else _source(tmp_path)
    target_dir = tmp_path / "target"
    with _patch_globals(src, repo_root, target_dir):
        install.install_command()
    return (target_dir / "handoff.md").read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Placeholder substitution
# ---------------------------------------------------------------------------

def test_placeholder_replaced(tmp_path: Path) -> None:
    content = _run(tmp_path, repo_root=tmp_path / "repo")
    assert PLACEHOLDER not in content


def test_boring_path_appears_verbatim(tmp_path: Path) -> None:
    """Plain paths (no shell-special chars) should appear unquoted in output."""
    repo_root = tmp_path / "repo"
    content = _run(tmp_path, repo_root=repo_root)
    cli_path = (repo_root / "src" / "cli.ts").as_posix()
    assert f"'{cli_path}'" not in content
    assert cli_path in content


def test_missing_placeholder_exits(tmp_path: Path) -> None:
    src = _source(tmp_path, body="no placeholder here")
    with pytest.raises(SystemExit) as exc_info:
        _run(tmp_path, repo_root=tmp_path / "repo", source_cmd=src)
    msg = str(exc_info.value.code)
    assert "expected" in msg
    assert PLACEHOLDER in msg


def test_source_not_found_exits(tmp_path: Path) -> None:
    missing = tmp_path / "missing.md"
    with pytest.raises(SystemExit) as exc_info:
        _run(tmp_path, repo_root=tmp_path / "repo", source_cmd=missing)
    msg = str(exc_info.value.code)
    assert "source slash command not found" in msg
    assert str(missing) in msg


def test_against_real_template(tmp_path: Path) -> None:
    """install_command() stays compatible with the shipped handoff.md template."""
    real_source = _REPO_ROOT / ".claude" / "commands" / "handoff.md"
    repo_root = tmp_path / "repo"
    content = _run(tmp_path, repo_root=repo_root, source_cmd=real_source)
    assert PLACEHOLDER not in content
    cli_path = (repo_root / "src" / "cli.ts").as_posix()
    assert cli_path in content


# ---------------------------------------------------------------------------
# shlex.quote boundary cases
# ---------------------------------------------------------------------------

def test_path_with_spaces_is_single_quoted(tmp_path: Path) -> None:
    repo_root = tmp_path / "my repo" / "checkout"
    content = _run(tmp_path, repo_root=repo_root)
    cli_path = (repo_root / "src" / "cli.ts").as_posix()
    assert f"'{cli_path}'" in content


def test_path_with_dollar_sign(tmp_path: Path) -> None:
    """A $ in the path must be single-quoted so the shell won't expand it."""
    repo_root = tmp_path / "my$repo"
    content = _run(tmp_path, repo_root=repo_root)
    cli_path = (repo_root / "src" / "cli.ts").as_posix()
    assert shlex.quote(cli_path) in content


def test_path_with_single_quote(tmp_path: Path) -> None:
    """shlex.quote handles embedded single quotes via the 'a'\"'\"'b' idiom."""
    repo_root = tmp_path / "brian's repo"
    content = _run(tmp_path, repo_root=repo_root)
    cli_path = (repo_root / "src" / "cli.ts").as_posix()
    assert shlex.quote(cli_path) in content


def test_backtick_in_path_rejected(tmp_path: Path) -> None:
    # The fake root need not exist on disk — install_command() bails before
    # any REPO_ROOT filesystem access when the backtick check fires.
    fake_root = Path("/tmp/my`checkout")
    src = _source(tmp_path)
    with pytest.raises(SystemExit) as exc_info:
        _run(tmp_path, repo_root=fake_root, source_cmd=src)
    assert exc_info.value.code
    assert "backtick" in str(exc_info.value.code).lower()


# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------

def test_idempotent(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    src = _source(tmp_path)
    first = _run(tmp_path, repo_root=repo_root, source_cmd=src)
    second = _run(tmp_path, repo_root=repo_root, source_cmd=src)
    assert first == second
