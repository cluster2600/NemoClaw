---
title:
  page: "NemoClaw CLI Commands Reference"
  nav: "Commands"
description: "Full CLI reference for plugin and standalone NemoClaw commands."
keywords: ["nemoclaw cli commands", "nemoclaw command reference"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "nemoclaw", "cli"]
content:
  type: reference
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Commands

The `nemoclaw` CLI is the primary interface for managing NemoClaw sandboxes. It is installed when you run `npm install -g git+https://github.com/NVIDIA/NemoClaw.git`.

### `/nemoclaw` Slash Command

The `/nemoclaw` slash command is available inside the OpenClaw chat interface for quick actions:

| Subcommand | Description |
|---|---|
| `/nemoclaw status` | Show sandbox and inference state |

## Standalone Host Commands

The `nemoclaw` binary handles host-side operations that run outside the OpenClaw plugin context.

### `nemoclaw onboard`

Run the interactive setup wizard.
The wizard creates an OpenShell gateway, registers inference providers, builds the sandbox image, and creates the sandbox.
Use this command for new installs and for recreating a sandbox after changes to policy or configuration.

```console
$ nemoclaw onboard
```

The first run prompts for your NVIDIA API key and saves it to `~/.nemoclaw/credentials.json`.

The wizard prompts for a sandbox name.
Names must follow RFC 1123 subdomain rules: lowercase alphanumeric characters and hyphens only, and must start and end with an alphanumeric character.
Uppercase letters are automatically lowercased.

Before creating the gateway, the wizard runs preflight checks.
On systems with cgroup v2 (Ubuntu 24.04, DGX Spark, WSL2), it verifies that Docker is configured with `"default-cgroupns-mode": "host"` and provides fix instructions if the setting is missing.

### `nemoclaw list`

List all registered sandboxes with their model, provider, and policy presets.

```console
$ nemoclaw list
```

### `nemoclaw deploy`

:::{warning}
The `nemoclaw deploy` command is experimental and may not work as expected.
:::

Deploy NemoClaw to a remote GPU instance through [Brev](https://brev.nvidia.com).
The deploy script installs Docker, NVIDIA Container Toolkit if a GPU is present, and OpenShell on the VM, then runs the nemoclaw setup and connects to the sandbox.

```console
$ nemoclaw deploy <instance-name>
```

### `nemoclaw <name> connect`

Connect to a sandbox by name.

```console
$ nemoclaw my-assistant connect
```

### `nemoclaw <name> status`

Show sandbox status, health, and inference configuration.

```console
$ nemoclaw my-assistant status
```

### `nemoclaw <name> logs`

View sandbox logs.
Use `--follow` to stream output in real time.

```console
$ nemoclaw my-assistant logs [--follow]
```

### `nemoclaw <name> destroy`

Stop the NIM container and delete the sandbox.
This removes the sandbox from the registry.

```console
$ nemoclaw my-assistant destroy
```

### `nemoclaw <name> policy-add`

Add a policy preset to a sandbox.
Presets extend the baseline network policy with additional endpoints.

```console
$ nemoclaw my-assistant policy-add
```

### `nemoclaw <name> policy-list`

List available policy presets and show which ones are applied to the sandbox.

```console
$ nemoclaw my-assistant policy-list
```

### `nemoclaw <name> model`

View or change the active inference model for a sandbox.
Without a subcommand, shows the current model and provider.

```console
$ nemoclaw my-assistant model
$ nemoclaw my-assistant model list
$ nemoclaw my-assistant model set moonshotai/kimi-k2.5
```

| Subcommand | Description |
|---|---|
| `list` | List available models for the sandbox's provider |
| `set <model-id>` | Switch inference routing to a different model |

Model changes take effect immediately via the gateway inference route.
The sandbox `openclaw.json` is immutable by design and is not modified.

### `openshell term`

Open the OpenShell TUI to monitor sandbox activity and approve network egress requests.
Run this on the host where the sandbox is running.

```console
$ openshell term
```

For a remote Brev instance, SSH to the instance and run `openshell term` there, or use a port-forward to the gateway.

### `nemoclaw start`

Start auxiliary services, such as the Telegram bridge and cloudflared tunnel.

```console
$ nemoclaw start
```

Requires `TELEGRAM_BOT_TOKEN` for the Telegram bridge.

### `nemoclaw stop`

Stop all auxiliary services.

```console
$ nemoclaw stop
```

### `nemoclaw status`

Show the sandbox list and the status of auxiliary services.

```console
$ nemoclaw status
```

### `nemoclaw setup-spark`

Set up NemoClaw on DGX Spark.
This command applies cgroup v2 and Docker fixes required for Ubuntu 24.04.
Run with `sudo` on the Spark host.
After the fixes complete, the script prompts you to run `nemoclaw onboard` to continue setup.

```console
$ sudo nemoclaw setup-spark
```

### `nemoclaw debug`

Collect diagnostic information for bug reports.
Gathers system info, Docker state, sandbox health, and logs into a tarball.

```console
$ nemoclaw debug
$ nemoclaw debug --quick
$ nemoclaw debug --output /tmp/diag.tar.gz
```

| Option | Description |
|---|---|
| `--quick` | Minimal diagnostics (system info only) |
| `--sandbox <name>` | Target a specific sandbox |
| `--output <path>` | Save diagnostics tarball to a file |

### `nemoclaw reconnect`

Repair gateway and sandbox connectivity without re-onboarding.
Useful after Docker restarts, WSL2 shutdowns, or network changes.

```console
$ nemoclaw reconnect
$ nemoclaw reconnect my-sandbox
$ nemoclaw reconnect --diagnose
```

| Option | Description |
|---|---|
| `--diagnose` | Show connectivity diagnostics without attempting repair |

If repair fails, the command suggests running `nemoclaw onboard` as a fallback.

### `nemoclaw update`

Update NemoClaw to the latest version.
Automatically detects the installation type (source checkout or global npm) and uses the appropriate update method.

```console
$ nemoclaw update
$ nemoclaw update --check
```

| Option | Description |
|---|---|
| `--check` | Check for updates without installing |

For source checkouts, runs `git fetch` + `git reset` + rebuild.
For global npm installs, runs `npm install -g`.

### `nemoclaw uninstall`

Remove NemoClaw, sandboxes, and optionally Ollama models.
Runs the local `uninstall.sh` if available, otherwise falls back to the remote script.

```console
$ nemoclaw uninstall
$ nemoclaw uninstall --yes
$ nemoclaw uninstall --yes --delete-models
```

| Option | Description |
|---|---|
| `--yes` | Skip the confirmation prompt |
| `--keep-openshell` | Leave the openshell binary installed |
| `--delete-models` | Remove NemoClaw-pulled Ollama models |

### `nemoclaw help`

Show the full CLI help text with all available commands and options.

```console
$ nemoclaw help
$ nemoclaw --help
$ nemoclaw -h
```
