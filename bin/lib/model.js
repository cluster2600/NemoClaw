// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Model management: list available models, show current model, switch models.
// Addresses #759 — provides a supported CLI path to change the primary model
// without touching the immutable sandbox openclaw.json.

const registry = require("./registry");
const { CLOUD_MODEL_OPTIONS, DEFAULT_CLOUD_MODEL } = require("./inference-config");
const { DEFAULT_OLLAMA_MODEL } = require("./local-inference");
const { run, runCapture, shellQuote } = require("./runner");

/**
 * Get current model and provider for a sandbox from the registry.
 * @param {string} sandboxName
 * @param {{ registry?: object }} [deps]
 * @returns {{ model: string|null, provider: string|null }}
 */
function getCurrentModel(sandboxName, deps) {
  const _registry = (deps && deps.registry) || registry;
  const sb = _registry.getSandbox(sandboxName);
  if (!sb) return { model: null, provider: null };
  return { model: sb.model || null, provider: sb.provider || null };
}

/**
 * List available models for a given provider.
 * For nvidia-nim: returns the cloud model catalog.
 * For ollama-local: queries `ollama list` for installed models.
 * For vllm-local: returns the currently configured model (vLLM serves one).
 *
 * @param {string} provider
 * @param {{ runCapture?: Function }} [deps]
 * @returns {{ models: Array<{ id: string, label: string }>, source: string }}
 */
function listAvailableModels(provider, deps) {
  const _runCapture = (deps && deps.runCapture) || runCapture;

  switch (provider) {
    case "nvidia-nim":
      return {
        models: CLOUD_MODEL_OPTIONS.map((m) => ({ id: m.id, label: m.label })),
        source: "NVIDIA Endpoint API catalog",
      };

    case "ollama-local": {
      let models = [];
      try {
        const output = _runCapture("ollama list 2>/dev/null", { ignoreError: true });
        if (output) {
          // Parse ollama list output: NAME    ID    SIZE    MODIFIED
          const lines = output.split("\n").slice(1); // skip header
          for (const line of lines) {
            const name = line.trim().split(/\s+/)[0];
            if (name) {
              models.push({ id: name, label: name });
            }
          }
        }
      } catch {
        // Ollama not available
      }
      if (models.length === 0) {
        models = [{ id: DEFAULT_OLLAMA_MODEL, label: `${DEFAULT_OLLAMA_MODEL} (default)` }];
      }
      return { models, source: "locally installed Ollama models" };
    }

    case "vllm-local":
      return {
        models: [{ id: "vllm-local", label: "Local vLLM (single model)" }],
        source: "local vLLM server",
      };

    default:
      return { models: [], source: "unknown provider" };
  }
}

/**
 * Change the active model for a sandbox.
 * Calls `openshell inference set` to update gateway routing and persists
 * the new model in the NemoClaw registry.
 *
 * @param {string} sandboxName
 * @param {string} modelId
 * @param {{ registry?: object, run?: Function, sleep?: Function }} [deps]
 * @returns {{ success: boolean, error?: string }}
 */
function setModel(sandboxName, modelId, deps) {
  const _registry = (deps && deps.registry) || registry;
  const _run = (deps && deps.run) || run;
  const _sleep = (deps && deps.sleep) || (() => {
    const { spawnSync } = require("child_process");
    spawnSync("sleep", ["2"]);
  });

  const sb = _registry.getSandbox(sandboxName);
  if (!sb) {
    return { success: false, error: `Sandbox '${sandboxName}' not found in registry.` };
  }

  const provider = sb.provider;
  if (!provider) {
    return { success: false, error: `Sandbox '${sandboxName}' has no provider configured.` };
  }

  if (!modelId || typeof modelId !== "string" || !modelId.trim()) {
    return { success: false, error: "Model name is required." };
  }

  // Run openshell inference set with retry (gateway may still be starting)
  const maxRetries = 1;
  const cmd =
    `openshell inference set --no-verify --provider ${shellQuote(provider)} --model ${shellQuote(modelId)}`;

  let lastError = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = _run(cmd + " 2>&1", {
        ignoreError: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status === 0) {
        // Update registry with the new model
        _registry.updateSandbox(sandboxName, { model: modelId });
        return { success: true };
      }
      lastError = (result.stdout || result.stderr || "").toString().trim();
    } catch (e) {
      lastError = e.message || String(e);
    }

    if (attempt < maxRetries) {
      _sleep();
    }
  }

  return {
    success: false,
    error: `Failed to set model '${modelId}' on provider '${provider}'.`
      + (lastError ? ` ${lastError}` : "")
      + `\n  To retry manually: openshell inference set --provider ${provider} --model ${shellQuote(modelId)}`,
  };
}

module.exports = {
  getCurrentModel,
  listAvailableModels,
  setModel,
};
