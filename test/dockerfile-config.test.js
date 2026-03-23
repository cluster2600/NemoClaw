// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  patchDockerfileVersion,
  patchDockerfileExtraOrigins,
} = require("../bin/lib/onboard");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp Dockerfile with the real ARG lines for patching tests. */
function writeTmpDockerfile(content) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dfc-test-"));
  const dockerfilePath = path.join(tmpDir, "Dockerfile");
  fs.writeFileSync(dockerfilePath, content);
  return { tmpDir, dockerfilePath };
}

function cleanup(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const DOCKERFILE_TEMPLATE = [
  "FROM node:22-slim",
  "ARG OPENCLAW_VERSION=2026.3.11",
  "RUN npm install -g openclaw@${OPENCLAW_VERSION}",
  "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
  "ARG CHAT_UI_URL=http://127.0.0.1:18789",
  "ARG NEMOCLAW_EXTRA_ORIGINS=",
  "ARG NEMOCLAW_BUILD_ID=default",
].join("\n");

// ---------------------------------------------------------------------------
// patchDockerfileVersion
// ---------------------------------------------------------------------------

describe("Dockerfile config: OpenClaw version build arg (#739)", () => {
  it("patchDockerfileVersion replaces the default OPENCLAW_VERSION ARG", () => {
    const { tmpDir, dockerfilePath } = writeTmpDockerfile(DOCKERFILE_TEMPLATE);
    try {
      patchDockerfileVersion(dockerfilePath, "2026.3.22");
      const result = fs.readFileSync(dockerfilePath, "utf8");
      assert.match(result, /^ARG OPENCLAW_VERSION=2026\.3\.22$/m);
      // Other ARGs untouched
      assert.match(result, /^ARG NEMOCLAW_MODEL=/m);
      assert.match(result, /^ARG CHAT_UI_URL=/m);
    } finally {
      cleanup(tmpDir);
    }
  });

  it("patchDockerfileVersion is a no-op when version is null or undefined", () => {
    const { tmpDir, dockerfilePath } = writeTmpDockerfile(DOCKERFILE_TEMPLATE);
    try {
      const original = fs.readFileSync(dockerfilePath, "utf8");
      patchDockerfileVersion(dockerfilePath, null);
      assert.equal(fs.readFileSync(dockerfilePath, "utf8"), original);
      patchDockerfileVersion(dockerfilePath, undefined);
      assert.equal(fs.readFileSync(dockerfilePath, "utf8"), original);
    } finally {
      cleanup(tmpDir);
    }
  });

  it("real Dockerfile has OPENCLAW_VERSION ARG", () => {
    const repoDockerfile = path.join(__dirname, "..", "Dockerfile");
    const content = fs.readFileSync(repoDockerfile, "utf8");
    assert.match(
      content,
      /^ARG OPENCLAW_VERSION=/m,
      "Dockerfile must contain ARG OPENCLAW_VERSION= for patchDockerfileVersion to work"
    );
  });
});

// ---------------------------------------------------------------------------
// patchDockerfileExtraOrigins
// ---------------------------------------------------------------------------

describe("Dockerfile config: extra CORS origins build arg (#739)", () => {
  it("patchDockerfileExtraOrigins sets comma-separated origins", () => {
    const { tmpDir, dockerfilePath } = writeTmpDockerfile(DOCKERFILE_TEMPLATE);
    try {
      const origins = "http://192.168.1.50:3333,http://10.0.0.5:18789";
      patchDockerfileExtraOrigins(dockerfilePath, origins);
      const result = fs.readFileSync(dockerfilePath, "utf8");
      assert.match(
        result,
        /^ARG NEMOCLAW_EXTRA_ORIGINS=http:\/\/192\.168\.1\.50:3333,http:\/\/10\.0\.0\.5:18789$/m
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  it("patchDockerfileExtraOrigins is a no-op when origins is empty or falsy", () => {
    const { tmpDir, dockerfilePath } = writeTmpDockerfile(DOCKERFILE_TEMPLATE);
    try {
      const original = fs.readFileSync(dockerfilePath, "utf8");
      patchDockerfileExtraOrigins(dockerfilePath, null);
      assert.equal(fs.readFileSync(dockerfilePath, "utf8"), original);
      patchDockerfileExtraOrigins(dockerfilePath, "");
      assert.equal(fs.readFileSync(dockerfilePath, "utf8"), original);
    } finally {
      cleanup(tmpDir);
    }
  });

  it("real Dockerfile has NEMOCLAW_EXTRA_ORIGINS ARG", () => {
    const repoDockerfile = path.join(__dirname, "..", "Dockerfile");
    const content = fs.readFileSync(repoDockerfile, "utf8");
    assert.match(
      content,
      /^ARG NEMOCLAW_EXTRA_ORIGINS=/m,
      "Dockerfile must contain ARG NEMOCLAW_EXTRA_ORIGINS= for patching"
    );
  });
});

// ---------------------------------------------------------------------------
// trustedProxies includes private CIDRs
// ---------------------------------------------------------------------------

describe("Dockerfile config: trustedProxies includes private network CIDRs (#739)", () => {
  it("trustedProxies contains RFC1918 CIDR ranges", () => {
    const repoDockerfile = path.join(__dirname, "..", "Dockerfile");
    const content = fs.readFileSync(repoDockerfile, "utf8");
    assert.match(content, /10\.0\.0\.0\/8/, "trustedProxies must include 10.0.0.0/8");
    assert.match(content, /172\.16\.0\.0\/12/, "trustedProxies must include 172.16.0.0/12");
    assert.match(content, /192\.168\.0\.0\/16/, "trustedProxies must include 192.168.0.0/16");
  });

  it("trustedProxies still includes localhost entries", () => {
    const repoDockerfile = path.join(__dirname, "..", "Dockerfile");
    const content = fs.readFileSync(repoDockerfile, "utf8");
    assert.match(content, /127\.0\.0\.1/, "trustedProxies must include 127.0.0.1");
    assert.match(content, /::1/, "trustedProxies must include ::1");
  });
});

// ---------------------------------------------------------------------------
// allowedOrigins extra-origins integration in Dockerfile
// ---------------------------------------------------------------------------

describe("Dockerfile config: allowedOrigins extra-origins parsing (#739)", () => {
  it("Dockerfile Python config parses NEMOCLAW_EXTRA_ORIGINS", () => {
    const repoDockerfile = path.join(__dirname, "..", "Dockerfile");
    const content = fs.readFileSync(repoDockerfile, "utf8");
    // The Python snippet must reference the NEMOCLAW_EXTRA_ORIGINS build arg
    assert.match(
      content,
      /NEMOCLAW_EXTRA_ORIGINS/,
      "Dockerfile Python config must reference NEMOCLAW_EXTRA_ORIGINS"
    );
    // It should split on comma and append to origins
    assert.match(
      content,
      /extra_origins_raw\.split/,
      "Dockerfile must split extra origins by comma"
    );
  });
});
