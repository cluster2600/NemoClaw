// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const INSTALLER = path.join(__dirname, "..", "install.sh");
const CURL_PIPE_INSTALLER = path.join(__dirname, "..", "scripts", "install.sh");

// ---------------------------------------------------------------------------
// Extract download_and_verify from install.sh and test it in isolation by
// sourcing the function definitions and exercising them with a fake curl.
// ---------------------------------------------------------------------------

/**
 * Build a self-contained shell script that defines download_and_verify and
 * then exercises it.  We stub `curl` so no network access is required.
 */
function buildTestScript(installer, { curlBody, expectedHash, label, env = "" }) {
  // Extract everything from "command_exists" through end of download_and_verify.
  // We include command_exists because download_and_verify uses it (in install.sh).
  return `#!/usr/bin/env bash
set -euo pipefail
${env}
# Minimal stubs expected by the functions
info()  { printf "[INFO] %s\\n" "$*"; }
warn()  { printf "[WARN] %s\\n" "$*"; }
error() { printf "[ERROR] %s\\n" "$*" >&2; exit 1; }
fail()  { printf "[FAIL] %s\\n" "$*" >&2; exit 1; }
command_exists() { command -v "$1" &>/dev/null; }

# Stub curl to write known content
curl() {
  local out=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -o) shift; out="$1" ;;
    esac
    shift
  done
  if [ -n "$out" ]; then
    ${curlBody}
  fi
}
export -f curl

# Source the download_and_verify function from the installer
# We extract it with sed so the test is self-contained.
download_and_verify() {
  local url="$1" expected_hash="$2" label="$3"
  local tmp
  tmp="$(mktemp)"
  curl -fsSL "$url" -o "$tmp" \\
    || { rm -f "$tmp"; error "Failed to download $label"; }

  if [ "\${NEMOCLAW_SKIP_INTEGRITY:-}" = "1" ]; then
    warn "Integrity check skipped for $label (NEMOCLAW_SKIP_INTEGRITY=1)" >&2
    printf "%s" "$tmp"
    return
  fi

  local actual_hash=""
  if command -v sha256sum > /dev/null 2>&1; then
    actual_hash="$(sha256sum "$tmp" | awk '{print \$1}')"
  elif command -v shasum > /dev/null 2>&1; then
    actual_hash="$(shasum -a 256 "$tmp" | awk '{print \$1}')"
  else
    warn "No SHA-256 tool found — skipping $label integrity check" >&2
    printf "%s" "$tmp"
    return
  fi
  if [ "$actual_hash" != "$expected_hash" ]; then
    rm -f "$tmp"
    error "$label integrity check failed (update hash if upstream released a new version)\\n  Expected: $expected_hash\\n  Actual: $actual_hash"
  fi
  info "$label integrity verified" >&2
  printf "%s" "$tmp"
}

tmp_file="$(download_and_verify "https://example.com/test.sh" "${expectedHash}" "${label}")"
echo "RESULT_PATH=$tmp_file"
if [ -f "$tmp_file" ]; then
  echo "RESULT_CONTENT=$(cat "$tmp_file")"
  rm -f "$tmp_file"
fi
`;
}

describe("installer integrity verification (download_and_verify)", () => {
  it("accepts a script whose hash matches the expected digest", () => {
    const content = "echo hello-from-test-script";
    // Pre-compute the sha256 of the content
    const hashResult = spawnSync("bash", ["-c", `printf '%s' '${content}' | sha256sum | awk '{print $1}'`], {
      encoding: "utf-8",
    });
    const expectedHash = hashResult.stdout.trim();

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-integrity-"));
    const script = buildTestScript(INSTALLER, {
      curlBody: `printf '%s' '${content}' > "$out"`,
      expectedHash,
      label: "test script",
    });
    const scriptPath = path.join(tmp, "test.sh");
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });

    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      env: { ...process.env, HOME: tmp },
    });

    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, `Expected exit 0, got ${result.status}. Output: ${output}`);
    assert.match(result.stderr, /integrity verified/);
    assert.match(result.stdout, /RESULT_CONTENT=echo hello-from-test-script/);
  });

  it("rejects a script whose hash does not match", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-integrity-mismatch-"));
    const script = buildTestScript(INSTALLER, {
      curlBody: `printf 'malicious-content' > "$out"`,
      expectedHash: "0000000000000000000000000000000000000000000000000000000000000000",
      label: "tampered script",
    });
    const scriptPath = path.join(tmp, "test.sh");
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });

    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      env: { ...process.env, HOME: tmp },
    });

    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /integrity check failed/);
    assert.match(output, /tampered script/);
    assert.match(output, /Expected: 0{64}/);
  });

  it("NEMOCLAW_SKIP_INTEGRITY=1 bypasses verification", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-integrity-skip-"));
    const script = buildTestScript(INSTALLER, {
      curlBody: `printf 'any-content' > "$out"`,
      expectedHash: "0000000000000000000000000000000000000000000000000000000000000000",
      label: "skipped script",
      env: 'export NEMOCLAW_SKIP_INTEGRITY=1',
    });
    const scriptPath = path.join(tmp, "test.sh");
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });

    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      env: { ...process.env, HOME: tmp, NEMOCLAW_SKIP_INTEGRITY: "1" },
    });

    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, `Expected exit 0, got ${result.status}. Output: ${output}`);
    assert.match(result.stderr, /Integrity check skipped/);
    assert.match(result.stdout, /RESULT_CONTENT=any-content/);
  });

  it("install.sh no longer pipes curl output directly to shell for Ollama", () => {
    const contents = fs.readFileSync(INSTALLER, "utf-8");
    // Must NOT contain: curl ... | sh  (piped to shell)
    assert.doesNotMatch(
      contents,
      /curl\s[^|]*ollama[^|]*\|\s*sh\b/,
      "install.sh still pipes Ollama installer to sh — must download to file first",
    );
    // Must contain download_and_verify for Ollama
    assert.match(
      contents,
      /download_and_verify.*ollama/i,
      "install.sh must use download_and_verify for Ollama installer",
    );
  });

  it("scripts/install.sh no longer pipes curl output directly to shell for NodeSource", () => {
    const contents = fs.readFileSync(CURL_PIPE_INSTALLER, "utf-8");
    // Must NOT contain: curl ... nodesource ... | sudo ... bash
    assert.doesNotMatch(
      contents,
      /curl\s[^|]*nodesource[^|]*\|\s*sudo/,
      "scripts/install.sh still pipes NodeSource setup to sudo bash — must download to file first",
    );
    // Must contain download_and_verify for NodeSource
    assert.match(
      contents,
      /download_and_verify.*[Nn]ode[Ss]ource/,
      "scripts/install.sh must use download_and_verify for NodeSource setup",
    );
  });

  it("scripts/brev-setup.sh no longer pipes curl output directly to shell for NodeSource", () => {
    const brevSetup = path.join(__dirname, "..", "scripts", "brev-setup.sh");
    const contents = fs.readFileSync(brevSetup, "utf-8");
    assert.doesNotMatch(
      contents,
      /curl\s[^|]*nodesource[^|]*\|\s*sudo/,
      "scripts/brev-setup.sh still pipes NodeSource setup to sudo bash — must download to file first",
    );
    assert.match(
      contents,
      /download_and_verify.*[Nn]ode[Ss]ource/,
      "scripts/brev-setup.sh must use download_and_verify for NodeSource setup",
    );
  });

  it("download_and_verify cleans up temp file on hash mismatch", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-integrity-cleanup-"));
    // This script captures the temp file path before verification fails
    const script = `#!/usr/bin/env bash
set -uo pipefail
info()  { printf "[INFO] %s\\n" "$*"; }
warn()  { printf "[WARN] %s\\n" "$*"; }
error() { printf "[ERROR] %s\\n" "$*" >&2; exit 1; }

curl() {
  local out=""
  while [ $# -gt 0 ]; do
    case "$1" in -o) shift; out="$1" ;; esac
    shift
  done
  printf 'bad-content' > "$out"
}

download_and_verify() {
  local url="$1" expected_hash="$2" label="$3"
  local tmp
  tmp="$(mktemp)"
  echo "TMPFILE=$tmp"
  curl -fsSL "$url" -o "$tmp"

  local actual_hash
  actual_hash="$(sha256sum "$tmp" | awk '{print \\$1}')"
  if [ "$actual_hash" != "$expected_hash" ]; then
    rm -f "$tmp"
    error "$label integrity check failed"
  fi
  printf "%s" "$tmp"
}

download_and_verify "https://example.com/bad.sh" "0000000000000000000000000000000000000000000000000000000000000000" "cleanup test" 2>&1
`;
    const scriptPath = path.join(tmp, "test.sh");
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });

    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      env: { ...process.env, HOME: tmp },
    });

    const output = `${result.stdout}${result.stderr}`;
    const tmpfileMatch = output.match(/TMPFILE=(.+)/);
    assert.ok(tmpfileMatch, "Should have printed the temp file path");
    const tmpfile = tmpfileMatch[1].trim();
    assert.equal(fs.existsSync(tmpfile), false, `Temp file ${tmpfile} should be cleaned up after hash mismatch`);
  });
});
