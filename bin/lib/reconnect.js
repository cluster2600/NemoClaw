// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Reconnect — repair gateway/sandbox connectivity after cluster restarts.
// Fixes #716: WSL2 (and other runtimes) lose connectivity when
// openshell-cluster is restarted, previously requiring full re-onboard.

const path = require("path");
const { spawnSync } = require("child_process");
const { ROOT, SCRIPTS, run, runCapture, shellQuote } = require("./runner");
const { inferContainerRuntime, shouldPatchCoredns, isWsl } = require("./platform");
const registry = require("./registry");
const { debug } = require("./logger");

/**
 * Check if the gateway is running and responsive.
 * @param {object} [deps] - Injectable dependencies for testing.
 * @returns {{ running: boolean, healthy: boolean, info: string }}
 */
function checkGatewayHealth(deps = {}) {
  const capture = deps.runCapture ?? runCapture;
  const info = capture("openshell gateway info -g nemoclaw 2>/dev/null", { ignoreError: true });
  const running = typeof info === "string" && info.length > 0 && info.includes("nemoclaw");

  if (!running) {
    return { running: false, healthy: false, info: "" };
  }

  const status = capture("openshell status 2>&1", { ignoreError: true });
  const healthy = typeof status === "string" && status.includes("Connected");
  return { running, healthy, info };
}

/**
 * Check if a sandbox pod is in Ready state.
 * @param {string} sandboxName
 * @param {object} [deps] - Injectable dependencies for testing.
 * @returns {{ exists: boolean, ready: boolean, output: string }}
 */
function checkSandboxHealth(sandboxName, deps = {}) {
  const capture = deps.runCapture ?? runCapture;
  const output = capture("openshell sandbox list 2>&1", { ignoreError: true });

  if (!output || !output.includes(sandboxName)) {
    return { exists: false, ready: false, output };
  }

  // Reuse the isSandboxReady logic — parse columnar output for Ready status
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  const ready = clean.split("\n").some((l) => {
    const cols = l.trim().split(/\s+/);
    return cols[0] === sandboxName && cols.includes("Ready") && !cols.includes("NotReady");
  });

  return { exists: true, ready, output };
}

/**
 * Wait for a sandbox to become ready, with retries.
 * @param {string} sandboxName
 * @param {object} [deps] - Injectable dependencies for testing.
 * @returns {boolean} true if ready within timeout
 */
function waitForSandboxReady(sandboxName, deps = {}) {
  const maxAttempts = deps.maxAttempts ?? 15;
  const sleepSec = deps.sleepSec ?? 2;

  for (let i = 0; i < maxAttempts; i++) {
    const health = checkSandboxHealth(sandboxName, deps);
    if (health.ready) return true;
    if (!health.exists) return false;
    spawnSync("sleep", [String(sleepSec)]);
  }
  return false;
}

/**
 * Restart the gateway — destroy and recreate.
 * @param {object} [deps] - Injectable dependencies for testing.
 */
function restartGateway(deps = {}) {
  const execute = deps.run ?? run;
  const capture = deps.runCapture ?? runCapture;

  execute("openshell gateway destroy -g nemoclaw 2>/dev/null || true", { ignoreError: true });

  // Get pinned version if available
  const versionOutput = capture("openshell -V 2>/dev/null", { ignoreError: true });
  const match = String(versionOutput).match(/openshell\s+([0-9]+\.[0-9]+\.[0-9]+)/i);
  const gwArgs = ["--name", "nemoclaw"];
  const gatewayEnv = {};

  if (match) {
    const version = match[1];
    gatewayEnv.OPENSHELL_CLUSTER_IMAGE = `ghcr.io/nvidia/openshell/cluster:${version}`;
    gatewayEnv.IMAGE_TAG = version;
  }

  execute(`openshell gateway start ${gwArgs.join(" ")}`, {
    ignoreError: false,
    env: gatewayEnv,
  });
}

/**
 * Verify gateway health after restart, with retries.
 * @param {object} [deps]
 * @returns {boolean}
 */
function waitForGatewayHealthy(deps = {}) {
  const capture = deps.runCapture ?? runCapture;
  const maxAttempts = deps.maxAttempts ?? 5;

  for (let i = 0; i < maxAttempts; i++) {
    const status = capture("openshell status 2>&1", { ignoreError: true });
    if (typeof status === "string" && status.includes("Connected")) {
      return true;
    }
    if (i < maxAttempts - 1) {
      spawnSync("sleep", ["2"]);
    }
  }
  return false;
}

/**
 * Re-apply CoreDNS fix if needed for the current container runtime.
 * @param {object} [deps]
 */
function repairCoreDns(deps = {}) {
  const capture = deps.runCapture ?? runCapture;
  const execute = deps.run ?? run;

  const info = capture("docker info 2>/dev/null", { ignoreError: true });
  const runtime = inferContainerRuntime(info);

  if (shouldPatchCoredns(runtime)) {
    debug("reconnect: patching CoreDNS for %s", runtime);
    execute(`bash "${path.join(SCRIPTS, "fix-coredns.sh")}" nemoclaw ${runtime} 2>&1 || true`, {
      ignoreError: true,
    });
    // Give DNS a moment to propagate
    spawnSync("sleep", ["3"]);
    return true;
  }
  return false;
}

/**
 * Restart port forwards for a sandbox.
 * @param {string} sandboxName
 * @param {object} [deps]
 */
function restartPortForwards(sandboxName, deps = {}) {
  const execute = deps.run ?? run;
  const sb = registry.getSandbox(sandboxName);
  const dashPort = sb?.dashboardPort || process.env.NEMOCLAW_DASHBOARD_PORT || "18789";

  // Stop stale forwards
  execute(`openshell forward stop ${dashPort} 2>/dev/null || true`, { ignoreError: true });

  // Restart dashboard forward
  execute(`openshell forward start --background ${dashPort} ${shellQuote(sandboxName)} 2>/dev/null || true`, {
    ignoreError: true,
  });
}

/**
 * Build a diagnostic summary of the current state.
 * @param {string} sandboxName
 * @param {object} [deps]
 * @returns {{ gateway: object, sandbox: object, wsl: boolean, runtime: string }}
 */
function diagnose(sandboxName, deps = {}) {
  const capture = deps.runCapture ?? runCapture;
  const gateway = checkGatewayHealth(deps);
  const sandbox = checkSandboxHealth(sandboxName, deps);

  const info = capture("docker info 2>/dev/null", { ignoreError: true });
  const runtime = inferContainerRuntime(info);
  const wsl = isWsl(deps.platformOpts);

  return { gateway, sandbox, wsl, runtime };
}

/**
 * Main reconnect flow.
 *
 * 1. Check gateway health — restart if down/unhealthy
 * 2. Re-apply CoreDNS fix
 * 3. Wait for sandbox to become ready
 * 4. Restart port forwards
 *
 * @param {string} [sandboxName] - Override sandbox name (defaults to registered default)
 * @param {object} [deps] - Injectable dependencies for testing.
 * @returns {{ success: boolean, steps: string[], errors: string[] }}
 */
function reconnect(sandboxName, deps = {}) {
  const steps = [];
  const errors = [];

  // Resolve sandbox name
  const name = sandboxName || registry.getDefault();
  if (!name) {
    return {
      success: false,
      steps,
      errors: ["No sandbox registered. Run `nemoclaw onboard` first."],
    };
  }

  debug("reconnect: target sandbox=%s", name);

  // Step 1: Check & repair gateway
  const gwHealth = checkGatewayHealth(deps);
  if (!gwHealth.running || !gwHealth.healthy) {
    steps.push("Restarting gateway...");
    try {
      restartGateway(deps);
      const gwOk = waitForGatewayHealthy(deps);
      if (gwOk) {
        steps.push("Gateway restarted successfully");
      } else {
        errors.push("Gateway failed to become healthy after restart");
        return { success: false, steps, errors };
      }
    } catch (err) {
      errors.push(`Gateway restart failed: ${err.message || err}`);
      return { success: false, steps, errors };
    }
  } else {
    steps.push("Gateway is healthy");
  }

  // Step 2: CoreDNS fix
  const dnsPatched = repairCoreDns(deps);
  if (dnsPatched) {
    steps.push("CoreDNS patched for container runtime");
  }

  // Step 3: Wait for sandbox
  const sbHealth = checkSandboxHealth(name, deps);
  if (!sbHealth.exists) {
    errors.push(`Sandbox '${name}' not found in gateway. You may need to re-onboard.`);
    return { success: false, steps, errors };
  }

  if (!sbHealth.ready) {
    steps.push("Waiting for sandbox to become ready...");
    const ready = waitForSandboxReady(name, deps);
    if (ready) {
      steps.push("Sandbox is ready");
    } else {
      errors.push(`Sandbox '${name}' did not become ready within timeout`);
      return { success: false, steps, errors };
    }
  } else {
    steps.push("Sandbox is ready");
  }

  // Step 4: Restart port forwards
  restartPortForwards(name, deps);
  steps.push("Port forwards restarted");

  return { success: true, steps, errors };
}

module.exports = {
  checkGatewayHealth,
  checkSandboxHealth,
  diagnose,
  reconnect,
  repairCoreDns,
  restartGateway,
  restartPortForwards,
  waitForGatewayHealthy,
  waitForSandboxReady,
};
