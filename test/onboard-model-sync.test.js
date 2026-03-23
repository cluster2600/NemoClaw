// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  patchDockerfileModel,
} = require("../bin/lib/onboard");

describe("Dockerfile model sync (#628)", () => {
  it("patchDockerfileModel replaces the default NEMOCLAW_MODEL ARG", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dockerfile-test-"));
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    try {
      fs.writeFileSync(
        dockerfilePath,
        [
          "FROM node:22-slim",
          "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
          "ARG CHAT_UI_URL=http://127.0.0.1:18789",
          'RUN echo "${NEMOCLAW_MODEL}"',
        ].join("\n")
      );

      patchDockerfileModel(dockerfilePath, "nemotron-3-nano:30b");

      const result = fs.readFileSync(dockerfilePath, "utf8");
      assert.match(result, /^ARG NEMOCLAW_MODEL=nemotron-3-nano:30b$/m);
      // Other ARGs must be untouched
      assert.match(result, /^ARG CHAT_UI_URL=http:\/\/127\.0\.0\.1:18789$/m);
      // Rest of the file is preserved
      assert.match(result, /FROM node:22-slim/);
      assert.match(result, /RUN echo/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("patchDockerfileModel handles Ollama model IDs with colons", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dockerfile-test-"));
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    try {
      fs.writeFileSync(
        dockerfilePath,
        "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b\n"
      );

      patchDockerfileModel(dockerfilePath, "qwen3:32b");

      const result = fs.readFileSync(dockerfilePath, "utf8");
      assert.match(result, /^ARG NEMOCLAW_MODEL=qwen3:32b$/m);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("patchDockerfileModel handles vLLM model IDs with slashes", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dockerfile-test-"));
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    try {
      fs.writeFileSync(
        dockerfilePath,
        "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b\n"
      );

      patchDockerfileModel(dockerfilePath, "meta/llama-3.1-70b-instruct");

      const result = fs.readFileSync(dockerfilePath, "utf8");
      assert.match(result, /^ARG NEMOCLAW_MODEL=meta\/llama-3\.1-70b-instruct$/m);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("patchDockerfileModel is a no-op when model is null or undefined", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dockerfile-test-"));
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    try {
      const original = "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b\n";
      fs.writeFileSync(dockerfilePath, original);

      patchDockerfileModel(dockerfilePath, null);
      assert.equal(fs.readFileSync(dockerfilePath, "utf8"), original);

      patchDockerfileModel(dockerfilePath, undefined);
      assert.equal(fs.readFileSync(dockerfilePath, "utf8"), original);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("selectInferenceProvider is exported", () => {
    const { selectInferenceProvider } = require("../bin/lib/onboard");
    assert.equal(typeof selectInferenceProvider, "function");
  });

  it("real Dockerfile ARG line is patchable", () => {
    // Verify the actual Dockerfile in the repo has the expected ARG line
    const repoDockerfile = path.join(__dirname, "..", "Dockerfile");
    const content = fs.readFileSync(repoDockerfile, "utf8");
    assert.match(
      content,
      /^ARG NEMOCLAW_MODEL=/m,
      "Dockerfile must contain ARG NEMOCLAW_MODEL= for patchDockerfileModel to work"
    );
  });
});
