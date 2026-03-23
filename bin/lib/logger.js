// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Structured CLI logger with --verbose / --debug support.
 *
 * Verbosity is enabled by any of:
 *   - --verbose or --debug on the command line (stripped before dispatch)
 *   - LOG_LEVEL=debug environment variable
 *   - NEMOCLAW_VERBOSE=1 environment variable
 *
 * When enabled, debug messages are written to stderr so they don't
 * interfere with stdout piping or JSON output.
 */

let _verbose = false;

function isVerbose() {
  return _verbose;
}

function setVerbose(enabled) {
  _verbose = !!enabled;
}

/**
 * Initialise verbosity from environment variables.
 * Called once at module load; CLI flag parsing calls setVerbose() later.
 */
function _initFromEnv() {
  if (process.env.LOG_LEVEL === "debug" || process.env.NEMOCLAW_VERBOSE === "1") {
    _verbose = true;
  }
}

/**
 * Write a debug-level message to stderr (only when verbose mode is on).
 * Accepts printf-style arguments: debug("port %d in use", 8080).
 */
function debug(fmt, ...args) {
  if (!_verbose) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  let msg = String(fmt);
  if (args.length > 0) {
    let i = 0;
    msg = msg.replace(/%[sd]/g, () => (i < args.length ? String(args[i++]) : "%s"));
  }
  process.stderr.write(`[${ts}] DEBUG  ${msg}\n`);
}

_initFromEnv();

module.exports = { isVerbose, setVerbose, debug };
