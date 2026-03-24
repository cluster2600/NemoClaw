// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Self-update for the NemoClaw CLI.
 *
 * Detects the installation type (source checkout via npm link, or global npm
 * install) and updates accordingly:
 *
 *   - **Source checkout** (`~/.nemoclaw/source` or CWD):
 *     git fetch → git reset → npm install → npm run build → npm link
 *
 *   - **Global npm install**:
 *     npm install -g git+https://github.com/NVIDIA/NemoClaw.git
 *
 * Ref: https://github.com/NVIDIA/NemoClaw/issues/642
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { debug } = require("./logger");

const REPO_URL = "https://github.com/NVIDIA/NemoClaw.git";
const DEFAULT_SOURCE_DIR = path.join(os.homedir(), ".nemoclaw", "source");

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Run a shell command synchronously and return trimmed stdout.
 * Returns null on failure.
 */
function exec(cmd, opts = {}) {
  try {
    debug("update: exec %s", cmd);
    return execSync(cmd, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
      ...opts,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Detect the NemoClaw installation type and source directory.
 *
 * Returns { type: "source" | "global" | "unknown", sourceDir: string | null }
 *
 * @param {object} [deps] - Injectable dependencies for testing.
 * @param {function} [deps.existsSync] - Replacement for fs.existsSync.
 * @param {function} [deps.readFileSync] - Replacement for fs.readFileSync.
 * @param {function} [deps.exec] - Replacement for module-level exec().
 * @param {string} [deps.root] - Override for the CWD-based root directory.
 * @param {string} [deps.defaultSourceDir] - Override for DEFAULT_SOURCE_DIR.
 */
function detectInstallType(deps = {}) {
  const _existsSync = deps.existsSync ?? fs.existsSync;
  const _readFileSync = deps.readFileSync ?? fs.readFileSync;
  const _exec = deps.exec ?? exec;
  const root = deps.root ?? path.resolve(__dirname, "..", "..");
  const defaultSourceDir = deps.defaultSourceDir ?? DEFAULT_SOURCE_DIR;

  // 1. Check if running from a git checkout (development / source install in CWD)
  const rootPkg = path.join(root, "package.json");
  if (_existsSync(path.join(root, ".git")) && _existsSync(rootPkg)) {
    try {
      const pkg = JSON.parse(_readFileSync(rootPkg, "utf8"));
      if (pkg.name === "nemoclaw") {
        debug("update: source install detected at %s", root);
        return { type: "source", sourceDir: root };
      }
    } catch { /* ignore */ }
  }

  // 2. Check the default source directory created by the installer
  const defaultPkg = path.join(defaultSourceDir, "package.json");
  if (_existsSync(path.join(defaultSourceDir, ".git")) && _existsSync(defaultPkg)) {
    debug("update: source install detected at %s", defaultSourceDir);
    return { type: "source", sourceDir: defaultSourceDir };
  }

  // 3. Check if installed globally via npm
  const npmRoot = _exec("npm root -g");
  if (npmRoot) {
    const globalPkg = path.join(npmRoot, "nemoclaw", "package.json");
    if (_existsSync(globalPkg)) {
      debug("update: global npm install detected");
      return { type: "global", sourceDir: null };
    }
  }

  return { type: "unknown", sourceDir: null };
}

/**
 * Fetch the latest remote commit SHA without cloning.
 * Returns the short SHA or null on failure.
 *
 * @param {object} [deps] - Injectable dependencies for testing.
 * @param {function} [deps.exec] - Replacement for module-level exec().
 */
function fetchRemoteHead(deps = {}) {
  const _exec = deps.exec ?? exec;
  const out = _exec(`git ls-remote ${REPO_URL} refs/heads/main`);
  if (!out) return null;
  const sha = out.split(/\s/)[0];
  return sha ? sha.slice(0, 12) : null;
}

/**
 * Get the local HEAD commit SHA in a source directory.
 */
function getLocalHead(sourceDir) {
  return exec("git rev-parse --short=12 HEAD", { cwd: sourceDir });
}

/**
 * Read the version from a package.json file.
 */
function readVersion(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Check whether an update is available.
 * Returns { current, remote, updateAvailable, currentVersion }.
 *
 * @param {object} install - The installation info from detectInstallType().
 * @param {object} [deps] - Injectable dependencies for testing.
 * @param {function} [deps.fetchRemoteHead] - Override fetchRemoteHead().
 * @param {function} [deps.getLocalHead] - Override getLocalHead().
 * @param {function} [deps.readVersion] - Override readVersion().
 */
function checkForUpdate(install, deps = {}) {
  const _fetchRemoteHead = deps.fetchRemoteHead ?? fetchRemoteHead;
  const _getLocalHead = deps.getLocalHead ?? getLocalHead;
  const _readVersion = deps.readVersion ?? readVersion;

  const remote = _fetchRemoteHead();
  if (!remote) {
    return { error: "Could not reach GitHub to check for updates." };
  }

  if (install.type === "source" && install.sourceDir) {
    const local = _getLocalHead(install.sourceDir);
    const version = _readVersion(install.sourceDir);
    return {
      current: local,
      remote,
      currentVersion: version,
      updateAvailable: local !== remote,
    };
  }

  // For global installs, we can only compare remote HEAD
  return {
    current: null,
    remote,
    currentVersion: _readVersion(path.resolve(__dirname, "..", "..")),
    updateAvailable: true, // Cannot compare — always offer update
  };
}

/**
 * Update a source-based installation.
 * @param {string} sourceDir
 * @param {object} [deps] - Injectable dependencies for testing.
 * @param {function} [deps.exec] - Replacement for module-level exec().
 * @param {function} [deps.execSync] - Replacement for child_process.execSync.
 * @param {function} [deps.write] - Replacement for process.stdout.write.
 * @param {function} [deps.log] - Replacement for console.log.
 * @param {function} [deps.logError] - Replacement for console.error.
 */
function updateSource(sourceDir, deps = {}) {
  const { exec: _exec, execSync: _execSync, write: _write, log: _log, logError: _logError } = {
    exec, execSync, write: (s) => process.stdout.write(s),
    log: console.log.bind(console), logError: console.error.bind(console), ...deps,
  };

  const steps = [
    { msg: "Fetching latest changes", cmd: "git fetch origin main" },
    { msg: "Updating to latest", cmd: "git reset --hard origin/main" },
    { msg: "Installing dependencies", cmd: "npm install --ignore-scripts" },
    { msg: "Building plugin", cmd: 'bash -lc \'cd nemoclaw && npm install --ignore-scripts && npm run build\'' },
    { msg: "Linking CLI", cmd: "npm link --ignore-scripts" },
  ];

  for (const { msg, cmd } of steps) {
    _write(`  ${msg}...`);
    const result = _exec(cmd, { cwd: sourceDir, timeout: 300_000 });
    if (result === null) {
      // execSync threw — check if it was really a failure
      // Some commands (like git fetch) may output to stderr but succeed
      try {
        _execSync(cmd, {
          cwd: sourceDir,
          stdio: "pipe",
          timeout: 300_000,
        });
        _log(" done");
      } catch (err) {
        _log(" FAILED");
        const stderr = err.stderr ? err.stderr.toString().trim() : "";
        if (stderr) _logError(`    ${stderr}`);
        return false;
      }
    } else {
      _log(" done");
    }
  }
  return true;
}

/**
 * Update a global npm installation.
 * @param {object} [deps] - Injectable dependencies for testing.
 */
function updateGlobal(deps = {}) {
  const { exec: _exec, execSync: _execSync, write: _write, log: _log, logError: _logError } = {
    exec, execSync, write: (s) => process.stdout.write(s),
    log: console.log.bind(console), logError: console.error.bind(console), ...deps,
  };

  _write("  Installing latest NemoClaw from GitHub...");
  const result = _exec(`npm install -g git+https://${REPO_URL.replace("https://", "")}`, {
    timeout: 300_000,
  });
  if (result === null) {
    try {
      _execSync(`npm install -g git+https://${REPO_URL.replace("https://", "")}`, {
        stdio: "pipe",
        timeout: 300_000,
      });
      _log(" done");
      return true;
    } catch (err) {
      _log(" FAILED");
      const stderr = err.stderr ? err.stderr.toString().trim() : "";
      if (stderr) _logError(`    ${stderr}`);
      return false;
    }
  }
  _log(" done");
  return true;
}

/**
 * Verify the update by checking nemoclaw --version.
 * @param {object} [deps] - Injectable dependencies for testing.
 */
function verifyUpdate(deps = {}) {
  const { exec: _exec } = { exec, ...deps };
  const out = _exec("nemoclaw --version");
  return out || null;
}

// ── Exports ─────────────────────────────────────────────────────

module.exports = {
  detectInstallType,
  checkForUpdate,
  updateSource,
  updateGlobal,
  verifyUpdate,
  fetchRemoteHead,
  getLocalHead,
  readVersion,
  DEFAULT_SOURCE_DIR,
  REPO_URL,
};
