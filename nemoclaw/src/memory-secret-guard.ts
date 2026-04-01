// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

type UnknownRecord = Record<string, unknown>;

export type SecretMatch = {
  ruleId: string;
  label: string;
};

type SecretRule = {
  id: string;
  label: string;
  pattern: RegExp;
};

const DEFAULT_WORKSPACE_DIR = "/sandbox/.openclaw/workspace";
const MEMORY_INDEX_NAME = "MEMORY.md";
const DAILY_MEMORY_DIR_NAME = "memory";

const TEXT_KEYS = new Set([
  "content",
  "new_string",
  "newString",
  "new_str",
  "newText",
  "replacement",
  "text",
  "insert_text",
  "insertText",
]);

const PATH_KEYS = ["file_path", "filePath", "path"];

const WRITE_LIKE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit"]);

const SECRET_RULES: SecretRule[] = [
  {
    id: "anthropic-api-key",
    label: "Anthropic API key",
    pattern: /(?<![A-Za-z0-9_-])sk-ant-api03-[A-Za-z0-9_-]{80,128}(?![A-Za-z0-9_-])/,
  },
  {
    id: "openai-api-key",
    label: "OpenAI API key",
    pattern:
      /\b(?:sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})(?:[\s'"`;"]|$)/,
  },
  {
    id: "github-pat",
    label: "GitHub token",
    pattern: /\b(?:ghp_[0-9A-Za-z]{36}|github_pat_[0-9A-Za-z_]{20,}|gh[ousr]_[0-9A-Za-z]{36})\b/,
  },
  {
    id: "aws-access-token",
    label: "AWS access token",
    pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/,
  },
  {
    id: "slack-bot-token",
    label: "Slack bot token",
    pattern: /\bxoxb-[0-9]{10,13}-[0-9]{10,13}[A-Za-z0-9-]*\b/,
  },
  {
    id: "private-key",
    label: "Private key",
    pattern:
      /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S]{32,}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/i,
  },
];

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

export function resolveWorkspaceDir(config: UnknownRecord): string {
  const agents = asRecord(config["agents"]);
  const defaults = asRecord(agents?.["defaults"]);
  const workspaceDir = defaults?.["workspace"];
  if (typeof workspaceDir === "string" && workspaceDir.trim()) {
    return path.resolve(workspaceDir.trim());
  }
  return DEFAULT_WORKSPACE_DIR;
}

export function isProtectedMemoryPath(filePath: string, workspaceDir: string): boolean {
  const resolvedPath = path.resolve(filePath);
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const memoryIndexPath = path.join(resolvedWorkspaceDir, MEMORY_INDEX_NAME);
  const dailyMemoryDir = path.join(resolvedWorkspaceDir, DAILY_MEMORY_DIR_NAME);
  return (
    resolvedPath === memoryIndexPath || resolvedPath.startsWith(`${dailyMemoryDir}${path.sep}`)
  );
}

function resolveTargetPath(
  params: UnknownRecord,
  resolvePath: ((input: string) => string) | undefined,
): string | null {
  for (const key of PATH_KEYS) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      return resolvePath ? resolvePath(value) : path.resolve(value);
    }
  }
  return null;
}

function collectWritableText(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) {
    return [];
  }
  if (typeof value === "string") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectWritableText(item, depth + 1));
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  const texts: string[] = [];
  for (const [key, nestedValue] of Object.entries(record)) {
    if (TEXT_KEYS.has(key) && typeof nestedValue === "string" && nestedValue.trim()) {
      texts.push(nestedValue);
      continue;
    }
    texts.push(...collectWritableText(nestedValue, depth + 1));
  }
  return texts;
}

export function scanForMemorySecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const rule of SECRET_RULES) {
    if (rule.pattern.test(text)) {
      matches.push({ ruleId: rule.id, label: rule.label });
    }
  }
  return matches;
}

function uniqueLabels(matches: SecretMatch[]): string[] {
  return [...new Set(matches.map((match) => match.label))];
}

function formatMemoryPath(filePath: string, workspaceDir: string): string {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedPath = path.resolve(filePath);
  if (resolvedPath === path.join(resolvedWorkspaceDir, MEMORY_INDEX_NAME)) {
    return MEMORY_INDEX_NAME;
  }
  const dailyDir = path.join(resolvedWorkspaceDir, DAILY_MEMORY_DIR_NAME);
  if (resolvedPath.startsWith(`${dailyDir}${path.sep}`)) {
    return path.join(DAILY_MEMORY_DIR_NAME, path.relative(dailyDir, resolvedPath));
  }
  return path.basename(resolvedPath);
}

export function evaluateMemorySecretGuard(params: {
  toolName: string;
  toolParams: UnknownRecord;
  config: UnknownRecord;
  resolvePath?: (input: string) => string;
}): { block: true; blockReason: string } | undefined {
  const toolName = params.toolName.trim().toLowerCase();
  if (!WRITE_LIKE_TOOLS.has(toolName)) {
    return undefined;
  }

  const targetPath = resolveTargetPath(params.toolParams, params.resolvePath);
  if (!targetPath) {
    return undefined;
  }

  const workspaceDir = resolveWorkspaceDir(params.config);
  if (!isProtectedMemoryPath(targetPath, workspaceDir)) {
    return undefined;
  }

  const textSegments = collectWritableText(params.toolParams);
  if (textSegments.length === 0) {
    return undefined;
  }

  const matches = uniqueLabels(textSegments.flatMap((segment) => scanForMemorySecrets(segment)));
  if (matches.length === 0) {
    return undefined;
  }

  const targetLabel = formatMemoryPath(targetPath, workspaceDir);
  const joinedLabels = matches.join(", ");
  return {
    block: true,
    blockReason:
      `Refusing to write likely secrets (${joinedLabels}) into persistent memory file ${targetLabel}. ` +
      "Remove the sensitive material or keep credentials in the host-side OpenShell provider path instead.",
  };
}
