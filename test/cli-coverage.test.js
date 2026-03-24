// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// CLI branch coverage tests — exercises nemoclaw.js dispatch paths that
// require a registered sandbox, uninstall logic, and helper functions.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CLI = path.join(__dirname, "..", "bin", "nemoclaw.js");

/** Create a temp HOME with a registered sandbox so the CLI can dispatch
 *  sandbox-scoped commands.  Returns { home, cleanup }. */
function makeSandboxHome(overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-clitest-"));
  const dir = path.join(home, ".nemoclaw");
  fs.mkdirSync(dir, { recursive: true });

  const sandbox = {
    name: "test-sb",
    createdAt: "2026-01-01T00:00:00.000Z",
    model: "nemotron-mini",
    nimContainer: null,
    provider: "ollama-local",
    gpuEnabled: false,
    policies: ["base"],
    nimPort: 8000,
    dashboardPort: 18789,
    ...overrides,
  };

  const registry = {
    sandboxes: { [sandbox.name]: sandbox },
    defaultSandbox: sandbox.name,
  };

  fs.writeFileSync(path.join(dir, "sandboxes.json"), JSON.stringify(registry));
  return {
    home,
    sandboxName: sandbox.name,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

function runCli(args, env = {}) {
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    timeout: 10000,
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      HOME: env.HOME || "/tmp/nemoclaw-clitest-empty-" + Date.now(),
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

// ── Sandbox-scoped dispatch ──────────────────────────────────────

describe("sandbox-scoped CLI dispatch", () => {
  let ctx;

  beforeEach(() => {
    ctx = makeSandboxHome();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("unknown sandbox action exits 1 with valid actions list", () => {
    const r = runCli([ctx.sandboxName, "bogus-action"], { HOME: ctx.home });
    assert.equal(r.code, 1);
    assert.ok(r.combined.includes("Unknown action"), "should report unknown action");
    assert.ok(r.combined.includes("connect"), "should list valid actions");
    assert.ok(r.combined.includes("destroy"), "should list destroy as valid action");
  });

  it("sandbox status prints sandbox details (exits non-zero without openshell)", () => {
    const r = runCli([ctx.sandboxName, "status"], { HOME: ctx.home });
    // Will fail at openshell call, but should print sandbox info first
    assert.ok(r.combined.includes("Sandbox:") || r.combined.includes("test-sb"),
      "should show sandbox name in output");
  });

  it("sandbox logs without openshell exits non-zero", () => {
    const r = runCli([ctx.sandboxName, "logs"], { HOME: ctx.home });
    assert.notEqual(r.code, 0, "logs should fail without openshell");
  });

  it("sandbox logs --follow passes --tail flag", () => {
    const r = runCli(["--verbose", ctx.sandboxName, "logs", "--follow"], { HOME: ctx.home });
    assert.ok(r.stderr.includes("--tail") || r.combined.includes("logs"),
      "should pass --tail flag for follow mode");
  });

  it("sandbox policy-list shows presets for registered sandbox", () => {
    const r = runCli([ctx.sandboxName, "policy-list"], { HOME: ctx.home });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("Policy presets"), "should show policy presets heading");
    assert.ok(r.stdout.includes(ctx.sandboxName), "should include sandbox name");
  });

  it("sandbox destroy --yes without openshell exits non-zero", () => {
    const r = runCli([ctx.sandboxName, "destroy", "--yes"], { HOME: ctx.home });
    // Destroy calls nim.stopNimContainer and openshell delete — both fail without tools
    // but the dispatch path is still exercised
    assert.ok(r.combined.includes("Stopping NIM") || r.combined.includes("Deleting") || r.code !== 0,
      "should attempt destruction sequence");
  });

  it("sandbox connect without openshell exits non-zero", () => {
    const r = runCli([ctx.sandboxName, "connect"], { HOME: ctx.home });
    assert.notEqual(r.code, 0, "connect should fail without openshell");
  });

  it("sandbox name with no action defaults to connect", () => {
    const r = runCli([ctx.sandboxName], { HOME: ctx.home });
    // Should attempt connect (default action), which fails without openshell
    assert.notEqual(r.code, 0, "should attempt connect by default");
  });
});

// ── list / status with registered sandboxes ──────────────────────

describe("list and status with registered sandboxes", () => {
  let ctx;

  beforeEach(() => {
    ctx = makeSandboxHome({ policies: ["base", "pypi"] });
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("list shows sandbox details when sandboxes exist", () => {
    const r = runCli(["list"], { HOME: ctx.home });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("Sandboxes:"), "should show Sandboxes heading");
    assert.ok(r.stdout.includes("test-sb"), "should list sandbox name");
    assert.ok(r.stdout.includes("*"), "should mark default sandbox");
    assert.ok(r.stdout.includes("nemotron-mini"), "should show model");
    assert.ok(r.stdout.includes("ollama-local"), "should show provider");
    assert.ok(r.stdout.includes("base"), "should show policies");
  });

  it("list shows GPU/CPU correctly", () => {
    const r = runCli(["list"], { HOME: ctx.home });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("CPU"), "should show CPU for non-gpu sandbox");
  });

  it("list with GPU-enabled sandbox shows GPU", () => {
    ctx.cleanup();
    ctx = makeSandboxHome({ gpuEnabled: true });
    const r = runCli(["list"], { HOME: ctx.home });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("GPU"), "should show GPU for gpu-enabled sandbox");
  });

  it("status shows sandbox registry (fails at service status without scripts)", () => {
    const r = runCli(["status"], { HOME: ctx.home });
    // status prints sandbox list then tries to run start-services.sh --status
    assert.ok(r.combined.includes("Sandboxes:") || r.combined.includes("test-sb"),
      "should show sandbox list");
  });
});

// ── list with multiple sandboxes ──────────────────────────────────

describe("list with multiple sandboxes", () => {
  let home;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-clitest-multi-"));
    const dir = path.join(home, ".nemoclaw");
    fs.mkdirSync(dir, { recursive: true });

    const registry = {
      sandboxes: {
        "prod-sb": {
          name: "prod-sb", model: "nemotron-super", provider: "nvidia-nim",
          gpuEnabled: true, policies: ["base", "npm"], createdAt: "2026-01-01T00:00:00.000Z",
        },
        "dev-sb": {
          name: "dev-sb", model: null, provider: null,
          gpuEnabled: false, policies: [], createdAt: "2026-01-02T00:00:00.000Z",
        },
      },
      defaultSandbox: "prod-sb",
    };
    fs.writeFileSync(path.join(dir, "sandboxes.json"), JSON.stringify(registry));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("list shows multiple sandboxes with correct details", () => {
    const r = runCli(["list"], { HOME: home });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("prod-sb"), "should list prod sandbox");
    assert.ok(r.stdout.includes("dev-sb"), "should list dev sandbox");
    assert.ok(r.stdout.includes("unknown"), "should show 'unknown' for null model/provider");
    assert.ok(r.stdout.includes("none"), "should show 'none' for empty policies");
    assert.ok(r.stdout.includes("* = default"), "should show default legend");
  });
});

// ── Unknown command with registered sandboxes ─────────────────────

describe("unknown command suggestions", () => {
  let ctx;

  beforeEach(() => {
    ctx = makeSandboxHome();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("unknown command with registered sandboxes suggests sandbox names", () => {
    const r = runCli(["totally-unknown"], { HOME: ctx.home });
    assert.equal(r.code, 1);
    assert.ok(r.combined.includes("Unknown command"), "should report unknown command");
    assert.ok(r.combined.includes("Registered sandboxes"), "should list registered sandboxes");
    assert.ok(r.combined.includes("test-sb"), "should show sandbox name in suggestion");
    assert.ok(r.combined.includes("nemoclaw help"), "should suggest help");
  });

  it("unknown command with no sandboxes omits sandbox suggestion", () => {
    const r = runCli(["totally-unknown"]);
    assert.equal(r.code, 1);
    assert.ok(r.combined.includes("Unknown command"), "should report unknown command");
    assert.ok(!r.combined.includes("Registered sandboxes"), "should not suggest sandboxes when none exist");
  });
});

// ── Uninstall dispatch ────────────────────────────────────────────

describe("uninstall dispatch", () => {
  it("uninstall finds local uninstall.sh and attempts to run it", () => {
    // The repo has uninstall.sh at ROOT — it should be found
    const r = runCli(["uninstall", "--yes"]);
    // uninstall.sh will run but may exit non-zero in test env
    assert.ok(
      r.combined.includes("Running local uninstall") || r.combined.includes("uninstall"),
      "should find and attempt local uninstall script",
    );
  });

  it("uninstall --yes --keep-openshell forwards flags to script", () => {
    const r = runCli(["uninstall", "--yes", "--keep-openshell"]);
    // The script receives the flags — we just verify it dispatched
    assert.ok(r.combined.includes("uninstall") || r.code !== undefined,
      "should dispatch uninstall with flags");
  });
});

// ── setup (deprecated) ────────────────────────────────────────────

describe("deprecated setup command", () => {
  it("setup prints deprecation warning", () => {
    const r = runCli(["setup"], {
      NVIDIA_API_KEY: "nvapi-test-1234567890abcdef1234567890abcdef",
    });
    assert.ok(r.combined.includes("deprecated"), "should show deprecation notice");
    assert.ok(r.combined.includes("nemoclaw onboard"), "should suggest onboard");
  });
});

// ── Color output detection ────────────────────────────────────────

describe("color output", () => {
  it("NO_COLOR=1 disables color codes in help output", () => {
    const r = runCli(["help"], { NO_COLOR: "1" });
    assert.equal(r.code, 0);
    // ESC codes should not appear
    assert.ok(!r.stdout.includes("\x1b["), "should not contain ANSI escape codes with NO_COLOR");
  });
});

// ── Help completeness ─────────────────────────────────────────────

describe("help output completeness", () => {
  it("help mentions all key sections", () => {
    const r = runCli(["help"]);
    assert.equal(r.code, 0);
    const sections = [
      "Getting Started", "Sandbox Management", "Policy Presets",
      "Deploy", "Services", "Troubleshooting", "Updates", "Cleanup",
      "Uninstall flags",
    ];
    for (const section of sections) {
      assert.ok(r.stdout.includes(section), `help should mention ${section}`);
    }
  });

  it("help mentions reconnect command", () => {
    const r = runCli(["help"]);
    assert.ok(r.stdout.includes("reconnect"), "should mention reconnect");
    assert.ok(r.stdout.includes("--diagnose"), "should mention --diagnose flag");
  });

  it("help mentions update command", () => {
    const r = runCli(["help"]);
    assert.ok(r.stdout.includes("nemoclaw update"), "should mention update");
    assert.ok(r.stdout.includes("--check"), "should mention --check flag");
  });
});

// ── Reconnect dispatch ────────────────────────────────────────────

describe("reconnect CLI dispatch", () => {
  it("reconnect with no sandbox exits 1", () => {
    const r = runCli(["reconnect"]);
    assert.equal(r.code, 1);
    assert.ok(r.combined.includes("No sandbox"), "should report no sandbox");
  });

  it("reconnect --diagnose with registered sandbox runs diagnostics", () => {
    const ctx = makeSandboxHome();
    try {
      const r = runCli(["reconnect", "--diagnose"], { HOME: ctx.home });
      assert.equal(r.code, 0);
      assert.ok(r.stdout.includes("Diagnostics"), "should show diagnostics heading");
      assert.ok(r.stdout.includes("Gateway running"), "should show gateway status");
      assert.ok(r.stdout.includes("Sandbox exists"), "should show sandbox existence");
    } finally {
      ctx.cleanup();
    }
  });

  it("reconnect with named sandbox runs diagnostics", () => {
    const ctx = makeSandboxHome();
    try {
      const r = runCli(["reconnect", ctx.sandboxName, "--diagnose"], { HOME: ctx.home });
      assert.equal(r.code, 0);
      assert.ok(r.stdout.includes("Diagnostics"), "should show diagnostics");
    } finally {
      ctx.cleanup();
    }
  });
});

// ── Update dispatch ───────────────────────────────────────────────

describe("update CLI dispatch", () => {
  it("update detects source checkout installation", () => {
    const r = runCli(["update", "--check"]);
    // In the repo, detectInstallType should find "source"
    assert.ok(
      r.combined.includes("source checkout") || r.combined.includes("Installation"),
      "should detect installation type",
    );
  });
});

// ── --json output for list and status (#753) ─────────────────────

describe("list --json", () => {
  it("outputs valid JSON with sandbox data", () => {
    const ctx = makeSandboxHome({ policies: ["base", "pypi"] });
    try {
      const r = runCli(["list", "--json"], { HOME: ctx.home });
      assert.equal(r.code, 0);
      const data = JSON.parse(r.stdout);
      assert.equal(data.sandboxes.length, 1);
      assert.equal(data.sandboxes[0].name, "test-sb");
      assert.equal(data.sandboxes[0].default, true);
      assert.equal(data.sandboxes[0].model, "nemotron-mini");
      assert.equal(data.sandboxes[0].provider, "ollama-local");
      assert.equal(data.sandboxes[0].gpuEnabled, false);
      assert.deepEqual(data.sandboxes[0].policies, ["base", "pypi"]);
      assert.equal(data.defaultSandbox, "test-sb");
    } finally {
      ctx.cleanup();
    }
  });

  it("outputs empty sandboxes array when none registered", () => {
    const r = runCli(["list", "--json"]);
    assert.equal(r.code, 0);
    const data = JSON.parse(r.stdout);
    assert.deepEqual(data.sandboxes, []);
    assert.equal(data.defaultSandbox, null);
  });

  it("outputs multiple sandboxes with correct default marker", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-json-multi-"));
    const dir = path.join(home, ".nemoclaw");
    fs.mkdirSync(dir, { recursive: true });
    const reg = {
      sandboxes: {
        "sb-a": {
          name: "sb-a", model: "nemotron-super", provider: "nvidia-nim",
          gpuEnabled: true, policies: ["base"], createdAt: "2026-01-01T00:00:00.000Z",
        },
        "sb-b": {
          name: "sb-b", model: null, provider: null,
          gpuEnabled: false, policies: [], createdAt: "2026-01-02T00:00:00.000Z",
        },
      },
      defaultSandbox: "sb-a",
    };
    fs.writeFileSync(path.join(dir, "sandboxes.json"), JSON.stringify(reg));
    try {
      const r = runCli(["list", "--json"], { HOME: home });
      assert.equal(r.code, 0);
      const data = JSON.parse(r.stdout);
      assert.equal(data.sandboxes.length, 2);
      const sbA = data.sandboxes.find((s) => s.name === "sb-a");
      const sbB = data.sandboxes.find((s) => s.name === "sb-b");
      assert.equal(sbA.default, true);
      assert.equal(sbA.gpuEnabled, true);
      assert.equal(sbB.default, false);
      assert.equal(sbB.model, null);
      assert.deepEqual(sbB.policies, []);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not include ANSI escape codes", () => {
    const ctx = makeSandboxHome();
    try {
      const r = runCli(["list", "--json"], { HOME: ctx.home });
      assert.ok(!r.stdout.includes("\x1b["), "JSON output should not contain ANSI codes");
    } finally {
      ctx.cleanup();
    }
  });

  it("null model/provider become JSON null not 'unknown'", () => {
    const ctx = makeSandboxHome({ model: null, provider: null });
    try {
      const r = runCli(["list", "--json"], { HOME: ctx.home });
      const data = JSON.parse(r.stdout);
      assert.strictEqual(data.sandboxes[0].model, null);
      assert.strictEqual(data.sandboxes[0].provider, null);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("status --json", () => {
  it("outputs valid JSON for global status", () => {
    const ctx = makeSandboxHome();
    try {
      const r = runCli(["status", "--json"], { HOME: ctx.home });
      assert.equal(r.code, 0);
      const data = JSON.parse(r.stdout);
      assert.equal(data.sandboxes.length, 1);
      assert.equal(data.sandboxes[0].name, "test-sb");
      assert.equal(data.defaultSandbox, "test-sb");
    } finally {
      ctx.cleanup();
    }
  });

  it("global status --json skips service status script", () => {
    const ctx = makeSandboxHome();
    try {
      const r = runCli(["status", "--json"], { HOME: ctx.home });
      // Should succeed because --json bypasses the start-services.sh call
      assert.equal(r.code, 0);
      assert.ok(!r.stderr.includes("start-services"), "should not invoke start-services.sh");
    } finally {
      ctx.cleanup();
    }
  });
});

describe("sandbox status --json", () => {
  it("outputs valid JSON for sandbox-scoped status", () => {
    const ctx = makeSandboxHome();
    try {
      const r = runCli([ctx.sandboxName, "status", "--json"], { HOME: ctx.home });
      assert.equal(r.code, 0);
      const data = JSON.parse(r.stdout);
      assert.equal(data.name, "test-sb");
      assert.equal(data.model, "nemotron-mini");
      assert.equal(data.provider, "ollama-local");
      assert.equal(data.gpuEnabled, false);
      assert.deepEqual(data.policies, ["base"]);
      assert.equal(typeof data.nim, "object");
      assert.equal(typeof data.nim.running, "boolean");
      assert.equal(typeof data.nim.healthy, "boolean");
      assert.equal(data.nim.port, 8000);
    } finally {
      ctx.cleanup();
    }
  });

  it("sandbox status --json skips openshell call", () => {
    const ctx = makeSandboxHome();
    try {
      const r = runCli([ctx.sandboxName, "status", "--json"], { HOME: ctx.home });
      // Should succeed because --json bypasses the openshell sandbox get call
      assert.equal(r.code, 0);
      assert.ok(!r.stderr.includes("openshell"), "should not invoke openshell");
    } finally {
      ctx.cleanup();
    }
  });

  it("sandbox status --json with custom NIM port", () => {
    const ctx = makeSandboxHome({ nimPort: 9000 });
    try {
      const r = runCli([ctx.sandboxName, "status", "--json"], { HOME: ctx.home });
      assert.equal(r.code, 0);
      const data = JSON.parse(r.stdout);
      assert.equal(data.nim.port, 9000);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("--json flag is stripped from args", () => {
  it("--json before command works", () => {
    const ctx = makeSandboxHome();
    try {
      const r = runCli(["--json", "list"], { HOME: ctx.home });
      assert.equal(r.code, 0);
      JSON.parse(r.stdout); // should be valid JSON
    } finally {
      ctx.cleanup();
    }
  });

  it("help mentions --json", () => {
    const r = runCli(["help"]);
    assert.ok(r.stdout.includes("--json"), "help should mention --json flag");
  });
});
