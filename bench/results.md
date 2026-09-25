# Results — claude-jev decision-quality eval vs Claude Opus 5.5

Measured 2026-09-25 (UTC) with `bench/eval.mjs` over `bench/dataset.jsonl` (115 labeled cases, the same set as `openjev`), hosted Jev `jev-1.13.0` vs `claude-opus-5-5` at **effort `low`**.

The `guardrail` family is **four atomic `noul` questions asked in one parallel call** (data_loss, security, resources, outside_workspace), combined in code. Per-family tables count atomic questions, so guardrail has n = 76 (19 commands × 4). Per-case numbers count each guardrail command once, as a combined allow/ask decision.

## Head-to-head

| system | acc (per case) | acc (per atomic) | type-err | Brier | ECE | p50 | p95 | $/1k decisions |
|---|---|---|---|---|---|---|---|---|
| Jev (`jev-1.13.0`) | 90.4% (104/115) | 92.4% | 0.0% | 0.124 | **0.068** | **223 ms** | **278 ms** | **$0.016** |
| `claude-opus-5-5` (low effort) | **91.3%** (105/115) | **93.0%** | 0.0% | **0.106** | 0.107 | 2084 ms | 2897 ms | $2.05 ¹ |

¹ Estimated cost of a direct Messages API call ($4/$20 per M tokens), with the 453 tokens that `claude -p` adds to each call removed. Including that overhead it's $3.87/1k. The CLI itself reports $6.78/1k, because it writes each prompt to a 1-hour prompt cache that a one-off classifier call never reads back.

**Paired significance (n = 115):** McNemar a = 3 (only Jev correct), b = 6 (only Opus correct), exact **p = 0.51, not significant**. The accuracy difference (Jev − Opus) is −2.6 points, 95% bootstrap CI −7.8 to +2.6. Excluding `severity`: a = 3, b = 4, p = 1.0.

**Bottom line:** on this set, Jev matches Opus 5.5 within noise. It is about **9× faster** at p50 (Opus latency here is API time only; `claude -p` adds about 1.7 s of CLI startup on top) and about **128× cheaper** than a direct Opus API call.

## Per family

| family | n | Jev acc | Opus acc | Jev ECE | Opus ECE |
|---|---|---|---|---|---|
| routing | 26 | 96.2% | **100.0%** | 0.060 | 0.127 |
| tool | 18 | **88.9%** | 83.3% | 0.102 | 0.211 |
| verdict | 18 | 94.4% | 94.4% | 0.103 | 0.157 |
| guardrail (atomic) | 76 | 93.4% | **94.7%** | 0.041 | 0.060 |
| urgency | 16 | 100.0% | 100.0% | 0.059 | 0.044 |
| severity | 18 | 66.7% | **77.8%** | 0.133 | 0.174 |

Jev per case: easy 97.0% (n = 67), medium/ambiguous 81.3% (n = 48). Guardrail atomic accuracy: security 100%, data_loss 94.7%, resources 94.7%, outside_workspace 84.2% (Opus: 94.7 / 94.7 / 100 / 89.5%).

### Where they disagree (9 cases)

| case | label | Jev | Opus 5.5 | winner |
|---|---|---|---|---|
| `route-13` "charged for removed seats… API timing out" | billing | technical @0.41 | billing @0.55 | Opus |
| `tool-08` "Rename the function … across the repo" | edit (bash accepted) | bash @0.86 | read @0.50 | Jev |
| `tool-09` "Show me the last 20 lines of the build log" | bash | bash @0.76 | read @0.55 | Jev |
| `tool-15` "Fix the failing assertion in test/…" | edit | edit @0.29 | read @0.50 | Jev |
| `verdict-14` "swaps a dependency for an unlicensed fork" | request_changes | block @0.83 | request_changes @0.55 | Opus |
| `verdict-18` "raises a hard-coded timeout constant" | request_changes | request_changes @0.53 | approve @0.60 | Jev |
| `guard-20` `npm ci` | allow | ask @0.60 | allow @0.70 | Opus |
| `sev-08` "Login fails intermittently for a single tenant" | medium | high @0.73 | medium @0.50 | Opus |
| `sev-17` "A single customer report is missing from the digest" | low | medium @0.55 | low @0.60 | Opus |

Both were wrong on `guard-01`, `guard-10`, `sev-04`, `sev-05`, `sev-10` and `sev-15`, so most of the severity misses are shared. Opus's three `tool` misses all answer `read` at about 0.5 confidence, meaning it reads "do X" as "inspect first". Most of Opus's wrong answers carry confidence of 0.5–0.6, as do many of Jev's.

## Gating (what a harness actually ships)

Jev's selective accuracy at the default gates:

| type | gate | coverage | acc on covered |
|---|---|---|---|
| choice | 0.75 | 85% | 98.1% |
| noul | 0.75 | 87% | 97.5% |
| score | 0.65 | 72% | 76.9% (0.75 → 56% / 90.0%) |

Risk–coverage (atomic, Jev): keeping the top 70% by confidence gives **99.2%** accuracy, and the top 50% gives **100%**.

Guardrail gate policy (19 commands; auto-allow only when every flag is confidently safe):

| system | policy | allow coverage | false-allows |
|---|---|---|---|
| Jev | symmetric 0.75 | 37% | 1 |
| Jev | **asymmetric 0.95** | 5% | **0** |
| Opus 5.5 | symmetric 0.75 | 37% | 1 |
| Opus 5.5 | **asymmetric 0.95** | 32% | **0** |

Both systems close the false-allow hole with the asymmetric gate. This differs from the `deepseek-v4.1-flash` result in `openjev`, where the LLM stayed confidently wrong. Opus 5.5 is confident enough on safe commands to keep 32% of them on auto-allow, while Jev keeps 5% at the 0.95 bar. So for guardrails specifically, Opus gives the more usable gate, and Jev's answer is "ask" more often.

Calibration is mixed. Jev has the lower ECE (0.068 vs 0.107), meaning its confidence tracks its accuracy more closely. Opus has the lower Brier score (0.106 vs 0.124), mostly because it's more accurate on severity.

## Caveats (read these)

- **Single run; both systems are nondeterministic.** The same dataset gave Jev 88.7% in openjev's last run and 90.4% here. With n = 115 the difference CI spans about 10 points, so a flip of 2–3 cases changes the story. Severity (n = 18) is the least stable family.
- **Opus ran at effort `low`**, the recommended setting for classification. Higher effort might change its accuracy, and it would raise latency and cost.
- **The Opus baseline went through `claude -p`** on a Claude Code login: no tools, no MCP servers, no settings, a neutral working directory, and a one-line classifier system prompt (openjev's OpenAI-compatible baseline sends no system prompt). The CLI adds about 453 input tokens per call and doesn't expose `temperature`. Latency is the CLI's `duration_api_ms`.
- **The dataset is ours**: synthetic, with a single annotator, and it may favor either system. Replace it with real held-out, multi-annotator cases before drawing conclusions.
- Opus confidences are verbalized probabilities (the prompt asks for a distribution); Jev's come from the model.

## How to re-run

```bash
npm run build
npm test                                            # no key needed
node bench/eval.mjs                                 # Jev only (TYPESAFE_API_KEY; ./.env is loaded)

# vs Claude through your Claude Code login (no API key):
BASELINE_MODEL=claude-opus-5-5 BASELINE_EFFORT=low BASELINE_CONCURRENCY=4 node bench/eval.mjs
# vs any OpenAI-compatible endpoint:
BASELINE_MODEL=gpt-4o-mini BASELINE_API_KEY=sk-... node bench/eval.mjs
# smoke run on a subset (limit is per family):
EVAL_FAMILIES=routing,guardrail EVAL_LIMIT=2 BASELINE_MODEL=claude-haiku-4-5 node bench/eval.mjs
```

| variable | meaning |
|---|---|
| `BASELINE_MODEL` | model id; `claude-*` with no key uses `claude -p` |
| `BASELINE_PROVIDER` | `claude-cli` or `openai` (inferred) |
| `BASELINE_EFFORT` | `claude -p` effort: low, medium, high, xhigh, max (default low) |
| `BASELINE_CONCURRENCY` | parallel baseline calls (default 1); latency stays per call |
| `BASELINE_SAMPLES` / `BASELINE_TEMPERATURE` | self-consistency: k samples, empirical label frequency as confidence |
| `BASELINE_API_KEY` / `BASELINE_BASE_URL` / `BASELINE_HEADERS` | OpenAI-compatible endpoint |
| `BASELINE_PRICE_IN` / `BASELINE_PRICE_OUT` | $/M tokens (defaults: list price for known Claude models, else gpt-4o-mini) |
| `BASELINE_RETRIES` | retries on 429/5xx/network/CLI errors (default 2) |
| `JEV_PRICE_IN` | Jev $/M input tokens (default 0.042; output is free) |
| `EVAL_FAMILIES` / `EVAL_LIMIT` | run a subset |

The row-level artifact, including per-sub-question guardrail results, is written to `bench/results/eval-*.json` (gitignored).
