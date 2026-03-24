// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { getCurrentModel, listAvailableModels, setModel } = require("../bin/lib/model");

// ── getCurrentModel ─────────────────────────────────────────────

describe("getCurrentModel", () => {
  it("returns model and provider from registry", () => {
    const deps = {
      registry: {
        getSandbox: () => ({ model: "nvidia/nemotron-3-super-120b-a12b", provider: "nvidia-nim" }),
      },
    };
    const result = getCurrentModel("test-sb", deps);
    assert.equal(result.model, "nvidia/nemotron-3-super-120b-a12b");
    assert.equal(result.provider, "nvidia-nim");
  });

  it("returns nulls when sandbox not found", () => {
    const deps = { registry: { getSandbox: () => null } };
    const result = getCurrentModel("missing", deps);
    assert.equal(result.model, null);
    assert.equal(result.provider, null);
  });

  it("returns nulls when sandbox has no model/provider", () => {
    const deps = { registry: { getSandbox: () => ({}) } };
    const result = getCurrentModel("empty", deps);
    assert.equal(result.model, null);
    assert.equal(result.provider, null);
  });
});

// ── listAvailableModels ─────────────────────────────────────────

describe("listAvailableModels", () => {
  it("returns cloud catalog for nvidia-nim", () => {
    const { models, source } = listAvailableModels("nvidia-nim");
    assert.ok(models.length >= 6);
    assert.ok(models.some((m) => m.id === "nvidia/nemotron-3-super-120b-a12b"));
    assert.ok(source.includes("NVIDIA"));
  });

  it("returns installed models for ollama-local", () => {
    const deps = {
      runCapture: () => "NAME            ID    SIZE    MODIFIED\nllama3:8b    abc   4.7 GB  2 days ago\nphi3:mini    def   2.3 GB  1 week ago",
    };
    const { models, source } = listAvailableModels("ollama-local", deps);
    assert.equal(models.length, 2);
    assert.equal(models[0].id, "llama3:8b");
    assert.equal(models[1].id, "phi3:mini");
    assert.ok(source.includes("Ollama"));
  });

  it("returns default model when ollama list is empty", () => {
    const deps = { runCapture: () => "" };
    const { models } = listAvailableModels("ollama-local", deps);
    assert.equal(models.length, 1);
    assert.ok(models[0].id.includes("nemotron"));
  });

  it("returns default model when ollama list throws", () => {
    const deps = { runCapture: () => { throw new Error("not found"); } };
    const { models } = listAvailableModels("ollama-local", deps);
    assert.equal(models.length, 1);
  });

  it("returns single model for vllm-local", () => {
    const { models, source } = listAvailableModels("vllm-local");
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "vllm-local");
    assert.ok(source.includes("vLLM"));
  });

  it("returns empty for unknown provider", () => {
    const { models, source } = listAvailableModels("unknown-provider");
    assert.equal(models.length, 0);
    assert.ok(source.includes("unknown"));
  });
});

// ── setModel ────────────────────────────────────────────────────

describe("setModel", () => {
  it("sets model via openshell inference set and updates registry", () => {
    let updatedWith = null;
    const deps = {
      registry: {
        getSandbox: () => ({ provider: "nvidia-nim", model: "old-model" }),
        updateSandbox: (name, updates) => { updatedWith = { name, updates }; return true; },
      },
      run: () => ({ status: 0 }),
      sleep: () => {},
    };
    const result = setModel("test-sb", "moonshotai/kimi-k2.5", deps);
    assert.ok(result.success);
    assert.equal(updatedWith.name, "test-sb");
    assert.equal(updatedWith.updates.model, "moonshotai/kimi-k2.5");
  });

  it("fails when sandbox not found", () => {
    const deps = {
      registry: { getSandbox: () => null },
      run: () => ({ status: 0 }),
    };
    const result = setModel("missing", "some-model", deps);
    assert.equal(result.success, false);
    assert.ok(result.error.includes("not found"));
  });

  it("fails when sandbox has no provider", () => {
    const deps = {
      registry: { getSandbox: () => ({ model: "x" }) },
      run: () => ({ status: 0 }),
    };
    const result = setModel("test-sb", "some-model", deps);
    assert.equal(result.success, false);
    assert.ok(result.error.includes("no provider"));
  });

  it("fails when model is empty", () => {
    const deps = {
      registry: { getSandbox: () => ({ provider: "nvidia-nim" }) },
      run: () => ({ status: 0 }),
    };
    const result = setModel("test-sb", "", deps);
    assert.equal(result.success, false);
    assert.ok(result.error.includes("required"));
  });

  it("fails when model is null", () => {
    const deps = {
      registry: { getSandbox: () => ({ provider: "nvidia-nim" }) },
      run: () => ({ status: 0 }),
    };
    const result = setModel("test-sb", null, deps);
    assert.equal(result.success, false);
    assert.ok(result.error.includes("required"));
  });

  it("retries once on failure then succeeds", () => {
    let attempts = 0;
    let slept = false;
    const deps = {
      registry: {
        getSandbox: () => ({ provider: "nvidia-nim" }),
        updateSandbox: () => true,
      },
      run: () => {
        attempts++;
        return { status: attempts === 1 ? 1 : 0 };
      },
      sleep: () => { slept = true; },
    };
    const result = setModel("test-sb", "new-model", deps);
    assert.ok(result.success);
    assert.equal(attempts, 2);
    assert.ok(slept);
  });

  it("returns error with remediation when all retries fail", () => {
    const deps = {
      registry: { getSandbox: () => ({ provider: "ollama-local" }) },
      run: () => ({ status: 1, stdout: "connection refused" }),
      sleep: () => {},
    };
    const result = setModel("test-sb", "llama3:8b", deps);
    assert.equal(result.success, false);
    assert.ok(result.error.includes("openshell inference set"));
    assert.ok(result.error.includes("ollama-local"));
  });

  it("handles run throwing an exception", () => {
    let attempts = 0;
    const deps = {
      registry: { getSandbox: () => ({ provider: "nvidia-nim" }) },
      run: () => { attempts++; throw new Error("exec failed"); },
      sleep: () => {},
    };
    const result = setModel("test-sb", "new-model", deps);
    assert.equal(result.success, false);
    assert.equal(attempts, 2);
    assert.ok(result.error.includes("exec failed"));
  });

  it("constructs correct openshell command with provider from registry", () => {
    let capturedCmd = null;
    const deps = {
      registry: {
        getSandbox: () => ({ provider: "ollama-local" }),
        updateSandbox: () => true,
      },
      run: (cmd) => { capturedCmd = cmd; return { status: 0 }; },
      sleep: () => {},
    };
    setModel("test-sb", "llama3:8b", deps);
    assert.ok(capturedCmd.includes("--provider 'ollama-local'"));
    assert.ok(capturedCmd.includes("--model 'llama3:8b'"));
  });
});
