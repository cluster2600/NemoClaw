// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Tests for onboard.js step functions: setupInference, setupOpenclaw,
// setupPolicies, setupInferenceBackend — all exercised via dependency injection.

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  setupInference,
  setupInferenceBackend,
  setupOpenclaw,
  setupPolicies,
} = require("../bin/lib/onboard");

// ── Helpers ──────────────────────────────────────────────────────

function noop() {}
function noopStep() {}
function noopNote() {}

function makeRegistryStub(sandbox = null) {
  const updates = [];
  return {
    getSandbox: () => sandbox,
    updateSandbox: (name, data) => updates.push({ name, ...data }),
    updates,
  };
}

// ── setupInferenceBackend ────────────────────────────────────────

describe("setupInferenceBackend()", () => {
  it("registers sandbox with model/provider even without GPU", async () => {
    const reg = makeRegistryStub();
    await setupInferenceBackend("test-sb", "test-model", "nvidia-nim", null, {
      nim: {},
      registry: reg,
      env: {},
    });
    assert.equal(reg.updates.length, 1);
    assert.equal(reg.updates[0].name, "test-sb");
    assert.equal(reg.updates[0].model, "test-model");
    assert.equal(reg.updates[0].provider, "nvidia-nim");
    assert.equal(reg.updates[0].nimContainer, null);
  });

  it("uses default NIM port 8000 when env var not set", async () => {
    const reg = makeRegistryStub();
    await setupInferenceBackend("sb", "m", "nvidia-nim", null, {
      nim: {},
      registry: reg,
      env: {},
    });
    assert.equal(reg.updates[0].nimPort, 8000);
  });

  it("uses custom NIM port from env var", async () => {
    const reg = makeRegistryStub();
    await setupInferenceBackend("sb", "m", "nvidia-nim", null, {
      nim: {},
      registry: reg,
      env: { _NEMOCLAW_RESOLVED_NIM_PORT: "9000" },
    });
    assert.equal(reg.updates[0].nimPort, 9000);
  });

  it("skips NIM container when provider is not vllm-local", async () => {
    const reg = makeRegistryStub();
    const nimCalls = [];
    await setupInferenceBackend("sb", "m", "ollama-local", { nimCapable: true }, {
      nim: { listModels: () => { nimCalls.push("listModels"); return []; } },
      registry: reg,
      env: {},
      experimental: true,
    });
    assert.equal(nimCalls.length, 0);
    assert.equal(reg.updates[0].nimContainer, null);
  });

  it("skips NIM container when not experimental", async () => {
    const reg = makeRegistryStub();
    const nimCalls = [];
    await setupInferenceBackend("sb", "m", "vllm-local", { nimCapable: true }, {
      nim: { listModels: () => { nimCalls.push("list"); return []; } },
      registry: reg,
      env: {},
      experimental: false,
    });
    assert.equal(nimCalls.length, 0);
  });

  it("pulls and starts NIM container when experimental + vllm-local + GPU capable", async () => {
    const reg = makeRegistryStub();
    const calls = [];
    await setupInferenceBackend("sb", "big-model", "vllm-local", { nimCapable: true, totalMemoryMB: 16000 }, {
      nim: {
        listModels: () => [{ name: "big-model", minGpuMemoryMB: 8000 }],
        pullNimImage: (m) => calls.push(`pull:${m}`),
        startNimContainer: (s, m, p) => { calls.push(`start:${s}:${m}:${p}`); return "container-id"; },
        waitForNimHealth: (p) => { calls.push(`health:${p}`); return true; },
      },
      registry: reg,
      env: {},
      experimental: true,
    });
    assert.deepEqual(calls, ["pull:big-model", "start:sb:big-model:8000", "health:8000"]);
    assert.equal(reg.updates[0].nimContainer, "container-id");
  });

  it("falls back to null nimContainer when NIM health check fails", async () => {
    const reg = makeRegistryStub();
    await setupInferenceBackend("sb", "m", "vllm-local", { nimCapable: true, totalMemoryMB: 16000 }, {
      nim: {
        listModels: () => [{ name: "m", minGpuMemoryMB: 8000 }],
        pullNimImage: noop,
        startNimContainer: () => "cid",
        waitForNimHealth: () => false,
      },
      registry: reg,
      env: {},
      experimental: true,
    });
    assert.equal(reg.updates[0].nimContainer, null);
  });

  it("skips NIM when no models fit GPU VRAM", async () => {
    const reg = makeRegistryStub();
    await setupInferenceBackend("sb", "m", "vllm-local", { nimCapable: true, totalMemoryMB: 2000 }, {
      nim: {
        listModels: () => [{ name: "m", minGpuMemoryMB: 8000 }],
        pullNimImage: () => { throw new Error("should not be called"); },
      },
      registry: reg,
      env: {},
      experimental: true,
    });
    assert.equal(reg.updates[0].nimContainer, null);
  });
});

// ── setupInference ───────────────────────────────────────────────

describe("setupInference()", () => {
  function makeDeps(overrides = {}) {
    const calls = [];
    return {
      calls,
      deps: {
        step: noopStep,
        getCredential: (key) => { calls.push(`cred:${key}`); return overrides.apiKey || "test-key"; },
        run: (cmd, opts) => { calls.push(`run:${cmd.slice(0, 40)}`); return { status: 0 }; },
        runCapture: () => "",
        setInferenceRoute: (p, m) => { calls.push(`route:${p}:${m}`); return true; },
        validateLocalProvider: (p) => ({ ok: true }),
        getLocalProviderBaseUrl: (p) => "http://host.openshell.internal:11434/v1",
        getOllamaWarmupCommand: (m) => `curl warmup ${m}`,
        validateOllamaModel: (m) => ({ ok: true }),
        registry: makeRegistryStub(),
        exit: (code) => { calls.push(`exit:${code}`); },
        ...overrides,
      },
    };
  }

  it("creates nvidia-nim provider and sets route for cloud provider", async () => {
    const { calls, deps } = makeDeps();
    await setupInference("sb", "nvidia/nemotron", "nvidia-nim", deps);
    assert.ok(calls.some((c) => c.includes("cred:NVIDIA_API_KEY")));
    assert.ok(calls.some((c) => c.includes("route:nvidia-nim:nvidia/nemotron")));
    assert.ok(deps.registry.updates.some((u) => u.provider === "nvidia-nim"));
  });

  it("passes API key via env indirection not CLI args", async () => {
    const runCalls = [];
    const { deps } = makeDeps({
      run: (cmd, opts) => { runCalls.push({ cmd, opts }); return { status: 0 }; },
    });
    await setupInference("sb", "model", "nvidia-nim", deps);
    const providerCreate = runCalls.find((c) => c.cmd.includes("provider create"));
    assert.ok(providerCreate, "should call provider create");
    assert.ok(!providerCreate.cmd.includes("test-key"), "API key should not appear in CLI args");
    assert.ok(providerCreate.opts.env._NEMOCLAW_CRED, "API key should be passed via env");
  });

  it("creates vllm-local provider and sets route", async () => {
    const { calls, deps } = makeDeps();
    await setupInference("sb", "vllm-model", "vllm-local", deps);
    assert.ok(calls.some((c) => c.includes("route:vllm-local:vllm-model")));
    assert.ok(deps.registry.updates.some((u) => u.provider === "vllm-local"));
  });

  it("exits when vllm-local validation fails", async () => {
    const { calls, deps } = makeDeps({
      validateLocalProvider: () => ({ ok: false, message: "vLLM not reachable" }),
    });
    await setupInference("sb", "m", "vllm-local", deps);
    assert.ok(calls.some((c) => c === "exit:1"));
    assert.equal(deps.registry.updates.length, 0);
  });

  it("creates ollama-local provider, sets route, warms up, and validates", async () => {
    const { calls, deps } = makeDeps();
    await setupInference("sb", "llama3:8b", "ollama-local", deps);
    assert.ok(calls.some((c) => c.includes("route:ollama-local:llama3:8b")));
    // Warmup run
    assert.ok(calls.some((c) => c.includes("run:curl warmup llama3:8b")));
    assert.ok(deps.registry.updates.some((u) => u.provider === "ollama-local"));
  });

  it("exits when ollama-local validation fails", async () => {
    const { calls, deps } = makeDeps({
      validateLocalProvider: () => ({ ok: false, message: "Ollama not reachable" }),
    });
    await setupInference("sb", "m", "ollama-local", deps);
    assert.ok(calls.some((c) => c === "exit:1"));
    assert.equal(deps.registry.updates.length, 0);
  });

  it("exits when ollama model probe fails", async () => {
    const { calls, deps } = makeDeps({
      validateOllamaModel: () => ({ ok: false, message: "Model not found" }),
    });
    await setupInference("sb", "bad-model", "ollama-local", deps);
    assert.ok(calls.some((c) => c === "exit:1"));
    assert.equal(deps.registry.updates.length, 0);
  });

  it("skips provider setup for unknown provider but still registers", async () => {
    const { calls, deps } = makeDeps();
    await setupInference("sb", "m", "custom-provider", deps);
    assert.ok(!calls.some((c) => c.startsWith("route:")));
    assert.equal(deps.registry.updates.length, 1);
    assert.equal(deps.registry.updates[0].provider, "custom-provider");
  });
});

// ── setupOpenclaw ────────────────────────────────────────────────

describe("setupOpenclaw()", () => {
  it("writes config sync script to sandbox when selectionConfig exists", async () => {
    const calls = [];
    await setupOpenclaw("my-sb", "llama3:8b", "ollama-local", {
      step: noopStep,
      run: (cmd) => calls.push(cmd),
      fs: { unlinkSync: (p) => calls.push(`unlink:${p}`) },
      getProviderSelectionConfig: () => ({ provider: "ollama-local", model: "llama3:8b" }),
      buildSandboxConfigSyncScript: (cfg) => {
        calls.push("buildScript");
        assert.equal(cfg.provider, "ollama-local");
        assert.ok(cfg.onboardedAt);
        return "#!/bin/bash\necho test";
      },
      writeSandboxConfigSyncFile: (script) => {
        calls.push("writeScript");
        return "/tmp/nemoclaw-sync-1234.sh";
      },
      now: () => "2026-03-24T00:00:00.000Z",
    });
    assert.ok(calls.includes("buildScript"));
    assert.ok(calls.includes("writeScript"));
    assert.ok(calls.some((c) => typeof c === "string" && c.includes("openshell sandbox connect")));
    assert.ok(calls.some((c) => typeof c === "string" && c.startsWith("unlink:")));
  });

  it("skips config sync when selectionConfig is null", async () => {
    const calls = [];
    await setupOpenclaw("sb", "m", "unknown", {
      step: noopStep,
      run: (cmd) => calls.push(cmd),
      fs: { unlinkSync: noop },
      getProviderSelectionConfig: () => null,
      buildSandboxConfigSyncScript: () => { throw new Error("should not be called"); },
      writeSandboxConfigSyncFile: () => { throw new Error("should not be called"); },
    });
    assert.ok(!calls.some((c) => typeof c === "string" && c.includes("openshell")));
  });

  it("cleans up script file even when run() throws", async () => {
    const unlinkCalls = [];
    await assert.rejects(
      () => setupOpenclaw("sb", "m", "nvidia-nim", {
        step: noopStep,
        run: () => { throw new Error("connection refused"); },
        fs: { unlinkSync: (p) => unlinkCalls.push(p) },
        getProviderSelectionConfig: () => ({ provider: "nvidia-nim" }),
        buildSandboxConfigSyncScript: () => "script",
        writeSandboxConfigSyncFile: () => "/tmp/test.sh",
        now: () => "2026-01-01T00:00:00Z",
      }),
      { message: "connection refused" }
    );
    assert.equal(unlinkCalls.length, 1);
    assert.equal(unlinkCalls[0], "/tmp/test.sh");
  });

  it("includes onboardedAt timestamp in config", async () => {
    let capturedConfig = null;
    await setupOpenclaw("sb", "m", "nvidia-nim", {
      step: noopStep,
      run: noop,
      fs: { unlinkSync: noop },
      getProviderSelectionConfig: () => ({ provider: "nvidia-nim" }),
      buildSandboxConfigSyncScript: (cfg) => { capturedConfig = cfg; return ""; },
      writeSandboxConfigSyncFile: () => "/tmp/t.sh",
      now: () => "2026-03-24T12:00:00Z",
    });
    assert.equal(capturedConfig.onboardedAt, "2026-03-24T12:00:00Z");
  });
});

// ── setupPolicies ────────────────────────────────────────────────

describe("setupPolicies()", () => {
  const PRESETS = [
    { name: "pypi", description: "Python packages" },
    { name: "npm", description: "Node packages" },
    { name: "docker", description: "Docker Hub" },
    { name: "local-inference", description: "Local inference" },
    { name: "telegram", description: "Telegram" },
    { name: "slack", description: "Slack" },
    { name: "discord", description: "Discord" },
  ];

  function makePolicyDeps(overrides = {}) {
    const applied = [];
    return {
      applied,
      deps: {
        step: noopStep,
        note: noopNote,
        registry: makeRegistryStub(overrides.sandbox || null),
        policies: {
          listPresets: () => PRESETS,
          getAppliedPresets: () => overrides.appliedPresets || [],
          applyPreset: (sb, name) => applied.push(name),
        },
        getCredential: (key) => overrides.credentials?.[key] || null,
        isNonInteractive: () => overrides.nonInteractive ?? true,
        prompt: async () => overrides.promptAnswer || "",
        waitForSandboxReady: () => overrides.sandboxReady ?? true,
        sleep: noop,
        exit: (code) => { applied.push(`exit:${code}`); },
        env: overrides.env || {},
        ...overrides.depsOverrides,
      },
    };
  }

  // ── Non-interactive mode ─────────────────────────────────────

  it("applies default suggested presets (pypi, npm) in non-interactive mode", async () => {
    const { applied, deps } = makePolicyDeps();
    await setupPolicies("sb", deps);
    assert.deepEqual(applied, ["pypi", "npm"]);
  });

  it("auto-detects local-inference preset for ollama-local provider", async () => {
    const { applied, deps } = makePolicyDeps({
      sandbox: { provider: "ollama-local" },
    });
    await setupPolicies("sb", deps);
    assert.ok(applied.includes("local-inference"));
  });

  it("auto-detects local-inference preset for vllm-local provider", async () => {
    const { applied, deps } = makePolicyDeps({
      sandbox: { provider: "vllm-local" },
    });
    await setupPolicies("sb", deps);
    assert.ok(applied.includes("local-inference"));
  });

  it("auto-detects telegram preset when TELEGRAM_BOT_TOKEN is set", async () => {
    const { applied, deps } = makePolicyDeps({
      credentials: { TELEGRAM_BOT_TOKEN: "tok" },
    });
    await setupPolicies("sb", deps);
    assert.ok(applied.includes("telegram"));
  });

  it("auto-detects slack preset when SLACK_BOT_TOKEN is set", async () => {
    const { applied, deps } = makePolicyDeps({
      credentials: { SLACK_BOT_TOKEN: "tok" },
    });
    await setupPolicies("sb", deps);
    assert.ok(applied.includes("slack"));
  });

  it("auto-detects discord preset when DISCORD_BOT_TOKEN is set", async () => {
    const { applied, deps } = makePolicyDeps({
      credentials: { DISCORD_BOT_TOKEN: "tok" },
    });
    await setupPolicies("sb", deps);
    assert.ok(applied.includes("discord"));
  });

  it("auto-detects all three messaging presets when all tokens set", async () => {
    const { applied, deps } = makePolicyDeps({
      credentials: {
        TELEGRAM_BOT_TOKEN: "t",
        SLACK_BOT_TOKEN: "s",
        DISCORD_BOT_TOKEN: "d",
      },
    });
    await setupPolicies("sb", deps);
    assert.ok(applied.includes("telegram"));
    assert.ok(applied.includes("slack"));
    assert.ok(applied.includes("discord"));
    assert.ok(applied.includes("pypi"));
    assert.ok(applied.includes("npm"));
  });

  it("skips presets when NEMOCLAW_POLICY_MODE=skip", async () => {
    const { applied, deps } = makePolicyDeps({
      env: { NEMOCLAW_POLICY_MODE: "skip" },
    });
    await setupPolicies("sb", deps);
    assert.equal(applied.length, 0);
  });

  it("skips presets when NEMOCLAW_POLICY_MODE=none", async () => {
    const { applied, deps } = makePolicyDeps({
      env: { NEMOCLAW_POLICY_MODE: "none" },
    });
    await setupPolicies("sb", deps);
    assert.equal(applied.length, 0);
  });

  it("skips presets when NEMOCLAW_POLICY_MODE=no", async () => {
    const { applied, deps } = makePolicyDeps({
      env: { NEMOCLAW_POLICY_MODE: "no" },
    });
    await setupPolicies("sb", deps);
    assert.equal(applied.length, 0);
  });

  it("uses custom presets when NEMOCLAW_POLICY_MODE=custom", async () => {
    const { applied, deps } = makePolicyDeps({
      env: {
        NEMOCLAW_POLICY_MODE: "custom",
        NEMOCLAW_POLICY_PRESETS: "docker,telegram",
      },
    });
    await setupPolicies("sb", deps);
    assert.deepEqual(applied, ["docker", "telegram"]);
  });

  it("exits when NEMOCLAW_POLICY_MODE=custom but no presets specified", async () => {
    const { applied, deps } = makePolicyDeps({
      env: { NEMOCLAW_POLICY_MODE: "custom" },
    });
    await setupPolicies("sb", deps);
    assert.ok(applied.includes("exit:1"));
  });

  it("uses NEMOCLAW_POLICY_PRESETS to override suggested in suggested mode", async () => {
    const { applied, deps } = makePolicyDeps({
      env: {
        NEMOCLAW_POLICY_MODE: "suggested",
        NEMOCLAW_POLICY_PRESETS: "docker",
      },
    });
    await setupPolicies("sb", deps);
    assert.deepEqual(applied, ["docker"]);
  });

  it("uses NEMOCLAW_POLICY_PRESETS override with default mode", async () => {
    const { applied, deps } = makePolicyDeps({
      env: {
        NEMOCLAW_POLICY_MODE: "default",
        NEMOCLAW_POLICY_PRESETS: "local-inference",
      },
    });
    await setupPolicies("sb", deps);
    assert.deepEqual(applied, ["local-inference"]);
  });

  it("uses NEMOCLAW_POLICY_PRESETS override with auto mode", async () => {
    const { applied, deps } = makePolicyDeps({
      env: {
        NEMOCLAW_POLICY_MODE: "auto",
        NEMOCLAW_POLICY_PRESETS: "slack",
      },
    });
    await setupPolicies("sb", deps);
    assert.deepEqual(applied, ["slack"]);
  });

  it("falls back to suggestions when env presets are empty in suggested mode", async () => {
    const { applied, deps } = makePolicyDeps({
      env: {
        NEMOCLAW_POLICY_MODE: "suggested",
        NEMOCLAW_POLICY_PRESETS: "",
      },
    });
    await setupPolicies("sb", deps);
    assert.deepEqual(applied, ["pypi", "npm"]);
  });

  it("exits for unsupported NEMOCLAW_POLICY_MODE", async () => {
    const { applied, deps } = makePolicyDeps({
      env: { NEMOCLAW_POLICY_MODE: "invalid" },
    });
    await setupPolicies("sb", deps);
    assert.ok(applied.includes("exit:1"));
  });

  it("exits when unknown presets are requested", async () => {
    const { applied, deps } = makePolicyDeps({
      env: {
        NEMOCLAW_POLICY_MODE: "custom",
        NEMOCLAW_POLICY_PRESETS: "nonexistent",
      },
    });
    await setupPolicies("sb", deps);
    assert.ok(applied.includes("exit:1"));
  });

  it("exits when sandbox is not ready", async () => {
    const { applied, deps } = makePolicyDeps({ sandboxReady: false });
    await setupPolicies("sb", deps);
    assert.ok(applied.includes("exit:1"));
  });

  it("retries on sandbox-not-found error", async () => {
    let attempt = 0;
    const applied = [];
    const { deps } = makePolicyDeps({
      depsOverrides: {
        policies: {
          listPresets: () => PRESETS,
          getAppliedPresets: () => [],
          applyPreset: (sb, name) => {
            attempt++;
            if (attempt === 1) throw new Error("sandbox not found");
            applied.push(name);
          },
        },
      },
    });
    await setupPolicies("sb", deps);
    assert.ok(applied.includes("pypi"));
  });

  it("rethrows non-sandbox-not-found errors", async () => {
    const { deps } = makePolicyDeps({
      depsOverrides: {
        policies: {
          listPresets: () => PRESETS,
          getAppliedPresets: () => [],
          applyPreset: () => { throw new Error("network timeout"); },
        },
      },
    });
    await assert.rejects(
      () => setupPolicies("sb", deps),
      { message: "network timeout" }
    );
  });

  it("rethrows sandbox-not-found after 3 attempts", async () => {
    const { deps } = makePolicyDeps({
      depsOverrides: {
        policies: {
          listPresets: () => PRESETS,
          getAppliedPresets: () => [],
          applyPreset: () => { throw new Error("sandbox not found"); },
        },
      },
    });
    await assert.rejects(
      () => setupPolicies("sb", deps),
      { message: "sandbox not found" }
    );
  });

  // ── Interactive mode ─────────────────────────────────────────

  it("applies suggested presets on Enter (default answer)", async () => {
    const { applied, deps } = makePolicyDeps({
      nonInteractive: false,
      promptAnswer: "",
    });
    await setupPolicies("sb", deps);
    assert.deepEqual(applied, ["pypi", "npm"]);
  });

  it("skips presets when user answers 'n'", async () => {
    const { applied, deps } = makePolicyDeps({
      nonInteractive: false,
      promptAnswer: "n",
    });
    await setupPolicies("sb", deps);
    assert.equal(applied.length, 0);
  });

  it("prompts for custom list when user answers 'list'", async () => {
    let promptCount = 0;
    const applied = [];
    const { deps } = makePolicyDeps({
      nonInteractive: false,
      depsOverrides: {
        prompt: async () => {
          promptCount++;
          if (promptCount === 1) return "list";
          return "docker, telegram";
        },
        policies: {
          listPresets: () => PRESETS,
          getAppliedPresets: () => [],
          applyPreset: (sb, name) => applied.push(name),
        },
      },
    });
    await setupPolicies("sb", deps);
    assert.deepEqual(applied, ["docker", "telegram"]);
  });

  it("shows applied marker for already-applied presets", async () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      const { deps } = makePolicyDeps({
        nonInteractive: false,
        promptAnswer: "n",
        appliedPresets: ["pypi"],
      });
      await setupPolicies("sb", deps);
    } finally {
      console.log = origLog;
    }
    assert.ok(logs.some((l) => l.includes("●") && l.includes("pypi")));
    assert.ok(logs.some((l) => l.includes("○") && l.includes("npm")));
  });
});
