// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "nemoclaw.js");
const loggerPath = path.join(__dirname, "..", "bin", "lib", "logger");

function runCli(args, env = {}) {
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    timeout: 10000,
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      HOME: "/tmp/nemoclaw-verbose-test-" + Date.now(),
      ...env,
    },
  });
  return {
    code: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

describe("--verbose / --debug CLI flag (#666)", () => {
  it("--verbose produces DEBUG output on stderr", () => {
    const r = runCli(["--verbose", "--version"]);
    assert.equal(r.code, 0);
    assert.ok(r.stderr.includes("DEBUG"), "stderr should contain DEBUG lines");
    assert.ok(r.stderr.includes("nemoclaw"), "stderr should log the command");
  });

  it("--debug is an alias for --verbose", () => {
    const r = runCli(["--debug", "--version"]);
    assert.equal(r.code, 0);
    assert.ok(r.stderr.includes("DEBUG"), "stderr should contain DEBUG lines with --debug");
  });

  it("LOG_LEVEL=debug enables verbose without flag", () => {
    const r = runCli(["--version"], { LOG_LEVEL: "debug" });
    assert.equal(r.code, 0);
    assert.ok(r.stderr.includes("DEBUG"), "stderr should contain DEBUG when LOG_LEVEL=debug");
  });

  it("NEMOCLAW_VERBOSE=1 enables verbose without flag", () => {
    const r = runCli(["--version"], { NEMOCLAW_VERBOSE: "1" });
    assert.equal(r.code, 0);
    assert.ok(r.stderr.includes("DEBUG"), "stderr should contain DEBUG when NEMOCLAW_VERBOSE=1");
  });

  it("no verbose flag produces no DEBUG output", () => {
    const r = runCli(["--version"], { LOG_LEVEL: "", NEMOCLAW_VERBOSE: "" });
    assert.equal(r.code, 0);
    assert.ok(!r.stderr.includes("DEBUG"), "stderr should be clean without verbose flag");
  });

  it("--verbose is stripped from args — does not break commands", () => {
    const r = runCli(["--verbose", "help"]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("Getting Started"), "help output should still render");
  });

  it("--verbose can appear after the command", () => {
    const r = runCli(["help", "--verbose"]);
    assert.equal(r.code, 0);
    assert.ok(r.stderr.includes("DEBUG"), "verbose should activate even after command");
  });

  it("debug output includes platform info", () => {
    const r = runCli(["--verbose", "--version"]);
    assert.ok(r.stderr.includes("platform"), "should log platform info");
    assert.ok(r.stderr.includes("node"), "should log node version");
  });

  it("debug output redacts secrets in commands", () => {
    // Ensure the logger itself doesn't leak secrets in command logging
    const r = runCli(["--verbose", "--version"], {
      NVIDIA_API_KEY: "nvapi-test-secret-1234567890",
    });
    assert.ok(!r.stderr.includes("nvapi-test-secret"), "secrets must not appear in debug output");
  });
});

describe("logger module", () => {
  beforeEach(() => {
    delete require.cache[require.resolve(loggerPath)];
  });

  afterEach(() => {
    delete require.cache[require.resolve(loggerPath)];
  });

  it("isVerbose() defaults to false", () => {
    const saved = { LOG_LEVEL: process.env.LOG_LEVEL, NEMOCLAW_VERBOSE: process.env.NEMOCLAW_VERBOSE };
    delete process.env.LOG_LEVEL;
    delete process.env.NEMOCLAW_VERBOSE;
    try {
      delete require.cache[require.resolve(loggerPath)];
      const { isVerbose } = require(loggerPath);
      assert.equal(isVerbose(), false);
    } finally {
      if (saved.LOG_LEVEL !== undefined) process.env.LOG_LEVEL = saved.LOG_LEVEL;
      if (saved.NEMOCLAW_VERBOSE !== undefined) process.env.NEMOCLAW_VERBOSE = saved.NEMOCLAW_VERBOSE;
    }
  });

  it("setVerbose(true) enables isVerbose()", () => {
    const saved = { LOG_LEVEL: process.env.LOG_LEVEL, NEMOCLAW_VERBOSE: process.env.NEMOCLAW_VERBOSE };
    delete process.env.LOG_LEVEL;
    delete process.env.NEMOCLAW_VERBOSE;
    try {
      delete require.cache[require.resolve(loggerPath)];
      const { isVerbose, setVerbose } = require(loggerPath);
      assert.equal(isVerbose(), false);
      setVerbose(true);
      assert.equal(isVerbose(), true);
      setVerbose(false);
      assert.equal(isVerbose(), false);
    } finally {
      if (saved.LOG_LEVEL !== undefined) process.env.LOG_LEVEL = saved.LOG_LEVEL;
      if (saved.NEMOCLAW_VERBOSE !== undefined) process.env.NEMOCLAW_VERBOSE = saved.NEMOCLAW_VERBOSE;
    }
  });

  it("LOG_LEVEL=debug auto-enables verbose at require time", () => {
    process.env.LOG_LEVEL = "debug";
    try {
      delete require.cache[require.resolve(loggerPath)];
      const { isVerbose } = require(loggerPath);
      assert.equal(isVerbose(), true);
    } finally {
      delete process.env.LOG_LEVEL;
    }
  });

  it("debug() writes to stderr when verbose", () => {
    const saved = { LOG_LEVEL: process.env.LOG_LEVEL, NEMOCLAW_VERBOSE: process.env.NEMOCLAW_VERBOSE };
    delete process.env.LOG_LEVEL;
    delete process.env.NEMOCLAW_VERBOSE;
    try {
      delete require.cache[require.resolve(loggerPath)];
      const { setVerbose, debug } = require(loggerPath);

      const writes = [];
      const origWrite = process.stderr.write;
      process.stderr.write = (chunk) => { writes.push(chunk); return true; };

      try {
        debug("should not appear");
        assert.equal(writes.length, 0, "debug() should be silent when verbose is off");

        setVerbose(true);
        debug("test message %s", "42");
        assert.equal(writes.length, 1);
        assert.ok(writes[0].includes("DEBUG"), "output should contain DEBUG prefix");
        assert.ok(writes[0].includes("test message"), "output should contain the message");
        assert.ok(writes[0].includes("42"), "output should contain interpolated args");
      } finally {
        process.stderr.write = origWrite;
      }
    } finally {
      if (saved.LOG_LEVEL !== undefined) process.env.LOG_LEVEL = saved.LOG_LEVEL;
      if (saved.NEMOCLAW_VERBOSE !== undefined) process.env.NEMOCLAW_VERBOSE = saved.NEMOCLAW_VERBOSE;
    }
  });
});
