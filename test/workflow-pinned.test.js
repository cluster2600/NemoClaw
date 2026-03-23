// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const WORKFLOWS_DIR = path.join(__dirname, "..", ".github", "workflows");

/**
 * Matches GitHub Actions `uses:` lines and captures the ref after `@`.
 * Examples:
 *   uses: actions/checkout@abc123def  # v4    → ref = "abc123def"
 *   uses: astral-sh/setup-uv@v4                → ref = "v4"
 */
const USES_RE = /uses:\s+[\w.-]+\/[\w.-]+@([^\s#]+)/g;

/** A full SHA-1 (40 hex chars) indicates a properly pinned action. */
const SHA_RE = /^[0-9a-f]{40}$/;

function getWorkflowFiles() {
  if (!fs.existsSync(WORKFLOWS_DIR)) return [];
  return fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => path.join(WORKFLOWS_DIR, f));
}

describe("GitHub Actions SHA pinning (#578)", () => {
  const files = getWorkflowFiles();

  it("workflow directory exists and contains files", () => {
    assert.ok(files.length > 0, "No workflow files found");
  });

  for (const file of files) {
    const basename = path.basename(file);

    it(`${basename}: all actions are pinned to a full SHA`, () => {
      const content = fs.readFileSync(file, "utf8");
      const unpinned = [];

      for (const match of content.matchAll(USES_RE)) {
        const ref = match[1];
        if (!SHA_RE.test(ref)) {
          unpinned.push(match[0]);
        }
      }

      assert.deepStrictEqual(
        unpinned,
        [],
        `Unpinned actions in ${basename}:\n  ${unpinned.join("\n  ")}\n` +
          "Pin every action to a full commit SHA (40 hex chars) with a # version comment.",
      );
    });
  }
});
