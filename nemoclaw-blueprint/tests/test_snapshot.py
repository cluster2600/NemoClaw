#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Tests for the NemoClaw migration snapshot module."""

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

import migrations.snapshot as snap

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def fake_home(tmp_path: Path) -> Path:
    """Set up a fake home directory with .openclaw config."""
    openclaw = tmp_path / ".openclaw"
    openclaw.mkdir()
    (openclaw / "config.json").write_text('{"key": "value"}')
    (openclaw / "extensions").mkdir()
    (openclaw / "extensions" / "hello.js").write_text("// ext")
    return tmp_path


@pytest.fixture(autouse=True)
def _patch_paths(fake_home: Path) -> None:
    """Patch module-level path constants to use fake_home."""
    with (
        patch.object(snap, "HOME", fake_home),
        patch.object(snap, "OPENCLAW_DIR", fake_home / ".openclaw"),
        patch.object(snap, "NEMOCLAW_DIR", fake_home / ".nemoclaw"),
        patch.object(snap, "SNAPSHOTS_DIR", fake_home / ".nemoclaw" / "snapshots"),
    ):
        yield


# ---------------------------------------------------------------------------
# create_snapshot
# ---------------------------------------------------------------------------


class TestCreateSnapshot:
    def test_creates_snapshot_dir(self, fake_home: Path) -> None:
        result = snap.create_snapshot()
        assert result is not None
        assert result.exists()

    def test_copies_openclaw_files(self, fake_home: Path) -> None:
        result = snap.create_snapshot()
        assert result is not None
        copied = result / "openclaw" / "config.json"
        assert copied.exists()
        assert json.loads(copied.read_text()) == {"key": "value"}

    def test_copies_nested_files(self, fake_home: Path) -> None:
        result = snap.create_snapshot()
        assert result is not None
        ext = result / "openclaw" / "extensions" / "hello.js"
        assert ext.exists()
        assert ext.read_text() == "// ext"

    def test_writes_manifest(self, fake_home: Path) -> None:
        result = snap.create_snapshot()
        assert result is not None
        manifest_file = result / "snapshot.json"
        assert manifest_file.exists()
        manifest = json.loads(manifest_file.read_text())
        assert manifest["file_count"] == 2  # config.json + hello.js
        assert "config.json" in manifest["contents"]

    def test_returns_none_when_no_openclaw_dir(self, fake_home: Path) -> None:
        import shutil

        shutil.rmtree(fake_home / ".openclaw")
        result = snap.create_snapshot()
        assert result is None

    def test_snapshot_is_independent_copy(self, fake_home: Path) -> None:
        """Snapshot content reflects state at creation time, not current state."""
        snap1 = snap.create_snapshot()
        assert snap1 is not None
        original = json.loads((snap1 / "openclaw" / "config.json").read_text())
        assert original["key"] == "value"

        # Modify source — snapshot should be unaffected
        (fake_home / ".openclaw" / "config.json").write_text('{"key": "updated"}')
        assert json.loads((snap1 / "openclaw" / "config.json").read_text())["key"] == "value"


# ---------------------------------------------------------------------------
# restore_into_sandbox
# ---------------------------------------------------------------------------


class TestRestoreIntoSandbox:
    @patch("migrations.snapshot.subprocess.run")
    def test_restore_calls_openshell_cp(self, mock_run: MagicMock, fake_home: Path) -> None:
        mock_run.return_value = MagicMock(returncode=0)
        snap_dir = snap.create_snapshot()
        assert snap_dir is not None

        result = snap.restore_into_sandbox(snap_dir, sandbox_name="my-sandbox")
        assert result is True

        call_args = mock_run.call_args[0][0]
        assert "openshell" in call_args
        assert "sandbox" in call_args
        assert "cp" in call_args
        assert "my-sandbox:/sandbox/.openclaw" in call_args

    @patch("migrations.snapshot.subprocess.run")
    def test_restore_fails_on_subprocess_error(self, mock_run: MagicMock, fake_home: Path) -> None:
        mock_run.return_value = MagicMock(returncode=1)
        snap_dir = snap.create_snapshot()
        assert snap_dir is not None

        result = snap.restore_into_sandbox(snap_dir)
        assert result is False

    def test_restore_fails_when_no_openclaw_subdir(self, fake_home: Path, tmp_path: Path) -> None:
        empty_snap = tmp_path / "empty_snap"
        empty_snap.mkdir()
        result = snap.restore_into_sandbox(empty_snap)
        assert result is False

    @patch("migrations.snapshot.subprocess.run")
    def test_restore_default_sandbox_name(self, mock_run: MagicMock, fake_home: Path) -> None:
        mock_run.return_value = MagicMock(returncode=0)
        snap_dir = snap.create_snapshot()
        assert snap_dir is not None

        snap.restore_into_sandbox(snap_dir)
        call_args = mock_run.call_args[0][0]
        assert "openclaw:/sandbox/.openclaw" in call_args


# ---------------------------------------------------------------------------
# cutover_host
# ---------------------------------------------------------------------------


class TestCutoverHost:
    def test_cutover_renames_openclaw_dir(self, fake_home: Path) -> None:
        snap_dir = snap.create_snapshot()
        assert snap_dir is not None

        result = snap.cutover_host(snap_dir)
        assert result is True
        assert not (fake_home / ".openclaw").exists()
        # Should have created archive
        archives = list(fake_home.glob(".openclaw.pre-nemoclaw.*"))
        assert len(archives) == 1

    def test_cutover_no_openclaw_dir(self, fake_home: Path) -> None:
        import shutil

        shutil.rmtree(fake_home / ".openclaw")
        result = snap.cutover_host(Path("/nonexistent"))
        assert result is True  # Nothing to archive

    def test_cutover_preserves_archive_content(self, fake_home: Path) -> None:
        snap_dir = snap.create_snapshot()
        assert snap_dir is not None

        snap.cutover_host(snap_dir)
        archives = list(fake_home.glob(".openclaw.pre-nemoclaw.*"))
        config = archives[0] / "config.json"
        assert config.exists()
        assert json.loads(config.read_text()) == {"key": "value"}


# ---------------------------------------------------------------------------
# rollback_from_snapshot
# ---------------------------------------------------------------------------


class TestRollbackFromSnapshot:
    def test_rollback_restores_config(self, fake_home: Path) -> None:
        snap_dir = snap.create_snapshot()
        assert snap_dir is not None

        # Modify current config
        (fake_home / ".openclaw" / "config.json").write_text('{"key": "modified"}')

        result = snap.rollback_from_snapshot(snap_dir)
        assert result is True

        restored = json.loads((fake_home / ".openclaw" / "config.json").read_text())
        assert restored["key"] == "value"  # Original value restored

    def test_rollback_archives_current_before_restore(self, fake_home: Path) -> None:
        snap_dir = snap.create_snapshot()
        assert snap_dir is not None

        snap.rollback_from_snapshot(snap_dir)

        archives = list(fake_home.glob(".openclaw.nemoclaw-archived.*"))
        assert len(archives) == 1

    def test_rollback_fails_on_missing_snapshot(self, tmp_path: Path) -> None:
        empty = tmp_path / "empty"
        empty.mkdir()
        result = snap.rollback_from_snapshot(empty)
        assert result is False

    def test_rollback_when_no_existing_config(self, fake_home: Path) -> None:
        snap_dir = snap.create_snapshot()
        assert snap_dir is not None

        import shutil

        shutil.rmtree(fake_home / ".openclaw")
        assert not (fake_home / ".openclaw").exists()

        result = snap.rollback_from_snapshot(snap_dir)
        assert result is True
        assert (fake_home / ".openclaw").exists()


# ---------------------------------------------------------------------------
# list_snapshots
# ---------------------------------------------------------------------------


class TestListSnapshots:
    def test_empty_when_no_snapshots(self, fake_home: Path) -> None:
        result = snap.list_snapshots()
        assert result == []

    def test_lists_created_snapshots(self, fake_home: Path) -> None:
        snap.create_snapshot()
        result = snap.list_snapshots()
        assert len(result) == 1
        assert "timestamp" in result[0]
        assert "file_count" in result[0]
        assert "path" in result[0]

    def test_lists_snapshot_with_correct_metadata(self, fake_home: Path) -> None:
        (fake_home / ".openclaw" / "extra.txt").write_text("extra")
        snap.create_snapshot()
        result = snap.list_snapshots()
        assert len(result) == 1
        assert result[0]["file_count"] == 3  # config.json + hello.js + extra.txt

    def test_skips_dirs_without_manifest(self, fake_home: Path) -> None:
        snapshots_dir = fake_home / ".nemoclaw" / "snapshots"
        snapshots_dir.mkdir(parents=True, exist_ok=True)
        (snapshots_dir / "garbage").mkdir()
        result = snap.list_snapshots()
        assert result == []
