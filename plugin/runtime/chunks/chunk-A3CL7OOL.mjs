// mcp-server/src/state.ts
var MAX_STATE_CHARS = 6e4;
var HEAD_RATIO = 0.6;
function smartTruncate(input, max = MAX_STATE_CHARS) {
  const origChars = input.length;
  if (origChars <= max) return { text: input, truncated: false, origChars };
  const head = Math.floor(max * HEAD_RATIO);
  const tail = max - head - 80;
  const marker = `

\u2026[truncated ${origChars - max} chars; head ${head} + tail ${tail} kept]\u2026

`;
  return { text: input.slice(0, head) + marker + input.slice(origChars - tail), truncated: true, origChars };
}
function lintChoiceCriteria(criteria) {
  const warnings = [];
  for (const [opt, desc] of Object.entries(criteria)) {
    if (desc === null) continue;
    const d = desc.trim();
    if (d.length < 12) warnings.push(`option "${opt}" description too short (${d.length} chars) \u2014 add a rubric sentence`);
    if (d.length > 2e3) warnings.push(`option "${opt}" description too long \u2014 trim to <500 chars`);
  }
  const opts = Object.keys(criteria);
  for (let i = 0; i < opts.length; i++) {
    for (let j = i + 1; j < opts.length; j++) {
      const a = new Set((criteria[opts[i]] ?? "").toLowerCase().split(/\W+/).filter(Boolean));
      const b = new Set((criteria[opts[j]] ?? "").toLowerCase().split(/\W+/).filter(Boolean));
      const inter = [...a].filter((x) => b.has(x)).length;
      const union = (/* @__PURE__ */ new Set([...a, ...b])).size;
      const jacc = union ? inter / union : 0;
      if (jacc > 0.6 && a.size > 3) warnings.push(`options "${opts[i]}"/"${opts[j]}" descriptions overlap (Jaccard ${jacc.toFixed(2)}) \u2014 differentiate rubrics`);
    }
  }
  return warnings;
}
function lintScoreLevels(levels) {
  const w = [];
  if (levels.length < 2) w.push("score needs \u22652 levels");
  if (levels.length > 16) w.push("score supports \u226416 levels");
  const uniq = new Set(levels.map((s) => s.trim().toLowerCase()));
  if (uniq.size !== levels.length) w.push("score levels must be distinct");
  return w;
}

// mcp-server/src/client.ts
var DEFAULT_MODEL = "jev-latest";
var DEFAULT_TIMEOUT_MS = 15e3;
var DEFAULT_MAX_RETRIES = 2;
var MAX_STATE_CHARS2 = 6e4;
var MAX_QUESTIONS = 32;
function resolveBackend(opts = {}) {
  const model = (opts.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const apiKey = opts.apiKey?.trim();
  if (!apiKey) {
    throw new Error("API key is required for claude-jev (live-only). Configure the API key in the plugin's settings. Direct clients must pass apiKey. No mock fallback.");
  }
  const baseURL = opts.baseURL?.trim() || "https://api.typesafe.ai/v1/systemone";
  return { apiKey, baseURL, model };
}
function validateQuestions(questions) {
  const ids = Object.keys(questions);
  if (ids.length === 0) throw new Error("questions: at least one question required");
  if (ids.length > MAX_QUESTIONS) throw new Error(`questions: at most ${MAX_QUESTIONS} questions per call (got ${ids.length})`);
  for (const [id, q] of Object.entries(questions)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(id)) throw new Error(`question id "${id}" must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`);
    if (!q || typeof q !== "object") throw new Error(`question "${id}": invalid shape`);
    if (typeof q.instructions !== "string" || !q.instructions.trim()) throw new Error(`question "${id}": instructions must be a non-empty string`);
    if (q.instructions.length > 4e3) throw new Error(`question "${id}": instructions too long (max 4000 chars)`);
    switch (q.type) {
      case "choice": {
        const c = q.criteria;
        if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error(`question "${id}": choice criteria must be an object`);
        const opts = Object.keys(c);
        if (opts.length < 2) throw new Error(`question "${id}": choice requires at least 2 options`);
        if (opts.length > 32) throw new Error(`question "${id}": choice supports at most 32 options`);
        for (const k of opts) if (!k.trim()) throw new Error(`question "${id}": option keys must be non-empty`);
        break;
      }
      case "noul":
        break;
      case "score": {
        const c = q.criteria;
        if (!Array.isArray(c) || c.length < 2) throw new Error(`question "${id}": score criteria must be an array with at least 2 levels`);
        if (c.length > 16) throw new Error(`question "${id}": score supports at most 16 levels`);
        for (const lvl of c) if (typeof lvl !== "string" || !lvl.trim()) throw new Error(`question "${id}": score levels must be non-empty strings`);
        break;
      }
      default:
        throw new Error(`question "${id}": unknown type "${q.type}"`);
    }
  }
}
function validateState(state) {
  const asString = typeof state === "string" ? state : JSON.stringify(state);
  if (!asString.trim()) throw new Error("state must be a non-empty string or object");
  if (asString.length > MAX_STATE_CHARS2) {
    const { text, origChars } = smartTruncate(asString);
    if (text.length > MAX_STATE_CHARS2) throw new Error(`state too large (${origChars} chars, max ${MAX_STATE_CHARS2}). Trim context.`);
    console.error(`[claude-jev] state truncated: ${origChars} -> ${text.length} chars (head+tail kept)`);
    return text;
  }
  return state;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function isRetryableStatus(s) {
  return s === 429 || s === 529 || s >= 500 && s < 600;
}
async function decide(state, questions, opts = {}) {
  validateQuestions(questions);
  const sendState = validateState(state);
  const { apiKey, baseURL, model } = resolveBackend(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const body = JSON.stringify({ model, state: sendState, questions });
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(baseURL, { method: "POST", headers, body, signal: ac.signal });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        const err = new Error(`Jev API ${res.status} ${res.statusText}: ${txt.slice(0, 800)}`);
        err.status = res.status;
        if (isRetryableStatus(res.status) && attempt < maxRetries) {
          await sleep(250 * 2 ** attempt + Math.random() * 150);
          lastErr = err;
          continue;
        }
        throw err;
      }
      const json = await res.json();
      if (!json || typeof json !== "object" || !json.answers) throw new Error("Jev API: invalid response shape (missing answers)");
      return json;
    } catch (e) {
      const err = e;
      if (err.name === "AbortError") {
        const abortErr = new Error(`Jev API timeout after ${timeoutMs}ms`);
        if (attempt < maxRetries) {
          lastErr = abortErr;
          await sleep(250 * 2 ** attempt);
          continue;
        }
        throw abortErr;
      }
      if (!res && attempt < maxRetries) {
        lastErr = err;
        await sleep(250 * 2 ** attempt);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr ?? new Error("Jev API: unknown error after retries");
}

export {
  lintChoiceCriteria,
  lintScoreLevels,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  MAX_STATE_CHARS2 as MAX_STATE_CHARS,
  MAX_QUESTIONS,
  resolveBackend,
  validateQuestions,
  decide
};
