// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

describe("documentation links (#747)", () => {
  describe("README.md external links", () => {
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

    it("docs.nvidia.com links use .html extension, not .md", () => {
      // Extract all docs.nvidia.com links
      const linkRe = /https:\/\/docs\.nvidia\.com\/[^\s)]+/g;
      const links = [...readme.matchAll(linkRe)].map((m) => m[0]);
      assert.ok(links.length > 0, "Expected docs.nvidia.com links in README.md");

      const mdLinks = links.filter((l) => l.endsWith(".md"));
      assert.equal(
        mdLinks.length,
        0,
        `Found .md links that should be .html: ${mdLinks.join(", ")}`
      );
    });

    it("docs links reference pages that exist locally in docs/", () => {
      // Map docs.nvidia.com/nemoclaw/latest/X.html → docs/X.md
      const linkRe = /https:\/\/docs\.nvidia\.com\/nemoclaw\/latest\/([^\s)]+)\.html/g;
      const missing = [];
      for (const match of readme.matchAll(linkRe)) {
        const relPath = match[1] + ".md";
        const localPath = path.join(ROOT, "docs", relPath);
        if (!fs.existsSync(localPath)) {
          missing.push(`${match[0]} → docs/${relPath}`);
        }
      }
      assert.equal(
        missing.length,
        0,
        `Links reference pages not found locally:\n  ${missing.join("\n  ")}`
      );
    });
  });

  describe("PR template relative links", () => {
    const templatePath = path.join(ROOT, ".github", "PULL_REQUEST_TEMPLATE.md");
    const template = fs.readFileSync(templatePath, "utf8");

    it("CONTRIBUTING.md link resolves to an existing file", () => {
      // Extract markdown links: [text](path)
      const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
      const broken = [];
      for (const match of template.matchAll(linkRe)) {
        const href = match[2];
        // Skip external links
        if (href.startsWith("http://") || href.startsWith("https://")) continue;
        // Resolve relative to .github/
        const resolved = path.resolve(path.dirname(templatePath), href);
        if (!fs.existsSync(resolved)) {
          broken.push(`"${match[1]}" → ${href} (resolves to ${resolved})`);
        }
      }
      assert.equal(
        broken.length,
        0,
        `Broken relative links in PR template:\n  ${broken.join("\n  ")}`
      );
    });
  });

  describe("setup-spark.sh messaging (#738)", () => {
    const scriptPath = path.join(ROOT, "scripts", "setup-spark.sh");
    const script = fs.readFileSync(scriptPath, "utf8");

    it("exit message mentions nemoclaw onboard", () => {
      assert.ok(
        script.includes("nemoclaw onboard"),
        "setup-spark.sh should tell users to run nemoclaw onboard"
      );
    });

    it("exit message explains why re-onboarding is needed", () => {
      assert.ok(
        /re-?onboard|onboard again|run onboard again|already onboarded/i.test(script),
        "setup-spark.sh should explain that users who already onboarded need to re-run"
      );
    });

    it("exit message explains what setup-spark configured", () => {
      assert.ok(
        /cgroup|cgroupns|Docker.*config/i.test(script),
        "setup-spark.sh exit message should explain what was configured"
      );
    });
  });
});
