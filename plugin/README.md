# OpenJev for Claude Code

Typed Choice, Noul (yes/no), and Score decisions through the live TypeSafe / OpenJev API, with confidence gating and privacy-conscious audit logging.

## Setup

Requires Node.js 20+ and a current Claude Code version with plugin `userConfig` support. This is a local stdio MCP server for Claude Code / compatible desktop hosts, not a remote connector for claude.ai.

1. Install `claude-jev@openjev` from the `darwintechlab/claude-openjev` marketplace.
2. Enter your API key from https://console.typesafe.ai in the plugin's **TypeSafe / OpenJev API key** configuration field. It is marked sensitive and stored by the host in secure storage. Do not paste it into chat or edit the manifest to include it.
3. Keep the default model (`jev-latest`) and endpoint (`https://api.typesafe.ai/v1/systemone`), or configure your own OpenJev-compatible endpoint and its key.
4. Run `jev_doctor` to check connectivity.

The tools are `jev_choice`, `jev_noul`, `jev_score`, `jev_ask`, and `jev_doctor`. The bundled `/jev` skill provides usage guidance.

## Data and credentials

Decision text and question schemas are sent to the configured endpoint, authenticated with the configured API key. Audit messages on stderr record a hash of the input, timing, and gating results, not the raw input. Do not include secrets or unrelated private data in decision text.

The host supplies the configured key to the MCP process through `CLAUDE_JEV_API_KEY`. The plugin does not load `.env` files or fall back to shell `TYPESAFE_API_KEY` / `JEV_API_KEY` values. Existing 0.1.0 users must enter their key in plugin settings after upgrading.

## Distribution

This directory is the complete plugin. It contains readable, unminified `.mjs` modules below 256 KB each, the skill, icon, and license notices. It requires no npm install or build step on the user's machine.

Source, development dependencies, benchmarks, and build instructions: https://github.com/darwintechlab/claude-openjev
