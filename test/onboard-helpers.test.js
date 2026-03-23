// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  getNonInteractiveModel,
  getNonInteractiveProvider,
  isSafeModelId,
  parsePolicyPresetEnv,
  printDashboard,
} = require("../bin/lib/onboard");

// ── parsePolicyPresetEnv ──────────────────────────────────────────

describe("parsePolicyPresetEnv", () => {
  it("returns empty array for null/undefined", () => {
    assert.deepEqual(parsePolicyPresetEnv(null), []);
    assert.deepEqual(parsePolicyPresetEnv(undefined), []);
  });

  it("returns empty array for empty string", () => {
    assert.deepEqual(parsePolicyPresetEnv(""), []);
  });

  it("returns empty array for whitespace-only string", () => {
    assert.deepEqual(parsePolicyPresetEnv("  ,  ,  "), []);
  });

  it("splits comma-separated presets", () => {
    assert.deepEqual(parsePolicyPresetEnv("pypi,npm"), ["pypi", "npm"]);
  });

  it("trims whitespace around preset names", () => {
    assert.deepEqual(parsePolicyPresetEnv("  pypi , npm , docker  "), ["pypi", "npm", "docker"]);
  });

  it("filters out empty entries from trailing comma", () => {
    assert.deepEqual(parsePolicyPresetEnv("pypi,npm,"), ["pypi", "npm"]);
  });

  it("handles single preset", () => {
    assert.deepEqual(parsePolicyPresetEnv("local-inference"), ["local-inference"]);
  });
});

// ── isSafeModelId ─────────────────────────────────────────────────

describe("isSafeModelId", () => {
  it("accepts simple model names", () => {
    assert.equal(isSafeModelId("nemotron-3-nano"), true);
  });

  it("accepts model names with colons (tags)", () => {
    assert.equal(isSafeModelId("nemotron-3-nano:30b"), true);
  });

  it("accepts model names with slashes (namespaced)", () => {
    assert.equal(isSafeModelId("nvidia/nemotron-3-super-120b-a12b"), true);
  });

  it("accepts model names with dots and underscores", () => {
    assert.equal(isSafeModelId("model_v2.1"), true);
  });

  it("rejects model names with spaces", () => {
    assert.equal(isSafeModelId("my model"), false);
  });

  it("rejects model names with shell metacharacters", () => {
    assert.equal(isSafeModelId("model;rm -rf /"), false);
    assert.equal(isSafeModelId("model$(whoami)"), false);
    assert.equal(isSafeModelId("model`id`"), false);
  });

  it("rejects empty string", () => {
    assert.equal(isSafeModelId(""), false);
  });

  it("rejects model names with newlines", () => {
    assert.equal(isSafeModelId("model\nname"), false);
  });
});

// ── getNonInteractiveProvider ─────────────────────────────────────

describe("getNonInteractiveProvider", () => {
  let savedProvider;

  beforeEach(() => {
    savedProvider = process.env.NEMOCLAW_PROVIDER;
  });

  afterEach(() => {
    if (savedProvider === undefined) {
      delete process.env.NEMOCLAW_PROVIDER;
    } else {
      process.env.NEMOCLAW_PROVIDER = savedProvider;
    }
  });

  it("returns null when NEMOCLAW_PROVIDER is unset", () => {
    delete process.env.NEMOCLAW_PROVIDER;
    assert.equal(getNonInteractiveProvider(), null);
  });

  it("returns null when NEMOCLAW_PROVIDER is empty", () => {
    process.env.NEMOCLAW_PROVIDER = "";
    assert.equal(getNonInteractiveProvider(), null);
  });

  it("returns null when NEMOCLAW_PROVIDER is whitespace", () => {
    process.env.NEMOCLAW_PROVIDER = "   ";
    assert.equal(getNonInteractiveProvider(), null);
  });

  it("returns 'cloud' for NEMOCLAW_PROVIDER=cloud", () => {
    process.env.NEMOCLAW_PROVIDER = "cloud";
    assert.equal(getNonInteractiveProvider(), "cloud");
  });

  it("returns 'ollama' for NEMOCLAW_PROVIDER=ollama", () => {
    process.env.NEMOCLAW_PROVIDER = "ollama";
    assert.equal(getNonInteractiveProvider(), "ollama");
  });

  it("returns 'vllm' for NEMOCLAW_PROVIDER=vllm", () => {
    process.env.NEMOCLAW_PROVIDER = "vllm";
    assert.equal(getNonInteractiveProvider(), "vllm");
  });

  it("returns 'nim' for NEMOCLAW_PROVIDER=nim", () => {
    process.env.NEMOCLAW_PROVIDER = "nim";
    assert.equal(getNonInteractiveProvider(), "nim");
  });

  it("normalizes to lowercase", () => {
    process.env.NEMOCLAW_PROVIDER = "CLOUD";
    assert.equal(getNonInteractiveProvider(), "cloud");
  });

  it("exits with code 1 for unsupported provider", () => {
    process.env.NEMOCLAW_PROVIDER = "invalid-provider";
    // Mock process.exit to prevent actual exit
    const originalExit = process.exit;
    let exitCode = null;
    process.exit = (code) => {
      exitCode = code;
      throw new Error("process.exit called");
    };
    try {
      assert.throws(
        () => getNonInteractiveProvider(),
        { message: "process.exit called" },
      );
      assert.equal(exitCode, 1);
    } finally {
      process.exit = originalExit;
    }
  });
});

// ── getNonInteractiveModel ────────────────────────────────────────

describe("getNonInteractiveModel", () => {
  let savedModel;

  beforeEach(() => {
    savedModel = process.env.NEMOCLAW_MODEL;
  });

  afterEach(() => {
    if (savedModel === undefined) {
      delete process.env.NEMOCLAW_MODEL;
    } else {
      process.env.NEMOCLAW_MODEL = savedModel;
    }
  });

  it("returns null when NEMOCLAW_MODEL is unset", () => {
    delete process.env.NEMOCLAW_MODEL;
    assert.equal(getNonInteractiveModel("cloud"), null);
  });

  it("returns null when NEMOCLAW_MODEL is empty", () => {
    process.env.NEMOCLAW_MODEL = "";
    assert.equal(getNonInteractiveModel("cloud"), null);
  });

  it("returns model when valid", () => {
    process.env.NEMOCLAW_MODEL = "nvidia/nemotron-3-super-120b-a12b";
    assert.equal(getNonInteractiveModel("cloud"), "nvidia/nemotron-3-super-120b-a12b");
  });

  it("returns model with tag", () => {
    process.env.NEMOCLAW_MODEL = "nemotron-3-nano:30b";
    assert.equal(getNonInteractiveModel("ollama"), "nemotron-3-nano:30b");
  });

  it("exits with code 1 for unsafe model ID", () => {
    process.env.NEMOCLAW_MODEL = "model;rm -rf /";
    const originalExit = process.exit;
    let exitCode = null;
    process.exit = (code) => {
      exitCode = code;
      throw new Error("process.exit called");
    };
    try {
      assert.throws(
        () => getNonInteractiveModel("cloud"),
        { message: "process.exit called" },
      );
      assert.equal(exitCode, 1);
    } finally {
      process.exit = originalExit;
    }
  });
});

// ── printDashboard ────────────────────────────────────────────────

describe("printDashboard", () => {
  it("outputs sandbox name, model, and provider labels", () => {
    const logs = [];
    const origLog = console.log;
    console.log = (msg) => logs.push(msg);
    try {
      printDashboard("test-sandbox", "nemotron-3-nano:30b", "nvidia-nim");
    } finally {
      console.log = origLog;
    }
    const output = logs.join("\n");
    assert.ok(output.includes("test-sandbox"));
    assert.ok(output.includes("nemotron-3-nano:30b"));
    assert.ok(output.includes("NVIDIA Endpoint API"));
  });

  it("maps ollama-local provider to friendly label", () => {
    const logs = [];
    const origLog = console.log;
    console.log = (msg) => logs.push(msg);
    try {
      printDashboard("my-assistant", "nemotron-3-nano:30b", "ollama-local");
    } finally {
      console.log = origLog;
    }
    const output = logs.join("\n");
    assert.ok(output.includes("Local Ollama"));
  });

  it("maps vllm-local provider to friendly label", () => {
    const logs = [];
    const origLog = console.log;
    console.log = (msg) => logs.push(msg);
    try {
      printDashboard("my-assistant", "vllm-local", "vllm-local");
    } finally {
      console.log = origLog;
    }
    const output = logs.join("\n");
    assert.ok(output.includes("Local vLLM"));
  });

  it("shows raw provider string for unknown providers", () => {
    const logs = [];
    const origLog = console.log;
    console.log = (msg) => logs.push(msg);
    try {
      printDashboard("my-assistant", "some-model", "custom-provider");
    } finally {
      console.log = origLog;
    }
    const output = logs.join("\n");
    assert.ok(output.includes("custom-provider"));
  });

  it("includes connect and status commands", () => {
    const logs = [];
    const origLog = console.log;
    console.log = (msg) => logs.push(msg);
    try {
      printDashboard("dev-box", "model", "nvidia-nim");
    } finally {
      console.log = origLog;
    }
    const output = logs.join("\n");
    assert.ok(output.includes("nemoclaw dev-box connect"));
    assert.ok(output.includes("nemoclaw dev-box status"));
    assert.ok(output.includes("nemoclaw dev-box logs"));
  });
});
