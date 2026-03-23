// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const nim = require("../bin/lib/nim");

describe("nim", () => {
  describe("listModels", () => {
    it("returns 5 models", () => {
      assert.equal(nim.listModels().length, 5);
    });

    it("each model has name, image, and minGpuMemoryMB", () => {
      for (const m of nim.listModels()) {
        assert.ok(m.name, "missing name");
        assert.ok(m.image, "missing image");
        assert.ok(typeof m.minGpuMemoryMB === "number", "minGpuMemoryMB should be number");
        assert.ok(m.minGpuMemoryMB > 0, "minGpuMemoryMB should be positive");
      }
    });
  });

  describe("getImageForModel", () => {
    it("returns correct image for known model", () => {
      assert.equal(
        nim.getImageForModel("nvidia/nemotron-3-nano-30b-a3b"),
        "nvcr.io/nim/nvidia/nemotron-3-nano-30b-a3b:latest"
      );
    });

    it("returns null for unknown model", () => {
      assert.equal(nim.getImageForModel("bogus/model"), null);
    });
  });

  describe("containerName", () => {
    it("prefixes with nemoclaw-nim-", () => {
      assert.equal(nim.containerName("my-sandbox"), "nemoclaw-nim-my-sandbox");
    });
  });

  describe("detectGpu", () => {
    it("returns object or null", () => {
      const gpu = nim.detectGpu();
      if (gpu !== null) {
        assert.ok(gpu.type, "gpu should have type");
        assert.ok(typeof gpu.count === "number", "count should be number");
        assert.ok(typeof gpu.totalMemoryMB === "number", "totalMemoryMB should be number");
        assert.ok(typeof gpu.nimCapable === "boolean", "nimCapable should be boolean");
      }
    });

    it("nvidia type is nimCapable", () => {
      const gpu = nim.detectGpu();
      if (gpu && gpu.type === "nvidia") {
        assert.equal(gpu.nimCapable, true);
      }
    });

    it("apple type is not nimCapable", () => {
      const gpu = nim.detectGpu();
      if (gpu && gpu.type === "apple") {
        assert.equal(gpu.nimCapable, false);
        assert.ok(gpu.name, "apple gpu should have name");
      }
    });
  });

  describe("nimStatus", () => {
    it("returns not running for nonexistent container", () => {
      const st = nim.nimStatus("nonexistent-test-xyz");
      assert.equal(st.running, false);
    });

    it("accepts custom port parameter", () => {
      const st = nim.nimStatus("nonexistent-test-xyz", 9001);
      assert.equal(st.running, false);
      assert.equal(st.container, "nemoclaw-nim-nonexistent-test-xyz");
    });

    it("defaults to port 8000 when port is undefined", () => {
      const st = nim.nimStatus("nonexistent-test-xyz", undefined);
      assert.equal(st.running, false);
    });

    it("defaults to port 8000 when port is null", () => {
      const st = nim.nimStatus("nonexistent-test-xyz", null);
      assert.equal(st.running, false);
    });
  });

  describe("nimStatus uses configurable port (#684/#713)", () => {
    it("nimStatus health check URL uses port parameter, not hardcoded 8000", () => {
      const src = fs.readFileSync(path.join(__dirname, "..", "bin", "lib", "nim.js"), "utf-8");
      // Extract nimStatus function body
      const match = src.match(/function nimStatus\b[\s\S]*?\n\}/);
      assert.ok(match, "nimStatus function must exist");
      const body = match[0];
      // The curl URL should use a variable (safePort), not a hardcoded 8000
      assert.ok(
        !body.includes("localhost:8000"),
        "nimStatus must use port parameter in health check URL, not hardcoded 8000",
      );
      assert.ok(
        body.includes("safePort"),
        "nimStatus should use safePort variable for the health check URL",
      );
    });
  });
});
