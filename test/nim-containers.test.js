// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  pullNimImage,
  startNimContainer,
  waitForNimHealth,
  stopNimContainer,
  nimStatus,
  listModels,
  getImageForModel,
} = require("../bin/lib/nim");

// Get a known model name from the catalog for testing
const knownModels = listModels();
const knownModel = knownModels.length > 0 ? knownModels[0].name : null;
const knownImage = knownModel ? getImageForModel(knownModel) : null;

// ── pullNimImage ────────────────────────────────────────────────

describe("pullNimImage()", () => {
  it("pulls image for known model", () => {
    if (!knownModel) return; // skip if no models defined
    let pulledCmd = null;
    const image = pullNimImage(knownModel, {
      run: (cmd) => { pulledCmd = cmd; },
      exit: () => { throw new Error("should not exit"); },
    });
    assert.equal(image, knownImage);
    assert.ok(pulledCmd.includes("docker pull"));
    assert.ok(pulledCmd.includes(knownImage));
  });

  it("calls exit for unknown model", () => {
    let exited = false;
    const image = pullNimImage("nonexistent-model-xyz", {
      run: () => { throw new Error("should not run"); },
      exit: () => { exited = true; },
    });
    assert.equal(exited, true);
    assert.equal(image, null);
  });
});

// ── startNimContainer ───────────────────────────────────────────

describe("startNimContainer()", () => {
  it("starts container for known model", () => {
    if (!knownModel) return;
    const commands = [];
    const name = startNimContainer("test-sb", knownModel, 8000, {
      run: (cmd, opts) => { commands.push({ cmd, opts }); },
      exit: () => { throw new Error("should not exit"); },
    });
    assert.equal(name, "nemoclaw-nim-test-sb");
    // First command: rm -f (cleanup), second: docker run
    assert.equal(commands.length, 2);
    assert.ok(commands[0].cmd.includes("docker rm -f"));
    assert.ok(commands[1].cmd.includes("docker run -d --gpus all"));
    assert.ok(commands[1].cmd.includes("-p 8000:8000"));
  });

  it("uses custom port", () => {
    if (!knownModel) return;
    const commands = [];
    startNimContainer("sb2", knownModel, 9000, {
      run: (cmd) => { commands.push(cmd); },
      exit: () => {},
    });
    assert.ok(commands[1].includes("-p 9000:8000"));
  });

  it("calls exit for unknown model", () => {
    let exited = false;
    const name = startNimContainer("sb", "bad-model", 8000, {
      run: () => { throw new Error("should not run"); },
      exit: () => { exited = true; },
    });
    assert.equal(exited, true);
    assert.equal(name, null);
  });
});

// ── waitForNimHealth ────────────────────────────────────────────

describe("waitForNimHealth()", () => {
  it("returns true when health check succeeds immediately", () => {
    const result = waitForNimHealth(8000, 10, {
      runCapture: () => '{"models":[]}',
      sleep: () => {},
      now: (() => { let t = 0; return () => t++; })(),
    });
    assert.equal(result, true);
  });

  it("returns true after retries", () => {
    let attempts = 0;
    const result = waitForNimHealth(8000, 10, {
      runCapture: () => {
        attempts++;
        if (attempts < 3) return "";
        return '{"models":[]}';
      },
      sleep: () => {},
      now: (() => { let t = 0; return () => t += 100; })(),
    });
    assert.equal(result, true);
  });

  it("returns false on timeout", () => {
    const result = waitForNimHealth(8000, 1, {
      runCapture: () => "",
      sleep: () => {},
      now: (() => { let t = 0; return () => { t += 2000; return t; }; })(),
    });
    assert.equal(result, false);
  });

  it("returns false when runCapture throws", () => {
    const result = waitForNimHealth(8000, 1, {
      runCapture: () => { throw new Error("connection refused"); },
      sleep: () => {},
      now: (() => { let t = 0; return () => { t += 2000; return t; }; })(),
    });
    assert.equal(result, false);
  });

  it("uses custom port in health check URL", () => {
    let checkedUrl = null;
    waitForNimHealth(9999, 1, {
      runCapture: (cmd) => { checkedUrl = cmd; return '{"ok":true}'; },
      sleep: () => {},
      now: (() => { let t = 0; return () => t++; })(),
    });
    assert.ok(checkedUrl.includes("9999"));
  });
});

// ── stopNimContainer ────────────────────────────────────────────

describe("stopNimContainer()", () => {
  it("stops and removes container", () => {
    const commands = [];
    stopNimContainer("test-sb", {
      run: (cmd) => { commands.push(cmd); },
    });
    assert.equal(commands.length, 2);
    assert.ok(commands[0].includes("docker stop"));
    assert.ok(commands[0].includes("nemoclaw-nim-test-sb"));
    assert.ok(commands[1].includes("docker rm"));
    assert.ok(commands[1].includes("nemoclaw-nim-test-sb"));
  });
});
