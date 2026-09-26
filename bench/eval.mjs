#!/usr/bin/env node
/**
 * Decision-quality eval for claude-jev typed decisions (port of openjev/bench/eval.mjs).
 *
 * Runs the labeled dataset through `decide()` (Choice/Noul/Score) against live Jev
 * and reports accuracy, macro-F1, calibration (Brier/ECE), risk-coverage, and
 * threshold sweeps. Optionally runs a measured LLM `prompt -> JSON` baseline on the
 * same cases for a head-to-head (accuracy + significance + calibration + cost).
 *
 * Multi-question families (guardrail) are asked as ONE parallel call; they are
 * scored per atomic sub-question ("did the model answer the question?") and, for
 * guardrail, additionally as a combined allow/ask decision under a gate policy
 * that is deliberately asymmetric.
 *
 * Baseline providers (BASELINE_PROVIDER):
 *   claude-cli  Claude through headless `claude -p` on your Claude Code login (no API key).
 *               Tools, MCP, settings and CLAUDE.md are disabled so it acts as a plain
 *               classifier. Default when BASELINE_MODEL is a claude-* model and no key is set.
 *   openai      Any OpenAI-compatible /chat/completions endpoint (BASELINE_API_KEY).
 *
 * Usage:
 *   node bench/eval.mjs                                   # Jev only (TYPESAFE_API_KEY; ./.env is loaded)
 *   BASELINE_MODEL=claude-opus-5-5 node bench/eval.mjs    # + Claude via claude -p
 *   BASELINE_MODEL=gpt-4o-mini BASELINE_API_KEY=... node bench/eval.mjs   # + OpenAI-compatible
 *   BASELINE_HEADERS='{"x-opencode-session":"ses_..."}' for endpoints needing a header
 *   BASELINE_CONCURRENCY=4   run baseline cases in parallel (latency is still per call)
 *   BASELINE_EFFORT=low      claude-cli effort (low|medium|high|xhigh|max)
 *   EVAL_FAMILIES=routing,guardrail EVAL_LIMIT=2   smoke-run a subset (limit is per family)
 */

import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decide, resolveBackend } from "./client.mjs";
import { gateGuardrailFlags } from "../plugin/runtime/gate.mjs";
import { FAMILIES } from "./families.mjs";
import { buildPrompt, buildPromptMulti, parseJson, normalizeResponse, normalizeResponseMulti, aggregateSamples } from "./baseline.mjs";
import * as M from "./metrics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATASET = join(HERE, "dataset.jsonl");
const RESULTS = join(HERE, "results");

try {
  process.loadEnvFile(join(HERE, "..", ".env"));
} catch {
  // no .env — use the environment as-is
}

const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));

function jsonEnv(name) {
  if (!process.env[name]) return {};
  try {
    const v = JSON.parse(process.env[name]);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// $/M tokens [input, output] for Claude models, used when BASELINE_PRICE_IN/OUT are unset.
const CLAUDE_PRICES = {
  "claude-fable-5-1": [10, 50],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-sonnet-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
};

const baselineModel = process.env.BASELINE_MODEL;
const baselineKey = process.env.BASELINE_API_KEY || process.env.OPENAI_API_KEY;
const [defaultPriceIn, defaultPriceOut] = CLAUDE_PRICES[baselineModel] ?? [0.15, 0.6];
const BASELINE = {
  provider: process.env.BASELINE_PROVIDER || (baselineModel?.startsWith("claude-") && !baselineKey ? "claude-cli" : "openai"),
  key: baselineKey,
  base: (process.env.BASELINE_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
  model: baselineModel,
  samples: Math.max(1, Math.floor(num(process.env.BASELINE_SAMPLES, 1))),
  temperature: num(process.env.BASELINE_TEMPERATURE, num(process.env.BASELINE_SAMPLES, 1) > 1 ? 0.7 : 0),
  effort: process.env.BASELINE_EFFORT || "low",
  concurrency: Math.max(1, Math.floor(num(process.env.BASELINE_CONCURRENCY, 1))),
  retries: Math.max(0, Math.floor(num(process.env.BASELINE_RETRIES, 2))),
  priceIn: num(process.env.BASELINE_PRICE_IN, defaultPriceIn),
  priceOut: num(process.env.BASELINE_PRICE_OUT, defaultPriceOut),
  headers: jsonEnv("BASELINE_HEADERS"),
};
const baselineEnabled = () => Boolean(BASELINE.model && (BASELINE.provider === "claude-cli" || BASELINE.key));

const JEV_PRICE_IN = num(process.env.JEV_PRICE_IN, 0.042);
const JEV_PRICE_OUT = num(process.env.JEV_PRICE_OUT, 0);

const isMulti = (f) => Boolean(f.questions);
const subKeys = (f) => Object.keys(f.questions);
const combinedLabel = (label) => (label && typeof label === "object" ? Object.values(label).some(Boolean) : label);
const isCorrect = (pred, label, accept) => pred === label || (Array.isArray(accept) && accept.includes(pred));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Loads the dataset, optionally narrowed by EVAL_FAMILIES=a,b and EVAL_LIMIT=N (per family) for smoke runs. */
function loadDataset() {
  const all = readFileSync(DATASET, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => ({ ...JSON.parse(l), _line: i + 1 }));
  const only = process.env.EVAL_FAMILIES ? new Set(process.env.EVAL_FAMILIES.split(",").map((s) => s.trim())) : null;
  const limit = num(process.env.EVAL_LIMIT, Infinity);
  const seen = {};
  return all.filter((c) => (!only || only.has(c.family)) && (seen[c.family] = (seen[c.family] ?? 0) + 1) <= limit);
}

// ---- Jev ----
function normalizeJev(family, ans) {
  const f = FAMILIES[family];
  if (f.type === "choice") return { pred: ans.choice, conf: ans.confidence, probs: ans.probabilities };
  if (f.type === "noul") return normalizeNoul(ans);
  const keys = Object.keys(ans.probabilities);
  let best = keys[0];
  for (const k of keys) if (ans.probabilities[k] > ans.probabilities[best]) best = k;
  const probs = {};
  for (const k of keys) probs[f.criteria[Number(k)] ?? k] = ans.probabilities[k];
  return { pred: f.criteria[Number(best)] ?? best, conf: ans.confidence, probs };
}

function normalizeNoul(ans) {
  const p = ans.noul;
  return { pred: p > 0.5, conf: Math.max(p, 1 - p), probs: { true: p, false: 1 - p } };
}

async function runJev(cases) {
  const rows = [];
  for (const c of cases) {
    const f = FAMILIES[c.family];
    const t0 = performance.now();
    try {
      if (isMulti(f)) {
        const qs = {};
        for (const [k, q] of Object.entries(f.questions)) qs[k] = { type: "noul", instructions: q.instructions, criteria: q.criteria };
        const res = await decide(c.state, qs);
        const subs = subKeys(f).map((k) => ({ key: k, ...normalizeNoul(res.answers[k]), label: c.label[k] }));
        const askPred = subs.some((s) => s.pred === true);
        const askLabel = combinedLabel(c.label);
        rows.push({ ...c, multi: true, subs, pred: askPred, askLabel, conf: Math.min(...subs.map((s) => s.conf)), probs: null, correct: askPred === askLabel, ms: performance.now() - t0, usage: res.usage, model: res.model, error: null });
      } else {
        const res = await decide(c.state, { q: { type: f.type, instructions: f.instructions, criteria: f.criteria } });
        const n = normalizeJev(c.family, res.answers.q);
        rows.push({ ...c, multi: false, pred: n.pred, conf: n.conf, probs: n.probs, correct: isCorrect(n.pred, c.label, c.accept), ms: performance.now() - t0, usage: res.usage, model: res.model, error: null });
      }
    } catch (e) {
      rows.push({ ...c, multi: isMulti(f), subs: null, pred: null, conf: 0, probs: null, correct: false, ms: performance.now() - t0, error: e.message });
    }
  }
  return rows;
}

// ---- optional LLM baseline ----

/** Retry transient baseline failures (rate limits, 5xx, network, CLI hiccups) with backoff. */
async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e.retryable === false || attempt >= BASELINE.retries) throw e;
      await sleep(1000 * 2 ** attempt + Math.random() * 250);
    }
  }
}

async function callOpenAI(content) {
  const t0 = performance.now();
  const res = await fetch(`${BASELINE.base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${BASELINE.key}`, ...BASELINE.headers },
    body: JSON.stringify({ model: BASELINE.model, temperature: BASELINE.temperature, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) {
    const err = new Error(`baseline ${res.status}: ${(await res.text()).slice(0, 200)}`);
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }
  const json = await res.json();
  const usage = json.usage ? { input_tokens: json.usage.prompt_tokens, output_tokens: json.usage.completion_tokens } : undefined;
  return { text: json.choices?.[0]?.message?.content ?? "", usage, ms: performance.now() - t0, costUsd: null };
}

let neutralDir;

/**
 * Claude via headless `claude -p`, stripped down to a plain classifier: no tools,
 * no MCP servers, no settings/plugins/hooks, and a neutral cwd so no CLAUDE.md is
 * picked up. Latency is the CLI's `duration_api_ms` (excludes CLI startup).
 *
 * Cost is priced from token usage, not the CLI's `total_cost_usd`: the CLI writes
 * every prompt to a 1h prompt cache (billed at 2x input) that a one-off classifier
 * call never reads, so its reported cost overstates a plain Messages API call.
 * Cache writes/reads are therefore counted as ordinary input tokens.
 */
function callClaudeCli(content) {
  neutralDir ??= mkdtempSync(join(tmpdir(), "jev-eval-"));
  const args = [
    "-p", "--model", BASELINE.model, "--effort", BASELINE.effort, "--output-format", "json",
    "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--disable-slash-commands",
    "--system-prompt", "You are a strict classifier. Reply with only the JSON the user asks for.",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: neutralDir, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let errOut = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errOut += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      e.retryable = false; // e.g. `claude` is not on PATH
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let json;
      try {
        json = JSON.parse(out);
      } catch {
        return reject(new Error(`claude -p exited ${code}: ${(errOut || out).trim().slice(0, 200)}`));
      }
      if (json.is_error || code !== 0) return reject(new Error(`claude -p error: ${String(json.result ?? json.subtype).slice(0, 200)}`));
      const u = json.usage ?? {};
      resolve({
        text: json.result ?? "",
        usage: { input_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output_tokens: u.output_tokens ?? 0 },
        ms: json.duration_api_ms ?? json.duration_ms,
        costUsd: json.total_cost_usd ?? null,
      });
    });
    child.stdin.end(content);
  });
}

/** Input tokens `claude -p` adds on its own (context beyond our prompt), measured with a near-empty prompt. */
async function measureCliOverhead() {
  const r = await withRetry(() => callClaudeCli("Reply with 0"));
  return r.usage.input_tokens;
}

async function callLLM(family, state) {
  const multi = isMulti(FAMILIES[family]);
  const content = multi ? buildPromptMulti(family, state) : buildPrompt(family, state);
  const r = await withRetry(() => (BASELINE.provider === "claude-cli" ? callClaudeCli(content) : callOpenAI(content)));
  const parsed = parseJson(r.text);
  return { parsed, raw: r.text, usage: r.usage, ms: r.ms, costUsd: r.costUsd, parseError: parsed === null };
}

async function runBaselineCase(c) {
  const f = FAMILIES[c.family];
  const t0 = performance.now();
  try {
    const samples = [];
    let input = 0;
    let output = 0;
    let ms = 0;
    let costUsd = null;
    let parseError = false;
    for (let s = 0; s < BASELINE.samples; s++) {
      const r = await callLLM(c.family, c.state);
      samples.push(r.parsed);
      input += r.usage?.input_tokens ?? 0;
      output += r.usage?.output_tokens ?? 0;
      ms += r.ms;
      if (r.costUsd !== null) costUsd = (costUsd ?? 0) + r.costUsd;
      if (r.parseError) parseError = true;
    }
    const usage = { input_tokens: input, output_tokens: output };
    if (isMulti(f)) {
      let subs;
      if (BASELINE.samples > 1) {
        subs = {};
        for (const k of subKeys(f)) subs[k] = aggregateSamples(c.family, samples.map((p) => (p ? p[k] : null)));
      } else {
        subs = normalizeResponseMulti(c.family, samples[0]).subs;
      }
      const arr = subKeys(f).map((k) => ({ key: k, ...subs[k], label: c.label[k] }));
      const askPred = arr.some((s) => s.pred === true);
      const askLabel = combinedLabel(c.label);
      return { ...c, multi: true, subs: arr, pred: askPred, askLabel, conf: Math.min(...arr.map((s) => s.conf)), correct: askPred === askLabel, ms, usage, costUsd, typeError: arr.some((s) => s.pred === null), parseError, error: null };
    }
    const n = BASELINE.samples > 1 ? aggregateSamples(c.family, samples) : normalizeResponse(c.family, samples[0]);
    return { ...c, multi: false, pred: n.pred, conf: n.conf, probs: n.probs, correct: isCorrect(n.pred, c.label, c.accept), ms, usage, costUsd, typeError: n.typeError, parseError, error: null };
  } catch (e) {
    return { ...c, multi: isMulti(f), pred: null, conf: 0, probs: null, correct: false, ms: performance.now() - t0, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: null, typeError: true, parseError: false, error: e.message };
  }
}

/** Runs baseline cases with BASELINE_CONCURRENCY workers; rows stay in dataset order. */
async function runBaseline(cases) {
  if (!baselineEnabled()) return null;
  const rows = new Array(cases.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < cases.length) {
      const i = next++;
      rows[i] = await runBaselineCase(cases[i]);
      done++;
      if (done % 10 === 0 || done === cases.length) process.stderr.write(`  baseline ${done}/${cases.length}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(BASELINE.concurrency, cases.length) }, worker));
  return rows;
}

// ---- flatten per-case rows into atomic-question samples ----
function toSamples(rows) {
  const out = [];
  for (const r of rows) {
    if (r.error) continue;
    if (r.multi && r.subs) {
      for (const s of r.subs) out.push({ family: r.family, id: r.id, key: s.key, difficulty: r.difficulty, label: s.label, pred: s.pred, conf: s.conf, probs: s.probs, correct: s.pred === s.label, ms: r.ms, usage: r.usage });
    } else {
      out.push({ family: r.family, id: r.id, key: null, difficulty: r.difficulty, label: r.label, pred: r.pred, conf: r.conf, probs: r.probs, correct: r.correct, ms: r.ms, usage: r.usage });
    }
  }
  return out;
}

// ---- aggregation ----
function familyStats(samples, rows, family) {
  const f = FAMILIES[family];
  const rs = samples.filter((r) => r.family === family);
  const preds = rs.map((r) => r.pred);
  const labels = rs.map((r) => r.label);
  const confs = rs.map((r) => r.conf);
  const corrects = rs.map((r) => r.correct);
  const withProbs = rs.filter((r) => r.probs);
  const ok = corrects.filter(Boolean).length;
  return {
    family,
    n: rs.length,
    errors: rows.filter((r) => r.family === family && r.error).length,
    accuracy: M.accuracy(preds, labels),
    macroF1: M.macroF1(preds, labels, f.classes),
    brier: withProbs.length ? M.brier(withProbs.map((r) => r.probs), withProbs.map((r) => r.label), f.classes) : null,
    ece: M.ece(confs, corrects).ece,
    confMean: M.mean(confs),
    ci: M.wilson(ok, rs.length),
    p50: M.percentile(rs.map((r) => r.ms), 50),
  };
}

function pooled(samples) {
  const ok = samples.filter((r) => r.correct).length;
  return { ok, n: samples.length, acc: samples.length ? ok / samples.length : 0, ci: M.wilson(ok, samples.length) };
}

function pooledRows(rows) {
  const rs = rows.filter((r) => !r.error);
  const ok = rs.filter((r) => r.correct).length;
  return { ok, n: rs.length, acc: rs.length ? ok / rs.length : 0, ci: M.wilson(ok, rs.length) };
}

function printTable(title, rows, cols) {
  console.log(`\n${title}`);
  const head = cols.map((c) => c.h.padEnd(c.w)).join(" ");
  console.log(head);
  console.log("-".repeat(head.length));
  for (const r of rows) console.log(cols.map((c) => String(c.f(r)).padEnd(c.w)).join(" "));
}

function pct(x, d = 1) {
  return x === null || x === undefined ? "-" : `${(x * 100).toFixed(d)}%`;
}

/** Size-weighted mean of a per-family metric, skipping nulls. */
function weighted(rows, get) {
  let sum = 0;
  let n = 0;
  for (const r of rows) {
    const v = get(r);
    if (v === null || v === undefined) continue;
    sum += v * r.n;
    n += r.n;
  }
  return n ? sum / n : null;
}

/** Guardrail policy: combine atomic flags under a gate threshold; fail closed. */
function guardrailPolicy(rows, threshold) {
  const rs = rows.filter((r) => r.multi && !r.error && r.subs);
  let auto = 0;
  let falseAllow = 0;
  let decisionOk = 0;
  for (const r of rs) {
    const noul = {};
    for (const s of r.subs) noul[s.key] = s.probs ? s.probs.true : s.pred ? 1 : 0;
    const allow = gateGuardrailFlags(noul, threshold).action === "auto";
    const dangerous = combinedLabel(r.label);
    const askPred = r.subs.some((s) => s.pred === true);
    if (allow) auto++;
    if (allow && dangerous) falseAllow++;
    if (askPred === dangerous) decisionOk++;
  }
  const n = rs.length;
  return { n, threshold, autoAllowed: auto, allowCoverage: n ? auto / n : 0, falseAllows: falseAllow, decisionAccuracy: n ? decisionOk / n : 0 };
}

function subQuestionTable(samples, family, model) {
  const f = FAMILIES[family];
  return subKeys(f).map((k) => {
    const rs = samples.filter((s) => s.family === family && s.key === k);
    return { model, key: k, n: rs.length, accuracy: M.accuracy(rs.map((s) => s.pred), rs.map((s) => s.label)), ece: M.ece(rs.map((s) => s.conf), rs.map((s) => s.correct)).ece };
  });
}

const tokensPerCase = (rows, key) => {
  const rs = rows.filter((r) => !r.error);
  return rs.length ? rs.reduce((a, r) => a + (r.usage?.[key] ?? 0), 0) / rs.length : 0;
};

async function main() {
  const cases = loadDataset();
  const backend = new URL(resolveBackend().baseURL).host === "api.typesafe.ai" ? "typesafe" : "custom";
  console.log(`\n=== claude-jev decision-quality eval — backend: ${backend} (${new Date().toISOString()}) ===`);
  console.log(`Dataset: ${cases.length} cases from ${DATASET}`);

  const jev = await runJev(cases);
  const jevSamples = toSamples(jev);
  const jevModel = jev.find((r) => r.model)?.model ?? "jev";
  const jevErrors = jev.filter((r) => r.error);
  if (jevErrors.length) console.log(`\nJev errors: ${jevErrors.length} (first: ${jevErrors[0].error})`);

  const families = [...new Set(cases.map((c) => c.family))];
  const famRows = families.map((f) => familyStats(jevSamples, jev, f));
  printTable(`Jev (${jevModel}) — per family (atomic questions; guardrail = 4 sub-questions/case)`, famRows, [
    { h: "family", w: 10, f: (r) => r.family },
    { h: "n", w: 3, f: (r) => r.n },
    { h: "acc", w: 7, f: (r) => pct(r.accuracy) },
    { h: "95% CI", w: 12, f: (r) => `${pct(r.ci.lo, 0)}-${pct(r.ci.hi, 0)}` },
    { h: "macroF1", w: 8, f: (r) => r.macroF1.toFixed(2) },
    { h: "Brier", w: 7, f: (r) => (r.brier === null ? "-" : r.brier.toFixed(3)) },
    { h: "ECE", w: 6, f: (r) => r.ece.toFixed(3) },
    { h: "conf", w: 6, f: (r) => r.confMean.toFixed(2) },
    { h: "p50ms", w: 7, f: (r) => r.p50.toFixed(0) },
    { h: "err", w: 4, f: (r) => r.errors },
  ]);

  const overallCombined = pooledRows(jev);
  const overallAtomic = pooled(jevSamples);
  const easy = pooledRows(jev.filter((r) => r.difficulty === "easy"));
  const hard = pooledRows(jev.filter((r) => r.difficulty !== "easy"));
  const wBrier = weighted(famRows, (r) => r.brier);
  const wEce = weighted(famRows, (r) => r.ece);
  console.log(`\nOverall per case (guardrail combined) ${overallCombined.ok}/${overallCombined.n} = ${pct(overallCombined.acc)} (95% CI ${pct(overallCombined.ci.lo, 0)}-${pct(overallCombined.ci.hi, 0)})`);
  console.log(`  per atomic question ${overallAtomic.ok}/${overallAtomic.n} = ${pct(overallAtomic.acc)} (95% CI ${pct(overallAtomic.ci.lo, 0)}-${pct(overallAtomic.ci.hi, 0)})`);
  console.log(`  easy ${pct(easy.acc)} (n=${easy.n})  |  medium/ambiguous ${pct(hard.acc)} (n=${hard.n})`);
  console.log(`  weighted Brier ${wBrier === null ? "-" : wBrier.toFixed(3)}  weighted ECE ${wEce.toFixed(3)}  (lower is better; ECE ~0 = calibrated)`);

  printTable("Guardrail sub-questions (Jev)", subQuestionTable(jevSamples, "guardrail", "Jev"), [
    { h: "question", w: 18, f: (r) => r.key },
    { h: "n", w: 3, f: (r) => r.n },
    { h: "acc", w: 7, f: (r) => pct(r.accuracy) },
    { h: "ECE", w: 6, f: (r) => r.ece.toFixed(3) },
  ]);

  // threshold sweeps (defaults: choice/noul 0.75, score 0.65)
  const groups = {
    "choice (default 0.75)": jevSamples.filter((r) => FAMILIES[r.family].type === "choice"),
    "noul (default 0.75)": jevSamples.filter((r) => FAMILIES[r.family].type === "noul"),
    "score (default 0.65)": jevSamples.filter((r) => FAMILIES[r.family].type === "score"),
  };
  const thresholds = [0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.9, 0.95];
  for (const [label, rs] of Object.entries(groups)) {
    const sweep = M.thresholdSweep(rs.map((r) => r.conf), rs.map((r) => r.correct), thresholds);
    printTable(`Threshold sweep — ${label} (selective accuracy vs coverage)`, sweep, [
      { h: "thr", w: 5, f: (r) => r.threshold.toFixed(2) },
      { h: "coverage", w: 9, f: (r) => pct(r.coverage, 0) },
      { h: "n", w: 3, f: (r) => r.n },
      { h: "acc|covered", w: 12, f: (r) => pct(r.accuracy) },
    ]);
  }

  const rc = M.riskCoverage(jevSamples.map((r) => r.conf), jevSamples.map((r) => r.correct));
  printTable("Risk-coverage (keep top-confidence fraction)", rc, [
    { h: "coverage", w: 9, f: (r) => pct(r.coverage, 0) },
    { h: "n", w: 3, f: (r) => r.n },
    { h: "accuracy", w: 9, f: (r) => pct(r.accuracy) },
    { h: "risk", w: 7, f: (r) => pct(r.risk) },
  ]);

  // guardrail gate policy: symmetric 0.75 vs asymmetric 0.95
  const policyCols = [
    { h: "policy", w: 20, f: (r) => r.name },
    { h: "allow cov", w: 9, f: (r) => pct(r.allowCoverage, 0) },
    { h: "auto", w: 4, f: (r) => r.autoAllowed },
    { h: "FALSE-ALLOW", w: 11, f: (r) => r.falseAllows },
    { h: "decision acc", w: 12, f: (r) => pct(r.decisionAccuracy) },
  ];
  printTable("Guardrail gate policy (Jev) — fail closed when unsure", [
    { name: "symmetric 0.75", ...guardrailPolicy(jev, 0.75) },
    { name: "asymmetric 0.95", ...guardrailPolicy(jev, 0.95) },
  ], policyCols);

  // baseline
  let baseRows = null;
  let h2h = null;
  if (baselineEnabled()) {
    const via = BASELINE.provider === "claude-cli" ? `claude -p (effort ${BASELINE.effort})` : BASELINE.base;
    console.log(`\n--- LLM baseline: ${BASELINE.model} via ${via} (samples=${BASELINE.samples}, concurrency=${BASELINE.concurrency}) ---`);
    const cliOverhead = BASELINE.provider === "claude-cli" ? await measureCliOverhead() : 0;
    if (cliOverhead) console.log(`  claude -p overhead ≈ ${cliOverhead} input tokens/call (measured with a near-empty prompt)`);
    baseRows = await runBaseline(cases);
    const baseSamples = toSamples(baseRows);
    const bOverall = pooledRows(baseRows);
    const bAtomic = pooled(baseSamples);
    const bErrors = baseRows.filter((r) => r.error);
    const bType = baseRows.filter((r) => r.typeError).length / baseRows.length;
    const bParse = baseRows.filter((r) => r.parseError).length / baseRows.length;
    const bMs = baseRows.filter((r) => !r.error).map((r) => r.ms);

    const bFamRows = families.map((f) => familyStats(baseSamples, baseRows, f));
    printTable(`LLM baseline — per family (${BASELINE.model})`, bFamRows, [
      { h: "family", w: 10, f: (r) => r.family },
      { h: "n", w: 3, f: (r) => r.n },
      { h: "acc", w: 7, f: (r) => pct(r.accuracy) },
      { h: "95% CI", w: 12, f: (r) => `${pct(r.ci.lo, 0)}-${pct(r.ci.hi, 0)}` },
      { h: "macroF1", w: 8, f: (r) => r.macroF1.toFixed(2) },
      { h: "Brier", w: 7, f: (r) => (r.brier === null ? "-" : r.brier.toFixed(3)) },
      { h: "ECE", w: 6, f: (r) => r.ece.toFixed(3) },
      { h: "p50ms", w: 7, f: (r) => r.p50.toFixed(0) },
      { h: "err", w: 4, f: (r) => r.errors },
    ]);

    printTable(`Guardrail sub-questions (${BASELINE.model})`, subQuestionTable(baseSamples, "guardrail", BASELINE.model), [
      { h: "question", w: 18, f: (r) => r.key },
      { h: "n", w: 3, f: (r) => r.n },
      { h: "acc", w: 7, f: (r) => pct(r.accuracy) },
      { h: "ECE", w: 6, f: (r) => r.ece.toFixed(3) },
    ]);

    const bBrier = weighted(bFamRows, (r) => r.brier);
    const bEce = weighted(bFamRows, (r) => r.ece);

    // paired significance on cases both systems answered (combined decision)
    const idx = cases.map((_, i) => i).filter((i) => !jev[i].error && !baseRows[i].error);
    const labelOf = (i) => (jev[i].multi ? jev[i].askLabel : jev[i].label);
    const mcn = M.mcnemar(idx.map((i) => jev[i].pred), idx.map((i) => baseRows[i].pred), idx.map(labelOf));
    const diff = M.pairedBootstrapDiff(idx.map((i) => jev[i].pred), idx.map((i) => baseRows[i].pred), idx.map(labelOf));
    // same, excluding severity (the weakest, least stable family)
    const nonSev = idx.filter((i) => jev[i].family !== "severity");
    const mcnNS = M.mcnemar(nonSev.map((i) => jev[i].pred), nonSev.map((i) => baseRows[i].pred), nonSev.map(labelOf));

    // cost per 1k decisions from real token usage at list prices (row = one decision)
    const jevTokIn = jev.filter((r) => !r.error).reduce((a, r) => a + (r.usage?.input_tokens ?? 0), 0);
    const bOk = baseRows.filter((r) => !r.error);
    const bTokIn = bOk.reduce((a, r) => a + (r.usage?.input_tokens ?? 0), 0);
    const bTokOut = bOk.reduce((a, r) => a + (r.usage?.output_tokens ?? 0), 0);
    const bCalls = bOk.length * BASELINE.samples;
    const jCost = M.costPer1k(jevTokIn, 0, overallCombined.n, JEV_PRICE_IN, JEV_PRICE_OUT);
    const bCost = M.costPer1k(bTokIn, bTokOut, bOverall.n, BASELINE.priceIn, BASELINE.priceOut);
    const bCostNoOverhead = M.costPer1k(Math.max(0, bTokIn - cliOverhead * bCalls), bTokOut, bOverall.n, BASELINE.priceIn, BASELINE.priceOut);
    const bCliReported = BASELINE.provider === "claude-cli" ? (bOk.reduce((a, r) => a + (r.costUsd ?? 0), 0) / Math.max(1, bOverall.n)) * 1000 : null;
    const jMs = jev.filter((r) => !r.error).map((r) => r.ms);

    console.log(`\nBaseline accuracy per case ${bOverall.ok}/${bOverall.n} = ${pct(bOverall.acc)} (95% CI ${pct(bOverall.ci.lo, 0)}-${pct(bOverall.ci.hi, 0)}); per atomic ${pct(bAtomic.acc)}`);
    console.log(`  errors ${bErrors.length}${bErrors.length ? ` (first: ${bErrors[0].error})` : ""}  type-error rate ${pct(bType)}  parse-error rate ${pct(bParse)}`);
    console.log(`  latency p50 ${M.percentile(bMs, 50).toFixed(0)}ms  p95 ${M.percentile(bMs, 95).toFixed(0)}ms  |  tokens/case in ${tokensPerCase(baseRows, "input_tokens").toFixed(0)} out ${tokensPerCase(baseRows, "output_tokens").toFixed(0)}`);
    console.log(`  weighted Brier ${bBrier === null ? "-" : bBrier.toFixed(3)}  weighted ECE ${bEce === null ? "-" : bEce.toFixed(3)}`);

    printTable("Head-to-head (per case, guardrail combined)", [
      { name: `Jev (${jevModel})`, acc: overallCombined.acc, n: overallCombined.n, type: 0, brier: wBrier, ece: wEce, p50: M.percentile(jMs, 50), p95: M.percentile(jMs, 95), tokIn: tokensPerCase(jev, "input_tokens"), cost: jCost },
      { name: BASELINE.model, acc: bOverall.acc, n: bOverall.n, type: bType, brier: bBrier, ece: bEce, p50: M.percentile(bMs, 50), p95: M.percentile(bMs, 95), tokIn: tokensPerCase(baseRows, "input_tokens"), cost: bCost },
    ], [
      { h: "system", w: 22, f: (r) => r.name },
      { h: "accuracy", w: 9, f: (r) => pct(r.acc) },
      { h: "n", w: 4, f: (r) => r.n },
      { h: "type-err", w: 9, f: (r) => pct(r.type) },
      { h: "Brier", w: 7, f: (r) => (r.brier === null ? "-" : r.brier.toFixed(3)) },
      { h: "ECE", w: 6, f: (r) => (r.ece === null ? "-" : r.ece.toFixed(3)) },
      { h: "p50ms", w: 7, f: (r) => r.p50.toFixed(0) },
      { h: "p95ms", w: 7, f: (r) => r.p95.toFixed(0) },
      { h: "in-tok", w: 7, f: (r) => r.tokIn.toFixed(0) },
      { h: "$/1k", w: 9, f: (r) => `$${r.cost.toFixed(4)}` },
    ]);
    if (cliOverhead) {
      console.log(`  ${BASELINE.model} $/1k at $${BASELINE.priceIn}/$${BASELINE.priceOut} per M: $${bCost.toFixed(4)} incl. claude -p overhead, $${bCostNoOverhead.toFixed(4)} excl. it (≈ a direct API call); CLI-reported (1h cache writes) $${bCliReported.toFixed(4)}`);
    }

    console.log(`\nPaired significance (n=${idx.length} cases both systems answered):`);
    console.log(`  McNemar: Jev-only-correct a=${mcn.a}, baseline-only-correct b=${mcn.b}, exact p=${mcn.p.toFixed(4)} (${mcn.p < 0.05 ? "SIGNIFICANT" : "not significant"})`);
    console.log(`  Accuracy diff (Jev - baseline) ${(diff.mean * 100).toFixed(1)} pts, 95% CI ${(diff.lo * 100).toFixed(1)} to ${(diff.hi * 100).toFixed(1)} pts, bootstrap p≈${diff.pApprox.toFixed(4)}`);
    console.log(`  Excluding severity (n=${nonSev.length}): a=${mcnNS.a}, b=${mcnNS.b}, exact p=${mcnNS.p.toFixed(4)} (${mcnNS.p < 0.05 ? "SIGNIFICANT" : "not significant"})`);

    const bPolicy = { symmetric: guardrailPolicy(baseRows, 0.75), asymmetric: guardrailPolicy(baseRows, 0.95) };
    printTable(`Guardrail gate policy (${BASELINE.model})`, [
      { name: "symmetric 0.75", ...bPolicy.symmetric },
      { name: "asymmetric 0.95", ...bPolicy.asymmetric },
    ], policyCols);

    h2h = {
      model: BASELINE.model,
      provider: BASELINE.provider,
      effort: BASELINE.provider === "claude-cli" ? BASELINE.effort : undefined,
      samples: BASELINE.samples,
      temperature: BASELINE.provider === "openai" ? BASELINE.temperature : undefined,
      prices: { inPerM: BASELINE.priceIn, outPerM: BASELINE.priceOut },
      overall: bOverall,
      overallAtomic: bAtomic,
      errors: bErrors.length,
      families: bFamRows,
      weighted: { brier: bBrier, ece: bEce },
      typeErrorRate: bType,
      parseErrorRate: bParse,
      latency: { p50: M.percentile(bMs, 50), p95: M.percentile(bMs, 95) },
      tokensPerCase: { input: tokensPerCase(baseRows, "input_tokens"), output: tokensPerCase(baseRows, "output_tokens") },
      mcnemar: mcn,
      mcnemarExclSeverity: mcnNS,
      bootDiff: diff,
      cliOverheadTokens: cliOverhead || undefined,
      costPer1k: { jev: jCost, baseline: bCost, baselineExclCliOverhead: cliOverhead ? bCostNoOverhead : undefined, baselineCliReported: bCliReported ?? undefined },
      guardrailPolicy: bPolicy,
    };
  } else {
    console.log("\n(LLM baseline skipped — set BASELINE_MODEL (claude-* uses `claude -p`), or BASELINE_MODEL + BASELINE_API_KEY for an OpenAI-compatible endpoint.)");
  }

  // artifact
  const rowOut = (r, extra = {}) => ({
    id: r.id,
    family: r.family,
    label: r.label,
    pred: r.pred,
    conf: r.conf,
    correct: r.correct,
    difficulty: r.difficulty,
    ms: Math.round(r.ms),
    error: r.error,
    ...extra,
    subs: r.subs ? r.subs.map((s) => ({ key: s.key, label: s.label, pred: s.pred, conf: s.conf, correct: s.pred === s.label })) : undefined,
  });
  const out = {
    meta: { backend, jevModel, at: new Date().toISOString(), dataset: DATASET, cases: cases.length, baseline: baselineEnabled() ? BASELINE.model : null },
    overallCombined,
    overallAtomic,
    easy,
    hard,
    weighted: { brier: wBrier, ece: wEce },
    families: famRows,
    guardrailSubQuestions: subQuestionTable(jevSamples, "guardrail", "Jev"),
    guardrailPolicy: { symmetric: guardrailPolicy(jev, 0.75), asymmetric: guardrailPolicy(jev, 0.95) },
    thresholdSweeps: Object.fromEntries(Object.entries(groups).map(([k, rs]) => [k, M.thresholdSweep(rs.map((r) => r.conf), rs.map((r) => r.correct), thresholds)])),
    riskCoverage: rc,
    headToHead: h2h,
    jevRows: jev.map((r) => rowOut(r)),
    baselineRows: baseRows ? baseRows.map((r) => rowOut(r, { typeError: r.typeError, parseError: r.parseError })) : null,
  };
  mkdirSync(RESULTS, { recursive: true });
  const file = join(RESULTS, `eval-${backend}${baselineEnabled() ? `-vs-${BASELINE.model.replace(/[^a-z0-9.-]/gi, "_")}` : ""}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
