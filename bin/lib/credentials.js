// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const path = require("path");
const readline = require("readline");
const { execSync } = require("child_process");
const { readConfigFile, writeConfigFile } = require("./config-io");

const CREDS_DIR = path.join(process.env.HOME || "/tmp", ".nemoclaw");
const CREDS_FILE = path.join(CREDS_DIR, "credentials.json");

function loadCredentials() {
  return readConfigFile(CREDS_FILE, {});
}

function saveCredential(key, value) {
  const creds = loadCredentials();
  creds[key] = value;
  writeConfigFile(CREDS_FILE, creds);
}

function getCredential(key) {
  if (process.env[key]) return process.env[key];
  const creds = loadCredentials();
  return creds[key] || null;
}

/**
 * All credential keys known to NemoClaw.  Every integration should use
 * getCredential() to read these — never raw process.env access.
 */
const KNOWN_CREDENTIAL_KEYS = [
  "NVIDIA_API_KEY",
  "GITHUB_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
];

/**
 * Build an env-var object containing every known credential that is
 * currently available (via env override or credentials.json).
 *
 * Use this when spawning subprocesses so secrets travel via the
 * environment — never as command-line arguments (visible in /proc,
 * shell history, and log output).
 *
 * @param {string[]} [keys] — restrict to these keys; defaults to all.
 * @returns {Record<string, string>}
 */
function buildCredentialEnv(keys) {
  const list = keys || KNOWN_CREDENTIAL_KEYS;
  const env = {};
  for (const key of list) {
    const val = getCredential(key);
    if (val) env[key] = val;
  }
  return env;
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      if (!process.stdin.isTTY) {
        if (typeof process.stdin.pause === "function") {
          process.stdin.pause();
        }
        if (typeof process.stdin.unref === "function") {
          process.stdin.unref();
        }
      }
      resolve(answer.trim());
    });
  });
}

async function ensureApiKey(deps) {
  const _getCredential = (deps && deps.getCredential) || getCredential;
  const _saveCredential = (deps && deps.saveCredential) || saveCredential;
  const _prompt = (deps && deps.prompt) || prompt;
  const _env = (deps && deps.env) || process.env;
  const _exit = (deps && deps.exit) || (() => process.exit(1));

  let key = _getCredential("NVIDIA_API_KEY");
  if (key) {
    _env.NVIDIA_API_KEY = key;
    return;
  }

  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────────────────┐");
  console.log("  │  NVIDIA API Key required                                        │");
  console.log("  │                                                                 │");
  console.log("  │  1. Go to https://build.nvidia.com/settings/api-keys            │");
  console.log("  │  2. Sign in with your NVIDIA account                            │");
  console.log("  │  3. Click 'Generate API Key' button                             │");
  console.log("  │  4. Paste the key below (starts with nvapi-)                    │");
  console.log("  └─────────────────────────────────────────────────────────────────┘");
  console.log("");

  key = await _prompt("  NVIDIA API Key: ");

  if (!key || !key.startsWith("nvapi-")) {
    console.error("  Invalid key. Must start with nvapi-");
    _exit();
    return;
  }

  _saveCredential("NVIDIA_API_KEY", key);
  _env.NVIDIA_API_KEY = key;
  console.log("");
  console.log("  Key saved to ~/.nemoclaw/credentials.json (mode 600)");
  console.log("");
}

function isRepoPrivate(repo) {
  try {
    const json = execSync(`gh api repos/${repo} --jq .private 2>/dev/null`, { encoding: "utf-8" }).trim();
    return json === "true";
  } catch {
    return false;
  }
}

async function ensureGithubToken(deps) {
  const _getCredential = (deps && deps.getCredential) || getCredential;
  const _saveCredential = (deps && deps.saveCredential) || saveCredential;
  const _prompt = (deps && deps.prompt) || prompt;
  const _execSync = (deps && deps.execSync) || execSync;
  const _env = (deps && deps.env) || process.env;
  const _exit = (deps && deps.exit) || (() => process.exit(1));

  let token = _getCredential("GITHUB_TOKEN");
  if (token) {
    _env.GITHUB_TOKEN = token;
    return;
  }

  try {
    token = _execSync("gh auth token 2>/dev/null", { encoding: "utf-8" }).trim();
    if (token) {
      _env.GITHUB_TOKEN = token;
      return;
    }
  } catch {}

  console.log("");
  console.log("  ┌──────────────────────────────────────────────────┐");
  console.log("  │  GitHub token required (private repo detected)   │");
  console.log("  │                                                  │");
  console.log("  │  Option A: gh auth login (if you have gh CLI)    │");
  console.log("  │  Option B: Paste a PAT with read:packages scope  │");
  console.log("  └──────────────────────────────────────────────────┘");
  console.log("");

  token = await _prompt("  GitHub Token: ");

  if (!token) {
    console.error("  Token required for deploy (repo is private).");
    _exit();
    return;
  }

  _saveCredential("GITHUB_TOKEN", token);
  _env.GITHUB_TOKEN = token;
  console.log("");
  console.log("  Token saved to ~/.nemoclaw/credentials.json (mode 600)");
  console.log("");
}

module.exports = {
  CREDS_DIR,
  CREDS_FILE,
  KNOWN_CREDENTIAL_KEYS,
  loadCredentials,
  saveCredential,
  getCredential,
  buildCredentialEnv,
  prompt,
  ensureApiKey,
  ensureGithubToken,
  isRepoPrivate,
};
