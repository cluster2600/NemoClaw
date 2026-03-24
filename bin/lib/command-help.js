// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-command help text for `nemoclaw <command> --help`.
 *
 * Each entry maps a command name to { purpose, usage, options?, examples, related? }.
 */

const GLOBAL_HELP = {
  onboard: {
    purpose: "Configure inference endpoint, credentials, and create your first sandbox.",
    usage: "nemoclaw onboard [--non-interactive]",
    options: [
      ["--non-interactive", "Skip prompts; use env vars (NVIDIA_API_KEY, NEMOCLAW_PROVIDER, NEMOCLAW_MODEL)"],
    ],
    examples: [
      "nemoclaw onboard",
      "NVIDIA_API_KEY=nvapi-... nemoclaw onboard --non-interactive",
    ],
    related: ["list", "status", "setup-spark"],
  },

  "setup-spark": {
    purpose: "Prepare a DGX Spark for NemoClaw (cgroup v2, Docker, NVIDIA runtime).",
    usage: "nemoclaw setup-spark",
    options: [],
    examples: [
      "nemoclaw setup-spark",
    ],
    related: ["onboard"],
  },

  list: {
    purpose: "List all registered sandboxes with model, provider, and policy details.",
    usage: "nemoclaw list [--json]",
    options: [
      ["--json", "Output machine-readable JSON instead of formatted text"],
    ],
    examples: [
      "nemoclaw list",
      "nemoclaw list --json",
      "nemoclaw list --json | jq '.sandboxes[].name'",
    ],
    related: ["status", "onboard"],
  },

  deploy: {
    purpose: "Deploy NemoClaw to a Brev GPU VM instance.",
    usage: "nemoclaw deploy <instance-name>",
    options: [],
    examples: [
      "nemoclaw deploy my-gpu-box",
      "nemoclaw deploy nemoclaw-prod",
      "NEMOCLAW_GPU=a2-highgpu-1g:nvidia-tesla-a100:1 nemoclaw deploy my-box",
    ],
    related: ["onboard", "start"],
  },

  start: {
    purpose: "Start auxiliary services (Telegram bridge, SSH tunnel).",
    usage: "nemoclaw start",
    options: [],
    examples: [
      "nemoclaw start",
    ],
    related: ["stop", "status"],
  },

  stop: {
    purpose: "Stop all auxiliary services.",
    usage: "nemoclaw stop",
    options: [],
    examples: [
      "nemoclaw stop",
    ],
    related: ["start", "status"],
  },

  status: {
    purpose: "Show global sandbox list and service status.",
    usage: "nemoclaw status [--json]",
    options: [
      ["--json", "Output machine-readable JSON (skips live service check)"],
    ],
    examples: [
      "nemoclaw status",
      "nemoclaw status --json",
    ],
    related: ["list", "<name> status"],
  },

  debug: {
    purpose: "Collect NemoClaw diagnostic information for bug reports.",
    usage: "nemoclaw debug [--quick] [--sandbox <name>] [--output <path>]",
    options: [
      ["--quick", "Minimal diagnostics (system info only)"],
      ["--sandbox <name>", "Target a specific sandbox"],
      ["--output <path>", "Save diagnostics tarball to a file"],
    ],
    examples: [
      "nemoclaw debug",
      "nemoclaw debug --quick",
      "nemoclaw debug --output /tmp/diag.tar.gz",
    ],
    related: ["reconnect", "status"],
  },

  reconnect: {
    purpose: "Repair gateway and sandbox connectivity without re-onboarding.",
    usage: "nemoclaw reconnect [<sandbox>] [--diagnose]",
    options: [
      ["--diagnose", "Show connectivity diagnostics without attempting repair"],
    ],
    examples: [
      "nemoclaw reconnect",
      "nemoclaw reconnect my-sandbox",
      "nemoclaw reconnect --diagnose",
    ],
    related: ["debug", "onboard"],
  },

  update: {
    purpose: "Update NemoClaw to the latest version.",
    usage: "nemoclaw update [--check]",
    options: [
      ["--check", "Check for updates without installing"],
    ],
    examples: [
      "nemoclaw update",
      "nemoclaw update --check",
    ],
    related: ["uninstall"],
  },

  uninstall: {
    purpose: "Remove NemoClaw, sandboxes, and optionally Ollama models.",
    usage: "nemoclaw uninstall [--yes] [--keep-openshell] [--delete-models]",
    options: [
      ["--yes", "Skip the confirmation prompt"],
      ["--keep-openshell", "Leave the openshell binary installed"],
      ["--delete-models", "Remove NemoClaw-pulled Ollama models"],
    ],
    examples: [
      "nemoclaw uninstall",
      "nemoclaw uninstall --yes",
      "nemoclaw uninstall --yes --delete-models",
    ],
    related: ["update"],
  },
};

const SANDBOX_HELP = {
  connect: {
    purpose: "Open an interactive shell session inside a running sandbox.",
    usage: "nemoclaw <name> connect",
    options: [],
    examples: [
      "nemoclaw my-sandbox connect",
    ],
    related: ["logs", "status"],
  },

  status: {
    purpose: "Show sandbox health, model, provider, and NIM status.",
    usage: "nemoclaw <name> status [--json]",
    options: [
      ["--json", "Output machine-readable JSON (skips openshell query)"],
    ],
    examples: [
      "nemoclaw my-sandbox status",
      "nemoclaw my-sandbox status --json",
    ],
    related: ["connect", "logs"],
  },

  logs: {
    purpose: "Stream sandbox logs.",
    usage: "nemoclaw <name> logs [--follow]",
    options: [
      ["--follow", "Continuously stream new log output (tail mode)"],
    ],
    examples: [
      "nemoclaw my-sandbox logs",
      "nemoclaw my-sandbox logs --follow",
    ],
    related: ["status", "connect"],
  },

  "policy-add": {
    purpose: "Interactively add a network or filesystem policy preset to a sandbox.",
    usage: "nemoclaw <name> policy-add",
    options: [],
    examples: [
      "nemoclaw my-sandbox policy-add",
    ],
    related: ["policy-list"],
  },

  "policy-list": {
    purpose: "List available policy presets and show which are applied.",
    usage: "nemoclaw <name> policy-list",
    options: [],
    examples: [
      "nemoclaw my-sandbox policy-list",
    ],
    related: ["policy-add"],
  },

  destroy: {
    purpose: "Stop NIM container and permanently delete a sandbox.",
    usage: "nemoclaw <name> destroy [--yes]",
    options: [
      ["--yes", "Skip the confirmation prompt"],
      ["--force", "Alias for --yes"],
    ],
    examples: [
      "nemoclaw my-sandbox destroy",
      "nemoclaw my-sandbox destroy --yes",
    ],
    related: ["list", "onboard"],
  },
};

/**
 * Format and print command help to stdout.
 * @param {string} cmd - Command name
 * @param {"global"|"sandbox"} scope - Whether it is global or sandbox-scoped
 */
function showCommandHelp(cmd, scope = "global") {
  const entry = scope === "sandbox" ? SANDBOX_HELP[cmd] : GLOBAL_HELP[cmd];
  if (!entry) return false;

  const lines = [];
  lines.push("");
  lines.push(`  ${entry.purpose}`);
  lines.push("");
  lines.push(`  Usage:`);
  lines.push(`    ${entry.usage}`);

  if (entry.options && entry.options.length > 0) {
    lines.push("");
    lines.push(`  Options:`);
    for (const [flag, desc] of entry.options) {
      lines.push(`    ${flag.padEnd(24)} ${desc}`);
    }
  }

  if (entry.examples && entry.examples.length > 0) {
    lines.push("");
    lines.push(`  Examples:`);
    for (const ex of entry.examples) {
      lines.push(`    ${ex}`);
    }
  }

  if (entry.related && entry.related.length > 0) {
    lines.push("");
    lines.push(`  See also: ${entry.related.join(", ")}`);
  }

  lines.push("");
  console.log(lines.join("\n"));
  return true;
}

/**
 * Check if args contain --help / -h and show help for the given command.
 * Returns true if help was shown (caller should exit 0).
 */
function handleHelpFlag(args, cmd, scope = "global") {
  if (args.includes("--help") || args.includes("-h")) {
    return showCommandHelp(cmd, scope);
  }
  return false;
}

module.exports = {
  GLOBAL_HELP,
  SANDBOX_HELP,
  showCommandHelp,
  handleHelpFlag,
};
