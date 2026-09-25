# OpenJev for Claude Code

**Your Claude Code agent makes a lot of small decisions. OpenJev makes them faster and cheaper, and it tells you when it isn't sure.**

A coding agent spends much of its time on questions with only a few possible answers. *Is this command safe to run? Which tool fits this task? Is this PR ready to merge? How serious is this bug?* Today the agent handles these the way it writes code: a large language model writes out an answer in text, and something then has to parse that text.

OpenJev gives Claude Code a model built for these questions. You pass it the text and the possible answers. It tells you which answer fits and how confident it is. It doesn't write text, so it can only answer with one of the options you gave it.

`claude-jev` · MIT · Node ≥ 20 · Claude Code ≥ 2.0 · **[3-minute setup](./SETUP.md)**

**Maintained by:** https://darwintechlab.com, https://darwinevo.com & the community.

---

## Why use it

| | Asking the LLM | With OpenJev |
|---|---|---|
| **Speed** | Usually seconds, because the model writes its answer word by word | About 0.3 s per decision (live bench: p50 307 ms) |
| **Cost** | You pay for every word it writes | About $0.017 per 1,000 decisions, and you don't pay for output |
| **Answer format** | Free text that has to be parsed, and sometimes the parsing fails | Always one of the options you defined |
| **When it's unsure** | Sounds equally confident whether it's right or guessing | Gives a confidence score and flags uncertain answers |
| **Several questions at once** | A longer prompt and a longer answer to parse | Up to 32 questions in one call; 27 questions took about 5 ms longer than 1 in our tests |

**The confidence score is the main reason to use it.** The scores are calibrated, which means higher confidence really does mean the answer is more likely to be right. The agent can act on its own when OpenJev is confident and bring in you (or the bigger model) when it isn't. The plugin labels every answer for you as `auto` (confident enough to act on) or `escalate` (should go to the LLM or a person).

### What that looks like

Here are two support tickets, each routed to one of four teams (billing, technical, sales, spam):

| Ticket | OpenJev's answer | Confidence | What happens |
|---|---|---|---|
| "Help! payouts failing 3 days — order #48281" | billing | 0.99 | Routed automatically |
| "Please help" | technical | 0.38 | Too vague to route, so it's flagged for a person |

The second ticket doesn't say enough to choose a team. OpenJev reports that with a low score instead of confidently giving an answer.

### What you can use it for

* **Safety checks.** Before the agent runs `rm -rf` or reads `.env`, ask whether the action is destructive or irreversible. If the answer is a confident yes, the agent stops and asks you.
* **Choosing a tool or model.** Decide which tool fits a request, or whether a task needs the large, expensive model or a small, fast one.
* **Review verdicts.** Approve, request changes, or block a PR, with a confidence bar that you set.
* **Triage.** Get the team, urgency, and severity for an issue in one call.
* **Scoring.** Rate risk, quality, or severity on a scale you define.

### What it's not for

It doesn't write code, summaries, or explanations, and it can't answer questions that don't have a fixed set of answers. Keep using your LLM for those. OpenJev works alongside the LLM and handles the small decisions so the LLM doesn't have to.

---

## How it works in Claude Code

Installing the plugin gives Claude five new tools through the bundled MCP server `jev`: `jev_choice`, `jev_noul`, `jev_score`, `jev_ask`, and `jev_doctor`. Claude can call them whenever it reaches a decision like the ones above. The bundled skill makes Claude use the tools by default without being asked.

**Jev** (System One) answers the questions. It's a hosted decision model reached through TypeSafe. You can also point the plugin at an OpenJev-compatible endpoint that you host yourself.

## Get started

You need Claude Code 2.0+, Node 20+, and a free API key from **https://console.typesafe.ai**.

1. **Add the plugin.** Install it from the bundled marketplace, or run straight from a clone.

   ```bash
   claude plugin marketplace add darwintechlab/claude-openjev
   claude plugin install claude-jev@openjev
   # or, from a clone:
   claude --plugin-dir .
   ```

2. **Set your key** in your shell (keep it out of the repo).

   ```bash
   export TYPESAFE_API_KEY=ts_...
   ```

3. **Restart Claude Code and run `jev_doctor`** to confirm the plugin is connected.

> **No key yet?** Unlike the opencode version, `claude-jev` has no mock fallback — it's live-only. Without a key every call returns `{ok:false, error:"TYPESAFE_API_KEY is required…"}`.

For the full walkthrough and troubleshooting, see **[SETUP.md](./SETUP.md)**.

## How accurate is it?

We tested it on 115 labeled decisions covering routing, tool choice, review verdicts, command guardrails, urgency and severity ([full results](./bench/results.md)):

* **90% correct overall** (104/115). That's 97% on clear cases and 81% on ambiguous ones.
* **Confident answers are more reliable.** At the default 0.75 gate, 85% of the pick-one decisions were accepted and 98% of those were correct. The top 50% by confidence were 100% correct.
* **Severity scoring is the weakest area:** 67% correct.
* **Against Claude Opus 5.5** (low effort) on the same cases, Opus got 91.3% and Jev 90.4%, which isn't a significant difference (McNemar p = 0.51). Jev answered about 9× faster (p50 223 ms vs 2.1 s) at roughly 1/128 of the cost.

The test set is small and we wrote it ourselves, so treat these numbers as a starting point. To measure accuracy on your own workload, replace `bench/dataset.jsonl` with your own cases and run `npm run bench:eval`.

## Your data

* The text you ask about (`state`) is sent to the Jev endpoint you configure. Don't include passwords, API keys, or private data that has nothing to do with the decision.
* Every decision is recorded in the MCP server's stderr audit log with its answer, confidence, and whether it was `auto` or `escalate`. The log stores a hash of the text, not the text itself.
* To keep everything in-house, point the plugin at a self-hosted OpenJev endpoint (see [Configuration](#configuration)).

---

# Reference

The rest of this page is for developers who are integrating the plugin or contributing to it.

## Tools

| Tool | Answers questions like | Returns (JSON string) |
|---|---|---|
| `jev_choice` | "Which team should get this?" (one of 2–32 options) | `{model, choice, probabilities, confidence, gated, warnings, usage}` |
| `jev_noul` | "Is this destructive?" (yes/no, as a probability 0..1) | `{model, noul, is_yes, confidence, gated, usage}` |
| `jev_score` | "How severe is this?" (an ordered scale) | `{model, score, probabilities, confidence, legend, gated, warnings, usage}` |
| `jev_ask` | Any mix of the above, in one call | `{model, answers:{id->Answer}, gated, usage}` |
| `jev_doctor` | "Is my setup working?" | `{ok, model, answers, usage}` or `{ok:false, error}` |

All questions in a single `jev_ask` are evaluated **in parallel** on the same `state`. Adding questions barely changes latency and doesn't cause context rot.

Default confidence gates: `choice` and `noul` 0.75, `score` 0.65 (`mcp-server/src/gate.ts`).

### Plugin vs skill

* **Plugin** (`claude-jev`): the Claude Code plugin that bundles the MCP server `jev` and handles auth, retries, validation, gating, and audit logging. It works on its own.
* **Skill** (`skills/jev/SKILL.md`): optional prompt guidance that makes Claude reach for `jev_*` by default for bounded decisions (routing, guardrails, approvals, scoring) instead of generating text.

---

## Install

### As a Claude Code plugin (recommended)

```bash
claude plugin marketplace add darwintechlab/claude-openjev   # or a local clone path
claude plugin install claude-jev@openjev
# then in any project: claude (plugin auto-loads)
```

Dev, straight from a clone (no install):

```bash
claude --plugin-dir .
```

### Local development

```bash
git clone https://github.com/darwintechlab/claude-openjev.git
cd claude-openjev
npm install
npm run build          # typecheck + esbuild → mcp-server/dist/index.js
claude plugin validate ./
```

### Bundled skill (included)

`skills/jev/SKILL.md` ships with the plugin and makes Claude default to
`jev_*` for bounded decisions — there is nothing extra to register. Invoke it
with `/jev`, or let it trigger automatically.

---

## Configuration

`claude-jev` is live-only: it talks to the hosted Jev endpoint, or to a
self-hosted OpenJev-compatible one.

| Backend | Env | Endpoint |
|---|---|---|
| `typesafe` (live, required) | `TYPESAFE_API_KEY=ts_...` | `https://api.typesafe.ai/v1/systemone` |
| `custom` (self-hosted OpenJev) | `JEV_BASE_URL=…` (+ `JEV_API_KEY=…`) | your URL |

Optional overrides: `JEV_MODEL` (default `jev-latest`), `JEV_BASE_URL`.

> **No `.env` auto-load.** The MCP server inherits Claude Code's environment, so set `TYPESAFE_API_KEY` with a shell export or in `mcpServers.jev.env` inside `.claude-plugin/plugin.json`. Restart Claude Code after changing it.

**Verify wiring in Claude Code:**

```
jev_doctor
jev_doctor { "probe_state": "my ticket text" }
```

---

## Usage

### Single decision

```json
// tool: jev_choice
{
  "state": "Help! payouts failing 3 days — order #48281",
  "instructions": "Route to team",
  "criteria": "{\"billing\":\"payments/invoices\",\"technical\":\"bugs/outages\",\"sales\":\"buying\",\"spam\":\"irrelevant\"}"
}
// → {"choice":"billing","probabilities":{"billing":0.99,…},"confidence":0.99,"gated":{"action":"auto",…},"model":"jev-latest"}
```

### Confidence gating (recommended)

Every result already includes `gated.action` (`auto` / `escalate`). If you want your own threshold:

```ts
const { choice, confidence } = JSON.parse(await jev_choice({ ... }));
if (confidence < 0.75) {
  // escalate to a slower LLM for rationale, or to a human `ask`
} else {
  route(choice);
}
```

Jev's numbers are **calibrated** (RLCD training), so higher confidence actually means higher accuracy. Standard LLMs are not calibrated this way.

### Parallel decisions (one round-trip)

```json
// tool: jev_ask
{
  "state": "{\"ticket\":\"payouts failing\",\"diff\":\"...\"}",
  "questions": "{\"team\":{\"type\":\"choice\",\"instructions\":\"Pick team\",\"criteria\":{\"billing\":\"...\",\"tech\":\"...\"}},\"is_urgent\":{\"type\":\"noul\",\"instructions\":\"Is urgent?\"},\"severity\":{\"type\":\"score\",\"instructions\":\"Score severity\",\"criteria\":[\"low\",\"medium\",\"high\",\"critical\"]}}"
}
```

### Direct Node.js (without Claude Code)

```ts
import { decide } from "./mcp-server/dist/client.js";
const res = await decide("Help! payouts failing", {
  team: { type: "choice", instructions: "Route", criteria: { billing: "pay", technical: "bug" } },
  is_urgent: { type: "noul", instructions: "Is urgent?" },
});
```

See `bench/bench.mjs`.

### Integration ideas for Claude Code

The MCP tools can be called from skills, subagents, and hooks wherever you'd otherwise do `prompt → text → parse JSON`:

* **`PreToolUse` hook gating** (`bash: rm *`, `.env` read → `jev_noul` “is destructive?”)
* **Skill / subagent routing** → `jev_choice`
* **Triage / QA verdicts** → `jev_choice` {approve, request_changes, block} + confidence
* **Severity scoring in review/CI** → `jev_score`

---

## Development

```bash
npm install
npm run build      # typecheck + esbuild → mcp-server/dist/index.js
npm run typecheck  # tsc --noEmit
npm test           # node --test: metrics, baseline parsing, gates, client (no key needed)
npm run bench      # live latency/parallelism bench (needs TYPESAFE_API_KEY)
npm run bench:eval # decision-quality eval: accuracy/Brier/ECE/risk-coverage on 115 labeled cases
# head-to-head vs Claude through your Claude Code login (no API key):
#   BASELINE_MODEL=claude-opus-5-5 BASELINE_CONCURRENCY=4 npm run bench:eval
# or any OpenAI-compatible endpoint:
#   BASELINE_MODEL=gpt-4o-mini BASELINE_API_KEY=sk-... npm run bench:eval
claude plugin validate ./   # should pass
```

`bench/eval.mjs` loads `./.env` if present. See [bench/results.md](./bench/results.md) for measured results and every knob.

### Project layout

```
.claude-plugin/
  plugin.json      # declares MCP server jev -> node ${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.js
  marketplace.json # repo is its own marketplace "openjev"
mcp-server/
  src/
    client.ts   # live-only backend resolution, validation, retries, decide()
    index.ts    # MCP server (5 tools, input parsing, audit logging)
    gate.ts     # confidence gating (auto / escalate thresholds)
    audit.ts    # privacy-safe audit log entries (state hash, not raw state)
    state.ts    # smartTruncate + criteria lint
  dist/         # esbuild bundles: index.js (server), client.js + gate.js (for bench/tests)
skills/
  jev/SKILL.md  # optional: makes Claude default to jev_* tools
bench/
  bench.mjs     # live latency/parallelism bench
  eval.mjs      # decision-quality eval + LLM head-to-head (claude -p or OpenAI-compatible)
  metrics.mjs   # pure metric functions (Brier, ECE, risk-coverage, Wilson, McNemar, bootstrap)
  baseline.mjs  # LLM prompt + answer normalization + self-consistency (pure)
  families.mjs  # decision family definitions
  dataset.jsonl # 115 labeled seed cases (shared with openjev; replace with real held-out data)
  results.md    # measured results
test/           # node --test suites (no key needed)
```

### Error handling

* Input validation before network (`state` 0–60k chars, 1–32 questions, per-type criteria limits). Longer `state` is head+tail truncated with a marker.
* Retries with exponential backoff + jitter for `429` / `529` / `5xx` and timeouts (per `docs.typesafe.ai/api`).
* Auth via `Authorization: Bearer …`; errors do not log the URL or key, only `backend`.
* Live-only: there is no mock fallback, so a missing `TYPESAFE_API_KEY` fails loudly instead of returning placeholder answers.

---

## Security

* Never send passwords, API keys, or unrelated private data as `state` (`docs.typesafe.ai` guidance — keep irreversible actions behind your own human approval).
* `state` is the content to decide on; `questions` are the typed schema you define upfront — there is no free-form generation to leak data.

---

## Contributing

PRs welcome — please add a test for new question types or backends. Run `npm run typecheck && npm run build` before pushing.

## License

MIT — see `LICENSE`.

## Ecosystem

To propose this for the Claude Code plugin marketplace, ensure `claude plugin validate ./` passes and the marketplace entry installs cleanly:

```bash
claude plugin validate ./
claude plugin marketplace add darwintechlab/claude-openjev
claude plugin install claude-jev@openjev
```
