// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { shellQuote } = require("./runner");

const HOST_GATEWAY_URL = "http://host.openshell.internal";
const CONTAINER_REACHABILITY_IMAGE = "curlimages/curl:8.10.1";
const DEFAULT_OLLAMA_MODEL = "nemotron-3-nano:30b";

function getLocalProviderBaseUrl(provider) {
  switch (provider) {
    case "vllm-local":
      return `${HOST_GATEWAY_URL}:8000/v1`;
    case "ollama-local":
      return `${HOST_GATEWAY_URL}:11434/v1`;
    default:
      return null;
  }
}

function getLocalProviderHealthCheck(provider) {
  switch (provider) {
    case "vllm-local":
      return "curl -sf http://localhost:8000/v1/models 2>/dev/null";
    case "ollama-local":
      return "curl -sf http://localhost:11434/api/tags 2>/dev/null";
    default:
      return null;
  }
}

function getLocalProviderContainerReachabilityCheck(provider) {
  switch (provider) {
    case "vllm-local":
      return `docker run --rm --add-host host.openshell.internal:host-gateway ${CONTAINER_REACHABILITY_IMAGE} -sf http://host.openshell.internal:8000/v1/models 2>/dev/null`;
    case "ollama-local":
      return `docker run --rm --add-host host.openshell.internal:host-gateway ${CONTAINER_REACHABILITY_IMAGE} -sf http://host.openshell.internal:11434/api/tags 2>/dev/null`;
    default:
      return null;
  }
}

function validateLocalProvider(provider, runCapture) {
  const command = getLocalProviderHealthCheck(provider);
  if (!command) {
    return { ok: true };
  }

  const output = runCapture(command, { ignoreError: true });
  if (!output) {
    switch (provider) {
      case "vllm-local":
        return {
          ok: false,
          message: "Local vLLM was selected, but nothing is responding on http://localhost:8000.",
        };
      case "ollama-local":
        return {
          ok: false,
          message: "Local Ollama was selected, but nothing is responding on http://localhost:11434.",
        };
      default:
        return { ok: false, message: "The selected local inference provider is unavailable." };
    }
  }

  const containerCommand = getLocalProviderContainerReachabilityCheck(provider);
  if (!containerCommand) {
    return { ok: true };
  }

  const containerOutput = runCapture(containerCommand, { ignoreError: true });
  if (containerOutput) {
    return { ok: true };
  }

  switch (provider) {
    case "vllm-local":
      return {
        ok: false,
        message:
          "Local vLLM is responding on localhost, but containers cannot reach http://host.openshell.internal:8000. Ensure the server is reachable from containers, not only from the host shell.",
      };
    case "ollama-local":
      return {
        ok: false,
        message:
          "Local Ollama is responding on localhost, but containers cannot reach http://host.openshell.internal:11434. Ensure Ollama listens on 0.0.0.0:11434 instead of 127.0.0.1 so sandboxes can reach it.",
      };
    default:
      return { ok: false, message: "The selected local inference provider is unavailable from containers." };
  }
}

function parseOllamaList(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^NAME\s+/i.test(line))
    .map((line) => line.split(/\s{2,}/)[0])
    .filter(Boolean);
}

function getOllamaModelOptions(runCapture) {
  const output = runCapture("ollama list 2>/dev/null", { ignoreError: true });
  const parsed = parseOllamaList(output);
  if (parsed.length > 0) {
    return parsed;
  }
  return [DEFAULT_OLLAMA_MODEL];
}

/**
 * Check whether Ollama has any locally installed models.
 * Returns true only if `ollama list` reports at least one real model.
 * Used to warn users early (before sandbox creation) that they need
 * to pull a model first.
 * Ref: https://github.com/NVIDIA/NemoClaw/issues/710
 */
function hasInstalledOllamaModels(runCapture) {
  const output = runCapture("ollama list 2>/dev/null", { ignoreError: true });
  const parsed = parseOllamaList(output);
  return parsed.length > 0;
}

/**
 * Build an actionable remediation message for Linux users whose Ollama
 * is bound to 127.0.0.1 (the default) — containers cannot reach it.
 * Returns null on non-Linux platforms or when Ollama is already
 * listening on 0.0.0.0.
 * Ref: https://github.com/NVIDIA/NemoClaw/issues/709
 */
function getOllamaBindAddressHint(platform = process.platform) {
  if (platform !== "linux") return null;
  return (
    "On Linux, Ollama defaults to 127.0.0.1 which is unreachable from containers.\n" +
    "  To fix, restart Ollama with:\n" +
    "    OLLAMA_HOST=0.0.0.0:11434 ollama serve\n" +
    "  Or set the env var permanently:\n" +
    "    sudo systemctl edit ollama  # add Environment=\"OLLAMA_HOST=0.0.0.0\"\n" +
    "    sudo systemctl restart ollama"
  );
}

function getDefaultOllamaModel(runCapture) {
  const models = getOllamaModelOptions(runCapture);
  return models.includes(DEFAULT_OLLAMA_MODEL) ? DEFAULT_OLLAMA_MODEL : models[0];
}

function getOllamaWarmupCommand(model, keepAlive = "15m") {
  const payload = JSON.stringify({
    model,
    prompt: "hello",
    stream: false,
    keep_alive: keepAlive,
  });
  return `nohup curl -s http://localhost:11434/api/generate -H 'Content-Type: application/json' -d ${shellQuote(payload)} >/dev/null 2>&1 &`;
}

function getOllamaProbeCommand(model, timeoutSeconds = 120, keepAlive = "15m") {
  const payload = JSON.stringify({
    model,
    prompt: "hello",
    stream: false,
    keep_alive: keepAlive,
  });
  return `curl -sS --max-time ${timeoutSeconds} http://localhost:11434/api/generate -H 'Content-Type: application/json' -d ${shellQuote(payload)} 2>/dev/null`;
}

function validateOllamaModel(model, runCapture) {
  const output = runCapture(getOllamaProbeCommand(model), { ignoreError: true });
  if (!output) {
    return {
      ok: false,
      message:
        `Selected Ollama model '${model}' did not answer the local probe in time. ` +
        "It may still be loading, too large for the host, or otherwise unhealthy.",
    };
  }

  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed.error === "string" && parsed.error.trim()) {
      return {
        ok: false,
        message: `Selected Ollama model '${model}' failed the local probe: ${parsed.error.trim()}`,
      };
    }
  } catch {}

  return { ok: true };
}

module.exports = {
  CONTAINER_REACHABILITY_IMAGE,
  DEFAULT_OLLAMA_MODEL,
  HOST_GATEWAY_URL,
  getDefaultOllamaModel,
  getLocalProviderBaseUrl,
  getLocalProviderContainerReachabilityCheck,
  getLocalProviderHealthCheck,
  getOllamaBindAddressHint,
  getOllamaModelOptions,
  getOllamaProbeCommand,
  getOllamaWarmupCommand,
  hasInstalledOllamaModels,
  parseOllamaList,
  validateOllamaModel,
  validateLocalProvider,
};
