// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

/**
 * CLI/docs drift test (#756).
 *
 * Validates that the command reference documentation (docs/reference/commands.md)
 * stays in sync with the actual CLI implementation (bin/nemoclaw.js) and the
 * per-command help registry (bin/lib/command-help.js).
 */
describe("CLI / docs drift detection (#756)", () => {
  const commandsDoc = fs.readFileSync(
    path.join(ROOT, "docs", "reference", "commands.md"),
    "utf8",
  );
  const nemoclawSrc = fs.readFileSync(
    path.join(ROOT, "bin", "nemoclaw.js"),
    "utf8",
  );
  const { GLOBAL_HELP, SANDBOX_HELP } = require(
    path.join(ROOT, "bin", "lib", "command-help.js"),
  );

  // ── Extract documented commands from commands.md ──────────────────

  /**
   * Parse H3 headings like ### `nemoclaw onboard` or ### `nemoclaw <name> model`
   * Returns { globals: Set<string>, sandboxActions: Set<string> }
   */
  function parseDocumentedCommands(md) {
    const globals = new Set();
    const sandboxActions = new Set();
    const headingRe = /^###\s+`nemoclaw\s+(.+?)`\s*$/gm;

    for (const match of md.matchAll(headingRe)) {
      const cmdPart = match[1].trim();
      if (cmdPart.startsWith("<name>")) {
        // Sandbox-scoped: extract action after "<name> "
        const action = cmdPart.replace("<name>", "").trim();
        if (action) sandboxActions.add(action);
      } else {
        // Global command — first word only (e.g. "deploy <instance-name>" → "deploy")
        const first = cmdPart.split(/\s/)[0];
        globals.add(first);
      }
    }
    return { globals, sandboxActions };
  }

  const documented = parseDocumentedCommands(commandsDoc);

  // ── Extract implemented commands from nemoclaw.js ─────────────────

  /**
   * Parse the GLOBAL_COMMANDS Set literal from nemoclaw.js source.
   * Matches entries like: "onboard", "list", etc.
   * Excludes meta entries: "help", "--help", "-h", "--version", "-v"
   */
  function parseImplementedGlobals(src) {
    const setMatch = src.match(/GLOBAL_COMMANDS\s*=\s*new\s+Set\(\[([\s\S]*?)\]\)/);
    if (!setMatch) return new Set();

    const entries = new Set();
    const entryRe = /"([^"]+)"/g;
    for (const m of setMatch[1].matchAll(entryRe)) {
      const cmd = m[1];
      // Skip meta/alias entries — these aren't standalone documented commands
      if (["help", "--help", "-h", "--version", "-v"].includes(cmd)) continue;
      entries.add(cmd);
    }
    return entries;
  }

  /**
   * Parse sandbox-scoped actions from the switch(action) block in nemoclaw.js.
   */
  function parseImplementedSandboxActions(src) {
    const actions = new Set();
    // Match: switch (action) { case "connect": ... default:
    const sandboxBlock = src.match(
      /switch\s*\(action\)\s*\{([\s\S]*?)\n\s*default:/,
    );
    if (!sandboxBlock) return actions;

    const caseRe = /case\s+"([^"]+)":/g;
    for (const m of sandboxBlock[1].matchAll(caseRe)) {
      actions.add(m[1]);
    }
    return actions;
  }

  const implementedGlobals = parseImplementedGlobals(nemoclawSrc);
  const implementedSandboxActions = parseImplementedSandboxActions(nemoclawSrc);

  // ── Tests ─────────────────────────────────────────────────────────

  describe("global commands", () => {
    it("every implemented global command is documented in commands.md", () => {
      // "setup" is a deprecated alias for "onboard" — skip
      const skip = new Set(["setup"]);
      const undocumented = [...implementedGlobals].filter(
        (cmd) => !skip.has(cmd) && !documented.globals.has(cmd),
      );
      assert.deepStrictEqual(
        undocumented,
        [],
        `Implemented but not documented: ${undocumented.join(", ")}.\n` +
          "Add a ### heading to docs/reference/commands.md for each.",
      );
    });

    it("every documented global command is implemented in GLOBAL_COMMANDS", () => {
      // "help" is documented but excluded from GLOBAL_COMMANDS extraction — allow it
      const notImplemented = [...documented.globals].filter(
        (cmd) => !implementedGlobals.has(cmd) && cmd !== "help",
      );
      assert.deepStrictEqual(
        notImplemented,
        [],
        `Documented but not implemented: ${notImplemented.join(", ")}.\n` +
          "Remove from docs/reference/commands.md or add to GLOBAL_COMMANDS in bin/nemoclaw.js.",
      );
    });

    it("every implemented global command has a per-command --help entry", () => {
      // "setup" is deprecated legacy alias — no --help needed
      const needHelp = [...implementedGlobals].filter(
        (cmd) => cmd !== "setup" && !GLOBAL_HELP[cmd],
      );
      assert.deepStrictEqual(
        needHelp,
        [],
        `Missing GLOBAL_HELP entry: ${needHelp.join(", ")}.\n` +
          "Add entries to bin/lib/command-help.js.",
      );
    });
  });

  describe("sandbox-scoped actions", () => {
    it("every implemented sandbox action is documented in commands.md", () => {
      const undocumented = [...implementedSandboxActions].filter(
        (a) => !documented.sandboxActions.has(a),
      );
      assert.deepStrictEqual(
        undocumented,
        [],
        `Implemented but not documented: ${undocumented.join(", ")}.\n` +
          "Add a ### `nemoclaw <name> ${action}` heading to docs/reference/commands.md.",
      );
    });

    it("every documented sandbox action is implemented in the sandbox switch", () => {
      const notImplemented = [...documented.sandboxActions].filter(
        (a) => !implementedSandboxActions.has(a),
      );
      assert.deepStrictEqual(
        notImplemented,
        [],
        `Documented but not implemented: ${notImplemented.join(", ")}.\n` +
          "Remove from docs/reference/commands.md or add to the sandbox switch in bin/nemoclaw.js.",
      );
    });

    it("every implemented sandbox action has a per-command --help entry", () => {
      const needHelp = [...implementedSandboxActions].filter(
        (a) => !SANDBOX_HELP[a],
      );
      assert.deepStrictEqual(
        needHelp,
        [],
        `Missing SANDBOX_HELP entry: ${needHelp.join(", ")}.\n` +
          "Add entries to bin/lib/command-help.js.",
      );
    });
  });

  describe("help text completeness", () => {
    it("main help() output mentions every global command", () => {
      // Read the help function output template from source
      const helpMatch = nemoclawSrc.match(/function help\(\)\s*\{([\s\S]*?)\n\}/);
      assert.ok(helpMatch, "Could not find help() function in nemoclaw.js");
      const helpBody = helpMatch[1];

      // Every non-deprecated, non-meta global command should appear in help text
      const skipInHelp = new Set(["setup"]); // deprecated
      const missing = [...implementedGlobals].filter(
        (cmd) => !skipInHelp.has(cmd) && !helpBody.includes(cmd),
      );
      assert.deepStrictEqual(
        missing,
        [],
        `Commands missing from help() output: ${missing.join(", ")}`,
      );
    });

    it("main help() output mentions every sandbox action", () => {
      const helpMatch = nemoclawSrc.match(/function help\(\)\s*\{([\s\S]*?)\n\}/);
      assert.ok(helpMatch);
      const helpBody = helpMatch[1];

      const missing = [...implementedSandboxActions].filter(
        (a) => !helpBody.includes(a),
      );
      assert.deepStrictEqual(
        missing,
        [],
        `Sandbox actions missing from help() output: ${missing.join(", ")}`,
      );
    });
  });

  describe("slash command documentation", () => {
    it("commands.md documents the /nemoclaw slash command", () => {
      assert.ok(
        commandsDoc.includes("/nemoclaw"),
        "commands.md should document the /nemoclaw slash command",
      );
    });
  });
});
