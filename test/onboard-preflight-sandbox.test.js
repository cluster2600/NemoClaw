// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  preflight,
  createSandbox,
} = require("../bin/lib/onboard");

// ── Shared helpers ──────────────────────────────────────────────

function noop() {}
const noopLog = noop;
const noopError = noop;
const noopStep = noop;
const noopRun = () => ({ status: 0 });
const noopRunCapture = () => "";
const noopExit = () => {};

function basePreflight(overrides = {}) {
  return {
    step: noopStep,
    isDockerRunning: () => true,
    getContainerRuntime: () => "docker",
    isUnsupportedMacosRuntime: () => false,
    isOpenshellInstalled: () => true,
    installOpenshell: () => true,
    runCapture: noopRunCapture,
    run: noopRun,
    hasStaleGateway: () => false,
    getConfiguredPorts: () => ({ gatewayPort: 8080, dashboardPort: 18789, nimPort: 8000 }),
    resolvePort: async (p) => ({ port: p, changed: false }),
    detectGpu: () => null,
    exit: noopExit,
    env: {},
    log: noopLog,
    error: noopError,
    ...overrides,
  };
}

function baseCreateSandbox(overrides = {}) {
  return {
    step: noopStep,
    promptOrDefault: async () => "test-sandbox",
    isNonInteractive: () => false,
    note: noopLog,
    prompt: async () => "n",
    run: noopRun,
    runCapture: () => "test-sandbox   Ready",
    registry: {
      getSandbox: () => null,
      removeSandbox: noop,
      registerSandbox: noop,
    },
    patchDockerfileModel: noop,
    patchDockerfileVersion: noop,
    patchDockerfileExtraOrigins: noop,
    buildCredentialEnv: () => ({}),
    shellQuote: (v) => `'${v}'`,
    streamSandboxCreate: async () => ({ status: 0, output: "", sawProgress: true }),
    isSandboxReady: (output, name) => output.includes(name) && output.includes("Ready"),
    exit: noopExit,
    env: {},
    log: noopLog,
    error: noopError,
    mkdtempSync: () => "/tmp/nemoclaw-build-test",
    copyFileSync: noop,
    spawnSync: noop,
    ...overrides,
  };
}

// ── preflight() ─────────────────────────────────────────────────

describe("preflight()", () => {
  it("exits when Docker is not running", async () => {
    let exitCode = null;
    const deps = basePreflight({
      isDockerRunning: () => false,
      exit: (code) => { exitCode = code; },
    });
    const result = await preflight(deps);
    assert.equal(exitCode, 1);
    assert.equal(result, null);
  });

  it("exits when macOS Podman is detected", async () => {
    let exitCode = null;
    const errors = [];
    const deps = basePreflight({
      getContainerRuntime: () => "podman",
      isUnsupportedMacosRuntime: () => true,
      exit: (code) => { exitCode = code; },
      error: (msg) => errors.push(msg),
    });
    await preflight(deps);
    assert.equal(exitCode, 1);
    assert.ok(errors.some((e) => e.includes("Podman on macOS")));
  });

  it("logs runtime when known", async () => {
    const logs = [];
    const deps = basePreflight({
      log: (msg) => logs.push(msg),
      getContainerRuntime: () => "colima",
    });
    await preflight(deps);
    assert.ok(logs.some((l) => l.includes("colima")));
  });

  it("does not log runtime when unknown", async () => {
    const logs = [];
    const deps = basePreflight({
      log: (msg) => logs.push(msg),
      getContainerRuntime: () => "unknown",
    });
    await preflight(deps);
    assert.ok(!logs.some((l) => l.includes("Container runtime")));
  });

  it("installs openshell when not present", async () => {
    let installed = false;
    const deps = basePreflight({
      isOpenshellInstalled: () => false,
      installOpenshell: () => { installed = true; return true; },
    });
    await preflight(deps);
    assert.equal(installed, true);
  });

  it("exits when openshell install fails", async () => {
    let exitCode = null;
    const errors = [];
    const deps = basePreflight({
      isOpenshellInstalled: () => false,
      installOpenshell: () => false,
      exit: (code) => { exitCode = code; },
      error: (msg) => errors.push(msg),
    });
    await preflight(deps);
    assert.equal(exitCode, 1);
    assert.ok(errors.some((e) => e.includes("Failed to install")));
  });

  it("cleans up stale gateway when detected", async () => {
    const commands = [];
    const deps = basePreflight({
      hasStaleGateway: () => true,
      run: (cmd) => { commands.push(cmd); return { status: 0 }; },
    });
    await preflight(deps);
    assert.ok(commands.some((c) => c.includes("forward stop")));
    assert.ok(commands.some((c) => c.includes("gateway destroy")));
  });

  it("uses custom dashboard port for stale cleanup", async () => {
    const commands = [];
    const deps = basePreflight({
      hasStaleGateway: () => true,
      env: { NEMOCLAW_DASHBOARD_PORT: "19000" },
      run: (cmd) => { commands.push(cmd); return { status: 0 }; },
    });
    await preflight(deps);
    assert.ok(commands.some((c) => c.includes("forward stop 19000")));
  });

  it("exits on port conflict with known process and PID", async () => {
    let exitCode = null;
    const errors = [];
    const deps = basePreflight({
      resolvePort: async () => ({
        conflict: { process: "nginx", pid: 1234, reason: "port in use" },
      }),
      exit: (code) => { exitCode = code; },
      error: (msg) => errors.push(msg),
    });
    await preflight(deps);
    assert.equal(exitCode, 1);
    assert.ok(errors.some((e) => e.includes("nginx")));
    assert.ok(errors.some((e) => e.includes("sudo kill 1234")));
  });

  it("exits on port conflict with known process but no PID", async () => {
    let exitCode = null;
    const errors = [];
    const deps = basePreflight({
      resolvePort: async () => ({
        conflict: { process: "java", reason: "port in use" },
      }),
      exit: (code) => { exitCode = code; },
      error: (msg) => errors.push(msg),
    });
    await preflight(deps);
    assert.equal(exitCode, 1);
    assert.ok(errors.some((e) => e.includes("sudo lsof")));
  });

  it("exits on port conflict with unknown process", async () => {
    let exitCode = null;
    const errors = [];
    const deps = basePreflight({
      resolvePort: async () => ({
        conflict: { process: "unknown", reason: "port in use" },
      }),
      exit: (code) => { exitCode = code; },
      error: (msg) => errors.push(msg),
    });
    await preflight(deps);
    assert.equal(exitCode, 1);
    assert.ok(errors.some((e) => e.includes("Could not identify")));
  });

  it("logs changed port with env var hint", async () => {
    const logs = [];
    let callCount = 0;
    const deps = basePreflight({
      resolvePort: async (p) => {
        callCount++;
        if (callCount === 1) return { port: 8081, original: 8080, changed: true };
        return { port: p, changed: false };
      },
      log: (msg) => logs.push(msg),
    });
    await preflight(deps);
    assert.ok(logs.some((l) => l.includes("8081") && l.includes("instead")));
    assert.ok(logs.some((l) => l.includes("NEMOCLAW_GATEWAY_PORT=8081")));
  });

  it("stores resolved ports in env", async () => {
    const env = {};
    const deps = basePreflight({
      env,
      resolvePort: async (p) => ({ port: p + 1, changed: true, original: p }),
    });
    await preflight(deps);
    assert.equal(env._NEMOCLAW_RESOLVED_GATEWAY_PORT, "8081");
    assert.equal(env._NEMOCLAW_RESOLVED_DASHBOARD_PORT, "18790");
    assert.equal(env._NEMOCLAW_RESOLVED_NIM_PORT, "8001");
  });

  it("detects NVIDIA GPU", async () => {
    const logs = [];
    const deps = basePreflight({
      detectGpu: () => ({ type: "nvidia", count: 2, totalMemoryMB: 48000 }),
      log: (msg) => logs.push(msg),
    });
    const gpu = await preflight(deps);
    assert.equal(gpu.type, "nvidia");
    assert.ok(logs.some((l) => l.includes("NVIDIA GPU")));
  });

  it("detects Apple GPU with cores", async () => {
    const logs = [];
    const deps = basePreflight({
      detectGpu: () => ({ type: "apple", name: "M2 Ultra", cores: 76, totalMemoryMB: 192000 }),
      log: (msg) => logs.push(msg),
    });
    const gpu = await preflight(deps);
    assert.equal(gpu.type, "apple");
    assert.ok(logs.some((l) => l.includes("Apple GPU")));
    assert.ok(logs.some((l) => l.includes("76 cores")));
    assert.ok(logs.some((l) => l.includes("NIM requires NVIDIA")));
  });

  it("detects Apple GPU without cores", async () => {
    const logs = [];
    const deps = basePreflight({
      detectGpu: () => ({ type: "apple", name: "M1", totalMemoryMB: 16000 }),
      log: (msg) => logs.push(msg),
    });
    await preflight(deps);
    assert.ok(logs.some((l) => l.includes("M1") && !l.includes("cores")));
  });

  it("handles no GPU", async () => {
    const logs = [];
    const deps = basePreflight({
      detectGpu: () => null,
      log: (msg) => logs.push(msg),
    });
    const gpu = await preflight(deps);
    assert.equal(gpu, null);
    assert.ok(logs.some((l) => l.includes("No GPU detected")));
  });

  it("all ports available — happy path", async () => {
    const logs = [];
    const deps = basePreflight({
      log: (msg) => logs.push(msg),
    });
    const gpu = await preflight(deps);
    assert.equal(gpu, null);
    assert.ok(logs.some((l) => l.includes("8080") && l.includes("available")));
    assert.ok(logs.some((l) => l.includes("18789") && l.includes("available")));
    assert.ok(logs.some((l) => l.includes("8000") && l.includes("available")));
  });
});

// ── createSandbox() ─────────────────────────────────────────────

describe("createSandbox()", () => {
  it("creates sandbox with default name", async () => {
    let registered = null;
    const deps = baseCreateSandbox({
      registry: {
        getSandbox: () => null,
        removeSandbox: noop,
        registerSandbox: (info) => { registered = info; },
      },
    });
    const name = await createSandbox(null, "llama3", deps);
    assert.equal(name, "test-sandbox");
    assert.deepEqual(registered, { name: "test-sandbox", gpuEnabled: false });
  });

  it("registers with gpuEnabled true when gpu provided", async () => {
    let registered = null;
    const deps = baseCreateSandbox({
      registry: {
        getSandbox: () => null,
        removeSandbox: noop,
        registerSandbox: (info) => { registered = info; },
      },
    });
    const name = await createSandbox({ type: "nvidia" }, "llama3", deps);
    assert.equal(name, "test-sandbox");
    assert.equal(registered.gpuEnabled, true);
  });

  it("exits on invalid sandbox name", async () => {
    let exitCode = null;
    const errors = [];
    const deps = baseCreateSandbox({
      promptOrDefault: async () => "INVALID_NAME!",
      exit: (code) => { exitCode = code; },
      error: (msg) => errors.push(msg),
    });
    await createSandbox(null, "llama3", deps);
    assert.equal(exitCode, 1);
    assert.ok(errors.some((e) => e.includes("Invalid sandbox name")));
  });

  it("exits on name starting with hyphen", async () => {
    let exitCode = null;
    const deps = baseCreateSandbox({
      promptOrDefault: async () => "-bad",
      exit: (code) => { exitCode = code; },
    });
    await createSandbox(null, "llama3", deps);
    assert.equal(exitCode, 1);
  });

  it("exits on name ending with hyphen", async () => {
    let exitCode = null;
    const deps = baseCreateSandbox({
      promptOrDefault: async () => "bad-",
      exit: (code) => { exitCode = code; },
    });
    await createSandbox(null, "llama3", deps);
    assert.equal(exitCode, 1);
  });

  it("uses default name when promptOrDefault returns null", async () => {
    const deps = baseCreateSandbox({
      promptOrDefault: async () => null,
      runCapture: () => "my-assistant   Ready",
      isSandboxReady: (output, name) => output.includes(name) && output.includes("Ready"),
    });
    const name = await createSandbox(null, "llama3", deps);
    assert.equal(name, "my-assistant");
  });

  it("non-interactive: exits when sandbox exists without RECREATE flag", async () => {
    let exitCode = null;
    const errors = [];
    const deps = baseCreateSandbox({
      isNonInteractive: () => true,
      env: {},
      registry: {
        getSandbox: () => ({ name: "test-sandbox" }),
        removeSandbox: noop,
        registerSandbox: noop,
      },
      exit: (code) => { exitCode = code; },
      error: (msg) => errors.push(msg),
    });
    await createSandbox(null, "llama3", deps);
    assert.equal(exitCode, 1);
    assert.ok(errors.some((e) => e.includes("NEMOCLAW_RECREATE_SANDBOX=1")));
  });

  it("non-interactive: recreates sandbox with RECREATE flag", async () => {
    let removed = false;
    const notes = [];
    const deps = baseCreateSandbox({
      isNonInteractive: () => true,
      env: { NEMOCLAW_RECREATE_SANDBOX: "1" },
      registry: {
        getSandbox: () => ({ name: "test-sandbox" }),
        removeSandbox: () => { removed = true; },
        registerSandbox: noop,
      },
      note: (msg) => notes.push(msg),
    });
    const name = await createSandbox(null, "llama3", deps);
    assert.equal(name, "test-sandbox");
    assert.equal(removed, true);
    assert.ok(notes.some((n) => n.includes("recreating")));
  });

  it("interactive: keeps existing sandbox when user declines", async () => {
    const logs = [];
    const deps = baseCreateSandbox({
      isNonInteractive: () => false,
      prompt: async () => "n",
      registry: {
        getSandbox: () => ({ name: "test-sandbox" }),
        removeSandbox: noop,
        registerSandbox: noop,
      },
      log: (msg) => logs.push(msg),
    });
    const name = await createSandbox(null, "llama3", deps);
    assert.equal(name, "test-sandbox");
    assert.ok(logs.some((l) => l.includes("Keeping existing")));
  });

  it("interactive: recreates sandbox when user confirms", async () => {
    let removed = false;
    const deps = baseCreateSandbox({
      isNonInteractive: () => false,
      prompt: async () => "y",
      registry: {
        getSandbox: () => ({ name: "test-sandbox" }),
        removeSandbox: () => { removed = true; },
        registerSandbox: noop,
      },
    });
    await createSandbox(null, "llama3", deps);
    assert.equal(removed, true);
  });

  it("patches Dockerfile with model, version, and extra origins", async () => {
    const patched = { model: false, version: false, origins: false };
    const deps = baseCreateSandbox({
      env: { NEMOCLAW_OPENCLAW_VERSION: "1.2.3", NEMOCLAW_EXTRA_ORIGINS: "http://localhost:9000" },
      patchDockerfileModel: () => { patched.model = true; },
      patchDockerfileVersion: () => { patched.version = true; },
      patchDockerfileExtraOrigins: () => { patched.origins = true; },
    });
    await createSandbox(null, "llama3", deps);
    assert.ok(patched.model);
    assert.ok(patched.version);
    assert.ok(patched.origins);
  });

  it("includes credential env vars in sandbox creation", async () => {
    let createCmd = "";
    const deps = baseCreateSandbox({
      buildCredentialEnv: () => ({ NVIDIA_API_KEY: "nvapi-test" }),
      shellQuote: (v) => `'${v}'`,
      streamSandboxCreate: async (cmd) => { createCmd = cmd; return { status: 0, output: "" }; },
    });
    await createSandbox(null, "llama3", deps);
    assert.ok(createCmd.includes("NVIDIA_API_KEY="));
  });

  it("exits on sandbox creation failure with output", async () => {
    let exitCode = null;
    const errors = [];
    const deps = baseCreateSandbox({
      streamSandboxCreate: async () => ({ status: 2, output: "build error: disk full" }),
      exit: (code) => { exitCode = code; },
      error: (msg) => errors.push(msg),
    });
    await createSandbox(null, "llama3", deps);
    assert.equal(exitCode, 2);
    assert.ok(errors.some((e) => e.includes("Sandbox creation failed")));
    assert.ok(errors.some((e) => e.includes("disk full")));
  });

  it("exits on sandbox creation failure without output — no output echoed", async () => {
    let exitCode = null;
    const errors = [];
    const deps = baseCreateSandbox({
      streamSandboxCreate: async () => ({ status: 1, output: "" }),
      exit: (code) => { exitCode = code; },
      error: (msg) => errors.push(msg),
    });
    await createSandbox(null, "llama3", deps);
    assert.equal(exitCode, 1);
    assert.ok(errors.some((e) => e.includes("Sandbox creation failed")));
    // When output is empty, the error output should not contain the raw output string
    assert.ok(!errors.some((e) => e === "build error: disk full"));
  });

  it("waits for sandbox readiness", async () => {
    let readinessChecks = 0;
    const deps = baseCreateSandbox({
      runCapture: () => { readinessChecks++; return "test-sandbox   Ready"; },
      isSandboxReady: (output, name) => {
        return output.includes(name) && output.includes("Ready");
      },
      spawnSync: noop,
    });
    await createSandbox(null, "llama3", deps);
    assert.ok(readinessChecks >= 1);
  });

  it("exits when sandbox never becomes ready — cleanup succeeds", async () => {
    let exitCode = null;
    const errors = [];
    const deps = baseCreateSandbox({
      runCapture: () => "test-sandbox   NotReady",
      isSandboxReady: () => false,
      spawnSync: noop,
      run: () => ({ status: 0 }),
      exit: (code) => { exitCode = code; },
      error: (msg) => errors.push(msg),
    });
    await createSandbox(null, "llama3", deps);
    assert.equal(exitCode, 1);
    assert.ok(errors.some((e) => e.includes("did not become ready")));
    assert.ok(errors.some((e) => e.includes("safely retry")));
  });

  it("exits when sandbox never becomes ready — cleanup fails", async () => {
    let exitCode = null;
    const errors = [];
    let deleteAttempted = false;
    const deps = baseCreateSandbox({
      runCapture: () => "test-sandbox   NotReady",
      isSandboxReady: () => false,
      spawnSync: noop,
      run: (cmd) => {
        if (cmd.includes("sandbox delete")) {
          deleteAttempted = true;
          return { status: 1 };
        }
        return { status: 0 };
      },
      exit: (code) => { exitCode = code; },
      error: (msg) => errors.push(msg),
    });
    await createSandbox(null, "llama3", deps);
    assert.equal(exitCode, 1);
    assert.equal(deleteAttempted, true);
    assert.ok(errors.some((e) => e.includes("Could not remove")));
  });

  it("uses custom dashboard port from env for port forwarding", async () => {
    const commands = [];
    const deps = baseCreateSandbox({
      env: { _NEMOCLAW_RESOLVED_DASHBOARD_PORT: "19000" },
      run: (cmd) => { commands.push(cmd); return { status: 0 }; },
    });
    await createSandbox(null, "llama3", deps);
    assert.ok(commands.some((c) => c.includes("forward stop 19000")));
    assert.ok(commands.some((c) => c.includes("forward start --background 19000")));
  });

  it("uses default dashboard port 18789 when env not set", async () => {
    const commands = [];
    const deps = baseCreateSandbox({
      env: {},
      run: (cmd) => { commands.push(cmd); return { status: 0 }; },
    });
    await createSandbox(null, "llama3", deps);
    assert.ok(commands.some((c) => c.includes("forward stop 18789")));
  });

  it("stages build context with mkdtempSync and copyFileSync", async () => {
    let tempCreated = false;
    let fileCopied = false;
    const deps = baseCreateSandbox({
      mkdtempSync: () => { tempCreated = true; return "/tmp/nemoclaw-build-test"; },
      copyFileSync: () => { fileCopied = true; },
    });
    await createSandbox(null, "llama3", deps);
    assert.equal(tempCreated, true);
    assert.equal(fileCopied, true);
  });

  it("cleans up build context after creation", async () => {
    const commands = [];
    const deps = baseCreateSandbox({
      run: (cmd) => { commands.push(cmd); return { status: 0 }; },
    });
    await createSandbox(null, "llama3", deps);
    assert.ok(commands.some((c) => c.includes("rm -rf") && c.includes("nemoclaw-build")));
  });

  it("cleans up build context even on failure", async () => {
    const commands = [];
    const deps = baseCreateSandbox({
      streamSandboxCreate: async () => ({ status: 1, output: "" }),
      run: (cmd) => { commands.push(cmd); return { status: 0 }; },
      exit: noop,
    });
    await createSandbox(null, "llama3", deps);
    assert.ok(commands.some((c) => c.includes("rm -rf") && c.includes("nemoclaw-build")));
  });

  it("uses CHAT_UI_URL env var when set", async () => {
    let createCmd = "";
    const deps = baseCreateSandbox({
      env: { CHAT_UI_URL: "https://custom.example.com" },
      streamSandboxCreate: async (cmd) => { createCmd = cmd; return { status: 0, output: "" }; },
    });
    await createSandbox(null, "llama3", deps);
    assert.ok(createCmd.includes("custom.example.com"));
  });

  it("readiness loop calls spawnSync for sleep", async () => {
    let sleepCalls = 0;
    let checkCount = 0;
    const deps = baseCreateSandbox({
      runCapture: () => {
        checkCount++;
        return checkCount >= 3 ? "test-sandbox   Ready" : "test-sandbox   NotReady";
      },
      isSandboxReady: (output, name) => output.includes(name) && output.includes("Ready") && !output.includes("NotReady"),
      spawnSync: (cmd) => { if (cmd === "sleep") sleepCalls++; },
    });
    await createSandbox(null, "llama3", deps);
    assert.equal(sleepCalls, 2);
  });
});
