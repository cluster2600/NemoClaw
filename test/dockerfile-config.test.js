// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  isSafeOriginsList,
  isSafeVersion,
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

// ---------------------------------------------------------------------------
// Sandbox home directory permissions (#622)
// ---------------------------------------------------------------------------

describe("Dockerfile config: sandbox home directory permissions (#622)", () => {
  it("Dockerfile explicitly sets /sandbox to chmod 755", () => {
    const repoDockerfile = path.join(__dirname, "..", "Dockerfile");
    const content = fs.readFileSync(repoDockerfile, "utf8");
    assert.match(
      content,
      /chmod\s+755\s+\/sandbox\b/,
      "Dockerfile must explicitly chmod 755 /sandbox to prevent 0711 permission issues"
    );
  });

  it("test Dockerfile also sets /sandbox to chmod 755", () => {
    const testDockerfile = path.join(__dirname, "Dockerfile.sandbox");
    const content = fs.readFileSync(testDockerfile, "utf8");
    assert.match(
      content,
      /chmod\s+755\s+\/sandbox\b/,
      "Test Dockerfile must also chmod 755 /sandbox"
    );
  });

  it("startup script contains fix_home_permissions function", () => {
    const startScript = path.join(__dirname, "..", "scripts", "nemoclaw-start.sh");
    const content = fs.readFileSync(startScript, "utf8");
    assert.match(
      content,
      /fix_home_permissions/,
      "nemoclaw-start.sh must contain fix_home_permissions for runtime repair"
    );
  });

  it("startup script repairs restrictive modes (700, 711, 710)", () => {
    const startScript = path.join(__dirname, "..", "scripts", "nemoclaw-start.sh");
    const content = fs.readFileSync(startScript, "utf8");
    // The case statement must cover the known restrictive modes
    assert.match(content, /700/, "Must handle mode 700");
    assert.match(content, /711/, "Must handle mode 711");
    assert.match(content, /710/, "Must handle mode 710");
    assert.match(content, /chmod\s+755/, "Must repair to 755");
  });
});

// ---------------------------------------------------------------------------
// Build toolchain for native Node.js addons (#724)
// ---------------------------------------------------------------------------

describe("Dockerfile config: build toolchain for native addons (#724)", () => {
  it("Dockerfile installs build-essential for native module compilation", () => {
    const repoDockerfile = path.join(__dirname, "..", "Dockerfile");
    const content = fs.readFileSync(repoDockerfile, "utf8");
    assert.match(
      content,
      /build-essential/,
      "Dockerfile must install build-essential for native addon compilation on aarch64"
    );
  });

  it("Dockerfile installs python3-dev for node-gyp", () => {
    const repoDockerfile = path.join(__dirname, "..", "Dockerfile");
    const content = fs.readFileSync(repoDockerfile, "utf8");
    assert.match(
      content,
      /python3-dev/,
      "Dockerfile must install python3-dev for node-gyp native builds"
    );
  });

  it("Dockerfile removes build toolchain after npm installs to save image size", () => {
    const repoDockerfile = path.join(__dirname, "..", "Dockerfile");
    const content = fs.readFileSync(repoDockerfile, "utf8");
    assert.match(
      content,
      /apt-get purge.*build-essential/,
      "Dockerfile must purge build-essential after native addons are compiled"
    );
  });

  it("test Dockerfile also installs build-essential", () => {
    const testDockerfile = path.join(__dirname, "Dockerfile.sandbox");
    const content = fs.readFileSync(testDockerfile, "utf8");
    assert.match(
      content,
      /build-essential/,
      "Test Dockerfile must also install build-essential"
    );
  });

  it("test Dockerfile removes build toolchain after compilation", () => {
    const testDockerfile = path.join(__dirname, "Dockerfile.sandbox");
    const content = fs.readFileSync(testDockerfile, "utf8");
    assert.match(
      content,
      /apt-get purge.*build-essential/,
      "Test Dockerfile must also purge build-essential after compilation"
    );
  });

  it("build tools are installed before OpenClaw npm install", () => {
    const repoDockerfile = path.join(__dirname, "..", "Dockerfile");
    const content = fs.readFileSync(repoDockerfile, "utf8");
    const buildEssentialIdx = content.indexOf("build-essential");
    const npmInstallIdx = content.indexOf("npm install -g openclaw");
    assert.ok(
      buildEssentialIdx < npmInstallIdx,
      "build-essential must be installed before npm install -g openclaw"
    );
  });

  it("build tools are purged after the last npm install", () => {
    const repoDockerfile = path.join(__dirname, "..", "Dockerfile");
    const content = fs.readFileSync(repoDockerfile, "utf8");
    const lastNpmInstall = content.lastIndexOf("npm install");
    const purgeIdx = content.indexOf("apt-get purge");
    assert.ok(
      purgeIdx > lastNpmInstall,
      "build-essential purge must come after the last npm install"
    );
  });
});

// ---------------------------------------------------------------------------
// Build-arg injection prevention (security hardening)
// ---------------------------------------------------------------------------

describe("Build-arg injection prevention (security)", () => {
  // --- isSafeVersion validation ---

  it("isSafeVersion accepts valid semver-like strings", () => {
    assert.ok(isSafeVersion("2026.3.22"));
    assert.ok(isSafeVersion("1.0.0-rc.1"));
    assert.ok(isSafeVersion("latest"));
    assert.ok(isSafeVersion("2026.3.11_beta"));
  });

  it("isSafeVersion rejects single-quote injection", () => {
    assert.ok(!isSafeVersion("1.0'; import os; os.system('rm -rf /'); '"));
  });

  it("isSafeVersion rejects backtick injection", () => {
    assert.ok(!isSafeVersion("1.0`touch /tmp/pwned`"));
  });

  it("isSafeVersion rejects semicolon injection", () => {
    assert.ok(!isSafeVersion("1.0; echo pwned"));
  });

  it("isSafeVersion rejects spaces", () => {
    assert.ok(!isSafeVersion("1.0 || true"));
  });

  it("isSafeVersion rejects dollar sign", () => {
    assert.ok(!isSafeVersion("$(whoami)"));
  });

  // --- isSafeOriginsList validation ---

  it("isSafeOriginsList accepts valid comma-separated URLs", () => {
    assert.ok(isSafeOriginsList("http://192.168.1.50:3333,http://10.0.0.5:18789"));
    assert.ok(isSafeOriginsList("http://localhost:3000"));
    assert.ok(isSafeOriginsList("https://my-server.local:8443"));
  });

  it("isSafeOriginsList rejects single-quote injection", () => {
    assert.ok(!isSafeOriginsList("http://ok:3000'; import os; '"));
  });

  it("isSafeOriginsList rejects backtick injection", () => {
    assert.ok(!isSafeOriginsList("http://ok:3000`touch /tmp/pwned`"));
  });

  it("isSafeOriginsList rejects semicolon injection", () => {
    assert.ok(!isSafeOriginsList("http://ok:3000; echo pwned"));
  });

  it("isSafeOriginsList rejects dollar sign expansion", () => {
    assert.ok(!isSafeOriginsList("$(whoami)"));
  });

  // --- patchDockerfileVersion throws on injection ---

  it("patchDockerfileVersion throws on injection attempt", () => {
    const { tmpDir, dockerfilePath } = writeTmpDockerfile(DOCKERFILE_TEMPLATE);
    try {
      assert.throws(
        () => patchDockerfileVersion(dockerfilePath, "1.0'; import os; '"),
        /Invalid NEMOCLAW_OPENCLAW_VERSION/
      );
      // Dockerfile must be unchanged
      const content = fs.readFileSync(dockerfilePath, "utf8");
      assert.match(content, /^ARG OPENCLAW_VERSION=2026\.3\.11$/m);
    } finally {
      cleanup(tmpDir);
    }
  });

  it("patchDockerfileExtraOrigins throws on injection attempt", () => {
    const { tmpDir, dockerfilePath } = writeTmpDockerfile(DOCKERFILE_TEMPLATE);
    try {
      assert.throws(
        () => patchDockerfileExtraOrigins(dockerfilePath, "http://ok:3000'; os.system('evil'); '"),
        /Invalid NEMOCLAW_EXTRA_ORIGINS/
      );
      // Dockerfile must be unchanged
      const content = fs.readFileSync(dockerfilePath, "utf8");
      assert.match(content, /^ARG NEMOCLAW_EXTRA_ORIGINS=$/m);
    } finally {
      cleanup(tmpDir);
    }
  });

  // --- Dockerfile uses os.environ instead of shell interpolation ---

  it("Dockerfile Python config reads values via os.environ, not shell interpolation", () => {
    const repoDockerfile = path.join(__dirname, "..", "Dockerfile");
    const content = fs.readFileSync(repoDockerfile, "utf8");
    // Must use os.environ.get() for all three config values
    assert.match(
      content,
      /os\.environ\.get\('NEMOCLAW_MODEL'/,
      "Dockerfile must read NEMOCLAW_MODEL via os.environ.get()"
    );
    assert.match(
      content,
      /os\.environ\.get\('CHAT_UI_URL'/,
      "Dockerfile must read CHAT_UI_URL via os.environ.get()"
    );
    assert.match(
      content,
      /os\.environ\.get\('NEMOCLAW_EXTRA_ORIGINS'/,
      "Dockerfile must read NEMOCLAW_EXTRA_ORIGINS via os.environ.get()"
    );
    // Must NOT use the old vulnerable pattern: model = '${VAR}'
    assert.doesNotMatch(
      content,
      /model\s*=\s*'\$\{NEMOCLAW_MODEL\}'/,
      "Dockerfile must NOT use shell interpolation for NEMOCLAW_MODEL"
    );
    assert.doesNotMatch(
      content,
      /chat_ui_url\s*=\s*'\$\{CHAT_UI_URL\}'/,
      "Dockerfile must NOT use shell interpolation for CHAT_UI_URL"
    );
  });

  // --- Model-aware reasoning and maxTokens configuration (#736) ---

  it("Dockerfile Python config sets reasoning=True for reasoning-capable models", () => {
    const repoDockerfile = path.join(__dirname, "..", "Dockerfile");
    const content = fs.readFileSync(repoDockerfile, "utf8");
    // Must define reasoning_models set
    assert.match(
      content,
      /reasoning_models\s*=/,
      "Dockerfile must define reasoning_models set for model-aware config"
    );
    // Nemotron 3 Super must be in the reasoning set
    assert.match(
      content,
      /nvidia\/nemotron-3-super-120b-a12b.*reasoning_models|reasoning_models.*nvidia\/nemotron-3-super-120b-a12b/s,
      "Nemotron 3 Super 120B must be listed as a reasoning model"
    );
  });

  it("Dockerfile Python config uses model-aware maxTokens", () => {
    const repoDockerfile = path.join(__dirname, "..", "Dockerfile");
    const content = fs.readFileSync(repoDockerfile, "utf8");
    // Must define model_max_tokens dict
    assert.match(
      content,
      /model_max_tokens\s*=/,
      "Dockerfile must define model_max_tokens for per-model output limits"
    );
    // Nemotron 3 Super should have 8192 maxTokens
    assert.match(
      content,
      /nemotron-3-super-120b-a12b.*8192/s,
      "Nemotron 3 Super must have 8192 maxTokens"
    );
  });

  it("Dockerfile Python config uses model_entry helper to avoid hardcoded values", () => {
    const repoDockerfile = path.join(__dirname, "..", "Dockerfile");
    const content = fs.readFileSync(repoDockerfile, "utf8");
    // Must define model_entry function and call it for both providers
    assert.match(
      content,
      /def model_entry/,
      "Dockerfile must define model_entry() helper"
    );
    assert.match(
      content,
      /model_entry\(model\.split/,
      "nvidia provider must use model_entry() with split ID"
    );
    assert.match(
      content,
      /model_entry\(model, model\)/,
      "inference provider must use model_entry() with full model ID"
    );
  });

  it("Dockerfile promotes ARGs to ENV for safe Python access", () => {
    const repoDockerfile = path.join(__dirname, "..", "Dockerfile");
    const content = fs.readFileSync(repoDockerfile, "utf8");
    // ENV block must promote all three ARGs
    assert.match(
      content,
      /ENV\s+NEMOCLAW_MODEL=\$\{NEMOCLAW_MODEL\}/,
      "Dockerfile must promote NEMOCLAW_MODEL ARG to ENV"
    );
    assert.match(
      content,
      /CHAT_UI_URL=\$\{CHAT_UI_URL\}/,
      "Dockerfile must promote CHAT_UI_URL ARG to ENV"
    );
    assert.match(
      content,
      /NEMOCLAW_EXTRA_ORIGINS=\$\{NEMOCLAW_EXTRA_ORIGINS\}/,
      "Dockerfile must promote NEMOCLAW_EXTRA_ORIGINS ARG to ENV"
    );
  });
});
