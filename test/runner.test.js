// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const childProcess = require("node:child_process");
const { spawnSync } = childProcess;

const runnerPath = path.join(__dirname, "..", "bin", "lib", "runner");

describe("runner helpers", () => {
  it("does not let child commands consume installer stdin", () => {
    const script = `
      const { run } = require(${JSON.stringify(runnerPath)});
      process.stdin.setEncoding("utf8");
      run("cat >/dev/null || true");
      process.stdin.once("data", (chunk) => {
        process.stdout.write(chunk);
      });
    `;

    const result = spawnSync("node", ["-e", script], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf-8",
      input: "preserved-answer\n",
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "preserved-answer\n");
  });

  it("uses inherited stdio for interactive commands only", () => {
    const calls = [];
    const originalSpawnSync = childProcess.spawnSync;
    childProcess.spawnSync = (...args) => {
      calls.push(args);
      return { status: 0 };
    };

    try {
      delete require.cache[require.resolve(runnerPath)];
      const { run, runInteractive } = require(runnerPath);
      run("echo noninteractive");
      runInteractive("echo interactive");
    } finally {
      childProcess.spawnSync = originalSpawnSync;
      delete require.cache[require.resolve(runnerPath)];
    }

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0][2].stdio, ["ignore", "inherit", "inherit"]);
    assert.equal(calls[1][2].stdio, "inherit");
  });

  it("preserves process env when opts.env is provided", () => {
    const calls = [];
    const originalSpawnSync = childProcess.spawnSync;
    const originalPath = process.env.PATH;
    childProcess.spawnSync = (...args) => {
      calls.push(args);
      return { status: 0 };
    };

    try {
      delete require.cache[require.resolve(runnerPath)];
      const { run } = require(runnerPath);
      process.env.PATH = "/usr/local/bin:/usr/bin";
      run("echo test", { env: { OPENSHELL_CLUSTER_IMAGE: "ghcr.io/nvidia/openshell/cluster:0.0.12" } });
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      childProcess.spawnSync = originalSpawnSync;
      delete require.cache[require.resolve(runnerPath)];
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0][2].env.OPENSHELL_CLUSTER_IMAGE, "ghcr.io/nvidia/openshell/cluster:0.0.12");
    assert.equal(calls[0][2].env.PATH, "/usr/local/bin:/usr/bin");
  });

  describe("shellQuote", () => {
    it("wraps in single quotes", () => {
      const { shellQuote } = require(runnerPath);
      assert.equal(shellQuote("hello"), "'hello'");
    });

    it("escapes embedded single quotes", () => {
      const { shellQuote } = require(runnerPath);
      assert.equal(shellQuote("it's"), "'it'\\''s'");
    });

    it("neutralizes shell metacharacters", () => {
      const { shellQuote } = require(runnerPath);
      const dangerous = "test; rm -rf /";
      const quoted = shellQuote(dangerous);
      assert.equal(quoted, "'test; rm -rf /'");
      const result = spawnSync("bash", ["-c", `echo ${quoted}`], { encoding: "utf-8" });
      assert.equal(result.stdout.trim(), dangerous);
    });

    it("handles backticks and dollar signs", () => {
      const { shellQuote } = require(runnerPath);
      const payload = "test`whoami`$HOME";
      const quoted = shellQuote(payload);
      const result = spawnSync("bash", ["-c", `echo ${quoted}`], { encoding: "utf-8" });
      assert.equal(result.stdout.trim(), payload);
    });
  });

  describe("validateName", () => {
    it("accepts valid RFC 1123 names", () => {
      const { validateName } = require(runnerPath);
      assert.equal(validateName("my-sandbox"), "my-sandbox");
      assert.equal(validateName("test123"), "test123");
      assert.equal(validateName("a"), "a");
    });

    it("rejects names with shell metacharacters", () => {
      const { validateName } = require(runnerPath);
      assert.throws(() => validateName("test; whoami"), /Invalid/);
      assert.throws(() => validateName("test`id`"), /Invalid/);
      assert.throws(() => validateName("test$(cat /etc/passwd)"), /Invalid/);
      assert.throws(() => validateName("../etc/passwd"), /Invalid/);
    });

    it("rejects empty and overlength names", () => {
      const { validateName } = require(runnerPath);
      assert.throws(() => validateName(""), /required/);
      assert.throws(() => validateName(null), /required/);
      assert.throws(() => validateName("a".repeat(64)), /too long/);
    });

    it("rejects uppercase and special characters", () => {
      const { validateName } = require(runnerPath);
      assert.throws(() => validateName("MyBox"), /Invalid/);
      assert.throws(() => validateName("my_box"), /Invalid/);
      assert.throws(() => validateName("-leading"), /Invalid/);
      assert.throws(() => validateName("trailing-"), /Invalid/);
    });
  });

  describe("redactSecrets", () => {
    it("redacts NVIDIA API key assignments", () => {
      const { redactSecrets } = require(runnerPath);
      assert.equal(
        redactSecrets("NVIDIA_API_KEY=nvapi-abc123xyz"),
        "NVIDIA_API_KEY=<REDACTED>",
      );
    });

    it("redacts nvapi- prefixed tokens in free text", () => {
      const { redactSecrets } = require(runnerPath);
      const input = "using key nvapi-AbCdEfGhIj1234 for auth";
      assert.ok(!redactSecrets(input).includes("nvapi-AbCdEfGhIj1234"));
      assert.ok(redactSecrets(input).includes("<REDACTED>"));
    });

    it("redacts GitHub PATs", () => {
      const { redactSecrets } = require(runnerPath);
      const ghToken = "ghp_" + "a".repeat(36);
      assert.equal(redactSecrets(`GITHUB_TOKEN=${ghToken}`), "GITHUB_TOKEN=<REDACTED>");
    });

    it("redacts Bearer tokens", () => {
      const { redactSecrets } = require(runnerPath);
      assert.equal(
        redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1Ni"),
        "Authorization: Bearer <REDACTED>",
      );
    });

    it("redacts multiple secrets in one string", () => {
      const { redactSecrets } = require(runnerPath);
      const input = "NVIDIA_API_KEY=nvapi-secret123456 GITHUB_TOKEN=ghp_" + "b".repeat(36);
      const result = redactSecrets(input);
      assert.ok(!result.includes("nvapi-secret123456"));
      assert.ok(!result.includes("ghp_"));
      assert.ok(result.includes("<REDACTED>"));
    });

    it("returns non-string values unchanged", () => {
      const { redactSecrets } = require(runnerPath);
      assert.equal(redactSecrets(null), null);
      assert.equal(redactSecrets(undefined), undefined);
      assert.equal(redactSecrets(42), 42);
    });

    it("leaves clean strings unchanged", () => {
      const { redactSecrets } = require(runnerPath);
      assert.equal(redactSecrets("bash setup.sh"), "bash setup.sh");
    });
  });

  describe("regression guards", () => {
    it("nemoclaw.js does not use execSync", () => {
      const fs = require("fs");
      const src = fs.readFileSync(path.join(__dirname, "..", "bin", "nemoclaw.js"), "utf-8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("execSync") && !lines[i].includes("execFileSync")) {
          assert.fail(`bin/nemoclaw.js:${i + 1} uses execSync — use execFileSync instead`);
        }
      }
    });

    it("no duplicate shellQuote definitions in bin/", () => {
      const fs = require("fs");
      const binDir = path.join(__dirname, "..", "bin");
      const files = [];
      function walk(dir) {
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
          if (f.isDirectory() && f.name !== "node_modules") walk(path.join(dir, f.name));
          else if (f.name.endsWith(".js")) files.push(path.join(dir, f.name));
        }
      }
      walk(binDir);

      const defs = [];
      for (const file of files) {
        const src = fs.readFileSync(file, "utf-8");
        if (src.includes("function shellQuote")) {
          defs.push(file.replace(binDir, "bin"));
        }
      }
      assert.equal(defs.length, 1, `Expected 1 shellQuote definition, found ${defs.length}: ${defs.join(", ")}`);
      assert.ok(defs[0].includes("runner"), `shellQuote should be in runner.js, found in ${defs[0]}`);
    });

    it("CLI rejects malicious sandbox names before shell commands (e2e)", () => {
      const fs = require("fs");
      const os = require("os");
      const canaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-canary-"));
      const canary = path.join(canaryDir, "executed");
      try {
        const result = spawnSync("node", [
          path.join(__dirname, "..", "bin", "nemoclaw.js"),
          `test; touch ${canary}`,
          "connect",
        ], {
          encoding: "utf-8",
          timeout: 10000,
          cwd: path.join(__dirname, ".."),
        });
        assert.notEqual(result.status, 0, "CLI should reject malicious sandbox name");
        assert.equal(fs.existsSync(canary), false, "shell payload must never execute");
      } finally {
        fs.rmSync(canaryDir, { recursive: true, force: true });
      }
    });

    it("setupSpark does not embed API key in command string", () => {
      const fs = require("fs");
      const src = fs.readFileSync(path.join(__dirname, "..", "bin", "nemoclaw.js"), "utf-8");
      // Extract the setupSpark function body — between "async function setupSpark"
      // and the next top-level "async function" or "function" declaration.
      const match = src.match(/async function setupSpark\b[\s\S]*?\n\}/);
      assert.ok(match, "setupSpark function must exist");
      const body = match[0];
      assert.ok(
        !body.includes("NVIDIA_API_KEY=") || body.includes("env:"),
        "setupSpark must pass API key via env option, not in the command string",
      );
    });

    it("walkthrough.sh does not echo raw API key value", () => {
      const fs = require("fs");
      const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "walkthrough.sh"), "utf-8");
      // The script should reference the variable name, not expand it unsafely
      assert.ok(
        !src.includes('echo "    export NVIDIA_API_KEY=$NVIDIA_API_KEY"'),
        "walkthrough.sh must not echo the raw API key value to terminal",
      );
    });

    it("telegram bridge validates SANDBOX_NAME on startup", () => {
      const fs = require("fs");
      const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "telegram-bridge.js"), "utf-8");
      assert.ok(src.includes("validateName(SANDBOX"), "telegram-bridge.js must validate SANDBOX_NAME");
      assert.ok(!src.includes("execSync"), "telegram-bridge.js should not use execSync");
    });
  });
});
