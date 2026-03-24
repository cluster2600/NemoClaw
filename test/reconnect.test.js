// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  checkGatewayHealth,
  checkSandboxHealth,
  diagnose,
  reconnect,
  repairCoreDns,
  restartGateway,
  restartPortForwards,
  waitForGatewayHealthy,
  waitForSandboxReady,
} = require("../bin/lib/reconnect");

// ---------------------------------------------------------------------------
// checkGatewayHealth
// ---------------------------------------------------------------------------

describe("checkGatewayHealth", () => {
  it("returns not running when gateway info is empty", () => {
    const result = checkGatewayHealth({
      runCapture: () => "",
    });
    assert.equal(result.running, false);
    assert.equal(result.healthy, false);
  });

  it("returns running but unhealthy when gateway exists but status not Connected", () => {
    const result = checkGatewayHealth({
      runCapture: (cmd) => {
        if (cmd.includes("gateway info")) return "nemoclaw  Running  10m";
        if (cmd.includes("status")) return "Disconnected";
        return "";
      },
    });
    assert.equal(result.running, true);
    assert.equal(result.healthy, false);
  });

  it("returns running and healthy when gateway is Connected", () => {
    const result = checkGatewayHealth({
      runCapture: (cmd) => {
        if (cmd.includes("gateway info")) return "nemoclaw  Running  10m";
        if (cmd.includes("status")) return "Connected to cluster nemoclaw";
        return "";
      },
    });
    assert.equal(result.running, true);
    assert.equal(result.healthy, true);
  });

  it("handles null gateway info output", () => {
    const result = checkGatewayHealth({
      runCapture: () => null,
    });
    assert.equal(result.running, false);
    assert.equal(result.healthy, false);
  });
});

// ---------------------------------------------------------------------------
// checkSandboxHealth
// ---------------------------------------------------------------------------

describe("checkSandboxHealth", () => {
  it("returns not exists when sandbox not in list", () => {
    const result = checkSandboxHealth("mysandbox", {
      runCapture: () => "NAME      STATUS\nother     Ready",
    });
    assert.equal(result.exists, false);
    assert.equal(result.ready, false);
  });

  it("returns exists but not ready when sandbox is NotReady", () => {
    const result = checkSandboxHealth("openclaw", {
      runCapture: () => "NAME       STATUS\nopenclaw   NotReady",
    });
    assert.equal(result.exists, true);
    assert.equal(result.ready, false);
  });

  it("returns exists and ready when sandbox is Ready", () => {
    const result = checkSandboxHealth("openclaw", {
      runCapture: () => "NAME       STATUS\nopenclaw   Ready",
    });
    assert.equal(result.exists, true);
    assert.equal(result.ready, true);
  });

  it("handles empty output", () => {
    const result = checkSandboxHealth("openclaw", {
      runCapture: () => "",
    });
    assert.equal(result.exists, false);
    assert.equal(result.ready, false);
  });

  it("strips ANSI color codes before parsing", () => {
    const result = checkSandboxHealth("openclaw", {
      runCapture: () => "\x1b[32mopenclaw\x1b[0m   \x1b[32mReady\x1b[0m",
    });
    assert.equal(result.exists, true);
    assert.equal(result.ready, true);
  });
});

// ---------------------------------------------------------------------------
// waitForGatewayHealthy
// ---------------------------------------------------------------------------

describe("waitForGatewayHealthy", () => {
  it("returns true immediately when gateway is connected", () => {
    const result = waitForGatewayHealthy({
      runCapture: () => "Connected to cluster nemoclaw",
      maxAttempts: 3,
    });
    assert.equal(result, true);
  });

  it("returns false after all attempts fail", () => {
    const result = waitForGatewayHealthy({
      runCapture: () => "Disconnected",
      maxAttempts: 1,
    });
    assert.equal(result, false);
  });

  it("succeeds on second attempt", () => {
    let attempt = 0;
    const result = waitForGatewayHealthy({
      runCapture: () => {
        attempt++;
        return attempt >= 2 ? "Connected" : "Disconnected";
      },
      maxAttempts: 3,
    });
    assert.equal(result, true);
    assert.equal(attempt, 2);
  });
});

// ---------------------------------------------------------------------------
// waitForSandboxReady
// ---------------------------------------------------------------------------

describe("waitForSandboxReady", () => {
  it("returns true immediately when sandbox is ready", () => {
    const result = waitForSandboxReady("openclaw", {
      runCapture: () => "openclaw   Ready",
      maxAttempts: 1,
      sleepSec: 0,
    });
    assert.equal(result, true);
  });

  it("returns false when sandbox does not exist", () => {
    const result = waitForSandboxReady("openclaw", {
      runCapture: () => "",
      maxAttempts: 1,
      sleepSec: 0,
    });
    assert.equal(result, false);
  });

  it("returns false after max attempts", () => {
    const result = waitForSandboxReady("openclaw", {
      runCapture: () => "openclaw   NotReady",
      maxAttempts: 2,
      sleepSec: 0,
    });
    assert.equal(result, false);
  });
});

// ---------------------------------------------------------------------------
// restartGateway
// ---------------------------------------------------------------------------

describe("restartGateway", () => {
  it("destroys then starts gateway with pinned version", () => {
    const commands = [];
    const envs = [];
    restartGateway({
      run: (cmd, opts) => {
        commands.push(cmd);
        if (opts?.env) envs.push(opts.env);
      },
      runCapture: () => "openshell 1.2.3",
    });
    assert.ok(commands[0].includes("gateway destroy"));
    assert.ok(commands[1].includes("gateway start"));
    assert.ok(envs.some((e) => e.OPENSHELL_CLUSTER_IMAGE?.includes("1.2.3")));
  });

  it("starts gateway without version pin when version unknown", () => {
    const commands = [];
    const envs = [];
    restartGateway({
      run: (cmd, opts) => {
        commands.push(cmd);
        if (opts?.env) envs.push(opts.env);
      },
      runCapture: () => "unknown",
    });
    assert.equal(commands.length, 2);
    // No env with image pin
    assert.ok(!envs.some((e) => e.OPENSHELL_CLUSTER_IMAGE));
  });
});

// ---------------------------------------------------------------------------
// repairCoreDns
// ---------------------------------------------------------------------------

describe("repairCoreDns", () => {
  it("patches CoreDNS when runtime needs it (colima)", () => {
    let patched = false;
    const result = repairCoreDns({
      runCapture: () => "colima runtime",
      run: (cmd) => {
        if (cmd.includes("fix-coredns")) patched = true;
      },
    });
    assert.equal(result, true);
    assert.equal(patched, true);
  });

  it("patches CoreDNS for docker desktop", () => {
    let patched = false;
    const result = repairCoreDns({
      runCapture: () => "Docker Desktop 4.30",
      run: (cmd) => {
        if (cmd.includes("fix-coredns")) patched = true;
      },
    });
    assert.equal(result, true);
    assert.equal(patched, true);
  });

  it("skips CoreDNS patch for podman", () => {
    const result = repairCoreDns({
      runCapture: () => "podman runtime",
      run: () => {},
    });
    assert.equal(result, false);
  });

  it("skips CoreDNS patch for unknown runtime", () => {
    const result = repairCoreDns({
      runCapture: () => "",
      run: () => {},
    });
    assert.equal(result, false);
  });
});

// ---------------------------------------------------------------------------
// restartPortForwards
// ---------------------------------------------------------------------------

describe("restartPortForwards", () => {
  it("stops and starts port forward for sandbox", () => {
    const commands = [];
    // Mock registry to return no sandbox data — falls back to env/default
    const origGetSandbox = require("../bin/lib/registry").getSandbox;
    require("../bin/lib/registry").getSandbox = () => null;
    try {
      restartPortForwards("openclaw", {
        run: (cmd) => commands.push(cmd),
      });
      assert.ok(commands.some((c) => c.includes("forward stop")));
      assert.ok(commands.some((c) => c.includes("forward start") && c.includes("openclaw")));
    } finally {
      require("../bin/lib/registry").getSandbox = origGetSandbox;
    }
  });

  it("uses custom dashboard port from sandbox registry", () => {
    const commands = [];
    const origGetSandbox = require("../bin/lib/registry").getSandbox;
    require("../bin/lib/registry").getSandbox = () => ({ dashboardPort: 19000 });
    try {
      restartPortForwards("openclaw", {
        run: (cmd) => commands.push(cmd),
      });
      assert.ok(commands.some((c) => c.includes("19000")));
    } finally {
      require("../bin/lib/registry").getSandbox = origGetSandbox;
    }
  });
});

// ---------------------------------------------------------------------------
// diagnose
// ---------------------------------------------------------------------------

describe("diagnose", () => {
  it("returns full diagnostic summary", () => {
    const result = diagnose("openclaw", {
      runCapture: (cmd) => {
        if (cmd.includes("gateway info")) return "nemoclaw Running";
        if (cmd.includes("status")) return "Connected";
        if (cmd.includes("sandbox list")) return "openclaw   Ready";
        if (cmd.includes("docker info")) return "colima";
        return "";
      },
      platformOpts: { platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, release: "" },
    });
    assert.equal(result.gateway.running, true);
    assert.equal(result.gateway.healthy, true);
    assert.equal(result.sandbox.exists, true);
    assert.equal(result.sandbox.ready, true);
    assert.equal(result.wsl, true);
    assert.equal(result.runtime, "colima");
  });

  it("detects unhealthy state", () => {
    const result = diagnose("openclaw", {
      runCapture: () => "",
      platformOpts: { platform: "darwin", env: {}, release: "" },
    });
    assert.equal(result.gateway.running, false);
    assert.equal(result.sandbox.exists, false);
    assert.equal(result.wsl, false);
  });
});

// ---------------------------------------------------------------------------
// reconnect (integration of all steps)
// ---------------------------------------------------------------------------

describe("reconnect", () => {
  // Save and restore registry.getDefault
  let origGetDefault;
  let origGetSandbox;

  beforeEach(() => {
    origGetDefault = require("../bin/lib/registry").getDefault;
    origGetSandbox = require("../bin/lib/registry").getSandbox;
  });

  it("returns error when no sandbox registered", () => {
    require("../bin/lib/registry").getDefault = () => null;
    try {
      const result = reconnect(null, {});
      assert.equal(result.success, false);
      assert.ok(result.errors[0].includes("No sandbox registered"));
    } finally {
      require("../bin/lib/registry").getDefault = origGetDefault;
    }
  });

  it("succeeds when gateway and sandbox are already healthy", () => {
    require("../bin/lib/registry").getSandbox = () => null;
    const result = reconnect("openclaw", {
      runCapture: (cmd) => {
        if (cmd.includes("gateway info")) return "nemoclaw Running";
        if (cmd.includes("openshell status")) return "Connected";
        if (cmd.includes("sandbox list")) return "openclaw   Ready";
        if (cmd.includes("docker info")) return "podman";
        return "";
      },
      run: () => {},
    });
    assert.equal(result.success, true);
    assert.ok(result.steps.includes("Gateway is healthy"));
    assert.ok(result.steps.includes("Sandbox is ready"));
    require("../bin/lib/registry").getSandbox = origGetSandbox;
  });

  it("restarts gateway when unhealthy then succeeds", () => {
    require("../bin/lib/registry").getSandbox = () => null;
    let gwStarted = false;
    let attempt = 0;

    const result = reconnect("openclaw", {
      runCapture: (cmd) => {
        if (cmd.includes("gateway info") && !gwStarted) return "";
        if (cmd.includes("gateway info")) return "nemoclaw Running";
        if (cmd.includes("openshell status") || cmd.includes("status")) {
          attempt++;
          return attempt >= 2 ? "Connected" : "Disconnected";
        }
        if (cmd.includes("sandbox list")) return "openclaw   Ready";
        if (cmd.includes("docker info")) return "podman";
        if (cmd.includes("openshell -V")) return "openshell 1.0.0";
        return "";
      },
      run: (cmd) => {
        if (cmd.includes("gateway start")) gwStarted = true;
      },
      maxAttempts: 3,
    });
    assert.equal(result.success, true);
    assert.ok(result.steps.some((s) => s.includes("Restarting gateway")));
    assert.ok(result.steps.some((s) => s.includes("restarted successfully")));
    require("../bin/lib/registry").getSandbox = origGetSandbox;
  });

  it("fails when sandbox does not exist in gateway", () => {
    require("../bin/lib/registry").getSandbox = () => null;
    const result = reconnect("ghost", {
      runCapture: (cmd) => {
        if (cmd.includes("gateway info")) return "nemoclaw Running";
        if (cmd.includes("status")) return "Connected";
        if (cmd.includes("sandbox list")) return "othersandbox   Ready";
        if (cmd.includes("docker info")) return "";
        return "";
      },
      run: () => {},
    });
    assert.equal(result.success, false);
    assert.ok(result.errors[0].includes("not found in gateway"));
    require("../bin/lib/registry").getSandbox = origGetSandbox;
  });

  it("uses default sandbox name from registry", () => {
    require("../bin/lib/registry").getDefault = () => "default-sandbox";
    require("../bin/lib/registry").getSandbox = () => null;

    const result = reconnect(null, {
      runCapture: (cmd) => {
        if (cmd.includes("gateway info")) return "nemoclaw Running";
        if (cmd.includes("status")) return "Connected";
        if (cmd.includes("sandbox list")) return "default-sandbox   Ready";
        if (cmd.includes("docker info")) return "";
        return "";
      },
      run: () => {},
    });
    assert.equal(result.success, true);
    require("../bin/lib/registry").getDefault = origGetDefault;
    require("../bin/lib/registry").getSandbox = origGetSandbox;
  });

  it("fails when gateway cannot be restarted", () => {
    require("../bin/lib/registry").getSandbox = () => null;
    const result = reconnect("openclaw", {
      runCapture: (cmd) => {
        if (cmd.includes("gateway info")) return "";
        if (cmd.includes("openshell -V")) return "openshell 1.0.0";
        return "";
      },
      run: (cmd, opts) => {
        if (cmd.includes("gateway start") && !opts?.ignoreError) {
          throw new Error("k3s failed to start");
        }
      },
    });
    assert.equal(result.success, false);
    assert.ok(result.errors[0].includes("Gateway restart failed"));
    require("../bin/lib/registry").getSandbox = origGetSandbox;
  });

  it("reports CoreDNS patching for docker runtime", () => {
    require("../bin/lib/registry").getSandbox = () => null;
    const result = reconnect("openclaw", {
      runCapture: (cmd) => {
        if (cmd.includes("gateway info")) return "nemoclaw Running";
        if (cmd.includes("status")) return "Connected";
        if (cmd.includes("sandbox list")) return "openclaw   Ready";
        if (cmd.includes("docker info")) return "docker server version 24.0";
        return "";
      },
      run: () => {},
    });
    assert.equal(result.success, true);
    assert.ok(result.steps.some((s) => s.includes("CoreDNS patched")));
    require("../bin/lib/registry").getSandbox = origGetSandbox;
  });
});
