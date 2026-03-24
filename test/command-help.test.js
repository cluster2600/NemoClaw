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

// ── Scope labels and disambiguation (#754) ──────────────────────

describe("scope labels and disambiguation (#754)", () => {
  const { GLOBAL_HELP, SANDBOX_HELP, showCommandHelp } =
    require("../bin/lib/command-help");

  it("global status --help shows [global] scope label", () => {
    const r = runCli(["status", "--help"]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("[global]"), "should show [global] scope label");
  });

  it("sandbox status --help shows [per-sandbox] scope label", () => {
    const ctx = makeSandboxHome();
    try {
      const r = runCli(["test-sb", "status", "--help"], { HOME: ctx.home });
      assert.equal(r.code, 0);
      assert.ok(r.stdout.includes("[per-sandbox]"), "should show [per-sandbox] scope label");
    } finally {
      ctx.cleanup();
    }
  });

  it("global status --help shows note about per-sandbox alternative", () => {
    const r = runCli(["status", "--help"]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("Note:"), "should show Note section");
    assert.ok(r.stdout.includes("nemoclaw <name> status"), "should reference per-sandbox status");
  });

  it("sandbox status --help shows note about global alternative", () => {
    const ctx = makeSandboxHome();
    try {
      const r = runCli(["test-sb", "status", "--help"], { HOME: ctx.home });
      assert.equal(r.code, 0);
      assert.ok(r.stdout.includes("Note:"), "should show Note section");
      assert.ok(r.stdout.includes("nemoclaw status"), "should reference global status");
    } finally {
      ctx.cleanup();
    }
  });

  it("global status See also annotates <name> status as per-sandbox", () => {
    const r = runCli(["status", "--help"]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("(per-sandbox)"), "should annotate sandbox ref");
  });

  it("sandbox status See also annotates status as global", () => {
    const ctx = makeSandboxHome();
    try {
      const r = runCli(["test-sb", "status", "--help"], { HOME: ctx.home });
      assert.equal(r.code, 0);
      assert.ok(r.stdout.includes("status (global)"), "should annotate global status");
    } finally {
      ctx.cleanup();
    }
  });

  it("list --help See also annotates <name> status as per-sandbox", () => {
    const r = runCli(["list", "--help"]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("(per-sandbox)"), "should annotate sandbox ref in list See also");
  });

  it("main help groups commands as Global vs Sandbox sections", () => {
    const r = runCli(["help"]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("Global Commands:"), "should have Global Commands section");
    assert.ok(r.stdout.includes("Sandbox Commands:"), "should have Sandbox Commands section");
  });

  it("main help Global Commands section contains list and status", () => {
    const r = runCli(["help"]);
    const lines = r.stdout.split("\n");
    const globalIdx = lines.findIndex((l) => l.includes("Global Commands:"));
    const sandboxIdx = lines.findIndex((l) => l.includes("Sandbox Commands:"));
    assert.ok(globalIdx >= 0 && sandboxIdx > globalIdx, "Global before Sandbox");
    const globalSection = lines.slice(globalIdx, sandboxIdx).join("\n");
    assert.ok(globalSection.includes("nemoclaw list"), "list in Global section");
    assert.ok(globalSection.includes("nemoclaw status"), "status in Global section");
    assert.ok(globalSection.includes("nemoclaw start"), "start in Global section");
    assert.ok(globalSection.includes("nemoclaw stop"), "stop in Global section");
  });

  it("main help Sandbox Commands section contains <name> commands", () => {
    const r = runCli(["help"]);
    const lines = r.stdout.split("\n");
    const sandboxIdx = lines.findIndex((l) => l.includes("Sandbox Commands:"));
    assert.ok(sandboxIdx >= 0, "should have Sandbox Commands section");
    const sandboxSection = lines.slice(sandboxIdx).join("\n");
    assert.ok(sandboxSection.includes("<name> connect"), "connect in Sandbox section");
    assert.ok(sandboxSection.includes("<name> status"), "status in Sandbox section");
    assert.ok(sandboxSection.includes("<name> model"), "model in Sandbox section");
    assert.ok(sandboxSection.includes("<name> destroy"), "destroy in Sandbox section");
  });

  it("GLOBAL_HELP.status has note field for disambiguation", () => {
    assert.ok(GLOBAL_HELP.status.note, "global status should have note");
    assert.ok(GLOBAL_HELP.status.note.includes("<name>"), "note should reference per-sandbox");
  });

  it("SANDBOX_HELP.status has note field for disambiguation", () => {
    assert.ok(SANDBOX_HELP.status.note, "sandbox status should have note");
    assert.ok(SANDBOX_HELP.status.note.includes("nemoclaw status"), "note should reference global");
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
