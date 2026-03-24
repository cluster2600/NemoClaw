// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { ensureApiKey, ensureGithubToken } = require("../bin/lib/credentials");

// ── ensureApiKey ────────────────────────────────────────────────

describe("ensureApiKey()", () => {
  it("sets env and returns immediately when credential exists", async () => {
    const env = {};
    await ensureApiKey({
      getCredential: (key) => key === "NVIDIA_API_KEY" ? "nvapi-test123" : null,
      saveCredential: () => {},
      prompt: () => { throw new Error("should not prompt"); },
      env,
      exit: () => { throw new Error("should not exit"); },
    });
    assert.equal(env.NVIDIA_API_KEY, "nvapi-test123");
  });

  it("prompts and saves valid key", async () => {
    const env = {};
    let saved = null;
    await ensureApiKey({
      getCredential: () => null,
      saveCredential: (key, val) => { saved = { key, val }; },
      prompt: () => "nvapi-valid-key-here",
      env,
      exit: () => { throw new Error("should not exit"); },
    });
    assert.equal(env.NVIDIA_API_KEY, "nvapi-valid-key-here");
    assert.deepEqual(saved, { key: "NVIDIA_API_KEY", val: "nvapi-valid-key-here" });
  });

  it("calls exit for empty key", async () => {
    let exited = false;
    await ensureApiKey({
      getCredential: () => null,
      saveCredential: () => {},
      prompt: () => "",
      env: {},
      exit: () => { exited = true; },
    });
    assert.equal(exited, true);
  });

  it("calls exit for key not starting with nvapi-", async () => {
    let exited = false;
    await ensureApiKey({
      getCredential: () => null,
      saveCredential: () => {},
      prompt: () => "sk-wrong-prefix",
      env: {},
      exit: () => { exited = true; },
    });
    assert.equal(exited, true);
  });

  it("does not save invalid key", async () => {
    let saved = false;
    await ensureApiKey({
      getCredential: () => null,
      saveCredential: () => { saved = true; },
      prompt: () => "bad-key",
      env: {},
      exit: () => {},
    });
    assert.equal(saved, false);
  });
});

// ── ensureGithubToken ───────────────────────────────────────────

describe("ensureGithubToken()", () => {
  it("sets env and returns when credential exists", async () => {
    const env = {};
    await ensureGithubToken({
      getCredential: (key) => key === "GITHUB_TOKEN" ? "ghp_test123" : null,
      saveCredential: () => {},
      prompt: () => { throw new Error("should not prompt"); },
      execSync: () => { throw new Error("should not exec"); },
      env,
      exit: () => { throw new Error("should not exit"); },
    });
    assert.equal(env.GITHUB_TOKEN, "ghp_test123");
  });

  it("falls back to gh auth token", async () => {
    const env = {};
    await ensureGithubToken({
      getCredential: () => null,
      saveCredential: () => {},
      prompt: () => { throw new Error("should not prompt"); },
      execSync: () => "ghp_from_cli\n",
      env,
      exit: () => { throw new Error("should not exit"); },
    });
    assert.equal(env.GITHUB_TOKEN, "ghp_from_cli");
  });

  it("prompts when gh auth token fails", async () => {
    const env = {};
    let saved = null;
    await ensureGithubToken({
      getCredential: () => null,
      saveCredential: (key, val) => { saved = { key, val }; },
      prompt: () => "ghp_manual_token",
      execSync: () => { throw new Error("gh not installed"); },
      env,
      exit: () => { throw new Error("should not exit"); },
    });
    assert.equal(env.GITHUB_TOKEN, "ghp_manual_token");
    assert.deepEqual(saved, { key: "GITHUB_TOKEN", val: "ghp_manual_token" });
  });

  it("prompts when gh auth token returns empty", async () => {
    const env = {};
    await ensureGithubToken({
      getCredential: () => null,
      saveCredential: () => {},
      prompt: () => "ghp_fallback",
      execSync: () => "  \n",
      env,
      exit: () => { throw new Error("should not exit"); },
    });
    // Empty gh auth output falls through to prompt
    // But trimmed " \n" => "" which is falsy, so falls through
    assert.equal(env.GITHUB_TOKEN, "ghp_fallback");
  });

  it("calls exit for empty token from prompt", async () => {
    let exited = false;
    await ensureGithubToken({
      getCredential: () => null,
      saveCredential: () => {},
      prompt: () => "",
      execSync: () => { throw new Error("gh fail"); },
      env: {},
      exit: () => { exited = true; },
    });
    assert.equal(exited, true);
  });

  it("does not save empty token", async () => {
    let saved = false;
    await ensureGithubToken({
      getCredential: () => null,
      saveCredential: () => { saved = true; },
      prompt: () => "",
      execSync: () => { throw new Error("no gh"); },
      env: {},
      exit: () => {},
    });
    assert.equal(saved, false);
  });
});
