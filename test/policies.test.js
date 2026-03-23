// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const policies = require("../bin/lib/policies");

describe("policies", () => {
  describe("listPresets", () => {
    it("returns all 10 presets", () => {
      const presets = policies.listPresets();
      assert.equal(presets.length, 10);
    });

    it("each preset has name and description", () => {
      for (const p of policies.listPresets()) {
        assert.ok(p.name, `preset missing name: ${p.file}`);
        assert.ok(p.description, `preset missing description: ${p.file}`);
      }
    });

    it("returns expected preset names", () => {
      const names = policies.listPresets().map((p) => p.name).sort();
      const expected = ["discord", "docker", "huggingface", "jira", "local-inference", "npm", "outlook", "pypi", "slack", "telegram"];
      assert.deepEqual(names, expected);
    });
  });

  describe("loadPreset", () => {
    it("loads existing preset", () => {
      const content = policies.loadPreset("outlook");
      assert.ok(content);
      assert.ok(content.includes("network_policies:"));
    });

    it("returns null for nonexistent preset", () => {
      assert.equal(policies.loadPreset("nonexistent"), null);
    });

    it("rejects path traversal attempts", () => {
      assert.equal(policies.loadPreset("../../etc/passwd"), null);
      assert.equal(policies.loadPreset("../../../etc/shadow"), null);
    });
  });

  describe("getPresetEndpoints", () => {
    it("extracts hosts from outlook preset", () => {
      const content = policies.loadPreset("outlook");
      const hosts = policies.getPresetEndpoints(content);
      assert.ok(hosts.includes("graph.microsoft.com"));
      assert.ok(hosts.includes("login.microsoftonline.com"));
      assert.ok(hosts.includes("outlook.office365.com"));
      assert.ok(hosts.includes("outlook.office.com"));
    });

    it("extracts hosts from telegram preset", () => {
      const content = policies.loadPreset("telegram");
      const hosts = policies.getPresetEndpoints(content);
      assert.deepEqual(hosts, ["api.telegram.org"]);
    });

    it("every preset has at least one endpoint", () => {
      for (const p of policies.listPresets()) {
        const content = policies.loadPreset(p.name);
        const hosts = policies.getPresetEndpoints(content);
        assert.ok(hosts.length > 0, `${p.name} has no endpoints`);
      }
    });
  });

  describe("buildPolicySetCommand", () => {
    it("shell-quotes sandbox name to prevent injection", () => {
      const cmd = policies.buildPolicySetCommand("/tmp/policy.yaml", "my-assistant");
      assert.equal(cmd, "openshell policy set --policy '/tmp/policy.yaml' --wait 'my-assistant'");
    });

    it("escapes shell metacharacters in sandbox name", () => {
      const cmd = policies.buildPolicySetCommand("/tmp/policy.yaml", "test; whoami");
      assert.ok(cmd.includes("'test; whoami'"), "metacharacters must be shell-quoted");
    });

    it("places --wait before the sandbox name", () => {
      const cmd = policies.buildPolicySetCommand("/tmp/policy.yaml", "test-box");
      const waitIdx = cmd.indexOf("--wait");
      const nameIdx = cmd.indexOf("'test-box'");
      assert.ok(waitIdx < nameIdx, "--wait must come before sandbox name");
    });
  });

  describe("buildPolicyGetCommand", () => {
    it("shell-quotes sandbox name", () => {
      const cmd = policies.buildPolicyGetCommand("my-assistant");
      assert.equal(cmd, "openshell policy get --full 'my-assistant' 2>/dev/null");
    });
  });

  describe("local-inference preset", () => {
    it("loads and contains host.openshell.internal", () => {
      const content = policies.loadPreset("local-inference");
      assert.ok(content, "local-inference preset must exist");
      const hosts = policies.getPresetEndpoints(content);
      assert.ok(hosts.includes("host.openshell.internal"), "must allow host.openshell.internal");
    });

    it("allows Ollama port 11434 and vLLM port 8000", () => {
      const content = policies.loadPreset("local-inference");
      assert.ok(content.includes("port: 11434"), "must include Ollama port 11434");
      assert.ok(content.includes("port: 8000"), "must include vLLM port 8000");
    });

    it("has a binaries section", () => {
      const content = policies.loadPreset("local-inference");
      assert.ok(content.includes("binaries:"), "must have binaries section (ref: #676)");
    });

    it("extracts valid network_policies entries", () => {
      const content = policies.loadPreset("local-inference");
      const entries = policies.extractPresetEntries(content);
      assert.ok(entries, "must have extractable network_policies entries");
      assert.ok(entries.includes("local_inference"), "must contain local_inference policy key");
    });
  });

  describe("validatePreset", () => {
    it("returns true for content with binaries section", () => {
      assert.equal(
        policies.validatePreset("binaries:\n  - /usr/local/bin/openclaw", "test"),
        true,
      );
    });

    it("returns false and warns when binaries section is missing", () => {
      const warnings = [];
      const origWarn = console.warn;
      console.warn = (...args) => warnings.push(args.join(" "));
      try {
        assert.equal(
          policies.validatePreset("network_policies:\n  allow_all:\n    endpoints:", "no-bin"),
          false,
        );
        assert.ok(warnings.length > 0, "should have logged a warning");
        assert.ok(warnings[0].includes("no-bin"), "warning should name the preset");
        assert.ok(warnings[0].includes("#676"), "warning should reference issue #676");
      } finally {
        console.warn = origWarn;
      }
    });
  });

  describe("extractPresetEntries", () => {
    it("returns null when content has no network_policies section", () => {
      assert.equal(policies.extractPresetEntries("binaries:\n  - /usr/bin/foo"), null);
    });

    it("extracts entries under network_policies key", () => {
      const content = "preset:\n  name: test\nnetwork_policies:\n  allow_test:\n    endpoints:\n      - host: example.com";
      const entries = policies.extractPresetEntries(content);
      assert.ok(entries);
      assert.ok(entries.includes("allow_test:"));
      assert.ok(entries.includes("host: example.com"));
    });

    it("trims trailing whitespace from extracted entries", () => {
      const content = "network_policies:\n  entry_one:\n    key: val  \n  ";
      const entries = policies.extractPresetEntries(content);
      assert.ok(entries);
      assert.ok(!entries.endsWith(" "), "trailing whitespace should be trimmed");
    });
  });

  describe("parseCurrentPolicy", () => {
    it("returns empty string for null/empty input", () => {
      assert.equal(policies.parseCurrentPolicy(null), "");
      assert.equal(policies.parseCurrentPolicy(""), "");
    });

    it("returns raw content when no --- separator exists", () => {
      const raw = "version: 1\nnetwork_policies:\n  allow_all:";
      assert.equal(policies.parseCurrentPolicy(raw), raw);
    });

    it("returns trimmed content after --- separator", () => {
      const raw = "Version: 1\nHash: abc123\n---\nversion: 1\nnetwork_policies:\n  rule:";
      const result = policies.parseCurrentPolicy(raw);
      assert.equal(result, "version: 1\nnetwork_policies:\n  rule:");
    });

    it("handles --- at the start of content", () => {
      const raw = "---\nversion: 1";
      assert.equal(policies.parseCurrentPolicy(raw), "version: 1");
    });
  });

  describe("applyPreset sandbox name validation", () => {
    it("rejects empty sandbox name", () => {
      assert.throws(
        () => policies.applyPreset("", "outlook"),
        /Invalid or truncated sandbox name/,
      );
    });

    it("rejects sandbox name longer than 63 chars", () => {
      assert.throws(
        () => policies.applyPreset("a".repeat(64), "outlook"),
        /Invalid or truncated sandbox name/,
      );
    });

    it("rejects sandbox name with uppercase letters", () => {
      assert.throws(
        () => policies.applyPreset("MyAssistant", "outlook"),
        /Invalid or truncated sandbox name/,
      );
    });

    it("rejects sandbox name with shell metacharacters", () => {
      assert.throws(
        () => policies.applyPreset("test; whoami", "outlook"),
        /Invalid or truncated sandbox name/,
      );
    });

    it("rejects sandbox name starting with hyphen", () => {
      assert.throws(
        () => policies.applyPreset("-leading", "outlook"),
        /Invalid or truncated sandbox name/,
      );
    });

    it("rejects sandbox name ending with hyphen", () => {
      assert.throws(
        () => policies.applyPreset("trailing-", "outlook"),
        /Invalid or truncated sandbox name/,
      );
    });

    it("returns false when preset does not exist", () => {
      const errors = [];
      const origError = console.error;
      console.error = (...args) => errors.push(args.join(" "));
      try {
        const result = policies.applyPreset("valid-name", "nonexistent-preset");
        assert.equal(result, false);
        assert.ok(errors.some((e) => e.includes("Cannot load preset")));
      } finally {
        console.error = origError;
      }
    });
  });

  describe("getAppliedPresets", () => {
    it("returns empty array for unknown sandbox", () => {
      // getSandbox returns null for non-registered sandboxes
      const presets = policies.getAppliedPresets("nonexistent-sandbox-xyz");
      assert.deepEqual(presets, []);
    });
  });

  describe("preset YAML schema", () => {
    it("no preset has rules at NetworkPolicyRuleDef level", () => {
      // rules must be inside endpoints, not as sibling of endpoints/binaries
      for (const p of policies.listPresets()) {
        const content = policies.loadPreset(p.name);
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // rules: at 4-space indent (same level as endpoints:) is wrong
          // rules: at 8+ space indent (inside an endpoint) is correct
          if (/^\s{4}rules:/.test(line)) {
            assert.fail(`${p.name} line ${i + 1}: rules at policy level (should be inside endpoint)`);
          }
        }
      }
    });

    it("every preset has network_policies section", () => {
      for (const p of policies.listPresets()) {
        const content = policies.loadPreset(p.name);
        assert.ok(content.includes("network_policies:"), `${p.name} missing network_policies`);
      }
    });

    it("every preset has a binaries section (ref: #676)", () => {
      for (const p of policies.listPresets()) {
        const content = policies.loadPreset(p.name);
        assert.ok(
          content.includes("binaries:"),
          `${p.name} missing binaries section — policies without binaries return 403`
        );
      }
    });

    it("every preset binaries section includes openclaw", () => {
      for (const p of policies.listPresets()) {
        const content = policies.loadPreset(p.name);
        assert.ok(
          content.includes("/usr/local/bin/openclaw"),
          `${p.name} must allow openclaw binary`
        );
      }
    });

    it("package manager presets include their tool binaries", () => {
      const npmContent = policies.loadPreset("npm");
      assert.ok(npmContent.includes("/usr/local/bin/npm"), "npm preset must allow npm binary");
      assert.ok(npmContent.includes("/usr/local/bin/node"), "npm preset must allow node binary");

      const pypiContent = policies.loadPreset("pypi");
      assert.ok(pypiContent.includes("/usr/bin/pip"), "pypi preset must allow pip binary");

      const dockerContent = policies.loadPreset("docker");
      assert.ok(dockerContent.includes("/usr/bin/docker"), "docker preset must allow docker binary");
    });
  });
});
