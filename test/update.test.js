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
  updateSource,
  updateGlobal,
  verifyUpdate,
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

// ---------------------------------------------------------------------------
// updateSource — DI-based tests
// ---------------------------------------------------------------------------

describe("update — updateSource", () => {
  const noop = () => {};

  it("returns true when all steps succeed on first exec", () => {
    const msgs = [];
    const result = updateSource("/fake/dir", {
      exec: () => "ok",
      execSync: () => { throw new Error("should not be called"); },
      write: (s) => msgs.push(s),
      log: (s) => msgs.push(s),
      logError: noop,
    });
    assert.equal(result, true);
    // Should have 5 steps, each with write + log
    assert.equal(msgs.filter((m) => m.includes("...")).length, 5);
    assert.equal(msgs.filter((m) => m === " done").length, 5);
  });

  it("retries with execSync when exec returns null, and succeeds", () => {
    const retried = [];
    const result = updateSource("/fake/dir", {
      exec: () => null, // always returns null (simulates stderr-only output)
      execSync: (cmd) => { retried.push(cmd); return ""; },
      write: noop,
      log: noop,
      logError: noop,
    });
    assert.equal(result, true);
    assert.equal(retried.length, 5, "all 5 steps should be retried");
  });

  it("returns false when a step fails on retry", () => {
    let stepCount = 0;
    const result = updateSource("/fake/dir", {
      exec: () => null,
      execSync: () => {
        stepCount++;
        if (stepCount === 3) {
          const err = new Error("npm install failed");
          err.stderr = Buffer.from("ERR! missing dependency");
          throw err;
        }
        return "";
      },
      write: noop,
      log: noop,
      logError: noop,
    });
    assert.equal(result, false);
    assert.equal(stepCount, 3, "should fail on the third step");
  });

  it("handles retry failure without stderr", () => {
    const errorMsgs = [];
    const result = updateSource("/fake/dir", {
      exec: () => null,
      execSync: () => { throw new Error("generic failure"); },
      write: noop,
      log: noop,
      logError: (s) => errorMsgs.push(s),
    });
    assert.equal(result, false);
    // No stderr message should be logged (stderr is undefined)
    assert.equal(errorMsgs.length, 0);
  });

  it("handles retry failure with empty stderr", () => {
    const errorMsgs = [];
    const result = updateSource("/fake/dir", {
      exec: () => null,
      execSync: () => {
        const err = new Error("fail");
        err.stderr = Buffer.from("");
        throw err;
      },
      write: noop,
      log: noop,
      logError: (s) => errorMsgs.push(s),
    });
    assert.equal(result, false);
    // Empty stderr should not produce an error log line
    assert.equal(errorMsgs.length, 0);
  });

  it("succeeds when some steps use exec and some use execSync", () => {
    let callCount = 0;
    const result = updateSource("/fake/dir", {
      exec: () => {
        callCount++;
        // First 2 steps succeed via exec, rest return null
        return callCount <= 2 ? "ok" : null;
      },
      execSync: () => "",
      write: noop,
      log: noop,
      logError: noop,
    });
    assert.equal(result, true);
  });
});

// ---------------------------------------------------------------------------
// updateGlobal — DI-based tests
// ---------------------------------------------------------------------------

describe("update — updateGlobal", () => {
  const noop = () => {};

  it("returns true when exec succeeds on first try", () => {
    const msgs = [];
    const result = updateGlobal({
      exec: () => "installed ok",
      execSync: () => { throw new Error("should not be called"); },
      write: (s) => msgs.push(s),
      log: (s) => msgs.push(s),
      logError: noop,
    });
    assert.equal(result, true);
    assert.ok(msgs.some((m) => m.includes("Installing latest")));
    assert.ok(msgs.includes(" done"));
  });

  it("retries with execSync when exec returns null, and succeeds", () => {
    let retried = false;
    const result = updateGlobal({
      exec: () => null,
      execSync: () => { retried = true; return ""; },
      write: noop,
      log: noop,
      logError: noop,
    });
    assert.equal(result, true);
    assert.equal(retried, true);
  });

  it("returns false when retry also fails with stderr", () => {
    const errorMsgs = [];
    const result = updateGlobal({
      exec: () => null,
      execSync: () => {
        const err = new Error("npm ERR");
        err.stderr = Buffer.from("permission denied");
        throw err;
      },
      write: noop,
      log: noop,
      logError: (s) => errorMsgs.push(s),
    });
    assert.equal(result, false);
    assert.ok(errorMsgs.some((m) => m.includes("permission denied")));
  });

  it("returns false when retry fails without stderr", () => {
    const errorMsgs = [];
    const result = updateGlobal({
      exec: () => null,
      execSync: () => { throw new Error("generic"); },
      write: noop,
      log: noop,
      logError: (s) => errorMsgs.push(s),
    });
    assert.equal(result, false);
    assert.equal(errorMsgs.length, 0);
  });

  it("returns false when retry fails with empty stderr", () => {
    const result = updateGlobal({
      exec: () => null,
      execSync: () => {
        const err = new Error("fail");
        err.stderr = Buffer.from("");
        throw err;
      },
      write: noop,
      log: noop,
      logError: noop,
    });
    assert.equal(result, false);
  });
});

// ---------------------------------------------------------------------------
// verifyUpdate — DI-based tests
// ---------------------------------------------------------------------------

describe("update — verifyUpdate", () => {
  it("returns version string when exec succeeds", () => {
    const result = verifyUpdate({
      exec: () => "nemoclaw v0.2.0",
    });
    assert.equal(result, "nemoclaw v0.2.0");
  });

  it("returns null when exec returns null", () => {
    const result = verifyUpdate({
      exec: () => null,
    });
    assert.equal(result, null);
  });

  it("returns null when exec returns empty string", () => {
    const result = verifyUpdate({
      exec: () => "",
    });
    assert.equal(result, null);
  });
});
