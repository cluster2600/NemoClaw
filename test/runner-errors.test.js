// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const runnerPath = path.resolve(__dirname, "..", "bin", "lib", "runner");

describe("runner error paths", () => {
  describe("run() command failure", () => {
    it("exits non-zero when command fails without ignoreError", () => {
      const script = `
        const { run } = require(${JSON.stringify(runnerPath)});
        run("exit 42");
      `;
      const result = spawnSync("node", ["-e", script], {
        cwd: path.join(__dirname, ".."),
        encoding: "utf-8",
        timeout: 10000,
      });
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes("Command failed"));
    });

    it("continues when command fails with ignoreError", () => {
      const script = `
        const { run } = require(${JSON.stringify(runnerPath)});
        const r = run("exit 7", { ignoreError: true });
        console.log("status:" + r.status);
      `;
      const result = spawnSync("node", ["-e", script], {
        cwd: path.join(__dirname, ".."),
        encoding: "utf-8",
        timeout: 10000,
      });
      assert.equal(result.status, 0);
      assert.ok(result.stdout.includes("status:7"));
    });

    it("redacts secrets in error messages", () => {
      const script = `
        const { run } = require(${JSON.stringify(runnerPath)});
        run("echo NVIDIA_API_KEY=nvapi-secret123456789 && exit 1");
      `;
      const result = spawnSync("node", ["-e", script], {
        cwd: path.join(__dirname, ".."),
        encoding: "utf-8",
        timeout: 10000,
      });
      assert.notEqual(result.status, 0);
      assert.ok(!result.stderr.includes("nvapi-secret123456789"));
    });
  });

  describe("runInteractive() command failure", () => {
    it("exits non-zero when command fails without ignoreError", () => {
      const script = `
        const { runInteractive } = require(${JSON.stringify(runnerPath)});
        runInteractive("exit 3");
      `;
      const result = spawnSync("node", ["-e", script], {
        cwd: path.join(__dirname, ".."),
        encoding: "utf-8",
        timeout: 10000,
      });
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes("Command failed"));
    });

    it("continues when command fails with ignoreError", () => {
      const script = `
        const { runInteractive } = require(${JSON.stringify(runnerPath)});
        const r = runInteractive("exit 5", { ignoreError: true });
        console.log("status:" + r.status);
      `;
      const result = spawnSync("node", ["-e", script], {
        cwd: path.join(__dirname, ".."),
        encoding: "utf-8",
        timeout: 10000,
      });
      assert.equal(result.status, 0);
      assert.ok(result.stdout.includes("status:5"));
    });
  });

  describe("runCapture() error handling", () => {
    it("throws when command fails without ignoreError", () => {
      const { runCapture } = require(runnerPath);
      assert.throws(() => runCapture("exit 1"), /Command failed/);
    });

    it("returns empty string when command fails with ignoreError", () => {
      const { runCapture } = require(runnerPath);
      const result = runCapture("exit 1", { ignoreError: true });
      assert.equal(result, "");
    });

    it("captures stdout correctly", () => {
      const { runCapture } = require(runnerPath);
      const result = runCapture("echo hello-world");
      assert.equal(result, "hello-world");
    });

    it("passes env vars to command", () => {
      const { runCapture } = require(runnerPath);
      const result = runCapture("echo $TEST_VAR_RUNNER", {
        env: { TEST_VAR_RUNNER: "captured-value" },
      });
      assert.equal(result, "captured-value");
    });
  });
});

describe("credentials module branches", () => {
  const credsPath = path.resolve(__dirname, "..", "bin", "lib", "credentials");

  describe("isRepoPrivate", () => {
    it("returns false when gh CLI is not available or errors", () => {
      const { isRepoPrivate } = require(credsPath);
      // Using a definitely-nonexistent repo to trigger error path
      const result = isRepoPrivate("nonexistent-org-xyz/nonexistent-repo-xyz-12345");
      assert.equal(result, false);
    });
  });

  describe("buildCredentialEnv", () => {
    it("returns empty object when no credentials are set", () => {
      const { buildCredentialEnv } = require(credsPath);
      // Use custom keys that are definitely not set
      const env = buildCredentialEnv(["NONEXISTENT_KEY_XYZ_123"]);
      assert.deepEqual(env, {});
    });

    it("picks up env var overrides", () => {
      const origVal = process.env.NVIDIA_API_KEY;
      process.env.NVIDIA_API_KEY = "nvapi-test-cred-env";
      try {
        const { buildCredentialEnv } = require(credsPath);
        const env = buildCredentialEnv(["NVIDIA_API_KEY"]);
        assert.equal(env.NVIDIA_API_KEY, "nvapi-test-cred-env");
      } finally {
        if (origVal === undefined) delete process.env.NVIDIA_API_KEY;
        else process.env.NVIDIA_API_KEY = origVal;
      }
    });

    it("defaults to KNOWN_CREDENTIAL_KEYS when no keys specified", () => {
      const { buildCredentialEnv, KNOWN_CREDENTIAL_KEYS } = require(credsPath);
      // Clear all credential env vars temporarily
      const saved = {};
      for (const k of KNOWN_CREDENTIAL_KEYS) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
      try {
        const env = buildCredentialEnv();
        // Should return an object (possibly empty if no creds file)
        assert.equal(typeof env, "object");
      } finally {
        for (const k of KNOWN_CREDENTIAL_KEYS) {
          if (saved[k] !== undefined) process.env[k] = saved[k];
        }
      }
    });
  });

  describe("getCredential", () => {
    it("returns env var when set", () => {
      const origVal = process.env.TELEGRAM_BOT_TOKEN;
      process.env.TELEGRAM_BOT_TOKEN = "test-tg-token";
      try {
        const { getCredential } = require(credsPath);
        assert.equal(getCredential("TELEGRAM_BOT_TOKEN"), "test-tg-token");
      } finally {
        if (origVal === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
        else process.env.TELEGRAM_BOT_TOKEN = origVal;
      }
    });

    it("returns null when key not in env or credentials file", () => {
      const origVal = process.env.NONEXISTENT_CRED_KEY;
      delete process.env.NONEXISTENT_CRED_KEY;
      try {
        const { getCredential } = require(credsPath);
        assert.equal(getCredential("NONEXISTENT_CRED_KEY"), null);
      } finally {
        if (origVal !== undefined) process.env.NONEXISTENT_CRED_KEY = origVal;
      }
    });
  });
});
