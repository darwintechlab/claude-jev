# Setup — claude-jev (live-only MCP, 3 minutes)

Claude Code mirror of `opencode-openjev` — same 5 tools, same `gated`/`audit`/`smartTruncate`, but **live-only** (no mock fallback) over `https://api.typesafe.ai/v1/systemone`.

## 1. Prerequisites

* **Node >=20**, **Claude Code** (`claude --version`)
* **TYPESAFE_API_KEY** — https://console.typesafe.ai → Create key `ts_…`

## 2. Get your key

```bash
export TYPESAFE_API_KEY=ts_…
# persist:
echo 'export TYPESAFE_API_KEY=ts_…' >> ~/.zshrc && source ~/.zshrc
```

## 3. Install the plugin (local — no registry needed)

```bash
git clone https://github.com/darwintechlab/claude-openjev.git
cd claude-openjev
npm install --cache /tmp/npm-cache
npm run build   # typecheck + esbuild → single self-contained mcp-server/dist/index.js

claude plugin validate ./   # ✔ Validation passed
```

The plugin is **file-based** — no `npm publish` required. `mcp-server` is declared inline under `mcpServers` in `.claude-plugin/plugin.json` as `jev → node ${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.js` with `env:TYPESAFE_API_KEY` passthrough. (Not a root `.mcp.json`: Claude Code would also load that as a *project* server when you open this repo, where `${CLAUDE_PLUGIN_ROOT}` is undefined → `CONNECTION_CLOSED`.)

## 4. Run with Claude

Dev (recommended — no install):

```bash
TYPESAFE_API_KEY=ts_... claude --plugin-dir .
# inside Claude:
# /jev  (skill)  or just ask: "use jev_choice to route this ticket"
```

Installed (loads in every project) — the repo is its own marketplace (`openjev`, `.claude-plugin/marketplace.json`):

```bash
claude plugin marketplace add darwintechlab/claude-openjev   # or a local clone path
claude plugin install claude-jev@openjev
# then in any project: claude (plugin auto-loads)
```

Verify inside Claude:

```
jev_doctor
# → {ok:true, model:"jev-1.13.0", answers:{team:{choice:"billing", confidence:0.94}, is_urgent:{noul:0.95}}}
```

Headless MCP smoke (no Claude):

```bash
TYPESAFE_API_KEY=ts_... printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"jev_doctor","arguments":{}}}\n' | node mcp-server/dist/index.js
```

## 5. First decisions (copy-paste in Claude)

```
# in Claude's tool call:
jev_choice { state:"Help! payouts failing 3 days", instructions:"Route to team", criteria:'{"billing":"payments/invoices","technical":"bugs/outages","sales":"buying","spam":"irrelevant"}' }
# → {choice:"billing", confidence:1.00, gated:{action:"auto"}, usage:{input_tokens:348}}

# ambiguous → escalate:
jev_choice { state:"Please help", instructions:"Route to team", criteria:'{"billing":"pay","technical":"bug","sales":"buy","spam":"junk"}' }
# → {choice:"technical", confidence:0.38, gated:{action:"escalate", reason:"conf 0.38 < 0.75 …"}}
# → then ask Claude for rationale

# parallel (one 70–500ms call):
jev_ask { state:'{"ticket":"payouts failing"}', questions:'{"team":{"type":"choice","instructions":"Route","criteria":{"billing":"pay","technical":"bug"}},"is_urgent":{"type":"noul","instructions":"Is urgent?"}}' }
```

## 6. Env

| Var | Purpose |
|---|---|
| `TYPESAFE_API_KEY` | **Required** — live-only, errors clearly if missing (`TYPESAFE_API_KEY is required… No mock fallback.`) |
| `JEV_MODEL` | Override (`jev-latest` → `jev-1.13.0`) |
| `JEV_BASE_URL` | Self-hosted OpenJev |

No `.env` auto-load here (MCP inherits Claude's env) — use shell export or `mcpServers.jev.env` in `.claude-plugin/plugin.json`.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `ok:false, error:"TYPESAFE_API_KEY is required…"` | `echo $TYPESAFE_API_KEY` empty → `export TYPESAFE_API_KEY=ts_…` and restart Claude/MCP. |
| `description too short` warnings | Option desc <12 chars — add a sentence (`"pay"` → `"payments, invoices, payouts"`). |
| `state … truncated` | >60k chars — `smartTruncate` keeps 60% head + tail + marker. Summarize first. |
| `429/529` | Auto-retry 2× with backoff. Still failing → back off 1s and retry, or lower `questions` batch. |
| `gated:escalate` on every call | Overlapping criteria (Jaccard >0.6) — differentiate rubrics. |

## 8. Bench (live, same as Opencode)

```bash
TYPESAFE_API_KEY=ts_... node bench/bench.mjs
# → 1q p50 307ms, 27q p50 287ms (+5ms), 10/10 100% @ conf 0.96, par 8×
```

## 9. Opencode parity

This is a 1:1 mirror of `opencode-openjev/src/*` (`client`/`gate`/`audit`/`state`) — same `60k` cap, `32` questions, `2` retries, `15s` timeout, `0.75/0.65` thresholds, `lint` + `audit` to `stderr`.
