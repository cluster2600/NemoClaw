// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Redirect HOME to a temp dir so tests don't touch real ~/.nemoclaw
const origHome = process.env.HOME;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-configio-"));
process.env.HOME = tmpDir;

const {
  ensureConfigDir,
  writeConfigFile,
  readConfigFile,
  ConfigPermissionError,
} = require("../bin/lib/config-io");

const testDir = path.join(tmpDir, ".nemoclaw");
const testFile = path.join(testDir, "test-config.json");

beforeEach(() => {
  // Clean up test dir between tests
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

afterEach(() => {
  // Restore writable permissions for cleanup
  try {
    if (fs.existsSync(testDir)) {
      fs.chmodSync(testDir, 0o700);
    }
  } catch {}
});

describe("config-io", () => {
  describe("ensureConfigDir", () => {
    it("creates directory with mode 0700", () => {
      ensureConfigDir(testDir);
      const stat = fs.statSync(testDir);
      assert.ok(stat.isDirectory());
      assert.equal(stat.mode & 0o777, 0o700);
    });

    it("succeeds when directory already exists", () => {
      fs.mkdirSync(testDir, { recursive: true, mode: 0o700 });
      assert.doesNotThrow(() => ensureConfigDir(testDir));
    });

    it("throws ConfigPermissionError when directory is not writable", () => {
      fs.mkdirSync(testDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(testDir, 0o500); // read + execute only
      const subDir = path.join(testDir, "sub");
      assert.throws(
        () => ensureConfigDir(subDir),
        (err) => {
          assert.ok(err instanceof ConfigPermissionError);
          assert.equal(err.code, "EACCES");
          assert.ok(err.remediation.includes("chown"));
          return true;
        }
      );
    });

    it("throws ConfigPermissionError when existing dir is read-only", () => {
      fs.mkdirSync(testDir, { recursive: true, mode: 0o500 });
      assert.throws(
        () => ensureConfigDir(testDir),
        (err) => {
          assert.ok(err instanceof ConfigPermissionError);
          assert.ok(err.message.includes("not writable"));
          return true;
        }
      );
    });
  });

  describe("writeConfigFile", () => {
    it("writes JSON with mode 0600", () => {
      writeConfigFile(testFile, { key: "value" });
      const stat = fs.statSync(testFile);
      assert.equal(stat.mode & 0o777, 0o600);
      const data = JSON.parse(fs.readFileSync(testFile, "utf-8"));
      assert.deepEqual(data, { key: "value" });
    });

    it("creates parent directory if missing", () => {
      const nested = path.join(testDir, "deep", "config.json");
      writeConfigFile(nested, { deep: true });
      assert.ok(fs.existsSync(nested));
    });

    it("overwrites existing file atomically", () => {
      writeConfigFile(testFile, { version: 1 });
      writeConfigFile(testFile, { version: 2 });
      const data = JSON.parse(fs.readFileSync(testFile, "utf-8"));
      assert.equal(data.version, 2);
    });

    it("does not leave temp file on success", () => {
      writeConfigFile(testFile, { clean: true });
      const siblings = fs.readdirSync(testDir);
      const tmpFiles = siblings.filter((f) => f.includes(".tmp."));
      assert.equal(tmpFiles.length, 0);
    });

    it("throws ConfigPermissionError on EACCES", () => {
      fs.mkdirSync(testDir, { recursive: true, mode: 0o500 });
      assert.throws(
        () => writeConfigFile(testFile, { fail: true }),
        (err) => {
          assert.ok(err instanceof ConfigPermissionError);
          assert.equal(err.code, "EACCES");
          return true;
        }
      );
    });
  });

  describe("readConfigFile", () => {
    it("reads valid JSON", () => {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(testFile, '{"hello":"world"}');
      const data = readConfigFile(testFile, {});
      assert.deepEqual(data, { hello: "world" });
    });

    it("returns default for missing file", () => {
      const data = readConfigFile(testFile, { empty: true });
      assert.deepEqual(data, { empty: true });
    });

    it("returns default for corrupt JSON", () => {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(testFile, "NOT VALID JSON");
      const data = readConfigFile(testFile, []);
      assert.deepEqual(data, []);
    });

    it("throws ConfigPermissionError on EACCES", () => {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(testFile, '{"secret":true}', { mode: 0o000 });
      assert.throws(
        () => readConfigFile(testFile, {}),
        (err) => {
          assert.ok(err instanceof ConfigPermissionError);
          assert.ok(err.message.includes("Cannot read"));
          return true;
        }
      );
    });
  });

  describe("ConfigPermissionError", () => {
    it("includes remediation in message", () => {
      const err = new ConfigPermissionError("test", "/home/user/.nemoclaw/x");
      assert.ok(err.message.includes("chown"));
      assert.ok(err.message.includes("nemoclaw onboard"));
      assert.equal(err.name, "ConfigPermissionError");
      assert.equal(err.code, "EACCES");
    });

    it("preserves cause", () => {
      const cause = new Error("original");
      const err = new ConfigPermissionError("test", "/tmp/x", cause);
      assert.equal(err.cause, cause);
    });
  });
});
