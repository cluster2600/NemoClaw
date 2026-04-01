// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawPluginApi } from "./index.js";

vi.mock("./onboard/config.js", () => ({
  loadOnboardConfig: vi.fn(),
  describeOnboardEndpoint: vi.fn(() => "build.nvidia.com"),
  describeOnboardProvider: vi.fn(() => "NVIDIA Endpoint API"),
}));

import register, { getPluginConfig } from "./index.js";
import { loadOnboardConfig } from "./onboard/config.js";
import {
  evaluateMemorySecretGuard,
  isProtectedMemoryPath,
  resolveWorkspaceDir,
  scanForMemorySecrets,
} from "./memory-secret-guard.js";

const mockedLoadOnboardConfig = vi.mocked(loadOnboardConfig);

function createMockApi(): OpenClawPluginApi {
  return {
    id: "nemoclaw",
    name: "NemoClaw",
    version: "0.1.0",
    config: {},
    pluginConfig: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerCommand: vi.fn(),
    registerProvider: vi.fn(),
    registerService: vi.fn(),
    resolvePath: vi.fn((p: string) => p),
    on: vi.fn(),
  };
}

describe("plugin registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLoadOnboardConfig.mockReturnValue(null);
  });

  it("registers a slash command", () => {
    const api = createMockApi();
    register(api);
    expect(api.registerCommand).toHaveBeenCalledWith(expect.objectContaining({ name: "nemoclaw" }));
  });

  it("registers an inference provider", () => {
    const api = createMockApi();
    register(api);
    expect(api.registerProvider).toHaveBeenCalledWith(expect.objectContaining({ id: "inference" }));
  });

  it("registers a before_tool_call hook for persistent memory writes", () => {
    const api = createMockApi();
    register(api);
    expect(api.on).toHaveBeenCalledWith("before_tool_call", expect.any(Function));
  });

  it("does NOT register CLI commands", () => {
    const api = createMockApi();
    // registerCli should not exist on the API interface after removal
    expect("registerCli" in api).toBe(false);
  });

  it("registers custom model when onboard config has a model", () => {
    mockedLoadOnboardConfig.mockReturnValue({
      endpointType: "build",
      endpointUrl: "https://api.build.nvidia.com/v1",
      ncpPartner: null,
      model: "nvidia/custom-model",
      profile: "default",
      credentialEnv: "NVIDIA_API_KEY",
      onboardedAt: "2026-03-01T00:00:00.000Z",
    });
    const api = createMockApi();
    register(api);
    const providerArg = vi.mocked(api.registerProvider).mock.calls[0][0];
    expect(providerArg.models?.chat).toEqual([
      expect.objectContaining({ id: "inference/nvidia/custom-model" }),
    ]);
  });

  it("blocks likely secrets from being written into persistent memory", () => {
    const api = createMockApi();
    register(api);

    const hook = vi
      .mocked(api.on)
      .mock.calls.find(([hookName]) => hookName === "before_tool_call")?.[1];
    expect(hook).toBeTypeOf("function");

    const result = (hook as (event: unknown) => unknown)({
      toolName: "Write",
      params: {
        file_path: "/sandbox/.openclaw/workspace/MEMORY.md",
        content: "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    });

    expect(result).toEqual({
      block: true,
      blockReason: expect.stringContaining("GitHub token"),
    });
  });
});

describe("memory secret guard", () => {
  it("uses the default workspace path when no workspace is configured", () => {
    expect(resolveWorkspaceDir({})).toBe("/sandbox/.openclaw/workspace");
  });

  it("uses the configured workspace path when one is provided", () => {
    expect(
      resolveWorkspaceDir({
        agents: {
          defaults: {
            workspace: "/sandbox/custom-workspace",
          },
        },
      }),
    ).toBe("/sandbox/custom-workspace");
  });

  it("protects MEMORY.md and daily memory files only", () => {
    expect(
      isProtectedMemoryPath(
        "/sandbox/.openclaw/workspace/MEMORY.md",
        "/sandbox/.openclaw/workspace",
      ),
    ).toBe(true);
    expect(
      isProtectedMemoryPath(
        "/sandbox/.openclaw/workspace/memory/2026-04-01.md",
        "/sandbox/.openclaw/workspace",
      ),
    ).toBe(true);
    expect(
      isProtectedMemoryPath("/sandbox/.openclaw/workspace/USER.md", "/sandbox/.openclaw/workspace"),
    ).toBe(false);
    expect(isProtectedMemoryPath("/tmp/random.md", "/sandbox/.openclaw/workspace")).toBe(false);
  });

  it("detects high-confidence GitHub tokens", () => {
    expect(scanForMemorySecrets("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toEqual([
      {
        ruleId: "github-pat",
        label: "GitHub token",
      },
    ]);
  });

  it("allows non-secret writes into MEMORY.md", () => {
    expect(
      evaluateMemorySecretGuard({
        toolName: "write",
        toolParams: {
          file_path: "/sandbox/.openclaw/workspace/MEMORY.md",
          content: "Remember to check the nightly build in the morning.",
        },
        config: {},
      }),
    ).toBeUndefined();
  });

  it("ignores writes outside persistent memory", () => {
    expect(
      evaluateMemorySecretGuard({
        toolName: "write",
        toolParams: {
          file_path: "/sandbox/.openclaw/workspace/USER.md",
          content: "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
        config: {},
      }),
    ).toBeUndefined();
  });

  it("blocks edits that add a private key to daily memory", () => {
    const result = evaluateMemorySecretGuard({
      toolName: "edit",
      toolParams: {
        file_path: "/sandbox/.openclaw/workspace/memory/2026-04-01.md",
        new_string:
          "-----BEGIN PRIVATE KEY-----\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END PRIVATE KEY-----",
      },
      config: {},
    });

    expect(result).toEqual({
      block: true,
      blockReason: expect.stringContaining("Private key"),
    });
  });
});

describe("getPluginConfig", () => {
  it("returns defaults when pluginConfig is undefined", () => {
    const api = createMockApi();
    api.pluginConfig = undefined;
    const config = getPluginConfig(api);
    expect(config.blueprintVersion).toBe("latest");
    expect(config.blueprintRegistry).toBe("ghcr.io/nvidia/nemoclaw-blueprint");
    expect(config.sandboxName).toBe("openclaw");
    expect(config.inferenceProvider).toBe("nvidia");
  });

  it("returns defaults when pluginConfig has non-string values", () => {
    const api = createMockApi();
    api.pluginConfig = { blueprintVersion: 42, sandboxName: true };
    const config = getPluginConfig(api);
    expect(config.blueprintVersion).toBe("latest");
    expect(config.sandboxName).toBe("openclaw");
  });

  it("uses string values from pluginConfig", () => {
    const api = createMockApi();
    api.pluginConfig = {
      blueprintVersion: "2.0.0",
      blueprintRegistry: "ghcr.io/custom/registry",
      sandboxName: "custom-sandbox",
      inferenceProvider: "openai",
    };
    const config = getPluginConfig(api);
    expect(config.blueprintVersion).toBe("2.0.0");
    expect(config.blueprintRegistry).toBe("ghcr.io/custom/registry");
    expect(config.sandboxName).toBe("custom-sandbox");
    expect(config.inferenceProvider).toBe("openai");
  });
});
