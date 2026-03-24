// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Tests for selectInferenceProvider(), startGateway(), promptCloudModel(),
// and promptOllamaModel() — all exercised via dependency injection.

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  selectInferenceProvider,
  startGateway,
  promptCloudModel,
  promptOllamaModel,
} = require("../bin/lib/onboard");

// ── Helpers ──────────────────────────────────────────────────────

function noop() {}
function noopStep() {}

/** Build a deps object for selectInferenceProvider with sensible defaults. */
function makeProviderDeps(overrides = {}) {
  return {
    step: noop,
    run: noop,
    runCapture: () => "",
    sleep: noop,
    prompt: async () => "",
    ensureApiKey: async () => {},
    getCredential: () => "test-key",
    isNonInteractive: () => false,
    getNonInteractiveProvider: () => null,
    getNonInteractiveModel: () => null,
    hasInstalledOllamaModels: () => true,
    getOllamaBindAddressHint: () => null,
    validateLocalProvider: () => ({ ok: true }),
    getDefaultOllamaModel: () => "nemotron-3-nano:30b",
    getOllamaModelOptions: () => ["nemotron-3-nano:30b", "llama3.1:8b"],
    nim: { listModels: () => [] },
    platform: "linux",
    experimental: false,
    exit: noop,
    ...overrides,
  };
}

/** Build a deps object for startGateway with sensible defaults. */
function makeGatewayDeps(overrides = {}) {
  return {
    step: noop,
    run: noop,
    runCapture: () => "Connected",
    sleep: noop,
    getInstalledOpenshellVersion: () => "0.5.0",
    getContainerRuntime: () => "docker",
    shouldPatchCoredns: () => false,
    exit: noop,
    ...overrides,
  };
}

// ── selectInferenceProvider ──────────────────────────────────────

describe("selectInferenceProvider()", () => {
  // ── Cloud provider (default) ────────────────────────────────

  it("defaults to nvidia-nim provider with cloud model when no local options", async () => {
    const deps = makeProviderDeps({
      prompt: async () => "",  // press Enter for default
    });
    const result = await selectInferenceProvider(null, deps);
    assert.equal(result.provider, "nvidia-nim");
    assert.ok(result.model);
  });

  it("calls ensureApiKey for interactive cloud provider", async () => {
    let ensureCalled = false;
    const deps = makeProviderDeps({
      ensureApiKey: async () => { ensureCalled = true; },
      prompt: async () => "",
    });
    await selectInferenceProvider(null, deps);
    assert.ok(ensureCalled);
  });

  it("uses promptCloudModel for interactive cloud selection", async () => {
    let promptCalls = [];
    const deps = makeProviderDeps({
      prompt: async (msg) => { promptCalls.push(msg); return ""; },
    });
    await selectInferenceProvider(null, deps);
    // Should have prompted for provider choice and model choice
    assert.ok(promptCalls.length >= 1);
  });

  // ── Non-interactive cloud ───────────────────────────────────

  it("non-interactive cloud requires NVIDIA_API_KEY", async () => {
    let exitCode = null;
    const deps = makeProviderDeps({
      isNonInteractive: () => true,
      getNonInteractiveProvider: () => "cloud",
      getCredential: () => null,
      exit: (code) => { exitCode = code; },
    });
    await selectInferenceProvider(null, deps);
    assert.equal(exitCode, 1);
  });

  it("non-interactive cloud succeeds with API key", async () => {
    const deps = makeProviderDeps({
      isNonInteractive: () => true,
      getNonInteractiveProvider: () => "cloud",
      getNonInteractiveModel: () => "meta/llama-3.1-405b-instruct",
      getCredential: () => "nvapi-test",
    });
    const result = await selectInferenceProvider(null, deps);
    assert.equal(result.provider, "nvidia-nim");
    assert.equal(result.model, "meta/llama-3.1-405b-instruct");
  });

  // ── Ollama provider ─────────────────────────────────────────

  it("selects ollama when user chooses ollama option", async () => {
    let promptIdx = 0;
    const deps = makeProviderDeps({
      runCapture: (cmd) => {
        if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
        if (cmd.includes("localhost:11434")) return '{"models":[]}';
        return "";
      },
      prompt: async () => {
        promptIdx++;
        if (promptIdx === 1) return "2"; // select ollama (option 2 after cloud)
        return "1"; // select first model
      },
      getOllamaModelOptions: () => ["nemotron-3-nano:30b"],
      getDefaultOllamaModel: () => "nemotron-3-nano:30b",
    });
    const result = await selectInferenceProvider(null, deps);
    assert.equal(result.provider, "ollama-local");
    assert.equal(result.model, "nemotron-3-nano:30b");
  });

  it("starts ollama daemon when ollama not running", async () => {
    let runCmds = [];
    let sleepCalls = 0;
    const deps = makeProviderDeps({
      runCapture: (cmd) => {
        if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
        // ollama installed but not running
        if (cmd.includes("localhost:11434")) return "";
        return "";
      },
      run: (cmd) => { runCmds.push(cmd); },
      sleep: () => { sleepCalls++; },
      prompt: async () => "2",  // select ollama
      getOllamaModelOptions: () => ["llama3.1:8b"],
      getDefaultOllamaModel: () => "llama3.1:8b",
    });
    const result = await selectInferenceProvider(null, deps);
    assert.equal(result.provider, "ollama-local");
    assert.ok(runCmds.some(c => c.includes("ollama serve")));
    assert.ok(sleepCalls >= 1);
  });

  it("exits when ollama has no models installed", async () => {
    let exitCode = null;
    const deps = makeProviderDeps({
      runCapture: (cmd) => {
        if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
        if (cmd.includes("localhost:11434")) return '{"models":[]}';
        return "";
      },
      prompt: async () => "2",  // select ollama
      hasInstalledOllamaModels: () => false,
      exit: (code) => { exitCode = code; },
    });
    await selectInferenceProvider(null, deps);
    assert.equal(exitCode, 1);
  });

  it("exits when ollama bind address validation fails on Linux", async () => {
    let exitCode = null;
    const deps = makeProviderDeps({
      runCapture: (cmd) => {
        if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
        if (cmd.includes("localhost:11434")) return '{"models":[]}';
        return "";
      },
      prompt: async () => "2",
      hasInstalledOllamaModels: () => true,
      getOllamaBindAddressHint: () => "Set OLLAMA_HOST=0.0.0.0",
      validateLocalProvider: () => ({ ok: false, message: "Cannot reach Ollama" }),
      exit: (code) => { exitCode = code; },
    });
    await selectInferenceProvider(null, deps);
    assert.equal(exitCode, 1);
  });

  it("non-interactive ollama uses default model", async () => {
    const deps = makeProviderDeps({
      isNonInteractive: () => true,
      getNonInteractiveProvider: () => "ollama",
      runCapture: (cmd) => {
        if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
        if (cmd.includes("localhost:11434")) return '{"models":[]}';
        return "";
      },
      getDefaultOllamaModel: () => "custom-model:7b",
    });
    const result = await selectInferenceProvider(null, deps);
    assert.equal(result.provider, "ollama-local");
    assert.equal(result.model, "custom-model:7b");
  });

  // ── vLLM provider ──────────────────────────────────────────

  it("selects vLLM when experimental and user chooses vllm", async () => {
    let promptIdx = 0;
    const deps = makeProviderDeps({
      experimental: true,
      runCapture: (cmd) => {
        if (cmd.includes("command -v ollama")) return "";
        if (cmd.includes("localhost:11434")) return "";
        if (cmd.includes("localhost:8000")) return '{"data":[]}';
        return "";
      },
      prompt: async () => {
        promptIdx++;
        if (promptIdx === 1) return "2"; // select vllm (cloud=1, vllm=2)
        return "";
      },
    });
    const result = await selectInferenceProvider(null, deps);
    assert.equal(result.provider, "vllm-local");
    assert.equal(result.model, "vllm-local");
  });

  // ── NIM provider (experimental) ────────────────────────────

  it("selects NIM model when experimental + nimCapable GPU", async () => {
    let promptIdx = 0;
    const gpu = { nimCapable: true, totalMemoryMB: 48000 };
    const deps = makeProviderDeps({
      experimental: true,
      nim: {
        listModels: () => [
          { name: "nemotron-super", minGpuMemoryMB: 40000 },
          { name: "nemotron-ultra", minGpuMemoryMB: 80000 },
        ],
      },
      runCapture: () => "",
      prompt: async () => {
        promptIdx++;
        if (promptIdx === 1) return "1"; // select nim (first option)
        if (promptIdx === 2) return "1"; // select first model
        return "";
      },
    });
    const result = await selectInferenceProvider(gpu, deps);
    assert.equal(result.provider, "vllm-local");
    assert.equal(result.model, "nemotron-super");
  });

  it("falls back to cloud when no NIM models fit GPU VRAM", async () => {
    const gpu = { nimCapable: true, totalMemoryMB: 8000 };
    let promptIdx = 0;
    const deps = makeProviderDeps({
      experimental: true,
      nim: {
        listModels: () => [
          { name: "nemotron-super", minGpuMemoryMB: 40000 },
        ],
      },
      runCapture: () => "",
      prompt: async () => {
        promptIdx++;
        if (promptIdx === 1) return "1"; // select nim
        return "";
      },
    });
    const result = await selectInferenceProvider(gpu, deps);
    // Falls back to cloud because no models fit
    assert.equal(result.provider, "nvidia-nim");
  });

  it("non-interactive NIM exits on unsupported model", async () => {
    let exitCode = null;
    const gpu = { nimCapable: true, totalMemoryMB: 48000 };
    const deps = makeProviderDeps({
      experimental: true,
      isNonInteractive: () => true,
      getNonInteractiveProvider: () => "nim",
      getNonInteractiveModel: () => "nonexistent-model",
      nim: {
        listModels: () => [
          { name: "nemotron-super", minGpuMemoryMB: 40000 },
        ],
      },
      runCapture: () => "",
      getCredential: () => "key",
      exit: (code) => { exitCode = code; },
    });
    await selectInferenceProvider(gpu, deps);
    assert.equal(exitCode, 1);
  });

  it("non-interactive NIM selects first fitting model by default", async () => {
    const gpu = { nimCapable: true, totalMemoryMB: 48000 };
    const deps = makeProviderDeps({
      experimental: true,
      isNonInteractive: () => true,
      getNonInteractiveProvider: () => "nim",
      getNonInteractiveModel: () => null,
      nim: {
        listModels: () => [
          { name: "nemotron-super", minGpuMemoryMB: 40000 },
        ],
      },
      runCapture: () => "",
    });
    const result = await selectInferenceProvider(gpu, deps);
    assert.equal(result.provider, "vllm-local");
    assert.equal(result.model, "nemotron-super");
  });

  // ── macOS install-ollama option ─────────────────────────────

  it("offers install-ollama on darwin without ollama", async () => {
    let runCmds = [];
    const deps = makeProviderDeps({
      platform: "darwin",
      runCapture: () => "", // no ollama, no vllm
      run: (cmd) => { runCmds.push(cmd); },
      prompt: async () => "2", // select install-ollama (cloud=1, install=2)
      hasInstalledOllamaModels: () => true,
      getOllamaModelOptions: () => ["llama3.1:8b"],
      getDefaultOllamaModel: () => "llama3.1:8b",
    });
    const result = await selectInferenceProvider(null, deps);
    assert.equal(result.provider, "ollama-local");
    assert.ok(runCmds.some(c => c.includes("brew install ollama")));
  });

  it("install-ollama exits when no models after install", async () => {
    let exitCode = null;
    const deps = makeProviderDeps({
      platform: "darwin",
      runCapture: () => "",
      run: noop,
      prompt: async () => "2",
      hasInstalledOllamaModels: () => false,
      exit: (code) => { exitCode = code; },
    });
    await selectInferenceProvider(null, deps);
    assert.equal(exitCode, 1);
  });

  // ── Non-interactive unavailable provider ────────────────────

  it("non-interactive exits when requested provider unavailable but options > 1", async () => {
    let exitCode = null;
    const deps = makeProviderDeps({
      isNonInteractive: () => true,
      getNonInteractiveProvider: () => "nim", // nim not available without experimental
      // Make ollama detectable so we have > 1 options
      runCapture: (cmd) => {
        if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
        if (cmd.includes("localhost:11434")) return '{"models":[]}';
        return "";
      },
      exit: (code) => { exitCode = code; },
    });
    await selectInferenceProvider(null, deps);
    assert.equal(exitCode, 1);
  });

  it("non-interactive falls through to cloud when only cloud available", async () => {
    const deps = makeProviderDeps({
      isNonInteractive: () => true,
      getNonInteractiveProvider: () => "nim",
      getNonInteractiveModel: () => null,
      runCapture: () => "",
      getCredential: () => "nvapi-key",
    });
    // Only cloud option → selection block skipped → falls through to cloud
    const result = await selectInferenceProvider(null, deps);
    assert.equal(result.provider, "nvidia-nim");
  });

  // ── Detected local inference suggestions ────────────────────

  it("shows suggestion message when ollama is running", async () => {
    let logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      const deps = makeProviderDeps({
        runCapture: (cmd) => {
          if (cmd.includes("command -v ollama")) return "/usr/bin/ollama";
          if (cmd.includes("localhost:11434")) return '{"models":[]}';
          return "";
        },
        prompt: async () => "",  // accept default (cloud)
      });
      await selectInferenceProvider(null, deps);
      assert.ok(logs.some(l => l.includes("Detected local inference option")));
    } finally {
      console.log = origLog;
    }
  });

  // ── Only cloud option (no options list shown) ───────────────

  it("skips option list when only cloud is available", async () => {
    let promptCalls = [];
    const deps = makeProviderDeps({
      runCapture: () => "",  // no ollama, no vllm
      prompt: async (msg) => { promptCalls.push(msg); return ""; },
    });
    const result = await selectInferenceProvider(null, deps);
    assert.equal(result.provider, "nvidia-nim");
    // Only cloud available → no "Choose" prompt for provider, just model prompt
    assert.ok(!promptCalls.some(p => p.includes("Choose [")));
  });
});

// ── startGateway ─────────────────────────────────────────────────

describe("startGateway()", () => {
  it("destroys old gateway before starting new one", async () => {
    let runCmds = [];
    const deps = makeGatewayDeps({
      run: (cmd) => { runCmds.push(cmd); },
    });
    await startGateway(null, deps);
    assert.ok(runCmds[0].includes("gateway destroy"));
    assert.ok(runCmds[1].includes("gateway start"));
  });

  it("pins gateway image when openshell version is available", async () => {
    let startEnv = null;
    const deps = makeGatewayDeps({
      getInstalledOpenshellVersion: () => "0.5.2",
      run: (cmd, opts) => {
        if (cmd.includes("gateway start")) startEnv = opts.env;
      },
    });
    await startGateway(null, deps);
    assert.ok(startEnv);
    assert.equal(startEnv.OPENSHELL_CLUSTER_IMAGE, "ghcr.io/nvidia/openshell/cluster:0.5.2");
    assert.equal(startEnv.IMAGE_TAG, "0.5.2");
  });

  it("does not pin image when openshell version is null", async () => {
    let startEnv = null;
    const deps = makeGatewayDeps({
      getInstalledOpenshellVersion: () => null,
      run: (cmd, opts) => {
        if (cmd.includes("gateway start")) startEnv = opts.env;
      },
    });
    await startGateway(null, deps);
    assert.ok(startEnv);
    assert.equal(Object.keys(startEnv).length, 0);
  });

  it("health check succeeds on first attempt", async () => {
    let sleepCalls = 0;
    const deps = makeGatewayDeps({
      runCapture: () => "Connected",
      sleep: () => { sleepCalls++; },
    });
    await startGateway(null, deps);
    // No sleep between health checks since first attempt succeeds
    // Only the final DNS propagation sleep
    assert.equal(sleepCalls, 1); // only the post-coredns sleep(5)
  });

  it("retries health check and succeeds on 3rd attempt", async () => {
    let healthChecks = 0;
    let sleepCalls = 0;
    const deps = makeGatewayDeps({
      runCapture: () => {
        healthChecks++;
        return healthChecks >= 3 ? "Connected" : "Connecting...";
      },
      sleep: () => { sleepCalls++; },
    });
    await startGateway(null, deps);
    assert.equal(healthChecks, 3);
    assert.equal(sleepCalls, 3); // 2 retries + 1 DNS propagation
  });

  it("exits when gateway never becomes healthy", async () => {
    let exitCode = null;
    const deps = makeGatewayDeps({
      runCapture: () => "Connecting...",
      exit: (code) => { exitCode = code; },
    });
    await startGateway(null, deps);
    assert.equal(exitCode, 1);
  });

  it("patches CoreDNS when shouldPatchCoredns returns true", async () => {
    let runCmds = [];
    const deps = makeGatewayDeps({
      run: (cmd) => { runCmds.push(cmd); },
      getContainerRuntime: () => "colima",
      shouldPatchCoredns: () => true,
    });
    await startGateway(null, deps);
    assert.ok(runCmds.some(c => c.includes("fix-coredns.sh")));
  });

  it("skips CoreDNS patch when shouldPatchCoredns returns false", async () => {
    let runCmds = [];
    const deps = makeGatewayDeps({
      run: (cmd) => { runCmds.push(cmd); },
      shouldPatchCoredns: () => false,
    });
    await startGateway(null, deps);
    assert.ok(!runCmds.some(c => c.includes("fix-coredns.sh")));
  });

  it("does not pass --gpu flag to gateway start", async () => {
    let startCmd = "";
    const deps = makeGatewayDeps({
      run: (cmd) => {
        if (cmd.includes("gateway start")) startCmd = cmd;
      },
    });
    await startGateway({ type: "nvidia", totalMemoryMB: 48000 }, deps);
    assert.ok(!startCmd.includes("--gpu"));
  });
});

// ── promptCloudModel ─────────────────────────────────────────────

describe("promptCloudModel()", () => {
  it("returns first cloud model on empty input", async () => {
    const result = await promptCloudModel(async () => "");
    assert.ok(result); // should be a valid model ID
    assert.ok(typeof result === "string");
  });

  it("returns selected model by index", async () => {
    const result = await promptCloudModel(async () => "2");
    assert.ok(result);
    assert.ok(typeof result === "string");
  });

  it("falls back to first model on invalid index", async () => {
    const first = await promptCloudModel(async () => "");
    const invalid = await promptCloudModel(async () => "999");
    assert.equal(invalid, first);
  });
});

// ── promptOllamaModel ───────────────────────────────────────────

describe("promptOllamaModel()", () => {
  const fakeModels = ["nemotron-3-nano:30b", "llama3.1:8b", "qwen3:32b"];

  it("returns default model on empty input", async () => {
    const result = await promptOllamaModel(
      noop,
      () => fakeModels,
      () => "nemotron-3-nano:30b",
      async () => ""
    );
    assert.equal(result, "nemotron-3-nano:30b");
  });

  it("returns selected model by index", async () => {
    const result = await promptOllamaModel(
      noop,
      () => fakeModels,
      () => "nemotron-3-nano:30b",
      async () => "2"
    );
    assert.equal(result, "llama3.1:8b");
  });

  it("falls back to default on invalid index", async () => {
    const result = await promptOllamaModel(
      noop,
      () => fakeModels,
      () => "nemotron-3-nano:30b",
      async () => "99"
    );
    assert.equal(result, "nemotron-3-nano:30b");
  });

  it("returns default model when list is empty", async () => {
    const result = await promptOllamaModel(
      noop,
      () => [],
      () => "fallback-model",
      async () => ""
    );
    assert.equal(result, "fallback-model");
  });
});
