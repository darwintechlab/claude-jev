# claude-jev — Jev for Claude Code (live MCP mirror of opencode-openjev)

Typed `Choice`/`Noul`/`Score` decisions via **live** `https://api.typesafe.ai/v1/systemone` — same 5 tools, same `gated`/`audit`/`smartTruncate` as `opencode-openjev`, no mock fallback.

* **Status:** ready — `claude plugin validate ✔`, `5 tools` via MCP `jev`
* **License:** MIT
* **Node:** `>=20`
* **Claude Code:** `>=2.0`
* **Setup:** **[SETUP.md](./SETUP.md)** — 3-minute install (plugin-dir or marketplace, env, verify)

> Jev = generic classifier you never have to train. 70–500ms, `$0.042/M` in, output free, 0% type errors. Use it where Claude would otherwise write prose and parse JSON for a bounded decision.

* **Live bench:** `1q p50 307ms`, `27q p50 287ms (+5ms)`, `10/10 100% @ conf 0.96`, `par 8×` vs sequential — see `bench/bench.mjs`.

## Tools (MCP `jev`)

| Tool | Returns |
|---|---|
| `jev_choice` | `{choice, probabilities, confidence, gated, warnings, usage}` |
| `jev_noul` | `{noul, is_yes, confidence, gated, usage}` |
| `jev_score` | `{score, probabilities, confidence, legend, gated, warnings, usage}` |
| `jev_ask` | parallel `{answers, gated}` in one call |
| `jev_doctor` | `{ok, model, answers, usage}` |

`gated: {action:"auto" (conf≥0.75/0.65) | "escalate"}` + `warnings` (lint) + `audit` to `stderr`.

See **SETUP.md** for install (plugin-dir, env `TYPESAFE_API_KEY`, `jev_doctor`), first decisions, and troubleshooting. Skills: `skills/jev/SKILL.md`.

Parity: mirrors `opencode-openjev/src/*` (`client`/`gate`/`audit`/`state`) exactly — 60k cap, 32 questions, retries on `429/529/5xx`.
