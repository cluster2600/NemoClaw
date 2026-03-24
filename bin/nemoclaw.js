#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execFileSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ---------------------------------------------------------------------------
// Color / style — respects NO_COLOR and non-TTY environments.
// Uses exact NVIDIA green #76B900 on truecolor terminals; 256-color otherwise.
// ---------------------------------------------------------------------------
const _useColor = !process.env.NO_COLOR && !!process.stdout.isTTY;
const _tc = _useColor && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");
const G = _useColor ? (_tc ? "\x1b[38;2;118;185;0m" : "\x1b[38;5;148m") : "";
const B = _useColor ? "\x1b[1m" : "";
const D = _useColor ? "\x1b[2m" : "";
const R = _useColor ? "\x1b[0m" : "";
const RD = _useColor ? "\x1b[1;31m" : "";
const YW = _useColor ? "\x1b[1;33m" : "";

const { isVerbose, setVerbose, debug: logDebug } = require("./lib/logger");
const { ROOT, SCRIPTS, run, runCapture, runInteractive, shellQuote, validateName } = require("./lib/runner");
const {
  ensureApiKey,
  ensureGithubToken,
  getCredential,
  buildCredentialEnv,
  isRepoPrivate,
} = require("./lib/credentials");
const registry = require("./lib/registry");
const nim = require("./lib/nim");
const policies = require("./lib/policies");
const model = require("./lib/model");
const { handleHelpFlag } = require("./lib/command-help");

// ── Global commands ──────────────────────────────────────────────

const GLOBAL_COMMANDS = new Set([
  "onboard", "list", "deploy", "setup", "setup-spark",
  "start", "stop", "status", "debug", "uninstall", "update",
  "reconnect",
  "help", "--help", "-h", "--version", "-v",
]);

const REMOTE_UNINSTALL_URL = "https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/uninstall.sh";

function resolveUninstallScript() {
  const candidates = [
    path.join(ROOT, "uninstall.sh"),
    path.join(__dirname, "..", "uninstall.sh"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function exitWithSpawnResult(result) {
  if (result.status !== null) {
    process.exit(result.status);
  }

  if (result.signal) {
    const signalNumber = os.constants.signals[result.signal];
    process.exit(signalNumber ? 128 + signalNumber : 1);
  }

  process.exit(1);
}

// ── Commands ─────────────────────────────────────────────────────

async function onboard(args) {
  const { onboard: runOnboard } = require("./lib/onboard");
  const allowedArgs = new Set(["--non-interactive"]);
  const unknownArgs = args.filter((arg) => !allowedArgs.has(arg));
  if (unknownArgs.length > 0) {
    console.error(`  Unknown onboard option(s): ${unknownArgs.join(", ")}`);
    console.error("  Usage: nemoclaw onboard [--non-interactive]");
    console.error("");
    console.error("  Help:  nemoclaw onboard --help");
    process.exit(1);
  }
  const nonInteractive = args.includes("--non-interactive");
  await runOnboard({ nonInteractive });
}

async function setup() {
  console.log("");
  console.log("  ⚠  `nemoclaw setup` is deprecated. Use `nemoclaw onboard` instead.");
  console.log("     Running legacy setup.sh for backwards compatibility...");
  console.log("");
  await ensureApiKey();
  const { defaultSandbox } = registry.listSandboxes();
  const safeName = defaultSandbox && /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(defaultSandbox) ? defaultSandbox : "";
  run(`bash "${SCRIPTS}/setup.sh" ${shellQuote(safeName)}`);
}

async function setupSpark() {
  await ensureApiKey();
  run(`sudo -E bash "${SCRIPTS}/setup-spark.sh"`, {
    env: buildCredentialEnv(["NVIDIA_API_KEY"]),
  });
}

async function deploy(instanceName) {
  if (!instanceName) {
    console.error("  Usage: nemoclaw deploy <instance-name>");
    console.error("");
    console.error("  Examples:");
    console.error("    nemoclaw deploy my-gpu-box");
    console.error("    nemoclaw deploy nemoclaw-prod");
    console.error("    nemoclaw deploy nemoclaw-test");
    console.error("");
    console.error("  Help:  nemoclaw deploy --help");
    process.exit(1);
  }
  await ensureApiKey();
  if (isRepoPrivate("NVIDIA/OpenShell")) {
    await ensureGithubToken();
  }
  validateName(instanceName, "instance name");
  const name = instanceName;
  const qname = shellQuote(name);
  const gpu = process.env.NEMOCLAW_GPU || "a2-highgpu-1g:nvidia-tesla-a100:1";

  console.log("");
  console.log(`  Deploying NemoClaw to Brev instance: ${name}`);
  console.log("");

  try {
    execFileSync("which", ["brev"], { stdio: "ignore" });
  } catch {
    console.error("  brev CLI not found.");
    console.error("  Install it from: https://brev.nvidia.com");
    console.error("");
    console.error("  Then retry:  nemoclaw deploy " + name);
    process.exit(1);
  }

  let exists = false;
  try {
    const out = execFileSync("brev", ["ls"], { encoding: "utf-8" });
    exists = out.includes(name);
  } catch (err) {
    if (err.stdout && err.stdout.includes(name)) exists = true;
    if (err.stderr && err.stderr.includes(name)) exists = true;
  }

  if (!exists) {
    console.log(`  Creating Brev instance '${name}' (${gpu})...`);
    run(`brev create ${qname} --gpu ${shellQuote(gpu)}`);
  } else {
    console.log(`  Brev instance '${name}' already exists.`);
  }

  run(`brev refresh`, { ignoreError: true });

  process.stdout.write(`  Waiting for SSH `);
  for (let i = 0; i < 60; i++) {
    try {
      execFileSync("ssh", ["-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no", name, "echo", "ok"], { encoding: "utf-8", stdio: "ignore" });
      process.stdout.write(` ${G}✓${R}\n`);
      break;
    } catch {
      if (i === 59) {
        process.stdout.write("\n");
        console.error(`  Timed out waiting for SSH to ${name}`);
        process.exit(1);
      }
      process.stdout.write(".");
      spawnSync("sleep", ["3"]);
    }
  }

  console.log("  Syncing NemoClaw to VM...");
  run(`ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR ${qname} 'mkdir -p /home/ubuntu/nemoclaw'`);
  run(`rsync -az --delete --exclude node_modules --exclude .git --exclude src -e "ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR" "${ROOT}/scripts" "${ROOT}/Dockerfile" "${ROOT}/nemoclaw" "${ROOT}/nemoclaw-blueprint" "${ROOT}/bin" "${ROOT}/package.json" ${qname}:/home/ubuntu/nemoclaw/`);

  const credEnv = buildCredentialEnv();
  const envLines = Object.entries(credEnv).map(
    ([k, v]) => `${k}=${shellQuote(v)}`
  );
  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-env-"));
  const envTmp = path.join(envDir, "env");
  fs.writeFileSync(envTmp, envLines.join("\n") + "\n", { mode: 0o600 });
  try {
    run(`scp -q -o StrictHostKeyChecking=no -o LogLevel=ERROR ${shellQuote(envTmp)} ${qname}:/home/ubuntu/nemoclaw/.env`);
  } finally {
    try { fs.unlinkSync(envTmp); } catch {}
    try { fs.rmdirSync(envDir); } catch {}
  }

  console.log("  Running setup...");
  runInteractive(`ssh -t -o StrictHostKeyChecking=no -o LogLevel=ERROR ${qname} 'cd /home/ubuntu/nemoclaw && set -a && . .env && set +a && bash scripts/brev-setup.sh'`);

  if (credEnv.TELEGRAM_BOT_TOKEN) {
    console.log("  Starting services...");
    run(`ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR ${qname} 'cd /home/ubuntu/nemoclaw && set -a && . .env && set +a && bash scripts/start-services.sh'`);
  }

  console.log("");
  console.log("  Connecting to sandbox...");
  console.log("");
  runInteractive(`ssh -t -o StrictHostKeyChecking=no -o LogLevel=ERROR ${qname} 'cd /home/ubuntu/nemoclaw && set -a && . .env && set +a && openshell sandbox connect nemoclaw'`);
}

async function start() {
  await ensureApiKey();
  const { defaultSandbox } = registry.listSandboxes();
  const safeName = defaultSandbox && /^[a-zA-Z0-9._-]+$/.test(defaultSandbox) ? defaultSandbox : null;
  const sandboxEnv = safeName ? `SANDBOX_NAME=${shellQuote(safeName)}` : "";
  run(`${sandboxEnv} bash "${SCRIPTS}/start-services.sh"`);
}

function stop() {
  run(`bash "${SCRIPTS}/start-services.sh" --stop`);
}

function debug(args) {
  const result = spawnSync("bash", [path.join(SCRIPTS, "debug.sh"), ...args], {
    stdio: "inherit",
    cwd: ROOT,
    env: {
      ...process.env,
      SANDBOX_NAME: registry.listSandboxes().defaultSandbox || "",
    },
  });
  exitWithSpawnResult(result);
}

function uninstall(args) {
  const localScript = resolveUninstallScript();
  if (localScript) {
    console.log(`  Running local uninstall script: ${localScript}`);
    const result = spawnSync("bash", [localScript, ...args], {
      stdio: "inherit",
      cwd: ROOT,
      env: process.env,
    });
    exitWithSpawnResult(result);
  }

  console.log(`  Local uninstall script not found; falling back to ${REMOTE_UNINSTALL_URL}`);
  const forwardedArgs = args.map(shellQuote).join(" ");
  const command = forwardedArgs.length > 0
    ? `curl -fsSL ${shellQuote(REMOTE_UNINSTALL_URL)} | bash -s -- ${forwardedArgs}`
    : `curl -fsSL ${shellQuote(REMOTE_UNINSTALL_URL)} | bash`;
  const result = spawnSync("bash", ["-c", command], {
    stdio: "inherit",
    cwd: ROOT,
    env: process.env,
  });
  exitWithSpawnResult(result);
}

function showStatus({ json = false } = {}) {
  // Show sandbox registry
  const { sandboxes, defaultSandbox } = registry.listSandboxes();

  if (json) {
    const data = {
      sandboxes: sandboxes.map((sb) => ({
        name: sb.name,
        default: sb.name === defaultSandbox,
        model: sb.model || null,
        provider: sb.provider || null,
        gpuEnabled: !!sb.gpuEnabled,
        policies: sb.policies || [],
      })),
      defaultSandbox: defaultSandbox || null,
    };
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (sandboxes.length > 0) {
    console.log("");
    console.log("  Sandboxes:");
    for (const sb of sandboxes) {
      const def = sb.name === defaultSandbox ? " *" : "";
      const model = sb.model ? ` (${sb.model})` : "";
      console.log(`    ${sb.name}${def}${model}`);
    }
    console.log("");
  }

  // Show service status
  run(`bash "${SCRIPTS}/start-services.sh" --status`);
}

function listSandboxes({ json = false } = {}) {
  const { sandboxes, defaultSandbox } = registry.listSandboxes();

  if (json) {
    const data = {
      sandboxes: sandboxes.map((sb) => ({
        name: sb.name,
        default: sb.name === defaultSandbox,
        model: sb.model || null,
        provider: sb.provider || null,
        gpuEnabled: !!sb.gpuEnabled,
        policies: sb.policies || [],
      })),
      defaultSandbox: defaultSandbox || null,
    };
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (sandboxes.length === 0) {
    console.log("");
    console.log("  No sandboxes registered. Run `nemoclaw onboard` to get started.");
    console.log("");
    return;
  }

  console.log("");
  console.log("  Sandboxes:");
  for (const sb of sandboxes) {
    const def = sb.name === defaultSandbox ? " *" : "";
    const model = sb.model || "unknown";
    const provider = sb.provider || "unknown";
    const gpu = sb.gpuEnabled ? "GPU" : "CPU";
    const presets = sb.policies && sb.policies.length > 0 ? sb.policies.join(", ") : "none";
    console.log(`    ${sb.name}${def}`);
    console.log(`      model: ${model}  provider: ${provider}  ${gpu}  policies: ${presets}`);
  }
  console.log("");
  console.log("  * = default sandbox");
  console.log("");
}

// ── Sandbox-scoped actions ───────────────────────────────────────

function sandboxConnect(sandboxName) {
  const qn = shellQuote(sandboxName);
  // Ensure port forward is alive before connecting
  run(`openshell forward start --background 18789 ${qn} 2>/dev/null || true`, { ignoreError: true });
  runInteractive(`openshell sandbox connect ${qn}`);
}

function sandboxStatus(sandboxName, { json = false } = {}) {
  const sb = registry.getSandbox(sandboxName);

  // NIM health — use stored port from registry (falls back to 8000)
  const nimPort = sb ? sb.nimPort : undefined;
  const nimStat = nim.nimStatus(sandboxName, nimPort);

  if (json) {
    const data = {
      name: sandboxName,
      model: sb ? sb.model || null : null,
      provider: sb ? sb.provider || null : null,
      gpuEnabled: sb ? !!sb.gpuEnabled : false,
      policies: sb ? sb.policies || [] : [],
      nim: {
        running: nimStat.running,
        healthy: nimStat.healthy || false,
        container: nimStat.container || null,
        port: Number(nimPort) || 8000,
      },
    };
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (sb) {
    console.log("");
    console.log(`  Sandbox: ${sb.name}`);
    console.log(`    Model:    ${sb.model || "unknown"}`);
    console.log(`    Provider: ${sb.provider || "unknown"}`);
    console.log(`    GPU:      ${sb.gpuEnabled ? "yes" : "no"}`);
    console.log(`    Policies: ${(sb.policies || []).join(", ") || "none"}`);
  }

  // openshell info
  run(`openshell sandbox get ${shellQuote(sandboxName)} 2>/dev/null || true`, { ignoreError: true });

  console.log(`    NIM:      ${nimStat.running ? `running (${nimStat.container})` : "not running"}`);
  if (nimStat.running) {
    console.log(`    Healthy:  ${nimStat.healthy ? "yes" : "no"}`);
    if (nimPort && nimPort !== 8000) {
      console.log(`    NIM port: ${nimPort}`);
    }
  }
  console.log("");
}

function sandboxLogs(sandboxName, follow) {
  const followFlag = follow ? " --tail" : "";
  run(`openshell logs ${shellQuote(sandboxName)}${followFlag}`);
}

async function sandboxPolicyAdd(sandboxName) {
  const allPresets = policies.listPresets();
  const applied = policies.getAppliedPresets(sandboxName);

  console.log("");
  console.log("  Available presets:");
  allPresets.forEach((p) => {
    const marker = applied.includes(p.name) ? "●" : "○";
    console.log(`    ${marker} ${p.name} — ${p.description}`);
  });
  console.log("");

  const { prompt: askPrompt } = require("./lib/credentials");
  const answer = await askPrompt("  Preset to apply: ");
  if (!answer) return;

  const confirm = await askPrompt(`  Apply '${answer}' to sandbox '${sandboxName}'? [Y/n]: `);
  if (confirm.toLowerCase() === "n") return;

  policies.applyPreset(sandboxName, answer);
}

function sandboxModel(sandboxName, actionArgs) {
  const subCmd = actionArgs[0];

  if (subCmd === "list") {
    const { provider } = model.getCurrentModel(sandboxName);
    if (!provider) {
      console.error(`  Sandbox '${sandboxName}' has no provider configured.`);
      console.error("");
      console.error("  Re-run onboard to configure a provider:  nemoclaw onboard");
      process.exit(1);
    }
    const { models: available, source } = model.listAvailableModels(provider);
    const { model: current } = model.getCurrentModel(sandboxName);

    console.log("");
    console.log(`  Available models (${source}):`);
    for (const m of available) {
      const marker = current && (m.id === current) ? "●" : "○";
      console.log(`    ${marker} ${m.id}${m.label !== m.id ? ` — ${m.label}` : ""}`);
    }
    console.log("");
    return;
  }

  if (subCmd === "set") {
    const modelId = actionArgs[1];
    if (!modelId) {
      console.error("  Usage: nemoclaw <name> model set <model-id>");
      console.error("");
      console.error("  List available models with: nemoclaw <name> model list");
      process.exit(1);
    }

    const { model: current } = model.getCurrentModel(sandboxName);
    if (current === modelId) {
      console.log(`  ${G}✓${R} Already using model '${modelId}'.`);
      return;
    }

    console.log(`  Switching model from '${current || "unknown"}' to '${modelId}'...`);
    const result = model.setModel(sandboxName, modelId);
    if (result.success) {
      console.log(`  ${G}✓${R} Model changed to '${modelId}'.`);
      console.log("");
      console.log(`  ${D}The gateway now routes inference requests to this model.${R}`);
      console.log(`  ${D}The sandbox openclaw.json is unchanged (immutable by design).${R}`);
    } else {
      console.error(`  ${RD}✗${R} ${result.error}`);
      process.exit(1);
    }
    return;
  }

  // Default: show current model
  const { model: current, provider } = model.getCurrentModel(sandboxName);
  console.log("");
  console.log(`  Sandbox:  ${sandboxName}`);
  console.log(`  Model:    ${current || "unknown"}`);
  console.log(`  Provider: ${provider || "unknown"}`);
  console.log("");
  console.log(`  Commands:`);
  console.log(`    nemoclaw ${sandboxName} model list          List available models`);
  console.log(`    nemoclaw ${sandboxName} model set <model>   Switch to a different model`);
  console.log("");
}

function sandboxPolicyList(sandboxName) {
  const allPresets = policies.listPresets();
  const applied = policies.getAppliedPresets(sandboxName);

  console.log("");
  console.log(`  Policy presets for sandbox '${sandboxName}':`);
  allPresets.forEach((p) => {
    const marker = applied.includes(p.name) ? "●" : "○";
    console.log(`    ${marker} ${p.name} — ${p.description}`);
  });
  console.log("");
}

async function sandboxDestroy(sandboxName, args = []) {
  const skipConfirm = args.includes("--yes") || args.includes("--force");
  if (!skipConfirm) {
    const { prompt: askPrompt } = require("./lib/credentials");
    const answer = await askPrompt(
      `  ${YW}Destroy sandbox '${sandboxName}'?${R} This cannot be undone. [y/N]: `,
    );
    if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
      console.log("  Cancelled.");
      return;
    }
  }

  console.log(`  Stopping NIM for '${sandboxName}'...`);
  nim.stopNimContainer(sandboxName);

  console.log(`  Deleting sandbox '${sandboxName}'...`);
  run(`openshell sandbox delete ${shellQuote(sandboxName)} 2>/dev/null || true`, { ignoreError: true });

  registry.removeSandbox(sandboxName);
  console.log(`  ${G}✓${R} Sandbox '${sandboxName}' destroyed`);
}

// ── Reconnect ─────────────────────────────────────────────────────

function reconnectCmd(args) {
  const { reconnect, diagnose } = require("./lib/reconnect");

  const sandboxName = args[0] || registry.getDefault();
  if (!sandboxName) {
    console.error("  No sandbox registered. Run `nemoclaw onboard` first.");
    process.exit(1);
  }

  const diagOnly = args.includes("--diagnose");

  if (diagOnly) {
    const diag = diagnose(sandboxName);
    console.log("");
    console.log(`  ${B}Diagnostics for sandbox '${sandboxName}':${R}`);
    console.log(`    Gateway running: ${diag.gateway.running ? `${G}yes${R}` : `${RD}no${R}`}`);
    console.log(`    Gateway healthy: ${diag.gateway.healthy ? `${G}yes${R}` : `${RD}no${R}`}`);
    console.log(`    Sandbox exists:  ${diag.sandbox.exists ? `${G}yes${R}` : `${RD}no${R}`}`);
    console.log(`    Sandbox ready:   ${diag.sandbox.ready ? `${G}yes${R}` : `${RD}no${R}`}`);
    console.log(`    WSL2:            ${diag.wsl ? "yes" : "no"}`);
    console.log(`    Runtime:         ${diag.runtime}`);
    console.log("");
    return;
  }

  console.log("");
  console.log(`  Reconnecting sandbox '${sandboxName}'...`);
  console.log("");

  const result = reconnect(sandboxName);

  for (const step of result.steps) {
    console.log(`  ${result.success ? G : ""}✓${R} ${step}`);
  }

  if (!result.success) {
    for (const err of result.errors) {
      console.error(`  ${RD}✗${R} ${err}`);
    }
    console.error("");
    console.error("  If this persists, try: nemoclaw onboard");
    process.exit(1);
  }

  console.log("");
  console.log(`  ${G}✓${R} Reconnected successfully. Try: nemoclaw ${sandboxName} connect`);
  console.log("");
}

// ── Update ────────────────────────────────────────────────────────

async function update(args) {
  const {
    detectInstallType,
    checkForUpdate,
    updateSource,
    updateGlobal,
    verifyUpdate,
  } = require("./lib/update");

  const checkOnly = args.includes("--check");

  const install = detectInstallType();
  logDebug("update: install type=%s sourceDir=%s", install.type, install.sourceDir);

  if (install.type === "unknown") {
    console.error("  Could not detect NemoClaw installation type.");
    console.error("  Re-install with:  curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/install.sh | bash");
    process.exit(1);
  }

  console.log(`  Installation: ${install.type === "source" ? `source checkout (${install.sourceDir})` : "global npm"}`);

  const status = checkForUpdate(install);
  if (status.error) {
    console.error(`  ${status.error}`);
    process.exit(1);
  }

  console.log(`  Current version: v${status.currentVersion}${status.current ? ` (${status.current})` : ""}`);
  console.log(`  Latest commit:   ${status.remote}`);

  if (!status.updateAvailable) {
    console.log(`  ${G}✓${R} Already up to date.`);
    return;
  }

  if (checkOnly) {
    console.log(`  ${YW}Update available.${R}  Run ${B}nemoclaw update${R} to install.`);
    return;
  }

  console.log("");
  console.log("  Updating NemoClaw...");
  console.log("");

  let ok;
  if (install.type === "source") {
    ok = updateSource(install.sourceDir);
  } else {
    ok = updateGlobal();
  }

  if (!ok) {
    console.error("");
    console.error("  Update failed. You can re-install manually:");
    console.error("    curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/install.sh | bash");
    process.exit(1);
  }

  const versionStr = verifyUpdate();
  console.log("");
  if (versionStr) {
    console.log(`  ${G}✓${R} Updated successfully: ${versionStr}`);
  } else {
    console.log(`  ${G}✓${R} Update complete. Verify with: nemoclaw --version`);
  }
}

// ── Help ─────────────────────────────────────────────────────────

function help() {
  const pkg = require(path.join(__dirname, "..", "package.json"));
  console.log(`
  ${B}${G}NemoClaw${R}  ${D}v${pkg.version}${R}
  ${D}Deploy more secure, always-on AI assistants with a single command.${R}

  ${G}Getting Started:${R}
    ${B}nemoclaw onboard${R}                 Configure inference endpoint and credentials
    nemoclaw setup-spark             Set up on DGX Spark ${D}(fixes cgroup v2 + Docker)${R}

  ${G}Global Commands:${R}           ${D}(apply to the whole NemoClaw installation)${R}
    ${B}nemoclaw list${R}                    List all sandboxes ${D}(--json for machine output)${R}
    nemoclaw status                  Show sandbox list + service status ${D}(--json)${R}
    nemoclaw start                   Start auxiliary services ${D}(Telegram, tunnel)${R}
    nemoclaw stop                    Stop all services
    nemoclaw deploy <instance>       Deploy to a Brev VM and start services

  ${G}Sandbox Commands:${R}          ${D}(operate on a specific sandbox by name)${R}
    nemoclaw <name> connect          Shell into a running sandbox
    nemoclaw <name> status           Sandbox health + NIM status ${D}(--json)${R}
    nemoclaw <name> logs ${D}[--follow]${R}  Stream sandbox logs
    nemoclaw <name> model            Show current model and provider
    nemoclaw <name> model list       List available models ${D}(● = active)${R}
    nemoclaw <name> model set <id>   Switch to a different model
    nemoclaw <name> policy-add       Add a network or filesystem policy preset
    nemoclaw <name> policy-list      List presets ${D}(● = applied)${R}
    nemoclaw <name> destroy          Stop NIM + delete sandbox ${D}(--yes to skip prompt)${R}

  Troubleshooting:
    nemoclaw reconnect               Repair gateway/sandbox connectivity ${D}(#716)${R}
    nemoclaw reconnect --diagnose    Show connectivity diagnostics without repair
    nemoclaw --verbose <command>     Show debug output ${D}(or --debug, LOG_LEVEL=debug)${R}
    nemoclaw debug [--quick]         Collect diagnostics for bug reports
    nemoclaw debug --output FILE     Save diagnostics tarball for GitHub issues

  Updates:
    nemoclaw update                  Update NemoClaw to the latest version
    nemoclaw update --check          Check for updates without installing

  Cleanup:
    nemoclaw uninstall [flags]       Run uninstall.sh (local first, curl fallback)

  ${G}Uninstall flags:${R}
    --yes                            Skip the confirmation prompt
    --keep-openshell                 Leave the openshell binary installed
    --delete-models                  Remove NemoClaw-pulled Ollama models

  ${D}Powered by NVIDIA OpenShell · Nemotron · Agent Toolkit
  Credentials saved in ~/.nemoclaw/credentials.json (mode 600)${R}
  ${D}https://www.nvidia.com/nemoclaw${R}
`);
}

// ── Dispatch ─────────────────────────────────────────────────────

// Strip --verbose / --debug / --json before dispatch so commands don't see them.
const VERBOSE_FLAGS = new Set(["--verbose", "--debug"]);
const rawArgs = process.argv.slice(2);
let _jsonOutput = false;
const filteredArgs = rawArgs.filter((a) => {
  if (VERBOSE_FLAGS.has(a)) {
    setVerbose(true);
    return false;
  }
  if (a === "--json") {
    _jsonOutput = true;
    return false;
  }
  return true;
});

const [cmd, ...args] = filteredArgs;

if (isVerbose()) {
  logDebug("nemoclaw %s", rawArgs.join(" "));
  logDebug("node %s", process.version);
  logDebug("platform %s %s", process.platform, process.arch);
}

(async () => {
  // No command → help
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    help();
    return;
  }

  // Global commands
  if (GLOBAL_COMMANDS.has(cmd)) {
    // Per-command --help: intercept before dispatch
    if (handleHelpFlag(args, cmd, "global")) return;

    switch (cmd) {
      case "onboard":     await onboard(args); break;
      case "setup":       await setup(); break;
      case "setup-spark": await setupSpark(); break;
      case "deploy":      await deploy(args[0]); break;
      case "start":       await start(); break;
      case "stop":        stop(); break;
      case "status":      showStatus({ json: _jsonOutput }); break;
      case "debug":       debug(args); break;
      case "uninstall":   uninstall(args); break;
      case "update":      await update(args); break;
      case "reconnect":   reconnectCmd(args); break;
      case "list":        listSandboxes({ json: _jsonOutput }); break;
      case "--version":
      case "-v": {
        const pkg = require(path.join(__dirname, "..", "package.json"));
        console.log(`nemoclaw v${pkg.version}`);
        break;
      }
      default:            help(); break;
    }
    return;
  }

  // Sandbox-scoped commands: nemoclaw <name> <action>
  const sandbox = registry.getSandbox(cmd);
  if (sandbox) {
    validateName(cmd, "sandbox name");
    const action = args[0] || "connect";
    const actionArgs = args.slice(1);

    // Per-action --help: intercept before dispatch
    if (handleHelpFlag(actionArgs, action, "sandbox")) return;

    switch (action) {
      case "connect":     sandboxConnect(cmd); break;
      case "status":      sandboxStatus(cmd, { json: _jsonOutput }); break;
      case "logs":        sandboxLogs(cmd, actionArgs.includes("--follow")); break;
      case "model":       sandboxModel(cmd, actionArgs); break;
      case "policy-add":  await sandboxPolicyAdd(cmd); break;
      case "policy-list": sandboxPolicyList(cmd); break;
      case "destroy":     await sandboxDestroy(cmd, actionArgs); break;
      default:
        console.error(`  Unknown action '${action}' for sandbox '${cmd}'.`);
        console.error("");
        console.error("  Valid actions: connect, status, logs, model, policy-add, policy-list, destroy");
        console.error("");
        console.error(`  Try:  nemoclaw ${cmd} connect`);
        console.error(`  Help: nemoclaw ${cmd} <action> --help`);
        process.exit(1);
    }
    return;
  }

  // Unknown command — suggest
  console.error(`  Unknown command: ${cmd}`);
  console.error("");

  // Check if it looks like a sandbox name with missing action
  const allNames = registry.listSandboxes().sandboxes.map((s) => s.name);
  if (allNames.length > 0) {
    console.error(`  Registered sandboxes: ${allNames.join(", ")}`);
    console.error(`  Try: nemoclaw <sandbox-name> connect`);
    console.error("");
  }

  console.error(`  Run 'nemoclaw help' for usage.`);
  process.exit(1);
})();
