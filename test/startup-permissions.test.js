// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const STARTUP_SH = path.join(__dirname, "..", "scripts", "nemoclaw-start.sh");

/**
 * Source just the fix_home_permissions function from nemoclaw-start.sh
 * (avoid running the full entrypoint which tries to start the gateway).
 */
function extractAndRun(homeDir) {
  // Extract fix_home_permissions from the startup script and run it
  // with HOME pointing at our temp directory.
  const script = `
    set -euo pipefail
    HOME="${homeDir}"
    # Extract the function from the startup script
    eval "$(sed -n '/^fix_home_permissions()/,/^}/p' "${STARTUP_SH}")"
    fix_home_permissions
  `;
  return spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: { ...process.env, HOME: homeDir },
  });
}

function getMode(dirPath) {
  const stat = fs.statSync(dirPath);
  return (stat.mode & 0o777).toString(8);
}

describe("startup script: fix_home_permissions (#622)", () => {
  it("repairs 0711 home directory to 0755", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-perm-"));
    try {
      fs.chmodSync(tmpHome, 0o711);
      assert.equal(getMode(tmpHome), "711");

      const result = extractAndRun(tmpHome);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(getMode(tmpHome), "755");
      assert.match(result.stdout, /Fixed home directory permissions.*711.*755/);
    } finally {
      fs.chmodSync(tmpHome, 0o755);
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("repairs 0700 home directory to 0755", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-perm-"));
    try {
      fs.chmodSync(tmpHome, 0o700);
      assert.equal(getMode(tmpHome), "700");

      const result = extractAndRun(tmpHome);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(getMode(tmpHome), "755");
      assert.match(result.stdout, /Fixed home directory permissions.*700.*755/);
    } finally {
      fs.chmodSync(tmpHome, 0o755);
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("repairs 0710 home directory to 0755", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-perm-"));
    try {
      fs.chmodSync(tmpHome, 0o710);
      assert.equal(getMode(tmpHome), "710");

      const result = extractAndRun(tmpHome);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(getMode(tmpHome), "755");
      assert.match(result.stdout, /Fixed home directory permissions.*710.*755/);
    } finally {
      fs.chmodSync(tmpHome, 0o755);
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("leaves 0755 home directory unchanged", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-perm-"));
    try {
      fs.chmodSync(tmpHome, 0o755);
      const result = extractAndRun(tmpHome);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(getMode(tmpHome), "755");
      // Should NOT print the "Fixed" message
      assert.ok(
        !result.stdout.includes("Fixed home directory permissions"),
        "Should not repair already-correct permissions"
      );
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("leaves 0750 home directory unchanged (group-readable is fine)", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-perm-"));
    try {
      fs.chmodSync(tmpHome, 0o750);
      const result = extractAndRun(tmpHome);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(getMode(tmpHome), "750");
      assert.ok(
        !result.stdout.includes("Fixed home directory permissions"),
        "Should not touch 750 (not in the restrictive set)"
      );
    } finally {
      fs.chmodSync(tmpHome, 0o755);
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
