// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for nemoclaw.js exported functions with DI — exercises
// branches that subprocess-based CLI tests cannot cover for c8.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveUninstallScript,
  exitWithSpawnResult,
  setup,
  setupSpark,
  start,
  stop,
  debug: debugCmd,
  uninstall,
  showStatus,
  sandboxStatus,
  sandboxModel,
  reconnectCmd,
  update,
  REMOTE_UNINSTALL_URL,
} = require("../bin/nemoclaw.js");

// ── resolveUninstallScript ──────────────────────────────────────

describe("resolveUninstallScript", () => {
  it("returns first existing candidate", () => {
    const result = resolveUninstallScript({
      existsSync: (p) => p.includes("uninstall.sh"),
    });
    assert.ok(result);
    assert.ok(result.endsWith("uninstall.sh"));
  });

  it("returns null when no candidates exist", () => {
    const result = resolveUninstallScript({
      existsSync: () => false,
    });
    assert.strictEqual(result, null);
  });

  it("returns second candidate when first doesn't exist", () => {
    let callCount = 0;
    const result = resolveUninstallScript({
      existsSync: () => {
        callCount++;
        return callCount === 2; // only second candidate exists
      },
    });
    assert.ok(result);
    assert.ok(result.endsWith("uninstall.sh"));
  });
});

// ── exitWithSpawnResult ──────────────────────────────────────────

describe("exitWithSpawnResult", () => {
  it("exits with status when status is not null", () => {
    let exitCode;
    exitWithSpawnResult({ status: 0, signal: null }, {
      exit: (c) => { exitCode = c; },
    });
    assert.strictEqual(exitCode, 0);
  });

  it("exits with non-zero status", () => {
    let exitCode;
    exitWithSpawnResult({ status: 42, signal: null }, {
      exit: (c) => { exitCode = c; },
    });
    assert.strictEqual(exitCode, 42);
  });

  it("exits with 128+signal number for known signal", () => {
    let exitCode;
    exitWithSpawnResult({ status: null, signal: "SIGTERM" }, {
      exit: (c) => { exitCode = c; },
      signals: { SIGTERM: 15 },
    });
    assert.strictEqual(exitCode, 128 + 15);
  });

  it("exits with 1 for unknown signal", () => {
    let exitCode;
    exitWithSpawnResult({ status: null, signal: "SIGUNKNOWN" }, {
      exit: (c) => { exitCode = c; },
      signals: {},
    });
    assert.strictEqual(exitCode, 1);
  });

  it("exits with 1 when no status and no signal", () => {
    let exitCode;
    exitWithSpawnResult({ status: null, signal: null }, {
      exit: (c) => { exitCode = c; },
    });
    assert.strictEqual(exitCode, 1);
  });

  it("exits with 128+9 for SIGKILL", () => {
    let exitCode;
    exitWithSpawnResult({ status: null, signal: "SIGKILL" }, {
      exit: (c) => { exitCode = c; },
      signals: { SIGKILL: 9 },
    });
    assert.strictEqual(exitCode, 137);
  });
});

// ── uninstall ─────────────────────────────────────────────────────

describe("uninstall", () => {
  it("runs local script when found", () => {
    let spawnedArgs;
    let exitResult;
    uninstall(["--yes"], {
      resolve: () => "/path/to/uninstall.sh",
      spawn: (cmd, a, opts) => {
        spawnedArgs = a;
        return { status: 0 };
      },
      exitSpawn: (r) => { exitResult = r; },
      log: () => {},
    });
    assert.ok(spawnedArgs.includes("/path/to/uninstall.sh"));
    assert.ok(spawnedArgs.includes("--yes"));
    assert.deepStrictEqual(exitResult, { status: 0 });
  });

  it("falls back to remote URL when local not found", () => {
    let spawnedCmd;
    uninstall([], {
      resolve: () => null,
      spawn: (cmd, a) => {
        spawnedCmd = a[1]; // bash -c <command>
        return { status: 0 };
      },
      exitSpawn: () => {},
      log: () => {},
    });
    assert.ok(spawnedCmd.includes(REMOTE_UNINSTALL_URL));
  });

  it("forwards args in remote fallback command", () => {
    let spawnedCmd;
    uninstall(["--yes", "--keep-openshell"], {
      resolve: () => null,
      spawn: (cmd, a) => {
        spawnedCmd = a[1];
        return { status: 0 };
      },
      exitSpawn: () => {},
      log: () => {},
    });
    assert.ok(spawnedCmd.includes("--yes"));
    assert.ok(spawnedCmd.includes("--keep-openshell"));
    assert.ok(spawnedCmd.includes("bash -s --"));
  });

  it("remote fallback without args uses plain curl | bash", () => {
    let spawnedCmd;
    uninstall([], {
      resolve: () => null,
      spawn: (cmd, a) => {
        spawnedCmd = a[1];
        return { status: 0 };
      },
      exitSpawn: () => {},
      log: () => {},
    });
    assert.ok(!spawnedCmd.includes("bash -s --"));
    assert.ok(spawnedCmd.includes("| bash"));
  });
});

// ── showStatus ───────────────────────────────────────────────────

describe("showStatus", () => {
  it("non-JSON path with sandboxes prints sandbox list and runs service status", () => {
    const logs = [];
    let runCalled = false;
    showStatus({
      json: false,
      deps: {
        listSandboxes: () => ({
          sandboxes: [{ name: "my-sb", model: "nemotron-mini" }],
          defaultSandbox: "my-sb",
        }),
        run: () => { runCalled = true; },
        log: (m) => logs.push(m),
      },
    });
    assert.ok(logs.some((l) => l.includes("Sandboxes:")));
    assert.ok(logs.some((l) => l.includes("my-sb")));
    assert.ok(logs.some((l) => l.includes("*"))); // default marker
    assert.ok(logs.some((l) => l.includes("nemotron-mini")));
    assert.ok(runCalled, "should run service status script");
  });

  it("non-JSON path with no sandboxes skips sandbox list", () => {
    const logs = [];
    let runCalled = false;
    showStatus({
      json: false,
      deps: {
        listSandboxes: () => ({ sandboxes: [], defaultSandbox: null }),
        run: () => { runCalled = true; },
        log: (m) => logs.push(m),
      },
    });
    assert.ok(!logs.some((l) => l.includes("Sandboxes:")));
    assert.ok(runCalled, "should still run service status");
  });

  it("non-JSON sandbox without model omits model suffix", () => {
    const logs = [];
    showStatus({
      json: false,
      deps: {
        listSandboxes: () => ({
          sandboxes: [{ name: "bare-sb", model: null }],
          defaultSandbox: null,
        }),
        run: () => {},
        log: (m) => logs.push(m),
      },
    });
    const sbLine = logs.find((l) => l.includes("bare-sb"));
    assert.ok(sbLine);
    assert.ok(!sbLine.includes("("), "no model parenthetical when model is null");
  });

  it("JSON path outputs structured data", () => {
    const logs = [];
    showStatus({
      json: true,
      deps: {
        listSandboxes: () => ({
          sandboxes: [{ name: "sb1", model: "m1", provider: "p1", gpuEnabled: true, policies: ["base"] }],
          defaultSandbox: "sb1",
        }),
        run: () => { throw new Error("should not run"); },
        log: (m) => logs.push(m),
      },
    });
    const data = JSON.parse(logs[0]);
    assert.equal(data.sandboxes[0].name, "sb1");
    assert.equal(data.sandboxes[0].default, true);
    assert.equal(data.sandboxes[0].gpuEnabled, true);
  });
});

// ── sandboxStatus ────────────────────────────────────────────────

describe("sandboxStatus (DI)", () => {
  it("non-JSON shows sandbox details and NIM status", () => {
    const logs = [];
    sandboxStatus("test-sb", {
      deps: {
        getSandbox: () => ({
          name: "test-sb", model: "nemotron-mini", provider: "ollama-local",
          gpuEnabled: true, policies: ["base", "pypi"], nimPort: 8000,
        }),
        nimStatus: () => ({ running: true, healthy: true, container: "nim-test" }),
        run: () => {},
        log: (m) => logs.push(m),
      },
    });
    assert.ok(logs.some((l) => l.includes("Sandbox: test-sb")));
    assert.ok(logs.some((l) => l.includes("nemotron-mini")));
    assert.ok(logs.some((l) => l.includes("yes")));       // GPU
    assert.ok(logs.some((l) => l.includes("base, pypi"))); // policies
    assert.ok(logs.some((l) => l.includes("running (nim-test)")));
    assert.ok(logs.some((l) => l.includes("Healthy:")));
  });

  it("non-JSON with NIM not running omits healthy line", () => {
    const logs = [];
    sandboxStatus("test-sb", {
      deps: {
        getSandbox: () => ({
          name: "test-sb", model: null, provider: null,
          gpuEnabled: false, policies: [], nimPort: undefined,
        }),
        nimStatus: () => ({ running: false, healthy: false, container: null }),
        run: () => {},
        log: (m) => logs.push(m),
      },
    });
    assert.ok(logs.some((l) => l.includes("not running")));
    assert.ok(!logs.some((l) => l.includes("Healthy:")));
  });

  it("non-JSON shows custom NIM port when non-default", () => {
    const logs = [];
    sandboxStatus("test-sb", {
      deps: {
        getSandbox: () => ({
          name: "test-sb", model: "m", provider: "p",
          gpuEnabled: false, policies: [], nimPort: 9000,
        }),
        nimStatus: () => ({ running: true, healthy: false, container: "nim-c" }),
        run: () => {},
        log: (m) => logs.push(m),
      },
    });
    assert.ok(logs.some((l) => l.includes("NIM port: 9000")));
  });

  it("non-JSON hides NIM port when default 8000", () => {
    const logs = [];
    sandboxStatus("test-sb", {
      deps: {
        getSandbox: () => ({
          name: "test-sb", model: "m", provider: "p",
          gpuEnabled: false, policies: [], nimPort: 8000,
        }),
        nimStatus: () => ({ running: true, healthy: true, container: "nim-c" }),
        run: () => {},
        log: (m) => logs.push(m),
      },
    });
    assert.ok(!logs.some((l) => l.includes("NIM port:")));
  });

  it("non-JSON with no sandbox record still shows NIM status", () => {
    const logs = [];
    sandboxStatus("unknown-sb", {
      deps: {
        getSandbox: () => null,
        nimStatus: () => ({ running: false }),
        run: () => {},
        log: (m) => logs.push(m),
      },
    });
    assert.ok(!logs.some((l) => l.includes("Sandbox:")), "no sandbox header for null");
    assert.ok(logs.some((l) => l.includes("not running")));
  });
});

// ── sandboxModel ─────────────────────────────────────────────────

describe("sandboxModel (DI)", () => {
  const noop = () => {};

  it("default (no subcommand) shows current model", () => {
    const logs = [];
    sandboxModel("my-sb", [], {
      getCurrentModel: () => ({ model: "nemotron-mini", provider: "ollama-local" }),
      log: (m) => logs.push(m),
      logError: noop,
      exit: noop,
    });
    assert.ok(logs.some((l) => l.includes("Sandbox:  my-sb")));
    assert.ok(logs.some((l) => l.includes("Model:    nemotron-mini")));
    assert.ok(logs.some((l) => l.includes("Provider: ollama-local")));
    assert.ok(logs.some((l) => l.includes("model list")));
    assert.ok(logs.some((l) => l.includes("model set")));
  });

  it("default with null model/provider shows unknown", () => {
    const logs = [];
    sandboxModel("sb", [], {
      getCurrentModel: () => ({ model: null, provider: null }),
      log: (m) => logs.push(m),
      logError: noop,
      exit: noop,
    });
    assert.ok(logs.some((l) => l.includes("Model:    unknown")));
    assert.ok(logs.some((l) => l.includes("Provider: unknown")));
  });

  it("list shows available models with active marker", () => {
    const logs = [];
    sandboxModel("sb", ["list"], {
      getCurrentModel: (name) => ({ model: "model-a", provider: "nvidia-nim" }),
      listAvailableModels: () => ({
        models: [
          { id: "model-a", label: "Model A" },
          { id: "model-b", label: "model-b" },
        ],
        source: "catalog",
      }),
      log: (m) => logs.push(m),
      logError: noop,
      exit: noop,
    });
    assert.ok(logs.some((l) => l.includes("Available models (catalog)")));
    assert.ok(logs.some((l) => l.includes("● model-a — Model A"))); // active
    assert.ok(logs.some((l) => l.includes("○ model-b")));           // inactive
    // model-b label === id, so no " — " suffix
    const mbLine = logs.find((l) => l.includes("model-b"));
    assert.ok(!mbLine.includes("—"), "no label suffix when label equals id");
  });

  it("list exits 1 when no provider configured", () => {
    let exitCode;
    const errors = [];
    sandboxModel("sb", ["list"], {
      getCurrentModel: () => ({ model: null, provider: null }),
      logError: (m) => errors.push(m),
      log: noop,
      exit: (c) => { exitCode = c; },
    });
    assert.strictEqual(exitCode, 1);
    assert.ok(errors.some((e) => e.includes("no provider")));
  });

  it("set changes model successfully", () => {
    const logs = [];
    sandboxModel("sb", ["set", "new-model"], {
      getCurrentModel: () => ({ model: "old-model" }),
      setModel: () => ({ success: true }),
      log: (m) => logs.push(m),
      logError: noop,
      exit: noop,
    });
    assert.ok(logs.some((l) => l.includes("Switching model")));
    assert.ok(logs.some((l) => l.includes("Model changed to 'new-model'")));
    assert.ok(logs.some((l) => l.includes("immutable by design")));
  });

  it("set exits 1 when setModel fails", () => {
    let exitCode;
    const errors = [];
    sandboxModel("sb", ["set", "bad-model"], {
      getCurrentModel: () => ({ model: "old" }),
      setModel: () => ({ success: false, error: "route failed" }),
      log: noop,
      logError: (m) => errors.push(m),
      exit: (c) => { exitCode = c; },
    });
    assert.strictEqual(exitCode, 1);
    assert.ok(errors.some((e) => e.includes("route failed")));
  });

  it("set with no model-id exits 1", () => {
    let exitCode;
    const errors = [];
    sandboxModel("sb", ["set"], {
      getCurrentModel: noop,
      logError: (m) => errors.push(m),
      log: noop,
      exit: (c) => { exitCode = c; },
    });
    assert.strictEqual(exitCode, 1);
    assert.ok(errors.some((e) => e.includes("Usage:")));
  });

  it("set with same model skips update", () => {
    const logs = [];
    let setModelCalled = false;
    sandboxModel("sb", ["set", "current-model"], {
      getCurrentModel: () => ({ model: "current-model" }),
      setModel: () => { setModelCalled = true; return { success: true }; },
      log: (m) => logs.push(m),
      logError: noop,
      exit: noop,
    });
    assert.ok(!setModelCalled, "should not call setModel when model unchanged");
    assert.ok(logs.some((l) => l.includes("Already using")));
  });
});

// ── reconnectCmd ─────────────────────────────────────────────────

describe("reconnectCmd (DI)", () => {
  it("exits 1 when no sandbox registered", () => {
    let exitCode;
    const errors = [];
    reconnectCmd([], {
      getDefault: () => null,
      logError: (m) => errors.push(m),
      log: () => {},
      exit: (c) => { exitCode = c; },
    });
    assert.strictEqual(exitCode, 1);
    assert.ok(errors.some((e) => e.includes("No sandbox")));
  });

  it("diagnose mode shows diagnostics and returns", () => {
    const logs = [];
    reconnectCmd(["--diagnose"], {
      getDefault: () => "my-sb",
      diagnose: () => ({
        gateway: { running: true, healthy: true },
        sandbox: { exists: true, ready: true },
        wsl: false,
        runtime: "docker",
      }),
      log: (m) => logs.push(m),
      logError: () => {},
      exit: () => {},
    });
    assert.ok(logs.some((l) => l.includes("Diagnostics")));
    assert.ok(logs.some((l) => l.includes("Gateway running")));
    assert.ok(logs.some((l) => l.includes("Runtime")));
  });

  it("diagnose with named sandbox uses that name", () => {
    let diagName;
    reconnectCmd(["custom-sb", "--diagnose"], {
      getDefault: () => "default-sb",
      diagnose: (name) => {
        diagName = name;
        return {
          gateway: { running: false, healthy: false },
          sandbox: { exists: false, ready: false },
          wsl: true,
          runtime: "docker-desktop",
        };
      },
      log: () => {},
      logError: () => {},
      exit: () => {},
    });
    assert.strictEqual(diagName, "custom-sb");
  });

  it("reconnect success shows steps and success message", () => {
    const logs = [];
    reconnectCmd([], {
      getDefault: () => "my-sb",
      reconnect: () => ({
        success: true,
        steps: ["Gateway restarted", "Port forwards restarted"],
        errors: [],
      }),
      log: (m) => logs.push(m),
      logError: () => {},
      exit: () => {},
    });
    assert.ok(logs.some((l) => l.includes("Reconnecting")));
    assert.ok(logs.some((l) => l.includes("Gateway restarted")));
    assert.ok(logs.some((l) => l.includes("Reconnected successfully")));
  });

  it("reconnect failure shows errors and exits 1", () => {
    let exitCode;
    const errors = [];
    const logs = [];
    reconnectCmd([], {
      getDefault: () => "my-sb",
      reconnect: () => ({
        success: false,
        steps: ["Gateway restarted"],
        errors: ["Sandbox unreachable"],
      }),
      log: (m) => logs.push(m),
      logError: (m) => errors.push(m),
      exit: (c) => { exitCode = c; },
    });
    assert.strictEqual(exitCode, 1);
    assert.ok(errors.some((e) => e.includes("Sandbox unreachable")));
    assert.ok(errors.some((e) => e.includes("nemoclaw onboard")));
  });
});

// ── update ────────────────────────────────────────────────────────

describe("update (DI)", () => {
  it("exits 1 when install type is unknown", async () => {
    let exitCode;
    const errors = [];
    await update([], {
      detectInstallType: () => ({ type: "unknown", sourceDir: null }),
      logError: (m) => errors.push(m),
      log: () => {},
      exit: (c) => { exitCode = c; },
    });
    assert.strictEqual(exitCode, 1);
    assert.ok(errors.some((e) => e.includes("Could not detect")));
  });

  it("exits 1 when checkForUpdate returns error", async () => {
    let exitCode;
    const errors = [];
    await update([], {
      detectInstallType: () => ({ type: "source", sourceDir: "/src" }),
      checkForUpdate: () => ({ error: "network error" }),
      logError: (m) => errors.push(m),
      log: () => {},
      exit: (c) => { exitCode = c; },
    });
    assert.strictEqual(exitCode, 1);
    assert.ok(errors.some((e) => e.includes("network error")));
  });

  it("shows already up to date when no update available", async () => {
    const logs = [];
    await update([], {
      detectInstallType: () => ({ type: "source", sourceDir: "/src" }),
      checkForUpdate: () => ({
        updateAvailable: false,
        currentVersion: "0.1.0",
        current: "abc1234",
        remote: "abc1234",
      }),
      log: (m) => logs.push(m),
      logError: () => {},
      exit: () => {},
    });
    assert.ok(logs.some((l) => l.includes("Already up to date")));
  });

  it("--check shows update available without installing", async () => {
    const logs = [];
    let updateSourceCalled = false;
    await update(["--check"], {
      detectInstallType: () => ({ type: "source", sourceDir: "/src" }),
      checkForUpdate: () => ({
        updateAvailable: true,
        currentVersion: "0.1.0",
        current: "abc1234",
        remote: "def5678",
      }),
      updateSource: () => { updateSourceCalled = true; return true; },
      log: (m) => logs.push(m),
      logError: () => {},
      exit: () => {},
    });
    assert.ok(!updateSourceCalled, "should not call updateSource in check mode");
    assert.ok(logs.some((l) => l.includes("Update available")));
  });

  it("source update calls updateSource", async () => {
    let sourceDir;
    const logs = [];
    await update([], {
      detectInstallType: () => ({ type: "source", sourceDir: "/my/src" }),
      checkForUpdate: () => ({
        updateAvailable: true,
        currentVersion: "0.1.0",
        current: "abc1234",
        remote: "def5678",
      }),
      updateSource: (dir) => { sourceDir = dir; return true; },
      verifyUpdate: () => "v0.2.0",
      log: (m) => logs.push(m),
      logError: () => {},
      exit: () => {},
    });
    assert.strictEqual(sourceDir, "/my/src");
    assert.ok(logs.some((l) => l.includes("Updated successfully: v0.2.0")));
  });

  it("global update calls updateGlobal", async () => {
    let globalCalled = false;
    const logs = [];
    await update([], {
      detectInstallType: () => ({ type: "global", sourceDir: null }),
      checkForUpdate: () => ({
        updateAvailable: true,
        currentVersion: "0.1.0",
        current: "abc1234",
        remote: "def5678",
      }),
      updateGlobal: () => { globalCalled = true; return true; },
      verifyUpdate: () => null,
      log: (m) => logs.push(m),
      logError: () => {},
      exit: () => {},
    });
    assert.ok(globalCalled);
    assert.ok(logs.some((l) => l.includes("Update complete. Verify with")));
  });

  it("exits 1 when update fails", async () => {
    let exitCode;
    const errors = [];
    await update([], {
      detectInstallType: () => ({ type: "source", sourceDir: "/src" }),
      checkForUpdate: () => ({
        updateAvailable: true,
        currentVersion: "0.1.0",
        current: "abc",
        remote: "def",
      }),
      updateSource: () => false,
      log: () => {},
      logError: (m) => errors.push(m),
      exit: (c) => { exitCode = c; },
    });
    assert.strictEqual(exitCode, 1);
    assert.ok(errors.some((e) => e.includes("Update failed")));
  });

  it("shows version with commit hash when available", async () => {
    const logs = [];
    await update([], {
      detectInstallType: () => ({ type: "source", sourceDir: "/src" }),
      checkForUpdate: () => ({
        updateAvailable: false,
        currentVersion: "0.1.0",
        current: "abc1234",
        remote: "abc1234",
      }),
      log: (m) => logs.push(m),
      logError: () => {},
      exit: () => {},
    });
    assert.ok(logs.some((l) => l.includes("v0.1.0") && l.includes("abc1234")));
  });

  it("shows version without commit when current is empty", async () => {
    const logs = [];
    await update([], {
      detectInstallType: () => ({ type: "global", sourceDir: null }),
      checkForUpdate: () => ({
        updateAvailable: false,
        currentVersion: "0.1.0",
        current: "",
        remote: "abc1234",
      }),
      log: (m) => logs.push(m),
      logError: () => {},
      exit: () => {},
    });
    const vLine = logs.find((l) => l.includes("v0.1.0"));
    assert.ok(vLine);
    assert.ok(!vLine.includes("()"), "no empty parens when current is empty");
  });

  it("displays global npm for non-source type", async () => {
    const logs = [];
    await update([], {
      detectInstallType: () => ({ type: "global", sourceDir: null }),
      checkForUpdate: () => ({
        updateAvailable: false, currentVersion: "0.1.0",
        current: "", remote: "abc",
      }),
      log: (m) => logs.push(m),
      logError: () => {},
      exit: () => {},
    });
    assert.ok(logs.some((l) => l.includes("global npm")));
  });
});

// ── setup ────────────────────────────────────────────────────────

describe("setup (DI)", () => {
  it("prints deprecation warning and runs setup.sh", async () => {
    const logs = [];
    let runCmd;
    let ensureCalled = false;
    await setup({
      ensureApiKey: async () => { ensureCalled = true; },
      listSandboxes: () => ({ sandboxes: [], defaultSandbox: null }),
      run: (cmd) => { runCmd = cmd; },
      log: (m) => logs.push(m),
    });
    assert.ok(ensureCalled);
    assert.ok(logs.some((l) => l.includes("deprecated")));
    assert.ok(runCmd.includes("setup.sh"));
  });

  it("passes valid sandbox name to setup.sh", async () => {
    let runCmd;
    await setup({
      ensureApiKey: async () => {},
      listSandboxes: () => ({ sandboxes: [], defaultSandbox: "my-sandbox" }),
      run: (cmd) => { runCmd = cmd; },
      log: () => {},
    });
    assert.ok(runCmd.includes("my-sandbox"));
  });

  it("uses empty string for invalid sandbox name", async () => {
    let runCmd;
    await setup({
      ensureApiKey: async () => {},
      listSandboxes: () => ({ sandboxes: [], defaultSandbox: "INVALID NAME!" }),
      run: (cmd) => { runCmd = cmd; },
      log: () => {},
    });
    // Invalid name doesn't match the regex, so safeName = ""
    assert.ok(!runCmd.includes("INVALID"));
  });
});

// ── setupSpark ───────────────────────────────────────────────────

describe("setupSpark (DI)", () => {
  it("calls ensureApiKey and runs setup-spark.sh with credential env", async () => {
    let ensureCalled = false;
    let runCmd;
    let runOpts;
    let credKeys;
    await setupSpark({
      ensureApiKey: async () => { ensureCalled = true; },
      buildCredentialEnv: (keys) => { credKeys = keys; return { NVIDIA_API_KEY: "test" }; },
      run: (cmd, opts) => { runCmd = cmd; runOpts = opts; },
    });
    assert.ok(ensureCalled);
    assert.ok(runCmd.includes("setup-spark.sh"));
    assert.deepStrictEqual(credKeys, ["NVIDIA_API_KEY"]);
    assert.deepStrictEqual(runOpts.env, { NVIDIA_API_KEY: "test" });
  });
});

// ── start ────────────────────────────────────────────────────────

describe("start (DI)", () => {
  it("runs start-services.sh with sandbox name env", async () => {
    let runCmd;
    await start({
      ensureApiKey: async () => {},
      listSandboxes: () => ({ defaultSandbox: "my-sb" }),
      run: (cmd) => { runCmd = cmd; },
    });
    assert.ok(runCmd.includes("SANDBOX_NAME="));
    assert.ok(runCmd.includes("my-sb"));
    assert.ok(runCmd.includes("start-services.sh"));
  });

  it("omits SANDBOX_NAME when no default sandbox", async () => {
    let runCmd;
    await start({
      ensureApiKey: async () => {},
      listSandboxes: () => ({ defaultSandbox: null }),
      run: (cmd) => { runCmd = cmd; },
    });
    assert.ok(!runCmd.includes("SANDBOX_NAME="));
  });

  it("omits SANDBOX_NAME when name has invalid chars", async () => {
    let runCmd;
    await start({
      ensureApiKey: async () => {},
      listSandboxes: () => ({ defaultSandbox: "bad name!" }),
      run: (cmd) => { runCmd = cmd; },
    });
    assert.ok(!runCmd.includes("SANDBOX_NAME="));
  });
});

// ── stop ─────────────────────────────────────────────────────────

describe("stop (DI)", () => {
  it("runs start-services.sh --stop", () => {
    let runCmd;
    stop({ run: (cmd) => { runCmd = cmd; } });
    assert.ok(runCmd.includes("start-services.sh"));
    assert.ok(runCmd.includes("--stop"));
  });
});

// ── debug ────────────────────────────────────────────────────────

describe("debug (DI)", () => {
  it("spawns debug.sh with args and exits with result", () => {
    let spawnArgs;
    let exitResult;
    debugCmd(["--quick"], {
      spawn: (cmd, args) => {
        spawnArgs = args;
        return { status: 0 };
      },
      exitSpawn: (r) => { exitResult = r; },
      listSandboxes: () => ({ defaultSandbox: "test-sb" }),
    });
    assert.ok(spawnArgs[0].includes("debug.sh"));
    assert.ok(spawnArgs.includes("--quick"));
    assert.deepStrictEqual(exitResult, { status: 0 });
  });

  it("passes empty defaultSandbox when none registered", () => {
    let spawnOpts;
    debugCmd([], {
      spawn: (cmd, args, opts) => {
        spawnOpts = opts;
        return { status: 0 };
      },
      exitSpawn: () => {},
      listSandboxes: () => ({ defaultSandbox: null }),
    });
    assert.strictEqual(spawnOpts.env.SANDBOX_NAME, "");
  });
});
