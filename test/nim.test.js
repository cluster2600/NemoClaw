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

  // ── detectGpu branch coverage with dependency injection ────────
  describe("detectGpu — NVIDIA discrete GPU branches", () => {
    it("detects single NVIDIA GPU with VRAM", () => {
      const gpu = nim.detectGpu({
        runCapture: (cmd) => {
          if (cmd.includes("memory.total")) return "24576\n";
          return "";
        },
      });
      assert.deepEqual(gpu, {
        type: "nvidia",
        count: 1,
        totalMemoryMB: 24576,
        perGpuMB: 24576,
        nimCapable: true,
      });
    });

    it("detects multiple NVIDIA GPUs and sums VRAM", () => {
      const gpu = nim.detectGpu({
        runCapture: (cmd) => {
          if (cmd.includes("memory.total")) return "24576\n24576\n";
          return "";
        },
      });
      assert.equal(gpu.type, "nvidia");
      assert.equal(gpu.count, 2);
      assert.equal(gpu.totalMemoryMB, 49152);
      assert.equal(gpu.perGpuMB, 24576);
      assert.equal(gpu.nimCapable, true);
    });

    it("falls through when nvidia-smi returns empty output", () => {
      const gpu = nim.detectGpu({
        platform: "linux",
        runCapture: () => "",
      });
      assert.equal(gpu, null);
    });

    it("falls through when nvidia-smi returns non-numeric lines", () => {
      const gpu = nim.detectGpu({
        platform: "linux",
        runCapture: (cmd) => {
          if (cmd.includes("memory.total")) return "N/A\n";
          if (cmd.includes("name")) return "Unknown GPU\n";
          return "";
        },
      });
      assert.equal(gpu, null);
    });

    it("falls through when nvidia-smi throws", () => {
      const gpu = nim.detectGpu({
        platform: "linux",
        runCapture: () => { throw new Error("nvidia-smi not found"); },
      });
      assert.equal(gpu, null);
    });
  });

  describe("detectGpu — DGX Spark (GB10) branches", () => {
    it("detects GB10 with system RAM from free -m", () => {
      const gpu = nim.detectGpu({
        runCapture: (cmd) => {
          if (cmd.includes("memory.total")) return "";
          if (cmd.includes("name")) return "NVIDIA GB10 Superchip\n";
          if (cmd.includes("free -m")) return "128000";
          return "";
        },
      });
      assert.deepEqual(gpu, {
        type: "nvidia",
        count: 1,
        totalMemoryMB: 128000,
        perGpuMB: 128000,
        nimCapable: true,
        spark: true,
      });
    });

    it("detects GB10 with zero memory when free -m returns empty", () => {
      const gpu = nim.detectGpu({
        runCapture: (cmd) => {
          if (cmd.includes("memory.total")) return "";
          if (cmd.includes("name")) return "NVIDIA GB10 Superchip\n";
          if (cmd.includes("free -m")) return "";
          return "";
        },
      });
      assert.equal(gpu.type, "nvidia");
      assert.equal(gpu.spark, true);
      assert.equal(gpu.totalMemoryMB, 0);
    });

    it("detects GB10 with zero memory when free -m throws", () => {
      let callCount = 0;
      const gpu = nim.detectGpu({
        runCapture: (cmd) => {
          if (cmd.includes("memory.total")) return "";
          if (cmd.includes("name")) return "GB10\n";
          if (cmd.includes("free -m")) throw new Error("free not found");
          return "";
        },
      });
      assert.equal(gpu.type, "nvidia");
      assert.equal(gpu.spark, true);
      assert.equal(gpu.totalMemoryMB, 0);
    });

    it("detects GB10 with non-numeric free output falls back to 0", () => {
      const gpu = nim.detectGpu({
        runCapture: (cmd) => {
          if (cmd.includes("memory.total")) return "";
          if (cmd.includes("name")) return "GB10\n";
          if (cmd.includes("free -m")) return "not-a-number";
          return "";
        },
      });
      assert.equal(gpu.spark, true);
      assert.equal(gpu.totalMemoryMB, 0);
    });

    it("skips GB10 path when name does not contain GB10", () => {
      const gpu = nim.detectGpu({
        platform: "linux",
        runCapture: (cmd) => {
          if (cmd.includes("memory.total")) return "";
          if (cmd.includes("name")) return "Tesla T4\n";
          return "";
        },
      });
      assert.equal(gpu, null);
    });

    it("skips GB10 path when name query throws", () => {
      let firstCall = true;
      const gpu = nim.detectGpu({
        platform: "linux",
        runCapture: (cmd) => {
          if (cmd.includes("memory.total")) return "";
          throw new Error("nvidia-smi error");
        },
      });
      assert.equal(gpu, null);
    });
  });

  describe("detectGpu — Apple Silicon branches", () => {
    it("detects Apple Silicon with VRAM in GB", () => {
      const gpu = nim.detectGpu({
        platform: "darwin",
        runCapture: (cmd) => {
          if (cmd.includes("nvidia-smi")) return "";
          if (cmd.includes("system_profiler")) {
            return [
              "Chipset Model: Apple M3 Max",
              "VRAM (Total): 48 GB",
              "Total Number of Cores: 40",
            ].join("\n");
          }
          return "";
        },
      });
      assert.deepEqual(gpu, {
        type: "apple",
        name: "Apple M3 Max",
        count: 1,
        cores: 40,
        totalMemoryMB: 49152,
        perGpuMB: 49152,
        nimCapable: false,
      });
    });

    it("detects Apple Silicon with VRAM in MB", () => {
      const gpu = nim.detectGpu({
        platform: "darwin",
        runCapture: (cmd) => {
          if (cmd.includes("nvidia-smi")) return "";
          if (cmd.includes("system_profiler")) {
            return [
              "Chipset Model: Apple M2",
              "VRAM (Total): 8192 MB",
            ].join("\n");
          }
          return "";
        },
      });
      assert.equal(gpu.type, "apple");
      assert.equal(gpu.name, "Apple M2");
      assert.equal(gpu.totalMemoryMB, 8192);
      assert.equal(gpu.cores, null);
    });

    it("Apple Silicon without VRAM falls back to sysctl hw.memsize", () => {
      const gpu = nim.detectGpu({
        platform: "darwin",
        runCapture: (cmd) => {
          if (cmd.includes("nvidia-smi")) return "";
          if (cmd.includes("system_profiler")) {
            return "Chipset Model: Apple M1\nTotal Number of Cores: 8";
          }
          if (cmd.includes("sysctl")) return "17179869184"; // 16 GB
          return "";
        },
      });
      assert.equal(gpu.type, "apple");
      assert.equal(gpu.name, "Apple M1");
      assert.equal(gpu.totalMemoryMB, 16384);
      assert.equal(gpu.cores, 8);
    });

    it("Apple Silicon without VRAM and sysctl throws gives 0 memory", () => {
      const gpu = nim.detectGpu({
        platform: "darwin",
        runCapture: (cmd) => {
          if (cmd.includes("nvidia-smi")) return "";
          if (cmd.includes("system_profiler")) {
            return "Chipset Model: Apple M1";
          }
          if (cmd.includes("sysctl")) throw new Error("sysctl failed");
          return "";
        },
      });
      assert.equal(gpu.type, "apple");
      assert.equal(gpu.totalMemoryMB, 0);
    });

    it("Apple Silicon without VRAM and empty sysctl gives 0 memory", () => {
      const gpu = nim.detectGpu({
        platform: "darwin",
        runCapture: (cmd) => {
          if (cmd.includes("nvidia-smi")) return "";
          if (cmd.includes("system_profiler")) {
            return "Chipset Model: Apple M1 Ultra";
          }
          if (cmd.includes("sysctl")) return "";
          return "";
        },
      });
      assert.equal(gpu.type, "apple");
      assert.equal(gpu.totalMemoryMB, 0);
    });

    it("returns null when system_profiler has no Chipset Model", () => {
      const gpu = nim.detectGpu({
        platform: "darwin",
        runCapture: (cmd) => {
          if (cmd.includes("nvidia-smi")) return "";
          if (cmd.includes("system_profiler")) return "Some other output\nNo chipset info";
          return "";
        },
      });
      assert.equal(gpu, null);
    });

    it("returns null when system_profiler returns empty", () => {
      const gpu = nim.detectGpu({
        platform: "darwin",
        runCapture: (cmd) => {
          if (cmd.includes("nvidia-smi")) return "";
          if (cmd.includes("system_profiler")) return "";
          return "";
        },
      });
      assert.equal(gpu, null);
    });

    it("returns null when system_profiler throws", () => {
      const gpu = nim.detectGpu({
        platform: "darwin",
        runCapture: (cmd) => {
          if (cmd.includes("nvidia-smi")) return "";
          if (cmd.includes("system_profiler")) throw new Error("not available");
          return "";
        },
      });
      assert.equal(gpu, null);
    });

    it("skips Apple path entirely on non-darwin platform", () => {
      const gpu = nim.detectGpu({
        platform: "linux",
        runCapture: () => "",
      });
      assert.equal(gpu, null);
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
