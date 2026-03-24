// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const path = require("path");

const CLI = path.join(__dirname, "..", "bin", "nemoclaw.js");

function run(args) {
  try {
    const out = execSync(`node "${CLI}" ${args}`, {
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, HOME: "/tmp/nemoclaw-cli-test-" + Date.now() },
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: (err.stdout || "") + (err.stderr || "") };
  }
}

describe("CLI dispatch", () => {
  it("help exits 0 and shows sections", () => {
    const r = run("help");
    assert.equal(r.code, 0);
    assert.ok(r.out.includes("Getting Started"), "missing Getting Started section");
    assert.ok(r.out.includes("Global Commands"), "missing Global Commands section");
    assert.ok(r.out.includes("Sandbox Commands"), "missing Sandbox Commands section");
  });

  it("--help exits 0", () => {
    assert.equal(run("--help").code, 0);
  });

  it("-h exits 0", () => {
    assert.equal(run("-h").code, 0);
  });

  it("no args exits 0 (shows help)", () => {
    const r = run("");
    assert.equal(r.code, 0);
    assert.ok(r.out.includes("nemoclaw"));
  });

  it("unknown command exits 1", () => {
    const r = run("boguscmd");
    assert.equal(r.code, 1);
    assert.ok(r.out.includes("Unknown command"));
  });

  it("list exits 0", () => {
    const r = run("list");
    assert.equal(r.code, 0);
    // With empty HOME, should say no sandboxes
    assert.ok(r.out.includes("No sandboxes"));
  });

  it("unknown onboard option exits 1", () => {
    const r = run("onboard --non-interactiv");
    assert.equal(r.code, 1);
    assert.ok(r.out.includes("Unknown onboard option"));
  });

  it("debug --help exits 0 and shows usage", () => {
    const r = run("debug --help");
    assert.equal(r.code, 0);
    assert.ok(r.out.includes("Collect NemoClaw diagnostic information"), "should show description");
    assert.ok(r.out.includes("--quick"), "should mention --quick flag");
    assert.ok(r.out.includes("--output"), "should mention --output flag");
  });

  it("debug --quick exits 0 and produces diagnostic output", () => {
    const r = run("debug --quick");
    assert.equal(r.code, 0, "debug --quick should exit 0");
    assert.ok(r.out.includes("Collecting diagnostics"), "should show collection header");
    assert.ok(r.out.includes("System"), "should include System section");
    assert.ok(r.out.includes("Done"), "should show completion message");
  });

  it("debug exits 1 on unknown option", () => {
    const r = run("debug --quik");
    assert.equal(r.code, 1, "misspelled flag should exit non-zero");
    assert.ok(r.out.includes("Unknown option"), "should report unknown option");
  });

  it("help mentions debug command", () => {
    const r = run("help");
    assert.equal(r.code, 0);
    assert.ok(r.out.includes("Troubleshooting"), "missing Troubleshooting section");
    assert.ok(r.out.includes("nemoclaw debug"), "help should mention debug command");
  });

  it("--version exits 0 and shows version string", () => {
    const r = run("--version");
    assert.equal(r.code, 0);
    assert.match(r.out.trim(), /^nemoclaw v\d+\.\d+\.\d+/);
  });

  it("-v exits 0 and shows same version as --version", () => {
    const r = run("-v");
    assert.equal(r.code, 0);
    assert.match(r.out.trim(), /^nemoclaw v\d+\.\d+\.\d+/);
    // Should match --version output
    const full = run("--version");
    assert.equal(r.out.trim(), full.out.trim());
  });

  it("--verbose help exits 0 (verbose flag stripped before dispatch)", () => {
    const r = run("--verbose help");
    assert.equal(r.code, 0);
    assert.ok(r.out.includes("Getting Started"), "verbose help should still show help");
  });

  it("--debug help exits 0 (debug flag stripped before dispatch)", () => {
    const r = run("--debug help");
    assert.equal(r.code, 0);
    assert.ok(r.out.includes("Getting Started"), "debug help should still show help");
  });

  it("list with empty HOME shows no sandboxes", () => {
    const r = run("list");
    assert.equal(r.code, 0);
    assert.ok(r.out.includes("No sandboxes"));
  });

  it("unknown sandbox name with action exits 1", () => {
    const r = run("nonexistent-sandbox-xyz connect");
    assert.equal(r.code, 1);
    assert.ok(r.out.includes("Unknown command"));
  });
});
