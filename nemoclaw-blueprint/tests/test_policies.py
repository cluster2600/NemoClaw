#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Tests for NemoClaw policy YAML presets — structural validation."""

from pathlib import Path

import pytest
import yaml

POLICIES_DIR = Path(__file__).resolve().parent.parent / "policies"
PRESETS_DIR = POLICIES_DIR / "presets"

REQUIRED_PRESET_FIELDS = {"network_policies"}
REQUIRED_POLICY_FIELDS = {"name", "endpoints"}
REQUIRED_ENDPOINT_FIELDS = {"host", "port"}


def _load_yaml(path: Path) -> dict:
    with path.open() as f:
        return yaml.safe_load(f)


def _all_preset_files() -> list[Path]:
    return sorted(PRESETS_DIR.glob("*.yaml"))


# ---------------------------------------------------------------------------
# Base sandbox policy
# ---------------------------------------------------------------------------


class TestBaseSandboxPolicy:
    @pytest.fixture()
    def policy(self) -> dict:
        return _load_yaml(POLICIES_DIR / "openclaw-sandbox.yaml")

    def test_has_version(self, policy: dict) -> None:
        assert "version" in policy
        assert policy["version"] == 1

    def test_has_filesystem_policy(self, policy: dict) -> None:
        fs = policy["filesystem_policy"]
        assert "read_only" in fs
        assert "read_write" in fs

    def test_has_network_policies(self, policy: dict) -> None:
        np = policy["network_policies"]
        assert len(np) > 0

    def test_all_policies_have_name_and_endpoints(self, policy: dict) -> None:
        for key, pol in policy["network_policies"].items():
            assert "name" in pol, f"Policy {key} missing 'name'"
            assert "endpoints" in pol, f"Policy {key} missing 'endpoints'"

    def test_all_endpoints_have_host_and_port(self, policy: dict) -> None:
        for key, pol in policy["network_policies"].items():
            for i, ep in enumerate(pol["endpoints"]):
                assert "host" in ep, f"Policy {key} endpoint {i} missing 'host'"
                assert "port" in ep, f"Policy {key} endpoint {i} missing 'port'"

    def test_core_policies_have_binaries(self, policy: dict) -> None:
        """Core policies (claude_code, nvidia, github, etc.) must have binaries.
        Messaging policies (telegram, discord) are intentionally unrestricted."""
        messaging = {"telegram", "discord"}
        for key, pol in policy["network_policies"].items():
            if key not in messaging:
                assert "binaries" in pol, f"Policy {key} missing 'binaries' section"

    def test_sandbox_user_is_sandbox(self, policy: dict) -> None:
        proc = policy["process"]
        assert proc["run_as_user"] == "sandbox"
        assert proc["run_as_group"] == "sandbox"

    def test_openclaw_config_is_read_only(self, policy: dict) -> None:
        ro = policy["filesystem_policy"]["read_only"]
        assert any(".openclaw" in str(p) for p in ro)


# ---------------------------------------------------------------------------
# Preset YAML validation
# ---------------------------------------------------------------------------


class TestPresetFiles:
    def test_presets_directory_exists(self) -> None:
        assert PRESETS_DIR.exists()
        assert PRESETS_DIR.is_dir()

    def test_at_least_5_presets_exist(self) -> None:
        presets = _all_preset_files()
        assert len(presets) >= 5

    @pytest.mark.parametrize("preset_file", _all_preset_files(), ids=lambda p: p.stem)
    def test_preset_is_valid_yaml(self, preset_file: Path) -> None:
        data = _load_yaml(preset_file)
        assert isinstance(data, dict)

    @pytest.mark.parametrize("preset_file", _all_preset_files(), ids=lambda p: p.stem)
    def test_preset_has_network_policies(self, preset_file: Path) -> None:
        data = _load_yaml(preset_file)
        assert "network_policies" in data, f"{preset_file.name} missing network_policies"

    @pytest.mark.parametrize("preset_file", _all_preset_files(), ids=lambda p: p.stem)
    def test_preset_policies_have_required_fields(self, preset_file: Path) -> None:
        data = _load_yaml(preset_file)
        for key, pol in data["network_policies"].items():
            assert "name" in pol, f"{preset_file.name}/{key} missing 'name'"
            assert "endpoints" in pol, f"{preset_file.name}/{key} missing 'endpoints'"
            for i, ep in enumerate(pol["endpoints"]):
                assert "host" in ep, f"{preset_file.name}/{key} ep {i} missing 'host'"
                assert "port" in ep, f"{preset_file.name}/{key} ep {i} missing 'port'"

    @pytest.mark.parametrize("preset_file", _all_preset_files(), ids=lambda p: p.stem)
    def test_preset_policies_have_binaries(self, preset_file: Path) -> None:
        data = _load_yaml(preset_file)
        for key, pol in data["network_policies"].items():
            assert "binaries" in pol, f"{preset_file.name}/{key} missing 'binaries'"

    @pytest.mark.parametrize("preset_file", _all_preset_files(), ids=lambda p: p.stem)
    def test_preset_ports_are_valid(self, preset_file: Path) -> None:
        data = _load_yaml(preset_file)
        for key, pol in data["network_policies"].items():
            for ep in pol["endpoints"]:
                port = ep["port"]
                assert isinstance(port, int), f"{preset_file.name}/{key}: port must be int"
                assert 1 <= port <= 65535, f"{preset_file.name}/{key}: port {port} out of range"

    @pytest.mark.parametrize("preset_file", _all_preset_files(), ids=lambda p: p.stem)
    def test_preset_has_spdx_header(self, preset_file: Path) -> None:
        content = preset_file.read_text()
        assert "SPDX-License-Identifier" in content, f"{preset_file.name} missing SPDX header"


# ---------------------------------------------------------------------------
# Specific preset checks
# ---------------------------------------------------------------------------


class TestLocalInferencePreset:
    @pytest.fixture()
    def preset(self) -> dict:
        return _load_yaml(PRESETS_DIR / "local-inference.yaml")

    def test_allows_ollama_port(self, preset: dict) -> None:
        endpoints = []
        for pol in preset["network_policies"].values():
            endpoints.extend(pol["endpoints"])
        ports = {ep["port"] for ep in endpoints}
        assert 11434 in ports  # Default Ollama port

    def test_allows_vllm_port(self, preset: dict) -> None:
        endpoints = []
        for pol in preset["network_policies"].values():
            endpoints.extend(pol["endpoints"])
        ports = {ep["port"] for ep in endpoints}
        assert 8000 in ports  # Default vLLM port
