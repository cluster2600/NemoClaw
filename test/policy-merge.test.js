// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { mergePresetIntoPolicy } = require("../bin/lib/policies");

describe("mergePresetIntoPolicy", () => {
  const sampleEntries =
    "  allow_outlook:\n" +
    "    endpoints:\n" +
    "      - host: graph.microsoft.com\n" +
    "        port: 443";

  // ── Path 3: no current policy ──────────────────────────────────
  describe("no current policy (empty/falsy)", () => {
    it("creates minimal document from empty string", () => {
      const result = mergePresetIntoPolicy("", sampleEntries);
      assert.ok(result.startsWith("version: 1"));
      assert.ok(result.includes("network_policies:"));
      assert.ok(result.includes("allow_outlook:"));
    });

    it("creates minimal document from null", () => {
      const result = mergePresetIntoPolicy(null, sampleEntries);
      assert.ok(result.startsWith("version: 1"));
      assert.ok(result.includes("network_policies:"));
      assert.ok(result.includes("allow_outlook:"));
    });

    it("creates minimal document from undefined", () => {
      const result = mergePresetIntoPolicy(undefined, sampleEntries);
      assert.ok(result.startsWith("version: 1"));
      assert.ok(result.includes("network_policies:"));
    });

    it("preserves preset entries exactly", () => {
      const result = mergePresetIntoPolicy("", sampleEntries);
      assert.ok(result.endsWith(sampleEntries));
    });
  });

  // ── Path 2: current policy exists, no network_policies ────────
  describe("current policy without network_policies section", () => {
    it("appends network_policies section", () => {
      const current = "version: 1\nbinaries:\n  - /usr/local/bin/openclaw";
      const result = mergePresetIntoPolicy(current, sampleEntries);
      assert.ok(result.includes("version: 1"));
      assert.ok(result.includes("binaries:"));
      assert.ok(result.includes("network_policies:"));
      assert.ok(result.includes("allow_outlook:"));
    });

    it("prepends version: 1 when version field missing", () => {
      const current = "binaries:\n  - /usr/local/bin/openclaw";
      const result = mergePresetIntoPolicy(current, sampleEntries);
      assert.ok(result.startsWith("version: 1\n"));
      assert.ok(result.includes("binaries:"));
      assert.ok(result.includes("network_policies:"));
    });

    it("does not duplicate version when already present", () => {
      const current = "version: 2\nbinaries:\n  - /usr/bin/pip";
      const result = mergePresetIntoPolicy(current, sampleEntries);
      assert.ok(result.startsWith("version: 2"));
      const versionCount = (result.match(/version:/g) || []).length;
      assert.equal(versionCount, 1);
    });

    it("preserves all existing content", () => {
      const current = "version: 1\nbinaries:\n  - /usr/local/bin/openclaw\n  - /usr/bin/pip";
      const result = mergePresetIntoPolicy(current, sampleEntries);
      assert.ok(result.includes("/usr/local/bin/openclaw"));
      assert.ok(result.includes("/usr/bin/pip"));
    });
  });

  // ── Path 1: current policy with network_policies section ──────
  describe("current policy with existing network_policies section", () => {
    it("injects entries when network_policies is the last section", () => {
      const current =
        "version: 1\nnetwork_policies:\n  existing_rule:\n    endpoints:\n      - host: example.com";
      const result = mergePresetIntoPolicy(current, sampleEntries);
      assert.ok(result.includes("existing_rule:"));
      assert.ok(result.includes("allow_outlook:"));
    });

    it("injects entries before the next top-level key", () => {
      const current =
        "version: 1\nnetwork_policies:\n  existing_rule:\n    endpoints:\n      - host: example.com\nbinaries:\n  - /usr/bin/curl";
      const result = mergePresetIntoPolicy(current, sampleEntries);
      // Preset entries should appear after existing_rule but before binaries
      const outlookIdx = result.indexOf("allow_outlook:");
      const binariesIdx = result.indexOf("binaries:");
      assert.ok(outlookIdx > 0, "preset entries must be in result");
      assert.ok(outlookIdx < binariesIdx, "preset entries must appear before binaries section");
    });

    it("preserves all existing network_policies entries", () => {
      const current =
        "version: 1\nnetwork_policies:\n  rule_a:\n    endpoints:\n      - host: a.com\n  rule_b:\n    endpoints:\n      - host: b.com";
      const result = mergePresetIntoPolicy(current, sampleEntries);
      assert.ok(result.includes("rule_a:"));
      assert.ok(result.includes("rule_b:"));
      assert.ok(result.includes("allow_outlook:"));
    });

    it("handles empty network_policies section (last in file)", () => {
      const current = "version: 1\nnetwork_policies:";
      const result = mergePresetIntoPolicy(current, sampleEntries);
      assert.ok(result.includes("network_policies:"));
      assert.ok(result.includes("allow_outlook:"));
    });

    it("handles empty network_policies section followed by another key", () => {
      const current = "version: 1\nnetwork_policies:\nbinaries:\n  - /usr/bin/curl";
      const result = mergePresetIntoPolicy(current, sampleEntries);
      assert.ok(result.includes("allow_outlook:"));
      assert.ok(result.includes("binaries:"));
    });

    it("does not insert entries twice", () => {
      const current =
        "version: 1\nnetwork_policies:\n  existing:\n    endpoints:\n      - host: foo.com\nbinaries:\n  - /usr/bin/curl\nother_section:\n  key: val";
      const result = mergePresetIntoPolicy(current, sampleEntries);
      const count = (result.match(/allow_outlook:/g) || []).length;
      assert.equal(count, 1, "entries should be inserted exactly once");
    });

    it("handles multiple top-level keys after network_policies", () => {
      const current =
        "version: 1\nnetwork_policies:\n  rule:\n    endpoints:\n      - host: x.com\nbinaries:\n  - /usr/bin/a\nmetadata:\n  author: test";
      const result = mergePresetIntoPolicy(current, sampleEntries);
      const outlookIdx = result.indexOf("allow_outlook:");
      const binariesIdx = result.indexOf("binaries:");
      const metadataIdx = result.indexOf("metadata:");
      assert.ok(outlookIdx < binariesIdx);
      assert.ok(binariesIdx < metadataIdx);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────
  describe("edge cases", () => {
    it("handles multiline preset entries", () => {
      const entries =
        "  rule_a:\n    endpoints:\n      - host: a.com\n  rule_b:\n    endpoints:\n      - host: b.com";
      const result = mergePresetIntoPolicy("", entries);
      assert.ok(result.includes("rule_a:"));
      assert.ok(result.includes("rule_b:"));
    });

    it("handles preset entries with ports", () => {
      const entries = "  allow_api:\n    endpoints:\n      - host: api.example.com\n        port: 8443";
      const result = mergePresetIntoPolicy("", entries);
      assert.ok(result.includes("port: 8443"));
    });

    it("works with real preset content from local-inference", () => {
      const policies = require("../bin/lib/policies");
      const preset = policies.loadPreset("local-inference");
      const entries = policies.extractPresetEntries(preset);
      const current = "version: 1\nnetwork_policies:\n  existing:\n    endpoints:\n      - host: foo.com";
      const result = mergePresetIntoPolicy(current, entries);
      assert.ok(result.includes("host.openshell.internal"));
      assert.ok(result.includes("existing:"));
    });
  });
});
