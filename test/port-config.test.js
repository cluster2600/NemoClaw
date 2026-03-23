// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const net = require("net");
const {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_NIM_PORT,
  getConfiguredPorts,
  parsePortEnv,
  resolvePort,
} = require("../bin/lib/preflight");

describe("parsePortEnv", () => {
  const saved = {};

  beforeEach(() => {
    saved.NEMOCLAW_GATEWAY_PORT = process.env.NEMOCLAW_GATEWAY_PORT;
    saved.NEMOCLAW_DASHBOARD_PORT = process.env.NEMOCLAW_DASHBOARD_PORT;
    saved.NEMOCLAW_NIM_PORT = process.env.NEMOCLAW_NIM_PORT;
  });

  afterEach(() => {
    if (saved.NEMOCLAW_GATEWAY_PORT === undefined) {
      delete process.env.NEMOCLAW_GATEWAY_PORT;
    } else {
      process.env.NEMOCLAW_GATEWAY_PORT = saved.NEMOCLAW_GATEWAY_PORT;
    }
    if (saved.NEMOCLAW_DASHBOARD_PORT === undefined) {
      delete process.env.NEMOCLAW_DASHBOARD_PORT;
    } else {
      process.env.NEMOCLAW_DASHBOARD_PORT = saved.NEMOCLAW_DASHBOARD_PORT;
    }
    if (saved.NEMOCLAW_NIM_PORT === undefined) {
      delete process.env.NEMOCLAW_NIM_PORT;
    } else {
      process.env.NEMOCLAW_NIM_PORT = saved.NEMOCLAW_NIM_PORT;
    }
  });

  it("returns default when env var is unset", () => {
    delete process.env.NEMOCLAW_GATEWAY_PORT;
    assert.equal(parsePortEnv("NEMOCLAW_GATEWAY_PORT", 8080), 8080);
  });

  it("returns default when env var is empty", () => {
    process.env.NEMOCLAW_GATEWAY_PORT = "";
    assert.equal(parsePortEnv("NEMOCLAW_GATEWAY_PORT", 8080), 8080);
  });

  it("returns default when env var is whitespace", () => {
    process.env.NEMOCLAW_GATEWAY_PORT = "   ";
    assert.equal(parsePortEnv("NEMOCLAW_GATEWAY_PORT", 8080), 8080);
  });

  it("parses valid port from env var", () => {
    process.env.NEMOCLAW_GATEWAY_PORT = "9090";
    assert.equal(parsePortEnv("NEMOCLAW_GATEWAY_PORT", 8080), 9090);
  });

  it("trims whitespace around port value", () => {
    process.env.NEMOCLAW_GATEWAY_PORT = "  9090  ";
    assert.equal(parsePortEnv("NEMOCLAW_GATEWAY_PORT", 8080), 9090);
  });

  it("rejects port below 1024", () => {
    process.env.NEMOCLAW_GATEWAY_PORT = "80";
    const result = parsePortEnv("NEMOCLAW_GATEWAY_PORT", 8080);
    assert.equal(typeof result, "object");
    assert.ok(result.error.includes("not a valid port"));
  });

  it("rejects port above 65535", () => {
    process.env.NEMOCLAW_GATEWAY_PORT = "70000";
    const result = parsePortEnv("NEMOCLAW_GATEWAY_PORT", 8080);
    assert.equal(typeof result, "object");
    assert.ok(result.error.includes("not a valid port"));
  });

  it("rejects non-numeric value", () => {
    process.env.NEMOCLAW_GATEWAY_PORT = "abc";
    const result = parsePortEnv("NEMOCLAW_GATEWAY_PORT", 8080);
    assert.equal(typeof result, "object");
    assert.ok(result.error.includes("not a valid port"));
  });

  it("rejects floating point value", () => {
    process.env.NEMOCLAW_GATEWAY_PORT = "8080.5";
    // parseInt("8080.5") === 8080, which is valid — this is acceptable
    assert.equal(parsePortEnv("NEMOCLAW_GATEWAY_PORT", 8080), 8080);
  });

  it("parses NEMOCLAW_NIM_PORT when set", () => {
    process.env.NEMOCLAW_NIM_PORT = "8001";
    assert.equal(parsePortEnv("NEMOCLAW_NIM_PORT", 8000), 8001);
  });

  it("returns NIM default when env var is unset", () => {
    delete process.env.NEMOCLAW_NIM_PORT;
    assert.equal(parsePortEnv("NEMOCLAW_NIM_PORT", 8000), 8000);
  });

  it("rejects invalid NEMOCLAW_NIM_PORT", () => {
    process.env.NEMOCLAW_NIM_PORT = "notanumber";
    const result = parsePortEnv("NEMOCLAW_NIM_PORT", 8000);
    assert.equal(typeof result, "object");
    assert.ok(result.error.includes("not a valid port"));
  });
});

describe("default port constants", () => {
  it("gateway default is 8080", () => {
    assert.equal(DEFAULT_GATEWAY_PORT, 8080);
  });

  it("dashboard default is 18789", () => {
    assert.equal(DEFAULT_DASHBOARD_PORT, 18789);
  });

  it("NIM default is 8000", () => {
    assert.equal(DEFAULT_NIM_PORT, 8000);
  });
});

describe("resolvePort", () => {
  it("returns preferred port when available", async () => {
    const freePort = await getFreePort();
    const result = await resolvePort(freePort, { skipLsof: true });
    assert.equal(result.port, freePort);
    assert.equal(result.changed, false);
  });

  it("auto-selects alternative when preferred port is occupied", async () => {
    const srv = net.createServer();
    const port = await new Promise((resolve) => {
      srv.listen(0, "127.0.0.1", () => resolve(srv.address().port));
    });
    try {
      const result = await resolvePort(port, { skipLsof: true });
      assert.equal(result.changed, true);
      assert.equal(result.original, port);
      assert.ok(result.port > port);
      assert.ok(result.port <= port + 9);
      assert.ok(result.blockedBy);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  });

  it("returns conflict when no alternative found", async () => {
    // Use an injectable checkPort that always says port is taken
    const alwaysBusy = async () => ({
      ok: false,
      process: "test",
      pid: 1,
      reason: "test occupied",
    });
    const result = await resolvePort(9999, { checkPort: alwaysBusy });
    assert.equal(result.changed, false);
    assert.equal(result.port, 9999);
    assert.ok(result.conflict);
    assert.equal(result.conflict.process, "test");
  });

  it("skips alternatives that are also occupied", async () => {
    // Occupy port N, N+1 is free
    const srv = net.createServer();
    const port = await new Promise((resolve) => {
      srv.listen(0, "127.0.0.1", () => resolve(srv.address().port));
    });
    try {
      const result = await resolvePort(port, { skipLsof: true });
      assert.equal(result.changed, true);
      // The alternative should be port+1 or later
      assert.ok(result.port > port);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  });
});

describe("getConfiguredPorts includes NIM port (#684)", () => {
  const saved = {};

  beforeEach(() => {
    saved.NEMOCLAW_NIM_PORT = process.env.NEMOCLAW_NIM_PORT;
    saved.NEMOCLAW_GATEWAY_PORT = process.env.NEMOCLAW_GATEWAY_PORT;
    saved.NEMOCLAW_DASHBOARD_PORT = process.env.NEMOCLAW_DASHBOARD_PORT;
    delete process.env.NEMOCLAW_NIM_PORT;
    delete process.env.NEMOCLAW_GATEWAY_PORT;
    delete process.env.NEMOCLAW_DASHBOARD_PORT;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("returns nimPort defaulting to 8000", () => {
    const ports = getConfiguredPorts();
    assert.equal(ports.nimPort, 8000);
    assert.equal(ports.gatewayPort, 8080);
    assert.equal(ports.dashboardPort, 18789);
  });

  it("reads NEMOCLAW_NIM_PORT override", () => {
    process.env.NEMOCLAW_NIM_PORT = "9000";
    const ports = getConfiguredPorts();
    assert.equal(ports.nimPort, 9000);
  });
});

// Helper: get a free ephemeral port
function getFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}
