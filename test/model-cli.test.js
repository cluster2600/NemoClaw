// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { SANDBOX_HELP } = require("../bin/lib/command-help");

// ── command-help entry ──────────────────────────────────────────

describe("model command-help", () => {
  it("has a sandbox help entry for model", () => {
    assert.ok(SANDBOX_HELP.model);
    assert.ok(SANDBOX_HELP.model.purpose.includes("model"));
  });

  it("includes list and set subcommands in usage", () => {
    assert.ok(SANDBOX_HELP.model.usage.includes("list"));
    assert.ok(SANDBOX_HELP.model.usage.includes("set"));
  });

  it("has examples", () => {
    assert.ok(SANDBOX_HELP.model.examples.length >= 3);
    assert.ok(SANDBOX_HELP.model.examples.some((e) => e.includes("model set")));
  });
});

// ── help text includes model section ────────────────────────────

describe("main help text", () => {
  it("includes model commands in Sandbox Commands section", () => {
    // Read the help function output by loading the source
    const fs = require("fs");
    const src = fs.readFileSync(require.resolve("../bin/nemoclaw.js"), "utf-8");
    assert.ok(src.includes("Sandbox Commands"));
    assert.ok(src.includes("model list"));
    assert.ok(src.includes("model set"));
  });

  it("lists model in valid sandbox actions", () => {
    const fs = require("fs");
    const src = fs.readFileSync(require.resolve("../bin/nemoclaw.js"), "utf-8");
    assert.ok(src.includes("Valid actions: connect, status, logs, model, policy-add, policy-list, destroy"));
  });
});
