// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const credentialsPath = path.join(__dirname, "..", "bin", "lib", "credentials");

describe("unified credential passing", () => {
  let tmpDir;
  let savedEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cred-test-"));
    savedEnv = { ...process.env };
    // Point credentials module at temp dir
    process.env.HOME = tmpDir;
    // Clear credential env vars so tests are isolated
    delete process.env.NVIDIA_API_KEY;
    delete process.env.GITHUB_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    // Force re-require to pick up new HOME
    delete require.cache[require.resolve(credentialsPath)];
    delete require.cache[require.resolve(path.join(__dirname, "..", "bin", "lib", "config-io"))];
  });

  afterEach(() => {
    process.env = savedEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("KNOWN_CREDENTIAL_KEYS", () => {
    it("includes all expected credential keys", () => {
      const { KNOWN_CREDENTIAL_KEYS } = require(credentialsPath);
      assert.ok(KNOWN_CREDENTIAL_KEYS.includes("NVIDIA_API_KEY"));
      assert.ok(KNOWN_CREDENTIAL_KEYS.includes("GITHUB_TOKEN"));
      assert.ok(KNOWN_CREDENTIAL_KEYS.includes("TELEGRAM_BOT_TOKEN"));
      assert.ok(KNOWN_CREDENTIAL_KEYS.includes("DISCORD_BOT_TOKEN"));
      assert.ok(KNOWN_CREDENTIAL_KEYS.includes("SLACK_BOT_TOKEN"));
    });
  });

  describe("getCredential", () => {
    it("returns env var over file value", () => {
      const { getCredential, saveCredential } = require(credentialsPath);
      const credsDir = path.join(tmpDir, ".nemoclaw");
      fs.mkdirSync(credsDir, { recursive: true });
      saveCredential("NVIDIA_API_KEY", "nvapi-from-file");
      process.env.NVIDIA_API_KEY = "nvapi-from-env";
      assert.equal(getCredential("NVIDIA_API_KEY"), "nvapi-from-env");
    });

    it("falls back to file when env var is unset", () => {
      const { getCredential, saveCredential } = require(credentialsPath);
      const credsDir = path.join(tmpDir, ".nemoclaw");
      fs.mkdirSync(credsDir, { recursive: true });
      saveCredential("TELEGRAM_BOT_TOKEN", "tg-token-from-file");
      assert.equal(getCredential("TELEGRAM_BOT_TOKEN"), "tg-token-from-file");
    });

    it("returns null when neither env nor file has value", () => {
      const { getCredential } = require(credentialsPath);
      assert.equal(getCredential("SLACK_BOT_TOKEN"), null);
    });
  });

  describe("buildCredentialEnv", () => {
    it("returns empty object when no credentials are set", () => {
      const { buildCredentialEnv } = require(credentialsPath);
      const env = buildCredentialEnv();
      assert.deepEqual(env, {});
    });

    it("collects all available credentials from env vars", () => {
      process.env.NVIDIA_API_KEY = "nvapi-test123";
      process.env.GITHUB_TOKEN = "ghp_testtoken123";
      const { buildCredentialEnv } = require(credentialsPath);
      const env = buildCredentialEnv();
      assert.equal(env.NVIDIA_API_KEY, "nvapi-test123");
      assert.equal(env.GITHUB_TOKEN, "ghp_testtoken123");
      assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
    });

    it("collects credentials from file when env vars are unset", () => {
      const { buildCredentialEnv, saveCredential } = require(credentialsPath);
      const credsDir = path.join(tmpDir, ".nemoclaw");
      fs.mkdirSync(credsDir, { recursive: true });
      saveCredential("DISCORD_BOT_TOKEN", "discord-from-file");
      saveCredential("SLACK_BOT_TOKEN", "slack-from-file");
      const env = buildCredentialEnv();
      assert.equal(env.DISCORD_BOT_TOKEN, "discord-from-file");
      assert.equal(env.SLACK_BOT_TOKEN, "slack-from-file");
      assert.equal(env.NVIDIA_API_KEY, undefined);
    });

    it("restricts to specified keys when provided", () => {
      process.env.NVIDIA_API_KEY = "nvapi-restricted";
      process.env.GITHUB_TOKEN = "ghp_restricted";
      const { buildCredentialEnv } = require(credentialsPath);
      const env = buildCredentialEnv(["NVIDIA_API_KEY"]);
      assert.equal(env.NVIDIA_API_KEY, "nvapi-restricted");
      assert.equal(env.GITHUB_TOKEN, undefined);
    });

    it("merges env and file sources correctly", () => {
      process.env.NVIDIA_API_KEY = "nvapi-from-env";
      const { buildCredentialEnv, saveCredential } = require(credentialsPath);
      const credsDir = path.join(tmpDir, ".nemoclaw");
      fs.mkdirSync(credsDir, { recursive: true });
      saveCredential("TELEGRAM_BOT_TOKEN", "tg-from-file");
      const env = buildCredentialEnv();
      assert.equal(env.NVIDIA_API_KEY, "nvapi-from-env");
      assert.equal(env.TELEGRAM_BOT_TOKEN, "tg-from-file");
    });
  });

  describe("no direct process.env access in integrations", () => {
    it("onboard.js imports buildCredentialEnv from credentials", () => {
      const onboardSrc = fs.readFileSync(
        path.join(__dirname, "..", "bin", "lib", "onboard.js"),
        "utf-8"
      );
      assert.ok(
        onboardSrc.includes("buildCredentialEnv"),
        "onboard.js should use buildCredentialEnv"
      );
      // Should not have redundant getCredential() || process.env.X patterns
      assert.ok(
        !onboardSrc.includes('getCredential("DISCORD_BOT_TOKEN") || process.env.DISCORD_BOT_TOKEN'),
        "onboard.js should not have redundant DISCORD_BOT_TOKEN fallback"
      );
      assert.ok(
        !onboardSrc.includes('getCredential("SLACK_BOT_TOKEN") || process.env.SLACK_BOT_TOKEN'),
        "onboard.js should not have redundant SLACK_BOT_TOKEN fallback"
      );
    });

    it("nemoclaw.js deploy uses buildCredentialEnv instead of manual env lines", () => {
      const nemoclawSrc = fs.readFileSync(
        path.join(__dirname, "..", "bin", "nemoclaw.js"),
        "utf-8"
      );
      assert.ok(
        nemoclawSrc.includes("buildCredentialEnv"),
        "nemoclaw.js should use buildCredentialEnv"
      );
      // Should not directly read process.env.GITHUB_TOKEN for deploy env
      assert.ok(
        !nemoclawSrc.includes("const ghToken = process.env.GITHUB_TOKEN"),
        "nemoclaw.js should not read GITHUB_TOKEN directly from process.env"
      );
    });

    it("telegram-bridge.js uses getCredential instead of process.env", () => {
      const bridgeSrc = fs.readFileSync(
        path.join(__dirname, "..", "scripts", "telegram-bridge.js"),
        "utf-8"
      );
      assert.ok(
        bridgeSrc.includes("getCredential"),
        "telegram-bridge.js should use getCredential"
      );
      assert.ok(
        !bridgeSrc.includes("process.env.TELEGRAM_BOT_TOKEN"),
        "telegram-bridge.js should not read TELEGRAM_BOT_TOKEN from process.env directly"
      );
      assert.ok(
        !bridgeSrc.includes("process.env.NVIDIA_API_KEY"),
        "telegram-bridge.js should not read NVIDIA_API_KEY from process.env directly"
      );
    });

    it("setupInference does not pass NVIDIA_API_KEY as CLI argument value", () => {
      const onboardSrc = fs.readFileSync(
        path.join(__dirname, "..", "bin", "lib", "onboard.js"),
        "utf-8"
      );
      // The old pattern: --credential "NVIDIA_API_KEY=" + process.env.NVIDIA_API_KEY
      // Now uses: --credential "NVIDIA_API_KEY=$_NEMOCLAW_CRED" with env passing
      assert.ok(
        !onboardSrc.includes('"NVIDIA_API_KEY=" + process.env.NVIDIA_API_KEY'),
        "setupInference should not concatenate API key into CLI args"
      );
      assert.ok(
        onboardSrc.includes("_NEMOCLAW_CRED"),
        "setupInference should use env indirection for credential passing"
      );
    });
  });
});
