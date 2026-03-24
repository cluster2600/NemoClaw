// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { setInferenceRoute } = require("../bin/lib/onboard");

describe("setInferenceRoute (#714)", () => {
  it("returns true and does not retry when the command succeeds on first attempt", () => {
    let callCount = 0;
    const mockRun = (cmd, opts) => {
      callCount++;
      assert.match(cmd, /openshell inference set/);
      assert.match(cmd, /--provider 'nvidia-nim'/);
      assert.match(cmd, /--model 'moonshotai\/kimi-k2.5'/);
      assert.ok(opts.ignoreError);
      return { status: 0 };
    };

    const result = setInferenceRoute("nvidia-nim", "moonshotai/kimi-k2.5", {
      run: mockRun,
      sleep: () => {},
    });
    assert.equal(result, true);
    assert.equal(callCount, 1);
  });

  it("retries once and succeeds on second attempt", () => {
    let callCount = 0;
    let sleptCount = 0;
    const mockRun = () => {
      callCount++;
      return { status: callCount === 1 ? 1 : 0 };
    };

    const result = setInferenceRoute("nvidia-nim", "moonshotai/kimi-k2.5", {
      run: mockRun,
      sleep: () => { sleptCount++; },
    });
    assert.equal(result, true);
    assert.equal(callCount, 2);
    assert.equal(sleptCount, 1);
  });

  it("returns false and warns after all retries are exhausted", () => {
    let callCount = 0;
    const warnings = [];
    const origError = console.error;
    console.error = (msg) => { if (msg) warnings.push(msg); };
    try {
      const result = setInferenceRoute("ollama-local", "llama3:8b", {
        maxRetries: 2,
        run: () => { callCount++; return { status: 1 }; },
        sleep: () => {},
      });
      assert.equal(result, false);
      // 1 initial + 2 retries = 3 attempts
      assert.equal(callCount, 3);
      // Warning should mention the model and provider
      const allWarnings = warnings.join("\n");
      assert.match(allWarnings, /llama3:8b/);
      assert.match(allWarnings, /ollama-local/);
      assert.match(allWarnings, /openshell inference set/);
    } finally {
      console.error = origError;
    }
  });

  it("does not retry when maxRetries is 0", () => {
    let callCount = 0;
    const origError = console.error;
    console.error = () => {};
    try {
      const result = setInferenceRoute("vllm-local", "mymodel", {
        maxRetries: 0,
        run: () => { callCount++; return { status: 1 }; },
        sleep: () => { throw new Error("should not sleep"); },
      });
      assert.equal(result, false);
      assert.equal(callCount, 1);
    } finally {
      console.error = origError;
    }
  });

  it("passes --no-verify flag in the command", () => {
    let capturedCmd = "";
    const result = setInferenceRoute("nvidia-nim", "test-model", {
      run: (cmd) => { capturedCmd = cmd; return { status: 0 }; },
      sleep: () => {},
    });
    assert.equal(result, true);
    assert.match(capturedCmd, /--no-verify/);
  });

  it("shell-quotes model names with special characters", () => {
    let capturedCmd = "";
    setInferenceRoute("nvidia-nim", "org/model:tag", {
      run: (cmd) => { capturedCmd = cmd; return { status: 0 }; },
      sleep: () => {},
    });
    // Model should be quoted to prevent shell injection
    assert.match(capturedCmd, /--model 'org\/model:tag'/);
  });

  it("defaults to 1 retry when no opts provided (uses injected run)", () => {
    let callCount = 0;
    const origError = console.error;
    console.error = () => {};
    try {
      const result = setInferenceRoute("nvidia-nim", "test", {
        run: () => { callCount++; return { status: 1 }; },
        sleep: () => {},
      });
      assert.equal(result, false);
      // 1 initial + 1 default retry = 2 attempts
      assert.equal(callCount, 2);
    } finally {
      console.error = origError;
    }
  });

  it("does not sleep after the last failed attempt", () => {
    let sleepCount = 0;
    const origError = console.error;
    console.error = () => {};
    try {
      setInferenceRoute("nvidia-nim", "test", {
        maxRetries: 1,
        run: () => ({ status: 1 }),
        sleep: () => { sleepCount++; },
      });
      // Should sleep between attempt 0 and 1, but not after attempt 1
      assert.equal(sleepCount, 1);
    } finally {
      console.error = origError;
    }
  });

  it("warning includes remediation command for manual fix", () => {
    const warnings = [];
    const origError = console.error;
    console.error = (msg) => { if (msg) warnings.push(msg); };
    try {
      setInferenceRoute("nvidia-nim", "moonshotai/kimi-k2.5", {
        maxRetries: 0,
        run: () => ({ status: 1 }),
        sleep: () => {},
      });
      const allWarnings = warnings.join("\n");
      // Should include the exact manual fix command
      assert.match(allWarnings, /openshell inference set --provider nvidia-nim --model/);
      assert.match(allWarnings, /kimi-k2\.5/);
      // Should warn about fallback to default model
      assert.match(allWarnings, /default model/);
    } finally {
      console.error = origError;
    }
  });
});
