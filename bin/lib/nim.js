// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// NIM container management — pull, start, stop, health-check NIM images.

const { run, runCapture, shellQuote } = require("./runner");
const nimImages = require("./nim-images.json");

function containerName(sandboxName) {
  return `nemoclaw-nim-${sandboxName}`;
}

function getImageForModel(modelName) {
  const entry = nimImages.models.find((m) => m.name === modelName);
  return entry ? entry.image : null;
}

function listModels() {
  return nimImages.models.map((m) => ({
    name: m.name,
    image: m.image,
    minGpuMemoryMB: m.minGpuMemoryMB,
  }));
}

function detectGpu(deps) {
  const _runCapture = (deps && deps.runCapture) || runCapture;
  const _platform = (deps && deps.platform) || process.platform;

  // Try NVIDIA first — query VRAM
  try {
    const output = _runCapture(
      "nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits",
      { ignoreError: true }
    );
    if (output) {
      const lines = output.split("\n").filter((l) => l.trim());
      const perGpuMB = lines.map((l) => parseInt(l.trim(), 10)).filter((n) => !isNaN(n));
      if (perGpuMB.length > 0) {
        const totalMemoryMB = perGpuMB.reduce((a, b) => a + b, 0);
        return {
          type: "nvidia",
          count: perGpuMB.length,
          totalMemoryMB,
          perGpuMB: perGpuMB[0],
          nimCapable: true,
        };
      }
    }
  } catch {}

  // Fallback: DGX Spark (GB10) — VRAM not queryable due to unified memory architecture
  try {
    const nameOutput = _runCapture(
      "nvidia-smi --query-gpu=name --format=csv,noheader,nounits",
      { ignoreError: true }
    );
    if (nameOutput && nameOutput.includes("GB10")) {
      // GB10 has 128GB unified memory shared with Grace CPU — use system RAM
      let totalMemoryMB = 0;
      try {
        const memLine = _runCapture("free -m | awk '/Mem:/ {print $2}'", { ignoreError: true });
        if (memLine) totalMemoryMB = parseInt(memLine.trim(), 10) || 0;
      } catch {}
      return {
        type: "nvidia",
        count: 1,
        totalMemoryMB,
        perGpuMB: totalMemoryMB,
        nimCapable: true,
        spark: true,
      };
    }
  } catch {}

  // macOS: detect Apple Silicon or discrete GPU
  if (_platform === "darwin") {
    try {
      const spOutput = _runCapture(
        "system_profiler SPDisplaysDataType 2>/dev/null",
        { ignoreError: true }
      );
      if (spOutput) {
        const chipMatch = spOutput.match(/Chipset Model:\s*(.+)/);
        const vramMatch = spOutput.match(/VRAM.*?:\s*(\d+)\s*(MB|GB)/i);
        const coresMatch = spOutput.match(/Total Number of Cores:\s*(\d+)/);

        if (chipMatch) {
          const name = chipMatch[1].trim();
          let memoryMB = 0;

          if (vramMatch) {
            memoryMB = parseInt(vramMatch[1], 10);
            if (vramMatch[2].toUpperCase() === "GB") memoryMB *= 1024;
          } else {
            // Apple Silicon shares system RAM — read total memory
            try {
              const memBytes = _runCapture("sysctl -n hw.memsize", { ignoreError: true });
              if (memBytes) memoryMB = Math.floor(parseInt(memBytes, 10) / 1024 / 1024);
            } catch {}
          }

          return {
            type: "apple",
            name,
            count: 1,
            cores: coresMatch ? parseInt(coresMatch[1], 10) : null,
            totalMemoryMB: memoryMB,
            perGpuMB: memoryMB,
            nimCapable: false,
          };
        }
      }
    } catch {}
  }

  return null;
}

function pullNimImage(model, deps) {
  const _run = (deps && deps.run) || run;
  const _exit = (deps && deps.exit) || (() => process.exit(1));
  const image = getImageForModel(model);
  if (!image) {
    console.error(`  Unknown model: ${model}`);
    _exit();
    return null;
  }
  console.log(`  Pulling NIM image: ${image}`);
  _run(`docker pull ${shellQuote(image)}`);
  return image;
}

function startNimContainer(sandboxName, model, port = 8000, deps) {
  const _run = (deps && deps.run) || run;
  const _exit = (deps && deps.exit) || (() => process.exit(1));
  const name = containerName(sandboxName);
  const image = getImageForModel(model);
  if (!image) {
    console.error(`  Unknown model: ${model}`);
    _exit();
    return null;
  }

  // Stop any existing container with same name
  const qn = shellQuote(name);
  _run(`docker rm -f ${qn} 2>/dev/null || true`, { ignoreError: true });

  console.log(`  Starting NIM container: ${name}`);
  _run(
    `docker run -d --gpus all -p ${Number(port)}:8000 --name ${qn} --shm-size 16g ${shellQuote(image)}`
  );
  return name;
}

function waitForNimHealth(port = 8000, timeout = 300, deps) {
  const _runCapture = (deps && deps.runCapture) || runCapture;
  const _sleep = (deps && deps.sleep) || (() => require("child_process").spawnSync("sleep", ["5"]));
  const _now = (deps && deps.now) || (() => Date.now());
  const start = _now();
  const safePort = Number(port);
  console.log(`  Waiting for NIM health on port ${safePort} (timeout: ${timeout}s)...`);

  while ((_now() - start) / 1000 < timeout) {
    try {
      const result = _runCapture(`curl -sf http://localhost:${safePort}/v1/models`, {
        ignoreError: true,
      });
      if (result) {
        console.log("  NIM is healthy.");
        return true;
      }
    } catch {}
    _sleep();
  }
  console.error(`  NIM did not become healthy within ${timeout}s.`);
  return false;
}

function stopNimContainer(sandboxName, deps) {
  const _run = (deps && deps.run) || run;
  const name = containerName(sandboxName);
  const qn = shellQuote(name);
  console.log(`  Stopping NIM container: ${name}`);
  _run(`docker stop ${qn} 2>/dev/null || true`, { ignoreError: true });
  _run(`docker rm ${qn} 2>/dev/null || true`, { ignoreError: true });
}

function nimStatus(sandboxName, port, deps) {
  const _runCapture = (deps && deps.runCapture) || runCapture;
  const name = containerName(sandboxName);
  const safePort = Number(port) || 8000;
  try {
    const state = _runCapture(
      `docker inspect --format '{{.State.Status}}' ${shellQuote(name)} 2>/dev/null`,
      { ignoreError: true }
    );
    if (!state) return { running: false, container: name };

    let healthy = false;
    if (state === "running") {
      const health = _runCapture(`curl -sf http://localhost:${safePort}/v1/models 2>/dev/null`, {
        ignoreError: true,
      });
      healthy = !!health;
    }
    return { running: state === "running", healthy, container: name, state };
  } catch {
    return { running: false, container: name };
  }
}

module.exports = {
  containerName,
  getImageForModel,
  listModels,
  detectGpu,
  pullNimImage,
  startNimContainer,
  waitForNimHealth,
  stopNimContainer,
  nimStatus,
};
