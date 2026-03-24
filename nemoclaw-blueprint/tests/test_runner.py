#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Tests for the NemoClaw blueprint runner."""

import json
import os
import subprocess
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
import yaml

from orchestrator.runner import (
    action_apply,
    action_plan,
    action_rollback,
    action_status,
    emit_run_id,
    load_blueprint,
    log,
    openshell_available,
    progress,
    run_cmd,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

SAMPLE_BLUEPRINT: dict[str, Any] = {
    "version": "0.1.0",
    "components": {
        "sandbox": {
            "image": "ghcr.io/nvidia/openclaw:latest",
            "name": "openclaw",
            "forward_ports": [18789],
        },
        "inference": {
            "profiles": {
                "default": {
                    "provider_type": "nvidia",
                    "provider_name": "nvidia-inference",
                    "endpoint": "https://integrate.api.nvidia.com/v1",
                    "model": "nvidia/nemotron-3-super-120b-a12b",
                },
                "vllm": {
                    "provider_type": "openai",
                    "provider_name": "vllm-local",
                    "endpoint": "http://localhost:8000/v1",
                    "model": "nvidia/nemotron-3-nano-30b-a3b",
                    "credential_env": "OPENAI_API_KEY",
                    "credential_default": "dummy",
                },
            }
        },
        "policy": {
            "additions": {
                "nim_service": {
                    "name": "nim_service",
                    "endpoints": [{"host": "nim-service.local", "port": 8000}],
                }
            }
        },
    },
}


@pytest.fixture()
def blueprint_dir(tmp_path: Path) -> Path:
    """Create a temp directory with a valid blueprint.yaml."""
    bp_file = tmp_path / "blueprint.yaml"
    bp_file.write_text(yaml.dump(SAMPLE_BLUEPRINT))
    return tmp_path


@pytest.fixture()
def state_dir(tmp_path: Path) -> Path:
    """Create a temp state directory for run artifacts."""
    d = tmp_path / ".nemoclaw" / "state" / "runs"
    d.mkdir(parents=True)
    return d


# ---------------------------------------------------------------------------
# Unit tests: helper functions
# ---------------------------------------------------------------------------


class TestLog:
    def test_log_prints_to_stdout(self, capsys: pytest.CaptureFixture[str]) -> None:
        log("hello world")
        assert capsys.readouterr().out == "hello world\n"


class TestProgress:
    def test_progress_format(self, capsys: pytest.CaptureFixture[str]) -> None:
        progress(42, "Building image")
        assert capsys.readouterr().out == "PROGRESS:42:Building image\n"

    def test_progress_zero(self, capsys: pytest.CaptureFixture[str]) -> None:
        progress(0, "Starting")
        assert capsys.readouterr().out == "PROGRESS:0:Starting\n"

    def test_progress_hundred(self, capsys: pytest.CaptureFixture[str]) -> None:
        progress(100, "Done")
        assert capsys.readouterr().out == "PROGRESS:100:Done\n"


class TestEmitRunId:
    def test_run_id_format(self, capsys: pytest.CaptureFixture[str]) -> None:
        rid = emit_run_id()
        out = capsys.readouterr().out.strip()
        assert out.startswith("RUN_ID:nc-")
        assert rid.startswith("nc-")
        assert rid == out.removeprefix("RUN_ID:")

    def test_run_id_uniqueness(self) -> None:
        ids = {emit_run_id() for _ in range(10)}
        assert len(ids) == 10


class TestRunCmd:
    def test_successful_command(self) -> None:
        result = run_cmd(["echo", "hello"], capture=True)
        assert result.returncode == 0
        assert result.stdout.strip() == "hello"

    def test_failed_command_raises(self) -> None:
        with pytest.raises(subprocess.CalledProcessError):
            run_cmd(["false"], check=True)

    def test_failed_command_no_check(self) -> None:
        result = run_cmd(["false"], check=False)
        assert result.returncode != 0


class TestOpenshellAvailable:
    @patch("orchestrator.runner.shutil.which", return_value="/usr/bin/openshell")
    def test_available(self, _mock: MagicMock) -> None:
        assert openshell_available() is True

    @patch("orchestrator.runner.shutil.which", return_value=None)
    def test_not_available(self, _mock: MagicMock) -> None:
        assert openshell_available() is False


# ---------------------------------------------------------------------------
# Unit tests: load_blueprint
# ---------------------------------------------------------------------------


class TestLoadBlueprint:
    def test_loads_valid_blueprint(self, blueprint_dir: Path) -> None:
        with patch.dict(os.environ, {"NEMOCLAW_BLUEPRINT_PATH": str(blueprint_dir)}):
            bp = load_blueprint()
        assert bp["version"] == "0.1.0"
        assert "default" in bp["components"]["inference"]["profiles"]

    def test_missing_blueprint_exits(self, tmp_path: Path) -> None:
        with patch.dict(os.environ, {"NEMOCLAW_BLUEPRINT_PATH": str(tmp_path)}):
            with pytest.raises(SystemExit):
                load_blueprint()


# ---------------------------------------------------------------------------
# Unit tests: action_plan
# ---------------------------------------------------------------------------


class TestActionPlan:
    @patch("orchestrator.runner.openshell_available", return_value=True)
    def test_plan_default_profile(
        self, _mock: MagicMock, capsys: pytest.CaptureFixture[str]
    ) -> None:
        plan = action_plan("default", SAMPLE_BLUEPRINT)
        assert plan["profile"] == "default"
        assert plan["sandbox"]["image"] == "ghcr.io/nvidia/openclaw:latest"
        assert plan["sandbox"]["name"] == "openclaw"
        assert plan["inference"]["provider_type"] == "nvidia"
        assert plan["inference"]["model"] == "nvidia/nemotron-3-super-120b-a12b"
        assert plan["dry_run"] is False

    @patch("orchestrator.runner.openshell_available", return_value=True)
    def test_plan_with_endpoint_override(
        self, _mock: MagicMock, capsys: pytest.CaptureFixture[str]
    ) -> None:
        plan = action_plan("default", SAMPLE_BLUEPRINT, endpoint_url="https://custom.endpoint/v1")
        assert plan["inference"]["endpoint"] == "https://custom.endpoint/v1"

    @patch("orchestrator.runner.openshell_available", return_value=True)
    def test_plan_dry_run(self, _mock: MagicMock, capsys: pytest.CaptureFixture[str]) -> None:
        plan = action_plan("default", SAMPLE_BLUEPRINT, dry_run=True)
        assert plan["dry_run"] is True

    def test_plan_invalid_profile_exits(self) -> None:
        with pytest.raises(SystemExit):
            action_plan("nonexistent", SAMPLE_BLUEPRINT)

    @patch("orchestrator.runner.openshell_available", return_value=False)
    def test_plan_no_openshell_exits(self, _mock: MagicMock) -> None:
        with pytest.raises(SystemExit):
            action_plan("default", SAMPLE_BLUEPRINT)

    @patch("orchestrator.runner.openshell_available", return_value=True)
    def test_plan_includes_policy_additions(
        self, _mock: MagicMock, capsys: pytest.CaptureFixture[str]
    ) -> None:
        plan = action_plan("default", SAMPLE_BLUEPRINT)
        assert "nim_service" in plan["policy_additions"]

    @patch("orchestrator.runner.openshell_available", return_value=True)
    def test_plan_vllm_profile(self, _mock: MagicMock, capsys: pytest.CaptureFixture[str]) -> None:
        plan = action_plan("vllm", SAMPLE_BLUEPRINT)
        assert plan["inference"]["provider_type"] == "openai"
        assert plan["inference"]["credential_env"] == "OPENAI_API_KEY"

    @patch("orchestrator.runner.openshell_available", return_value=True)
    def test_plan_emits_run_id(self, _mock: MagicMock, capsys: pytest.CaptureFixture[str]) -> None:
        plan = action_plan("default", SAMPLE_BLUEPRINT)
        out = capsys.readouterr().out
        assert "RUN_ID:nc-" in out
        assert plan["run_id"].startswith("nc-")

    @patch("orchestrator.runner.openshell_available", return_value=True)
    def test_plan_outputs_json(self, _mock: MagicMock, capsys: pytest.CaptureFixture[str]) -> None:
        action_plan("default", SAMPLE_BLUEPRINT)
        out = capsys.readouterr().out
        # Extract JSON from output (after PROGRESS and RUN_ID lines)
        json_lines: list[str] = []
        capture = False
        for line in out.splitlines():
            if line.startswith("{"):
                capture = True
            if capture:
                json_lines.append(line)
        parsed = json.loads("\n".join(json_lines))
        assert "run_id" in parsed
        assert "profile" in parsed


# ---------------------------------------------------------------------------
# Unit tests: action_apply
# ---------------------------------------------------------------------------


class TestActionApply:
    @patch("orchestrator.runner.run_cmd")
    @patch("orchestrator.runner.emit_run_id", return_value="nc-test-001")
    def test_apply_creates_sandbox(
        self,
        _emit: MagicMock,
        mock_run: MagicMock,
        tmp_path: Path,
    ) -> None:
        mock_run.return_value = MagicMock(returncode=0, stderr="", stdout="")
        with patch("orchestrator.runner.Path.home", return_value=tmp_path):
            action_apply("default", SAMPLE_BLUEPRINT)

        # First call should be sandbox create
        first_call_args = mock_run.call_args_list[0][0][0]
        assert "openshell" in first_call_args
        assert "sandbox" in first_call_args
        assert "create" in first_call_args

    @patch("orchestrator.runner.run_cmd")
    @patch("orchestrator.runner.emit_run_id", return_value="nc-test-002")
    def test_apply_reuses_existing_sandbox(
        self,
        _emit: MagicMock,
        mock_run: MagicMock,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        # First call (sandbox create) returns "already exists"
        mock_run.return_value = MagicMock(returncode=1, stderr="already exists", stdout="")
        with patch("orchestrator.runner.Path.home", return_value=tmp_path):
            action_apply("default", SAMPLE_BLUEPRINT)
        assert "already exists, reusing" in capsys.readouterr().out

    @patch("orchestrator.runner.run_cmd")
    @patch("orchestrator.runner.emit_run_id", return_value="nc-test-003")
    def test_apply_sandbox_create_failure_exits(
        self,
        _emit: MagicMock,
        mock_run: MagicMock,
        tmp_path: Path,
    ) -> None:
        mock_run.return_value = MagicMock(returncode=1, stderr="permission denied", stdout="")
        with patch("orchestrator.runner.Path.home", return_value=tmp_path):
            with pytest.raises(SystemExit):
                action_apply("default", SAMPLE_BLUEPRINT)

    @patch("orchestrator.runner.run_cmd")
    @patch("orchestrator.runner.emit_run_id", return_value="nc-test-004")
    def test_apply_saves_run_state(
        self,
        _emit: MagicMock,
        mock_run: MagicMock,
        tmp_path: Path,
    ) -> None:
        mock_run.return_value = MagicMock(returncode=0, stderr="", stdout="")
        with patch("orchestrator.runner.Path.home", return_value=tmp_path):
            action_apply("default", SAMPLE_BLUEPRINT)

        plan_file = tmp_path / ".nemoclaw" / "state" / "runs" / "nc-test-004" / "plan.json"
        assert plan_file.exists()
        plan = json.loads(plan_file.read_text())
        assert plan["run_id"] == "nc-test-004"
        assert plan["profile"] == "default"
        assert plan["sandbox_name"] == "openclaw"

    @patch("orchestrator.runner.run_cmd")
    @patch("orchestrator.runner.emit_run_id", return_value="nc-test-005")
    def test_apply_with_endpoint_override(
        self,
        _emit: MagicMock,
        mock_run: MagicMock,
        tmp_path: Path,
    ) -> None:
        mock_run.return_value = MagicMock(returncode=0, stderr="", stdout="")
        with patch("orchestrator.runner.Path.home", return_value=tmp_path):
            action_apply("default", SAMPLE_BLUEPRINT, endpoint_url="https://custom.api/v1")

        plan_file = tmp_path / ".nemoclaw" / "state" / "runs" / "nc-test-005" / "plan.json"
        plan = json.loads(plan_file.read_text())
        assert plan["inference"]["endpoint"] == "https://custom.api/v1"

    @patch("orchestrator.runner.run_cmd")
    @patch("orchestrator.runner.emit_run_id", return_value="nc-test-006")
    def test_apply_resolves_credential_from_env(
        self,
        _emit: MagicMock,
        mock_run: MagicMock,
        tmp_path: Path,
    ) -> None:
        mock_run.return_value = MagicMock(returncode=0, stderr="", stdout="")
        with (
            patch("orchestrator.runner.Path.home", return_value=tmp_path),
            patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test-key"}),
        ):
            action_apply("vllm", SAMPLE_BLUEPRINT)

        # Provider create call should include credential
        provider_call = mock_run.call_args_list[1][0][0]
        assert "--credential" in provider_call
        assert "OPENAI_API_KEY=sk-test-key" in provider_call

    @patch("orchestrator.runner.run_cmd")
    @patch("orchestrator.runner.emit_run_id", return_value="nc-test-007")
    def test_apply_uses_credential_default(
        self,
        _emit: MagicMock,
        mock_run: MagicMock,
        tmp_path: Path,
    ) -> None:
        mock_run.return_value = MagicMock(returncode=0, stderr="", stdout="")
        env = {k: v for k, v in os.environ.items() if k != "OPENAI_API_KEY"}
        with (
            patch("orchestrator.runner.Path.home", return_value=tmp_path),
            patch.dict(os.environ, env, clear=True),
        ):
            action_apply("vllm", SAMPLE_BLUEPRINT)

        provider_call = mock_run.call_args_list[1][0][0]
        assert "--credential" in provider_call
        assert "OPENAI_API_KEY=dummy" in provider_call


# ---------------------------------------------------------------------------
# Unit tests: action_status
# ---------------------------------------------------------------------------


class TestActionStatus:
    def test_status_no_runs(self, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
        with patch("orchestrator.runner.Path.home", return_value=tmp_path):
            with pytest.raises(SystemExit):
                action_status()

    def test_status_specific_run(self, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
        run_dir = tmp_path / ".nemoclaw" / "state" / "runs" / "nc-test-001"
        run_dir.mkdir(parents=True)
        plan = {"run_id": "nc-test-001", "profile": "default"}
        (run_dir / "plan.json").write_text(json.dumps(plan))

        with patch("orchestrator.runner.Path.home", return_value=tmp_path):
            action_status(rid="nc-test-001")

        out = capsys.readouterr().out
        assert "nc-test-001" in out

    def test_status_latest_run(self, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
        runs_dir = tmp_path / ".nemoclaw" / "state" / "runs"
        run_dir = runs_dir / "nc-test-latest"
        run_dir.mkdir(parents=True)
        plan = {"run_id": "nc-test-latest", "profile": "vllm"}
        (run_dir / "plan.json").write_text(json.dumps(plan))

        with patch("orchestrator.runner.Path.home", return_value=tmp_path):
            action_status()

        out = capsys.readouterr().out
        assert "nc-test-latest" in out

    def test_status_missing_plan(self, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
        run_dir = tmp_path / ".nemoclaw" / "state" / "runs" / "nc-orphan"
        run_dir.mkdir(parents=True)

        with patch("orchestrator.runner.Path.home", return_value=tmp_path):
            action_status(rid="nc-orphan")

        out = capsys.readouterr().out
        assert "unknown" in out

    def test_status_empty_runs_dir(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        runs_dir = tmp_path / ".nemoclaw" / "state" / "runs"
        runs_dir.mkdir(parents=True)

        with patch("orchestrator.runner.Path.home", return_value=tmp_path):
            with pytest.raises(SystemExit):
                action_status()


# ---------------------------------------------------------------------------
# Unit tests: action_rollback
# ---------------------------------------------------------------------------


class TestActionRollback:
    def test_rollback_missing_run_exits(self, tmp_path: Path) -> None:
        with patch("orchestrator.runner.Path.home", return_value=tmp_path):
            with pytest.raises(SystemExit):
                action_rollback("nc-nonexistent")

    @patch("orchestrator.runner.run_cmd")
    def test_rollback_stops_and_removes_sandbox(
        self,
        mock_run: MagicMock,
        tmp_path: Path,
    ) -> None:
        mock_run.return_value = MagicMock(returncode=0)
        run_dir = tmp_path / ".nemoclaw" / "state" / "runs" / "nc-rb-001"
        run_dir.mkdir(parents=True)
        plan = {"run_id": "nc-rb-001", "sandbox_name": "my-sandbox"}
        (run_dir / "plan.json").write_text(json.dumps(plan))

        with patch("orchestrator.runner.Path.home", return_value=tmp_path):
            action_rollback("nc-rb-001")

        # Should call stop then remove
        calls = [c[0][0] for c in mock_run.call_args_list]
        stop_call = calls[0]
        remove_call = calls[1]
        assert "stop" in stop_call
        assert "my-sandbox" in stop_call
        assert "remove" in remove_call
        assert "my-sandbox" in remove_call

    @patch("orchestrator.runner.run_cmd")
    def test_rollback_marks_rolled_back(
        self,
        mock_run: MagicMock,
        tmp_path: Path,
    ) -> None:
        mock_run.return_value = MagicMock(returncode=0)
        run_dir = tmp_path / ".nemoclaw" / "state" / "runs" / "nc-rb-002"
        run_dir.mkdir(parents=True)
        plan = {"run_id": "nc-rb-002", "sandbox_name": "openclaw"}
        (run_dir / "plan.json").write_text(json.dumps(plan))

        with patch("orchestrator.runner.Path.home", return_value=tmp_path):
            action_rollback("nc-rb-002")

        assert (run_dir / "rolled_back").exists()

    @patch("orchestrator.runner.run_cmd")
    def test_rollback_without_plan_still_marks(
        self,
        mock_run: MagicMock,
        tmp_path: Path,
    ) -> None:
        run_dir = tmp_path / ".nemoclaw" / "state" / "runs" / "nc-rb-003"
        run_dir.mkdir(parents=True)
        # No plan.json — should still mark as rolled back

        with patch("orchestrator.runner.Path.home", return_value=tmp_path):
            action_rollback("nc-rb-003")

        assert (run_dir / "rolled_back").exists()
        # Should not have called run_cmd (no sandbox to stop)
        mock_run.assert_not_called()


# ---------------------------------------------------------------------------
# Unit tests: main CLI parser
# ---------------------------------------------------------------------------


class TestMainParser:
    @patch("orchestrator.runner.load_blueprint", return_value=SAMPLE_BLUEPRINT)
    @patch("orchestrator.runner.action_plan")
    def test_main_plan(self, mock_plan: MagicMock, _bp: MagicMock) -> None:
        from orchestrator.runner import main

        with patch("sys.argv", ["runner", "plan", "--profile", "vllm"]):
            main()
        mock_plan.assert_called_once()
        assert mock_plan.call_args[0][0] == "vllm"

    @patch("orchestrator.runner.load_blueprint", return_value=SAMPLE_BLUEPRINT)
    @patch("orchestrator.runner.action_status")
    def test_main_status(self, mock_status: MagicMock, _bp: MagicMock) -> None:
        from orchestrator.runner import main

        with patch("sys.argv", ["runner", "status", "--run-id", "nc-test"]):
            main()
        mock_status.assert_called_once_with(rid="nc-test")

    @patch("orchestrator.runner.load_blueprint", return_value=SAMPLE_BLUEPRINT)
    @patch("orchestrator.runner.action_rollback")
    def test_main_rollback_requires_run_id(self, _rollback: MagicMock, _bp: MagicMock) -> None:
        from orchestrator.runner import main

        with patch("sys.argv", ["runner", "rollback"]):
            with pytest.raises(SystemExit):
                main()
