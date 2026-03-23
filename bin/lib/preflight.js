// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Preflight checks for NemoClaw onboarding.

const net = require("net");
const { runCapture } = require("./runner");

/**
 * Check whether a TCP port is available for listening.
 *
 * Detection chain:
 *   1. lsof (primary) — identifies the blocking process name + PID
 *   2. Node.js net probe (fallback) — cross-platform, detects EADDRINUSE
 *
 * opts.lsofOutput — inject fake lsof output for testing (skips shell)
 * opts.skipLsof   — force the net-probe fallback path
 *
 * Returns:
 *   { ok: true }
 *   { ok: false, process: string, pid: number|null, reason: string }
 */
async function checkPortAvailable(port, opts) {
  const p = port || 18789;
  const o = opts || {};

  // ── lsof path ──────────────────────────────────────────────────
  if (!o.skipLsof) {
    let lsofOut;
    if (typeof o.lsofOutput === "string") {
      lsofOut = o.lsofOutput;
    } else {
      const hasLsof = runCapture("command -v lsof", { ignoreError: true });
      if (hasLsof) {
        lsofOut = runCapture(
          `lsof -i :${p} -sTCP:LISTEN -P -n 2>/dev/null`,
          { ignoreError: true }
        );
        // On Linux, lsof may need elevated privileges to see other users'
        // processes (GH-726).  Retry with sudo if the first attempt returned
        // nothing and we aren't already root.
        if ((!lsofOut || !lsofOut.trim()) && process.getuid && process.getuid() !== 0) {
          const hasSudo = runCapture("command -v sudo", { ignoreError: true });
          if (hasSudo) {
            lsofOut = runCapture(
              `sudo -n lsof -i :${p} -sTCP:LISTEN -P -n 2>/dev/null`,
              { ignoreError: true }
            );
          }
        }
      }
    }

    if (typeof lsofOut === "string") {
      const lines = lsofOut.split("\n").filter((l) => l.trim());
      // Skip the header line (starts with COMMAND)
      const dataLines = lines.filter((l) => !l.startsWith("COMMAND"));
      if (dataLines.length > 0) {
        // Parse first data line: COMMAND PID USER ...
        const parts = dataLines[0].split(/\s+/);
        const proc = parts[0] || "unknown";
        const pid = parseInt(parts[1], 10) || null;
        return {
          ok: false,
          process: proc,
          pid,
          reason: `lsof reports ${proc} (PID ${pid}) listening on port ${p}`,
        };
      }
      // Empty lsof output is not authoritative — non-root users cannot
      // see listeners owned by root (e.g., docker-proxy, leftover gateway).
      // Fall through to the net probe which uses bind() at the kernel level.
    }
  }

  // ── net probe fallback ─────────────────────────────────────────
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        resolve({
          ok: false,
          process: "unknown",
          pid: null,
          reason: `port ${p} is in use (EADDRINUSE)`,
        });
      } else {
        // Unexpected error — treat port as unavailable
        resolve({
          ok: false,
          process: "unknown",
          pid: null,
          reason: `port probe failed: ${err.message}`,
        });
      }
    });
    srv.listen(p, "127.0.0.1", () => {
      srv.close(() => resolve({ ok: true }));
    });
  });
}

// ── Default ports ─────────────────────────────────────────────────
// These can conflict with common services (e.g., 8080 → web proxies,
// 8000 → Django/vLLM dev servers).  Users override via env vars.
const DEFAULT_GATEWAY_PORT = 8080;
const DEFAULT_DASHBOARD_PORT = 18789;
const DEFAULT_NIM_PORT = 8000;

/**
 * Parse and validate a port from an env var override.
 * Returns the default when the env var is unset or empty.
 * Exits with an error when the value is not a valid port number.
 */
function parsePortEnv(envVar, defaultPort) {
  const raw = (process.env[envVar] || "").trim();
  if (!raw) return defaultPort;
  const port = parseInt(raw, 10);
  if (!Number.isFinite(port) || port < 1024 || port > 65535) {
    return { error: `${envVar}=${raw} is not a valid port (must be 1024–65535)` };
  }
  return port;
}

/**
 * Resolve the preferred port, auto-selecting an alternative when
 * the default is occupied.
 *
 * Search strategy: try preferred port, then preferred+1 .. preferred+9.
 * Returns { port, changed } where changed=true when an alternative was chosen.
 *
 * opts.checkPort — injectable port checker (for testing)
 */
async function resolvePort(preferred, opts) {
  const o = opts || {};
  const check = o.checkPort || checkPortAvailable;

  const result = await check(preferred, o);
  if (result.ok) {
    return { port: preferred, changed: false };
  }

  // Try alternatives: preferred+1 through preferred+9
  for (let offset = 1; offset <= 9; offset++) {
    const candidate = preferred + offset;
    if (candidate > 65535) break;
    const alt = await check(candidate, o);
    if (alt.ok) {
      return { port: candidate, changed: true, original: preferred, blockedBy: result };
    }
  }

  // No alternative found — return the original conflict for error reporting
  return { port: preferred, changed: false, conflict: result };
}

/**
 * Read configured ports from env vars, with defaults.
 * Returns { gatewayPort, dashboardPort } or exits on invalid input.
 */
function getConfiguredPorts() {
  const gw = parsePortEnv("NEMOCLAW_GATEWAY_PORT", DEFAULT_GATEWAY_PORT);
  if (typeof gw === "object" && gw.error) {
    console.error(`  !! ${gw.error}`);
    process.exit(1);
  }
  const dash = parsePortEnv("NEMOCLAW_DASHBOARD_PORT", DEFAULT_DASHBOARD_PORT);
  if (typeof dash === "object" && dash.error) {
    console.error(`  !! ${dash.error}`);
    process.exit(1);
  }
  const nimPort = parsePortEnv("NEMOCLAW_NIM_PORT", DEFAULT_NIM_PORT);
  if (typeof nimPort === "object" && nimPort.error) {
    console.error(`  !! ${nimPort.error}`);
    process.exit(1);
  }
  return { gatewayPort: gw, dashboardPort: dash, nimPort };
}

module.exports = {
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_NIM_PORT,
  checkPortAvailable,
  getConfiguredPorts,
  parsePortEnv,
  resolvePort,
};
