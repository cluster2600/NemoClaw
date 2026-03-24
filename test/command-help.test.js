// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Tests for per-command --help (#757).

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CLI = path.join(__dirname, "..", "bin", "nemoclaw.js");

function runCli(args, env = {}) {
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    timeout: 10000,
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      HOME: env.HOME || "/tmp/nemoclaw-cmdhelp-" + Date.now(),
      NO_COLOR: "1",
      ...env,
    },
  });
  return {
    code: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    combined: (result.stdout || "") + (result.stderr || ""),
  };
}

function makeSandboxHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cmdhelp-sb-"));
  const dir = path.join(home, ".nemoclaw");
  fs.mkdirSync(dir, { recursive: true });
  const registry = {
    sandboxes: {
      "test-sb": {
        name: "test-sb",
        createdAt: "2026-01-01T00:00:00.000Z",
        model: "nemotron-mini",
        provider: "ollama-local",
        gpuEnabled: false,
        policies: ["base"],
        nimPort: 8000,
      },
    },
    defaultSandbox: "test-sb",
  };
  fs.writeFileSync(path.join(dir, "sandboxes.json"), JSON.stringify(registry));
  return { home, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

// ── Unit tests for command-help module ───────────────────────────

describe("command-help module", () => {
  const { GLOBAL_HELP, SANDBOX_HELP, showCommandHelp, handleHelpFlag } =
    require("../bin/lib/command-help");

  it("GLOBAL_HELP has entries for all documented global commands", () => {
    const expected = [
      "onboard", "setup-spark", "list", "deploy", "start", "stop",
      "status", "debug", "reconnect", "update", "uninstall",
    ];
    for (const cmd of expected) {
      assert.ok(GLOBAL_HELP[cmd], `missing GLOBAL_HELP entry for '${cmd}'`);
      assert.ok(GLOBAL_HELP[cmd].purpose, `${cmd} missing purpose`);
      assert.ok(GLOBAL_HELP[cmd].usage, `${cmd} missing usage`);
      assert.ok(GLOBAL_HELP[cmd].examples.length > 0, `${cmd} missing examples`);
    }
  });

  it("SANDBOX_HELP has entries for all sandbox-scoped actions", () => {
    const expected = ["connect", "status", "logs", "policy-add", "policy-list", "destroy"];
    for (const action of expected) {
      assert.ok(SANDBOX_HELP[action], `missing SANDBOX_HELP entry for '${action}'`);
      assert.ok(SANDBOX_HELP[action].purpose, `${action} missing purpose`);
      assert.ok(SANDBOX_HELP[action].usage, `${action} missing usage`);
      assert.ok(SANDBOX_HELP[action].examples.length > 0, `${action} missing examples`);
    }
  });

  it("showCommandHelp returns false for unknown command", () => {
    assert.equal(showCommandHelp("nonexistent", "global"), false);
    assert.equal(showCommandHelp("nonexistent", "sandbox"), false);
  });

  it("handleHelpFlag returns false when no --help in args", () => {
    assert.equal(handleHelpFlag(["--verbose"], "list", "global"), false);
  });

  it("handleHelpFlag returns true when --help is present", () => {
    assert.equal(handleHelpFlag(["--help"], "list", "global"), true);
  });

  it("handleHelpFlag returns true when -h is present", () => {
    assert.equal(handleHelpFlag(["-h"], "onboard", "global"), true);
  });
});

// ── CLI integration: global commands ─────────────────────────────

describe("per-command --help for global commands", () => {
  const globalCommands = [
    "onboard", "setup-spark", "list", "deploy", "start", "stop",
    "status", "reconnect", "update", "uninstall",
  ];

  for (const cmd of globalCommands) {
    it(`${cmd} --help exits 0 and shows usage`, () => {
      const r = runCli([cmd, "--help"]);
      assert.equal(r.code, 0, `${cmd} --help should exit 0`);
      assert.ok(r.stdout.includes("Usage:"), `${cmd} --help should show Usage`);
      assert.ok(r.stdout.includes("Examples:"), `${cmd} --help should show Examples`);
    });
  }

  it("onboard --help shows --non-interactive option", () => {
    const r = runCli(["onboard", "--help"]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("--non-interactive"), "should mention --non-interactive");
  });

  it("list --help shows --json option", () => {
    const r = runCli(["list", "--help"]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("--json"), "should mention --json");
  });

  it("uninstall --help shows all flags", () => {
    const r = runCli(["uninstall", "--help"]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("--yes"), "should mention --yes");
    assert.ok(r.stdout.includes("--keep-openshell"), "should mention --keep-openshell");
    assert.ok(r.stdout.includes("--delete-models"), "should mention --delete-models");
  });

  it("reconnect --help shows --diagnose option", () => {
    const r = runCli(["reconnect", "--help"]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("--diagnose"), "should mention --diagnose");
  });

  it("update --help shows --check option", () => {
    const r = runCli(["update", "--help"]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("--check"), "should mention --check");
  });

  it("-h works the same as --help for global commands", () => {
    const r = runCli(["list", "-h"]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("Usage:"), "should show Usage with -h");
  });

  it("status --help shows See also section", () => {
    const r = runCli(["status", "--help"]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("See also:"), "should show related commands");
  });
});

// ── CLI integration: sandbox-scoped actions ─────────────────────

describe("per-command --help for sandbox-scoped actions", () => {
  let ctx;

  beforeEach(() => {
    ctx = makeSandboxHome();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  const sandboxActions = [
    "connect", "status", "logs", "policy-add", "policy-list", "destroy",
  ];

  for (const action of sandboxActions) {
    it(`<sandbox> ${action} --help exits 0 and shows usage`, () => {
      const r = runCli(["test-sb", action, "--help"], { HOME: ctx.home });
      assert.equal(r.code, 0, `${action} --help should exit 0`);
      assert.ok(r.stdout.includes("Usage:"), `${action} --help should show Usage`);
      assert.ok(r.stdout.includes("Examples:"), `${action} --help should show Examples`);
    });
  }

  it("sandbox logs --help shows --follow option", () => {
    const r = runCli(["test-sb", "logs", "--help"], { HOME: ctx.home });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("--follow"), "should mention --follow");
  });

  it("sandbox destroy --help shows --yes and --force options", () => {
    const r = runCli(["test-sb", "destroy", "--help"], { HOME: ctx.home });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("--yes"), "should mention --yes");
    assert.ok(r.stdout.includes("--force"), "should mention --force");
  });

  it("sandbox status --help shows --json option", () => {
    const r = runCli(["test-sb", "status", "--help"], { HOME: ctx.home });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("--json"), "should mention --json");
  });

  it("-h works for sandbox-scoped actions", () => {
    const r = runCli(["test-sb", "connect", "-h"], { HOME: ctx.home });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("Usage:"), "should show Usage with -h");
  });
});
