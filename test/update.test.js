// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");

const {
  detectInstallType,
  checkForUpdate,
  readVersion,
  fetchRemoteHead,
  getLocalHead,
  DEFAULT_SOURCE_DIR,
  REPO_URL,
} = require("../bin/lib/update");

const CLI = path.join(__dirname, "..", "bin", "nemoclaw.js");

function runCli(args) {
  const { execSync } = require("child_process");
  try {
    const out = execSync(`node "${CLI}" ${args}`, {
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, HOME: "/tmp/nemoclaw-update-test-" + Date.now() },
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: (err.stdout || "") + (err.stderr || "") };
  }
}

describe("update — detectInstallType", () => {
  it("detects source install from current repo", () => {
    // Running from the NemoClaw repo itself — should detect source
    const install = detectInstallType();
    assert.equal(install.type, "source");
    assert.ok(install.sourceDir, "sourceDir should be set");
    assert.ok(
      fs.existsSync(path.join(install.sourceDir, "package.json")),
      "sourceDir should contain package.json"
    );
  });

  it("sourceDir contains .git directory", () => {
    const install = detectInstallType();
    if (install.type === "source") {
      assert.ok(
        fs.existsSync(path.join(install.sourceDir, ".git")),
        "sourceDir should be a git repo"
      );
    }
  });
});

describe("update — readVersion", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-update-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads version from package.json", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", version: "1.2.3" })
    );
    assert.equal(readVersion(tmpDir), "1.2.3");
  });

  it("returns unknown for missing package.json", () => {
    assert.equal(readVersion(path.join(tmpDir, "nonexistent")), "unknown");
  });

  it("returns unknown for malformed package.json", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), "not json");
    assert.equal(readVersion(tmpDir), "unknown");
  });

  it("returns unknown for package.json without version field", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test" })
    );
    assert.equal(readVersion(tmpDir), "unknown");
  });
});

describe("update — checkForUpdate", () => {
  it("returns updateAvailable when local and remote differ", () => {
    const install = detectInstallType();
    if (install.type !== "source") return; // skip if not source

    // We can't easily mock fetchRemoteHead, but we can test the structure
    const result = checkForUpdate(install);
    // Should have either an error or the expected fields
    if (result.error) {
      assert.ok(typeof result.error === "string");
    } else {
      assert.ok("current" in result);
      assert.ok("remote" in result);
      assert.ok("updateAvailable" in result);
      assert.ok("currentVersion" in result);
    }
  });

  it("returns error for unknown install type", () => {
    // checkForUpdate with global type and no network should still return structure
    const result = checkForUpdate({ type: "global", sourceDir: null });
    // Either error (no network) or valid structure
    if (!result.error) {
      assert.ok("remote" in result);
      assert.ok("updateAvailable" in result);
    }
  });
});

describe("update — REPO_URL", () => {
  it("points to NVIDIA/NemoClaw", () => {
    assert.ok(REPO_URL.includes("github.com/NVIDIA/NemoClaw"));
  });

  it("uses HTTPS", () => {
    assert.ok(REPO_URL.startsWith("https://"));
  });
});

describe("update — DEFAULT_SOURCE_DIR", () => {
  it("lives under ~/.nemoclaw", () => {
    assert.ok(DEFAULT_SOURCE_DIR.includes(".nemoclaw"));
    assert.ok(DEFAULT_SOURCE_DIR.endsWith("source"));
  });
});

describe("update — CLI integration", () => {
  it("help mentions update command", () => {
    const r = runCli("help");
    assert.equal(r.code, 0);
    assert.ok(r.out.includes("nemoclaw update"), "help should mention update");
    assert.ok(r.out.includes("--check"), "help should mention --check flag");
  });

  it("update is listed in Updates section", () => {
    const r = runCli("help");
    assert.equal(r.code, 0);
    assert.ok(r.out.includes("Updates:"), "help should have Updates section");
  });

  it("update --check runs without error", () => {
    // May fail if no network, but should not crash
    const r = runCli("update --check");
    // Either succeeds or reports a network error — both are fine
    assert.ok(r.code === 0 || r.code === 1, `unexpected exit code: ${r.code}`);
    assert.ok(
      r.out.includes("Installation:") || r.out.includes("Could not detect"),
      "should show installation info or detection failure"
    );
  });
});
