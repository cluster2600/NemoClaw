// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for deploy(), sandboxPolicyAdd(), sandboxDestroy() with DI.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  deploy,
  sandboxPolicyAdd,
  sandboxDestroy,
} = require("../bin/nemoclaw.js");

// ── Helpers ──────────────────────────────────────────────────────

function noopDeps() {
  return {
    ensureApiKey: async () => {},
    ensureGithubToken: async () => {},
    isRepoPrivate: () => false,
    validateName: () => {},
    run: () => {},
    runInteractive: () => {},
    buildCredentialEnv: () => ({}),
    execFileSync: () => "",
    spawnSync: () => {},
    fs: {
      mkdtempSync: () => "/tmp/test-env-dir",
      writeFileSync: () => {},
      unlinkSync: () => {},
      rmdirSync: () => {},
    },
    os: { tmpdir: () => "/tmp" },
    path: { join: (...parts) => parts.join("/") },
    log: () => {},
    logError: () => {},
    exit: () => {},
    stdout: { write: () => {} },
    gpu: "test-gpu",
    sshRetries: 2,
  };
}

// ── deploy ───────────────────────────────────────────────────────

describe("deploy", () => {
  it("exits with usage when no instanceName given", async () => {
    let exitCalled = false;
    const errors = [];
    await deploy(undefined, {
      ...noopDeps(),
      logError: (msg) => errors.push(msg),
      exit: () => { exitCalled = true; },
    });
    assert.ok(exitCalled, "should call exit");
    assert.ok(errors.some((e) => e.includes("Usage")));
    assert.ok(errors.some((e) => e.includes("--help")));
  });

  it("calls ensureApiKey before proceeding", async () => {
    let apiKeyCalled = false;
    await deploy("test-box", {
      ...noopDeps(),
      ensureApiKey: async () => { apiKeyCalled = true; },
    });
    assert.ok(apiKeyCalled);
  });

  it("calls ensureGithubToken when repo is private", async () => {
    let ghTokenCalled = false;
    await deploy("test-box", {
      ...noopDeps(),
      isRepoPrivate: () => true,
      ensureGithubToken: async () => { ghTokenCalled = true; },
    });
    assert.ok(ghTokenCalled);
  });

  it("skips ensureGithubToken when repo is public", async () => {
    let ghTokenCalled = false;
    await deploy("test-box", {
      ...noopDeps(),
      isRepoPrivate: () => false,
      ensureGithubToken: async () => { ghTokenCalled = true; },
    });
    assert.ok(!ghTokenCalled);
  });

  it("exits when brev CLI is not found", async () => {
    let exitCalled = false;
    const errors = [];
    await deploy("test-box", {
      ...noopDeps(),
      execFileSync: (cmd) => {
        if (cmd === "which") throw new Error("not found");
        return "";
      },
      logError: (msg) => errors.push(msg),
      exit: () => { exitCalled = true; },
    });
    assert.ok(exitCalled);
    assert.ok(errors.some((e) => e.includes("brev CLI not found")));
    assert.ok(errors.some((e) => e.includes("Then retry")));
  });

  it("creates instance when brev ls does not include name", async () => {
    const runCalls = [];
    await deploy("new-box", {
      ...noopDeps(),
      execFileSync: (cmd, args) => {
        if (cmd === "which") return "";
        if (cmd === "brev") return "other-box  Running";
        // SSH check succeeds on first try
        return "";
      },
      run: (cmd, opts) => runCalls.push({ cmd, opts }),
    });
    assert.ok(runCalls.some((c) => c.cmd.includes("brev create")));
  });

  it("skips creation when instance already exists in brev ls", async () => {
    const logs = [];
    await deploy("existing-box", {
      ...noopDeps(),
      execFileSync: (cmd, args) => {
        if (cmd === "which") return "";
        if (cmd === "brev") return "existing-box  Running";
        return "";
      },
      log: (msg) => logs.push(msg),
    });
    assert.ok(logs.some((m) => m.includes("already exists")));
  });

  it("detects instance from brev ls error stdout", async () => {
    const logs = [];
    await deploy("err-box", {
      ...noopDeps(),
      execFileSync: (cmd, args) => {
        if (cmd === "which") return "";
        if (cmd === "brev") {
          const err = new Error("brev ls failed");
          err.stdout = "err-box  Stopped";
          err.stderr = "";
          throw err;
        }
        return "";
      },
      log: (msg) => logs.push(msg),
    });
    assert.ok(logs.some((m) => m.includes("already exists")));
  });

  it("detects instance from brev ls error stderr", async () => {
    const logs = [];
    await deploy("stderr-box", {
      ...noopDeps(),
      execFileSync: (cmd, args) => {
        if (cmd === "which") return "";
        if (cmd === "brev") {
          const err = new Error("brev ls failed");
          err.stdout = "";
          err.stderr = "stderr-box is active";
          throw err;
        }
        return "";
      },
      log: (msg) => logs.push(msg),
    });
    assert.ok(logs.some((m) => m.includes("already exists")));
  });

  it("retries SSH and succeeds on second attempt", async () => {
    let sshAttempts = 0;
    const writes = [];
    await deploy("retry-box", {
      ...noopDeps(),
      execFileSync: (cmd, args) => {
        if (cmd === "which") return "";
        if (cmd === "brev") return "";
        if (cmd === "ssh") {
          sshAttempts++;
          if (sshAttempts === 1) throw new Error("connection refused");
          return "";
        }
        return "";
      },
      stdout: { write: (s) => writes.push(s) },
      sshRetries: 3,
    });
    assert.strictEqual(sshAttempts, 2);
    assert.ok(writes.some((w) => w === "."));
  });

  it("exits on SSH timeout after all retries", async () => {
    let exitCalled = false;
    const errors = [];
    await deploy("timeout-box", {
      ...noopDeps(),
      execFileSync: (cmd) => {
        if (cmd === "which") return "";
        if (cmd === "brev") return "";
        if (cmd === "ssh") throw new Error("connection refused");
        return "";
      },
      logError: (msg) => errors.push(msg),
      exit: () => { exitCalled = true; },
      sshRetries: 2,
    });
    assert.ok(exitCalled);
    assert.ok(errors.some((e) => e.includes("Timed out")));
  });

  it("syncs files and writes credential env", async () => {
    const runCalls = [];
    let writeFileArgs = null;
    await deploy("sync-box", {
      ...noopDeps(),
      run: (cmd, opts) => runCalls.push(cmd),
      fs: {
        mkdtempSync: () => "/tmp/test-dir",
        writeFileSync: (p, data, opts) => { writeFileArgs = { path: p, data, opts }; },
        unlinkSync: () => {},
        rmdirSync: () => {},
      },
      buildCredentialEnv: () => ({ NVIDIA_API_KEY: "test-key" }),
    });
    assert.ok(runCalls.some((c) => c.includes("rsync")));
    assert.ok(runCalls.some((c) => c.includes("scp")));
    assert.ok(writeFileArgs);
    assert.ok(writeFileArgs.data.includes("NVIDIA_API_KEY"));
    assert.deepStrictEqual(writeFileArgs.opts, { mode: 0o600 });
  });

  it("starts telegram services when TELEGRAM_BOT_TOKEN is in credEnv", async () => {
    const runCalls = [];
    await deploy("tg-box", {
      ...noopDeps(),
      run: (cmd) => runCalls.push(cmd),
      buildCredentialEnv: () => ({ TELEGRAM_BOT_TOKEN: "123:abc" }),
    });
    assert.ok(runCalls.some((c) => c.includes("start-services.sh")));
  });

  it("skips telegram services when no TELEGRAM_BOT_TOKEN", async () => {
    const runCalls = [];
    await deploy("no-tg-box", {
      ...noopDeps(),
      run: (cmd) => runCalls.push(cmd),
      buildCredentialEnv: () => ({ NVIDIA_API_KEY: "key" }),
    });
    assert.ok(!runCalls.some((c) => c.includes("start-services.sh")));
  });

  it("always connects to sandbox at the end", async () => {
    const interactiveCalls = [];
    await deploy("connect-box", {
      ...noopDeps(),
      runInteractive: (cmd) => interactiveCalls.push(cmd),
    });
    assert.ok(interactiveCalls.some((c) => c.includes("sandbox connect")));
  });

  it("cleans up temp env file even on scp failure", async () => {
    let unlinkCalled = false;
    let rmdirCalled = false;
    try {
      await deploy("cleanup-box", {
        ...noopDeps(),
        run: (cmd) => {
          if (cmd.includes("scp")) throw new Error("scp failed");
        },
        fs: {
          mkdtempSync: () => "/tmp/test-dir",
          writeFileSync: () => {},
          unlinkSync: () => { unlinkCalled = true; },
          rmdirSync: () => { rmdirCalled = true; },
        },
      });
    } catch {
      // expected
    }
    assert.ok(unlinkCalled, "should clean up temp file");
    assert.ok(rmdirCalled, "should clean up temp dir");
  });

  it("uses NEMOCLAW_GPU env var via deps.gpu", async () => {
    const runCalls = [];
    await deploy("gpu-box", {
      ...noopDeps(),
      execFileSync: (cmd) => {
        if (cmd === "which") return "";
        if (cmd === "brev") return "";
        return "";
      },
      run: (cmd) => runCalls.push(cmd),
      gpu: "a100-custom:nvidia-a100:4",
    });
    assert.ok(runCalls.some((c) => c.includes("a100-custom")));
  });

  it("brev ls error with no stdout/stderr does not set exists", async () => {
    const runCalls = [];
    await deploy("fresh-box", {
      ...noopDeps(),
      execFileSync: (cmd) => {
        if (cmd === "which") return "";
        if (cmd === "brev") {
          const err = new Error("fail");
          throw err;
        }
        return "";
      },
      run: (cmd) => runCalls.push(cmd),
    });
    assert.ok(runCalls.some((c) => c.includes("brev create")));
  });
});

// ── sandboxPolicyAdd ─────────────────────────────────────────────

describe("sandboxPolicyAdd", () => {
  it("lists presets with applied markers", async () => {
    const logs = [];
    await sandboxPolicyAdd("test-sb", {
      listPresets: () => [
        { name: "web", description: "Web access" },
        { name: "pypi", description: "PyPI access" },
      ],
      getAppliedPresets: () => ["web"],
      applyPreset: () => {},
      prompt: async () => "",
      log: (msg) => logs.push(msg),
    });
    assert.ok(logs.some((m) => m.includes("●") && m.includes("web")));
    assert.ok(logs.some((m) => m.includes("○") && m.includes("pypi")));
  });

  it("returns early when user enters empty answer", async () => {
    let applyCalled = false;
    await sandboxPolicyAdd("test-sb", {
      listPresets: () => [],
      getAppliedPresets: () => [],
      applyPreset: () => { applyCalled = true; },
      prompt: async () => "",
      log: () => {},
    });
    assert.ok(!applyCalled);
  });

  it("returns early when user declines confirmation", async () => {
    let applyCalled = false;
    let promptCount = 0;
    await sandboxPolicyAdd("test-sb", {
      listPresets: () => [{ name: "web", description: "Web" }],
      getAppliedPresets: () => [],
      applyPreset: () => { applyCalled = true; },
      prompt: async () => {
        promptCount++;
        return promptCount === 1 ? "web" : "n";
      },
      log: () => {},
    });
    assert.ok(!applyCalled);
  });

  it("applies preset when user confirms", async () => {
    let appliedPreset = null;
    let appliedSandbox = null;
    let promptCount = 0;
    await sandboxPolicyAdd("my-sb", {
      listPresets: () => [{ name: "docker", description: "Docker" }],
      getAppliedPresets: () => [],
      applyPreset: (sb, preset) => {
        appliedSandbox = sb;
        appliedPreset = preset;
      },
      prompt: async () => {
        promptCount++;
        return promptCount === 1 ? "docker" : "Y";
      },
      log: () => {},
    });
    assert.strictEqual(appliedSandbox, "my-sb");
    assert.strictEqual(appliedPreset, "docker");
  });

  it("applies when confirm is anything other than 'n'", async () => {
    let applyCalled = false;
    let promptCount = 0;
    await sandboxPolicyAdd("test-sb", {
      listPresets: () => [{ name: "web", description: "Web" }],
      getAppliedPresets: () => [],
      applyPreset: () => { applyCalled = true; },
      prompt: async () => {
        promptCount++;
        return promptCount === 1 ? "web" : "yes";
      },
      log: () => {},
    });
    assert.ok(applyCalled);
  });
});

// ── sandboxDestroy ──────────────────────────────────────────────

describe("sandboxDestroy", () => {
  it("skips confirmation with --yes flag", async () => {
    let promptCalled = false;
    let removeCalled = false;
    await sandboxDestroy("test-sb", ["--yes"], {
      prompt: async () => { promptCalled = true; return ""; },
      run: () => {},
      stopNimContainer: () => {},
      removeSandbox: () => { removeCalled = true; },
      log: () => {},
    });
    assert.ok(!promptCalled, "should not prompt with --yes");
    assert.ok(removeCalled, "should proceed with destroy");
  });

  it("skips confirmation with --force flag", async () => {
    let removeCalled = false;
    await sandboxDestroy("test-sb", ["--force"], {
      prompt: async () => "",
      run: () => {},
      stopNimContainer: () => {},
      removeSandbox: () => { removeCalled = true; },
      log: () => {},
    });
    assert.ok(removeCalled);
  });

  it("prompts and proceeds when user confirms with 'y'", async () => {
    let removeCalled = false;
    await sandboxDestroy("test-sb", [], {
      prompt: async () => "y",
      run: () => {},
      stopNimContainer: () => {},
      removeSandbox: () => { removeCalled = true; },
      log: () => {},
    });
    assert.ok(removeCalled);
  });

  it("prompts and proceeds when user confirms with 'yes'", async () => {
    let removeCalled = false;
    await sandboxDestroy("test-sb", [], {
      prompt: async () => "yes",
      run: () => {},
      stopNimContainer: () => {},
      removeSandbox: () => { removeCalled = true; },
      log: () => {},
    });
    assert.ok(removeCalled);
  });

  it("cancels when user declines (enters 'n')", async () => {
    let removeCalled = false;
    const logs = [];
    await sandboxDestroy("test-sb", [], {
      prompt: async () => "n",
      run: () => {},
      stopNimContainer: () => {},
      removeSandbox: () => { removeCalled = true; },
      log: (msg) => logs.push(msg),
    });
    assert.ok(!removeCalled);
    assert.ok(logs.some((m) => m.includes("Cancelled")));
  });

  it("cancels when user presses Enter (empty input)", async () => {
    let removeCalled = false;
    const logs = [];
    await sandboxDestroy("test-sb", [], {
      prompt: async () => "  ",
      run: () => {},
      stopNimContainer: () => {},
      removeSandbox: () => { removeCalled = true; },
      log: (msg) => logs.push(msg),
    });
    assert.ok(!removeCalled);
    assert.ok(logs.some((m) => m.includes("Cancelled")));
  });

  it("stops NIM container before deletion", async () => {
    const callOrder = [];
    await sandboxDestroy("my-sb", ["--yes"], {
      prompt: async () => "",
      run: () => callOrder.push("run"),
      stopNimContainer: (name) => {
        assert.strictEqual(name, "my-sb");
        callOrder.push("stopNim");
      },
      removeSandbox: () => callOrder.push("remove"),
      log: () => {},
    });
    assert.deepStrictEqual(callOrder, ["stopNim", "run", "remove"]);
  });

  it("runs openshell sandbox delete with correct sandbox name", async () => {
    let runCmd = "";
    await sandboxDestroy("prod-sb", ["--yes"], {
      prompt: async () => "",
      run: (cmd) => { runCmd = cmd; },
      stopNimContainer: () => {},
      removeSandbox: () => {},
      log: () => {},
    });
    assert.ok(runCmd.includes("openshell sandbox delete"));
    assert.ok(runCmd.includes("prod-sb"));
  });

  it("removes sandbox from registry after deletion", async () => {
    let removedName = null;
    await sandboxDestroy("rm-sb", ["--yes"], {
      prompt: async () => "",
      run: () => {},
      stopNimContainer: () => {},
      removeSandbox: (name) => { removedName = name; },
      log: () => {},
    });
    assert.strictEqual(removedName, "rm-sb");
  });

  it("logs success message with sandbox name", async () => {
    const logs = [];
    await sandboxDestroy("done-sb", ["--yes"], {
      prompt: async () => "",
      run: () => {},
      stopNimContainer: () => {},
      removeSandbox: () => {},
      log: (msg) => logs.push(msg),
    });
    assert.ok(logs.some((m) => m.includes("done-sb") && m.includes("destroyed")));
  });
});
