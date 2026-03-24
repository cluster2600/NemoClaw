// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// DI + branch coverage tests for policies.js applyPreset(), nim.js nimStatus(),
// and onboard.js onboard() main orchestration function.

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// ── policies.js applyPreset() ────────────────────────────────────

const policies = require("../bin/lib/policies");

describe("applyPreset() I/O path via DI", () => {
  // The "base" preset exists in the repo and has network_policies + binaries
  const PRESET_NAME = "pypi";

  function makeDeps(overrides = {}) {
    const written = [];
    const deleted = [];
    const dirs = [];
    const dirsRemoved = [];
    const commands = [];
    let registrySandbox = { name: "test-sb", policies: [] };
    let registryUpdated = null;

    return {
      deps: {
        run: (cmd) => { commands.push(cmd); },
        runCapture: () => "",
        registry: {
          getSandbox: () => registrySandbox,
          updateSandbox: (name, data) => { registryUpdated = { name, data }; },
        },
        fs: {
          mkdtempSync: (prefix) => {
            const d = prefix + "-mock";
            dirs.push(d);
            return d;
          },
          writeFileSync: (f, content, opts) => { written.push({ f, content, opts }); },
          unlinkSync: (f) => { deleted.push(f); },
          rmdirSync: (d) => { dirsRemoved.push(d); },
        },
        os: { tmpdir: () => "/tmp" },
        ...overrides,
      },
      written,
      deleted,
      dirs,
      dirsRemoved,
      commands,
      getRegistryUpdated: () => registryUpdated,
      getRegistrySandbox: () => registrySandbox,
      setRegistrySandbox: (sb) => { registrySandbox = sb; },
    };
  }

  it("happy path: writes temp file, runs openshell, updates registry", () => {
    const ctx = makeDeps();
    const result = policies.applyPreset("test-sb", PRESET_NAME, ctx.deps);
    assert.equal(result, true);
    // Should have written a temp file
    assert.equal(ctx.written.length, 1);
    assert.ok(ctx.written[0].f.includes("policy.yaml"), "should write policy.yaml");
    assert.equal(ctx.written[0].opts.mode, 0o600, "temp file should be mode 600");
    // Should have run an openshell policy set command
    assert.equal(ctx.commands.length, 1);
    assert.ok(ctx.commands[0].includes("openshell policy set"), "should run policy set");
    assert.ok(ctx.commands[0].includes("test-sb"), "command should include sandbox name");
    // Should have cleaned up temp file
    assert.equal(ctx.deleted.length, 1);
    assert.equal(ctx.dirsRemoved.length, 1);
    // Should have updated registry
    const reg = ctx.getRegistryUpdated();
    assert.ok(reg, "registry should be updated");
    assert.equal(reg.name, "test-sb");
    assert.ok(reg.data.policies.includes(PRESET_NAME), "should add preset to policies");
  });

  it("merges with existing policy from sandbox", () => {
    const ctx = makeDeps({
      runCapture: () => "Version: 1\nHash: abc\n---\nversion: 1\nnetwork_policies:\n  - name: existing\n    host: example.com",
    });
    const result = policies.applyPreset("test-sb", PRESET_NAME, ctx.deps);
    assert.equal(result, true);
    // Written content should contain both existing and preset entries
    assert.ok(ctx.written[0].content.includes("network_policies"), "should include network_policies");
  });

  it("does not duplicate preset in registry policies", () => {
    const ctx = makeDeps();
    ctx.setRegistrySandbox({ name: "test-sb", policies: [PRESET_NAME] });
    const result = policies.applyPreset("test-sb", PRESET_NAME, ctx.deps);
    assert.equal(result, true);
    const reg = ctx.getRegistryUpdated();
    // Policies array should not have duplicates
    const count = reg.data.policies.filter((p) => p === PRESET_NAME).length;
    assert.equal(count, 1, "should not duplicate preset in policies");
  });

  it("handles sandbox with no policies array in registry", () => {
    const ctx = makeDeps();
    ctx.setRegistrySandbox({ name: "test-sb" }); // no policies key
    const result = policies.applyPreset("test-sb", PRESET_NAME, ctx.deps);
    assert.equal(result, true);
    const reg = ctx.getRegistryUpdated();
    assert.deepEqual(reg.data.policies, [PRESET_NAME]);
  });

  it("cleans up temp file even when run() throws", () => {
    const ctx = makeDeps({
      run: () => { throw new Error("openshell not found"); },
    });
    assert.throws(
      () => policies.applyPreset("test-sb", PRESET_NAME, ctx.deps),
      /openshell not found/,
    );
    // Cleanup should still have happened (finally block)
    assert.equal(ctx.deleted.length, 1, "should cleanup temp file on error");
    assert.equal(ctx.dirsRemoved.length, 1, "should cleanup temp dir on error");
  });

  it("skips registry update when sandbox not found", () => {
    const ctx = makeDeps({
      registry: {
        getSandbox: () => null,
        updateSandbox: () => { throw new Error("should not be called"); },
      },
    });
    const result = policies.applyPreset("test-sb", PRESET_NAME, ctx.deps);
    assert.equal(result, true, "should still return true");
  });

  it("handles runCapture throwing when fetching current policy", () => {
    const ctx = makeDeps({
      runCapture: () => { throw new Error("docker not running"); },
    });
    const result = policies.applyPreset("test-sb", PRESET_NAME, ctx.deps);
    assert.equal(result, true, "should still succeed with empty policy");
  });
});

// ── nim.js nimStatus() ───────────────────────────────────────────

const nim = require("../bin/lib/nim");

describe("nimStatus() via DI", () => {
  it("returns running + healthy when container is running and health check passes", () => {
    let callCount = 0;
    const result = nim.nimStatus("test-sb", 8000, {
      runCapture: (cmd) => {
        callCount++;
        if (cmd.includes("docker inspect")) return "running";
        if (cmd.includes("curl")) return '{"data":[{"id":"model"}]}';
        return "";
      },
    });
    assert.equal(result.running, true);
    assert.equal(result.healthy, true);
    assert.equal(result.state, "running");
    assert.ok(result.container.includes("test-sb"));
    assert.equal(callCount, 2, "should call docker inspect + curl");
  });

  it("returns running + unhealthy when health check returns empty", () => {
    const result = nim.nimStatus("test-sb", 8000, {
      runCapture: (cmd) => {
        if (cmd.includes("docker inspect")) return "running";
        if (cmd.includes("curl")) return "";
        return "";
      },
    });
    assert.equal(result.running, true);
    assert.equal(result.healthy, false);
  });

  it("returns not running when container state is not 'running'", () => {
    const result = nim.nimStatus("test-sb", 8000, {
      runCapture: (cmd) => {
        if (cmd.includes("docker inspect")) return "exited";
        return "";
      },
    });
    assert.equal(result.running, false);
    assert.equal(result.state, "exited");
    // Should NOT call curl when not running
    assert.equal(result.healthy, false);
  });

  it("returns not running when docker inspect returns empty", () => {
    const result = nim.nimStatus("test-sb", 8000, {
      runCapture: () => "",
    });
    assert.equal(result.running, false);
    assert.ok(result.container.includes("test-sb"));
  });

  it("returns not running when runCapture throws", () => {
    const result = nim.nimStatus("test-sb", 8000, {
      runCapture: () => { throw new Error("docker not available"); },
    });
    assert.equal(result.running, false);
    assert.ok(result.container.includes("test-sb"));
  });

  it("uses custom port in health check URL", () => {
    let healthUrl = "";
    nim.nimStatus("test-sb", 9123, {
      runCapture: (cmd) => {
        if (cmd.includes("docker inspect")) return "running";
        if (cmd.includes("curl")) { healthUrl = cmd; return "ok"; }
        return "";
      },
    });
    assert.ok(healthUrl.includes("9123"), "should use custom port in health URL");
    assert.ok(!healthUrl.includes("8000"), "should not use default port");
  });

  it("defaults to port 8000 when port is undefined", () => {
    let healthUrl = "";
    nim.nimStatus("test-sb", undefined, {
      runCapture: (cmd) => {
        if (cmd.includes("docker inspect")) return "running";
        if (cmd.includes("curl")) { healthUrl = cmd; return "ok"; }
        return "";
      },
    });
    assert.ok(healthUrl.includes("8000"), "should default to port 8000");
  });

  it("defaults to port 8000 when port is NaN", () => {
    let healthUrl = "";
    nim.nimStatus("test-sb", "not-a-number", {
      runCapture: (cmd) => {
        if (cmd.includes("docker inspect")) return "running";
        if (cmd.includes("curl")) { healthUrl = cmd; return ""; }
        return "";
      },
    });
    assert.ok(healthUrl.includes("8000"), "should default to port 8000 for NaN");
  });

  it("skips health check for non-running states (created, paused)", () => {
    for (const state of ["created", "paused", "restarting", "dead"]) {
      let curlCalled = false;
      const result = nim.nimStatus("test-sb", 8000, {
        runCapture: (cmd) => {
          if (cmd.includes("docker inspect")) return state;
          if (cmd.includes("curl")) { curlCalled = true; return ""; }
          return "";
        },
      });
      assert.equal(result.running, false, `state '${state}' should not be running`);
      assert.equal(curlCalled, false, `should not curl for state '${state}'`);
      assert.equal(result.state, state);
    }
  });
});

// ── onboard.js onboard() main orchestration ──────────────────────

const { onboard } = require("../bin/lib/onboard");

describe("onboard() main orchestration via DI", () => {
  it("calls all steps in correct order with correct arguments", async () => {
    const callOrder = [];

    const deps = {
      preflight: async () => { callOrder.push("preflight"); return { hasGpu: true, vram: 8192 }; },
      startGateway: async (gpu) => { callOrder.push("startGateway"); assert.deepEqual(gpu, { hasGpu: true, vram: 8192 }); },
      selectInferenceProvider: async (gpu) => {
        callOrder.push("selectInferenceProvider");
        return { model: "nemotron-mini", provider: "ollama-local" };
      },
      createSandbox: async (gpu, model) => {
        callOrder.push("createSandbox");
        assert.equal(model, "nemotron-mini");
        return "my-sandbox";
      },
      setupInferenceBackend: async (name, model, provider, gpu) => {
        callOrder.push("setupInferenceBackend");
        assert.equal(name, "my-sandbox");
        assert.equal(model, "nemotron-mini");
        assert.equal(provider, "ollama-local");
      },
      setupInference: async (name, model, provider) => {
        callOrder.push("setupInference");
        assert.equal(name, "my-sandbox");
      },
      setupOpenclaw: async (name, model, provider) => {
        callOrder.push("setupOpenclaw");
        assert.equal(name, "my-sandbox");
      },
      setupPolicies: async (name) => {
        callOrder.push("setupPolicies");
        assert.equal(name, "my-sandbox");
      },
      printDashboard: (name, model, provider) => {
        callOrder.push("printDashboard");
        assert.equal(name, "my-sandbox");
        assert.equal(model, "nemotron-mini");
        assert.equal(provider, "ollama-local");
      },
    };

    await onboard({}, deps);

    assert.deepEqual(callOrder, [
      "preflight",
      "startGateway",
      "selectInferenceProvider",
      "createSandbox",
      "setupInferenceBackend",
      "setupInference",
      "setupOpenclaw",
      "setupPolicies",
      "printDashboard",
    ]);
  });

  it("passes nonInteractive option through", async () => {
    const deps = {
      preflight: async () => ({ hasGpu: false, vram: 0 }),
      startGateway: async () => {},
      selectInferenceProvider: async () => ({ model: "m", provider: "p" }),
      createSandbox: async () => "sb",
      setupInferenceBackend: async () => {},
      setupInference: async () => {},
      setupOpenclaw: async () => {},
      setupPolicies: async () => {},
      printDashboard: () => {},
    };

    // Should not throw with nonInteractive
    await onboard({ nonInteractive: true }, deps);
  });

  it("propagates step failure upward", async () => {
    const deps = {
      preflight: async () => ({ hasGpu: false, vram: 0 }),
      startGateway: async () => {},
      selectInferenceProvider: async () => { throw new Error("no provider available"); },
      createSandbox: async () => "sb",
      setupInferenceBackend: async () => {},
      setupInference: async () => {},
      setupOpenclaw: async () => {},
      setupPolicies: async () => {},
      printDashboard: () => {},
    };

    await assert.rejects(
      () => onboard({}, deps),
      /no provider available/,
    );
  });

  it("does not call later steps when early step fails", async () => {
    const called = [];
    const deps = {
      preflight: async () => { throw new Error("Docker not running"); },
      startGateway: async () => { called.push("startGateway"); },
      selectInferenceProvider: async () => { called.push("select"); return { model: "m", provider: "p" }; },
      createSandbox: async () => { called.push("create"); return "sb"; },
      setupInferenceBackend: async () => { called.push("backend"); },
      setupInference: async () => { called.push("inference"); },
      setupOpenclaw: async () => { called.push("openclaw"); },
      setupPolicies: async () => { called.push("policies"); },
      printDashboard: () => { called.push("dashboard"); },
    };

    await assert.rejects(() => onboard({}, deps), /Docker not running/);
    assert.equal(called.length, 0, "no steps after preflight should run");
  });

  it("passes GPU info from preflight to downstream steps", async () => {
    const gpuInfo = { hasGpu: true, vram: 16384, name: "A100" };
    let gatewayGpu, selectGpu, createGpu, backendGpu;

    const deps = {
      preflight: async () => gpuInfo,
      startGateway: async (gpu) => { gatewayGpu = gpu; },
      selectInferenceProvider: async (gpu) => { selectGpu = gpu; return { model: "m", provider: "p" }; },
      createSandbox: async (gpu) => { createGpu = gpu; return "sb"; },
      setupInferenceBackend: async (_n, _m, _p, gpu) => { backendGpu = gpu; },
      setupInference: async () => {},
      setupOpenclaw: async () => {},
      setupPolicies: async () => {},
      printDashboard: () => {},
    };

    await onboard({}, deps);
    assert.deepEqual(gatewayGpu, gpuInfo);
    assert.deepEqual(selectGpu, gpuInfo);
    assert.deepEqual(createGpu, gpuInfo);
    assert.deepEqual(backendGpu, gpuInfo);
  });
});
