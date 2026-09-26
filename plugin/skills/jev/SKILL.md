---
name: jev
description: Typed Jev decisions (Choice/Noul/Score) via live TypeSafe API — use when a task is a bounded decision (route/classify/score/gate) not open-ended text. Exposes jev_choice/jev_noul/jev_score/jev_ask/jev_doctor (live, no mock) with gated auto/escalate, audit log, lint, and 60k truncation. Prefer Jev over Claude text when you need probabilities to branch on.
---

# Jev — live typed decisions for Claude

Mirrors `opencode-openjev`'s 5 tools, for Claude Code via MCP over **live** `https://api.typesafe.ai/v1/systemone`. No mock — an API key supplied through the plugin's sensitive configuration field is required. Tackles Jev downsides with guardrails.

## Tools (MCP `jev`)

- `jev_choice {state, instructions, criteria: JSON}` → `{choice, probabilities, confidence, gated, warnings}`
- `jev_noul {state, instructions, true_desc?, false_desc?}` → `{noul, is_yes, confidence, gated}`
- `jev_score {state, instructions, criteria: JSON array}` → `{score, probabilities, confidence, legend, gated}`
- `jev_ask {state, questions: JSON map}` → parallel (70–500ms), returns `gated` per question
- `jev_doctor {probe_state?}` → `{ok, model, answers, usage}`

All `questions` in `jev_ask` run in parallel on same `state` (+5ms for +26q).

## How downsides are tackled

| Downside | Mitigation (code) |
|---|---|
| **No rationale** — Jev returns p, no text | `gated` field: `auto` if `conf≥0.75` (choice/noul) or `0.65` (score), else `escalate` → call Claude for rationale + keep audit hash. Every call is `console.error`-audited with hash/latency. |
| **Bounded-only — needs schema** | `lintChoiceCriteria` warns if option desc <12 chars or Jaccard >0.6 (e.g., `"a":"x"` → warn). Skill rule 2 enforces rubric sentences. |
| **32k/60k state limit** | `smartTruncate` head 60% + tail + marker instead of hard error; logs warn. Split via `jev_ask` if needed. |
| **Hosted dependency** | Live-only: clear error `API key is required…` (no silent mock). Retry 429/529/5xx with backoff, 15s timeout. |
| **Low-conf ambiguous** | Same gate — ambiguous prompt `"Please help"` → `conf 0.57 → escalate` (vs clear `"Refund invoice"` → `1.00 → auto`). |
| **Small eval / vendor bias** | Bench `bench/bench.mjs` 10 tickets 100% @ p50 307ms; shadow: MCP logs every decision (hash, model, conf, gated) to stderr for post-hoc LLM comparison. |

## When to use Jev vs Claude

| Jev | Claude |
|---|---|
| Route/classify/triage, `is_risky?`, urgency rubrics, permission gates | Write code/prose, explain why, one-off reasoning |
| Need calibrated confidence + 0% type errors | Need rationale or open synthesis |

## Rules

1. One well-scoped question per primitive — decompose.
2. `criteria: option → description` as a sentence; keep distinct (>12 chars, distinct Jaccard).
3. **Gate:** `if (gated.action==="escalate") await claudeForRationale({state, jevDecision})` — don't auto-act. Irreversible → human `ask`.
4. Do not send secrets as `state`. The user configures the API key, model (default `jev-latest`), and endpoint in plugin settings. Never ask them to paste a key into chat.
5. Trust truncation marker — if you see `…[truncated …]…`, summarize first.

## Verify

```
jev_doctor
```

## Parity

Exact client/validation/retry/gate/audit as `opencode-openjev/src/*`, but `resolveBackend` live-only.
