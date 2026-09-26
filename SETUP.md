# Setup — claude-jev (live-only MCP, 3 minutes)

Five typed decision tools over the live TypeSafe / OpenJev API, with confidence gating, audit logs, and smart truncation.

## 1. Prerequisites

* **Node.js 20+**
* **Current Claude Code** with plugin `userConfig` support (`claude --version`)
* An API key from **https://console.typesafe.ai**, or your self-hosted OpenJev service

This is a local stdio MCP server for Claude Code / compatible desktop hosts. It is not a web connector for claude.ai.

## 2. Install

```bash
claude plugin marketplace add darwintechlab/claude-openjev
claude plugin install claude-jev@openjev
```

The marketplace installs the repository's `plugin/` directory. The readable JavaScript runtime is included, so installation needs no npm install or build step.

For a local clone:

```bash
git clone https://github.com/darwintechlab/claude-openjev.git
cd claude-openjev
claude plugin validate ./plugin
claude --plugin-dir ./plugin
```

## 3. Configure your key

When the plugin configuration dialog appears, enter:

| Field | Value |
|---|---|
| **TypeSafe / OpenJev API key** | Your API key (required, sensitive) |
| **Jev model** | `jev-latest`, unless you need a specific version |
| **Jev API endpoint** | `https://api.typesafe.ai/v1/systemone`, or your own compatible endpoint |

The host stores sensitive configuration in secure storage and supplies it to the MCP process. Do not paste your key into chat, commit it, or write it into the manifest.

**Upgrading from 0.1.0:** enter your key in plugin settings. The installed plugin no longer uses shell `TYPESAFE_API_KEY` / `JEV_API_KEY` values or loads `.env` files. Restart the MCP server or Claude Code after updating configuration.

## 4. Verify

Ask Claude to run:

```
jev_doctor
```

A successful result contains `ok: true`, the model, and typed answers. A missing configuration produces `API key is required…`; there is no mock fallback.

## 5. First decisions

```
jev_choice { state:"Help! payouts failing 3 days", instructions:"Route to team", criteria:'{"billing":"payments, invoices, and payouts","technical":"software bugs and outages","sales":"buying plans and upgrades","spam":"irrelevant promotional messages"}' }

jev_ask { state:"Please help with my invoice", questions:'{"team":{"type":"choice","instructions":"Route to team","criteria":{"billing":"payments and invoices","technical":"software bugs and outages"}},"is_urgent":{"type":"noul","instructions":"Is urgent?"}}' }
```

Every decision includes `gated.action`: `auto` for sufficiently confident answers, or `escalate` for review by Claude or a person. Keep irreversible actions behind human approval.

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| `API key is required…` | Enter the key in the plugin configuration dialog, then restart Claude/MCP. |
| API authentication error | Check the configured key and endpoint belong to the same service. |
| Plugin configuration is unsupported | Update Claude Code. |
| `description too short` warnings | Write a descriptive sentence for each option. |
| `state … truncated` | Input exceeds 60k characters; summarize it first. |
| `429/529` | The client retries twice with backoff. Reduce concurrency if errors persist. |
| `gated:escalate` on every call | Make the criteria more distinct or supply better context. |

## 7. Development and review packaging

```bash
npm ci
npm run build
npm test
claude plugin validate ./plugin
claude plugin validate ./.claude-plugin/marketplace.json
npm run package:plugin
```

The build emits readable, unminified `.mjs` modules in `plugin/runtime/`, copies the supplied 512×512 `favicon.png`, and preserves bundled dependency licenses. It rejects files at or above 256,000 bytes and package manifests/lockfiles inside the release directory.

Commit the regenerated release files. For Anthropic review, upload **`dist/claude-jev-0.1.1.zip`**, or use **`plugin/`** as the repository plugin path. Do not submit the development repository root. The ZIP contains `.claude-plugin/plugin.json` directly at its root. Push/upload the new version and resubmit the unlisted plugin for review.

The offline test suite starts a copy of the packaged MCP server outside the repository, without `node_modules`, and exercises its tools against a local test endpoint.

## 8. Developer benchmarks

```bash
TYPESAFE_API_KEY=ts_... npm run bench
TYPESAFE_API_KEY=ts_... npm run bench:eval
```

Developer benchmarks retain their shell configuration via `bench/client.mjs`; `bench/eval.mjs` also loads a local `.env` if present. These scripts and their credentials handling are excluded from the distributed plugin. See [bench/results.md](./bench/results.md) for measured results.
