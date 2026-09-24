/**
 * Jev live client — mirrors opencode-openjev/src/client.ts exactly
 * but live-only: no mock fallback. Errors if TYPESAFE_API_KEY missing.
 * Spec: docs.typesafe.ai/api — POST {model, state, questions} -> {model, answers, usage}
 */

export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
};
export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
};
export type ScoreQuestion = {
  type: "score";
  instructions: string;
  criteria: string[];
};
export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export type ChoiceAnswer = { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };
export type NoulAnswer = { type: "noul"; noul: number };
export type ScoreAnswer = { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };
export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer;
export type JevResponse = { model: string; answers: Record<string, Answer>; usage?: { input_tokens?: number; output_tokens?: number } };

export type ClientOptions = {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
};

function env(name: string): string | undefined {
  try {
    const fromGlobal = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env?.[name];
    if (fromGlobal !== undefined) return fromGlobal;
    if (typeof process !== "undefined" && (process as unknown as { env: Record<string, string> }).env) {
      return (process as unknown as { env: Record<string, string> }).env[name];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export const DEFAULT_MODEL = "jev-latest";
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_RETRIES = 2;
export const MAX_STATE_CHARS = 60_000;
export const MAX_QUESTIONS = 32;

export function resolveBackend(opts: ClientOptions = {}): { apiKey: string; baseURL: string; model: string } {
  const model = (opts.model ?? env("JEV_MODEL") ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const apiKey = opts.apiKey ?? env("TYPESAFE_API_KEY") ?? env("JEV_API_KEY");
  if (!apiKey) {
    throw new Error("TYPESAFE_API_KEY is required for claude-jev (live-only). Set TYPESAFE_API_KEY=ts_... in env. No mock fallback.");
  }
  const baseURL = opts.baseURL ?? env("JEV_BASE_URL") ?? "https://api.typesafe.ai/v1/systemone";
  return { apiKey, baseURL, model };
}

export function validateQuestions(questions: Questions): void {
  const ids = Object.keys(questions);
  if (ids.length === 0) throw new Error("questions: at least one question required");
  if (ids.length > MAX_QUESTIONS) throw new Error(`questions: at most ${MAX_QUESTIONS} questions per call (got ${ids.length})`);
  for (const [id, q] of Object.entries(questions)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(id)) throw new Error(`question id "${id}" must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`);
    if (!q || typeof q !== "object") throw new Error(`question "${id}": invalid shape`);
    if (typeof q.instructions !== "string" || !q.instructions.trim()) throw new Error(`question "${id}": instructions must be a non-empty string`);
    if (q.instructions.length > 4000) throw new Error(`question "${id}": instructions too long (max 4000 chars)`);
    switch (q.type) {
      case "choice": {
        const c = (q as ChoiceQuestion).criteria;
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
        const c = (q as ScoreQuestion).criteria;
        if (!Array.isArray(c) || c.length < 2) throw new Error(`question "${id}": score criteria must be an array with at least 2 levels`);
        if (c.length > 16) throw new Error(`question "${id}": score supports at most 16 levels`);
        for (const lvl of c) if (typeof lvl !== "string" || !lvl.trim()) throw new Error(`question "${id}": score levels must be non-empty strings`);
        break;
      }
      default:
        throw new Error(`question "${id}": unknown type "${(q as { type: string }).type}"`);
    }
  }
}

import { smartTruncate } from "./state.js";

function validateState(state: string | object | unknown[]): string {
  const asString = typeof state === "string" ? state : JSON.stringify(state);
  if (!asString.trim()) throw new Error("state must be a non-empty string or object");
  if (asString.length > MAX_STATE_CHARS) {
    const { text, origChars } = smartTruncate(asString);
    if (text.length > MAX_STATE_CHARS) throw new Error(`state too large (${origChars} chars, max ${MAX_STATE_CHARS}). Trim context.`);
    return text;
  }
  return asString;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function isRetryableStatus(s: number): boolean {
  return s === 429 || s === 529 || (s >= 500 && s < 600);
}

export async function decide(state: string | object | unknown[], questions: Questions, opts: ClientOptions = {}): Promise<JevResponse> {
  validateQuestions(questions);
  validateState(state);
  const { apiKey, baseURL, model } = resolveBackend(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const body = JSON.stringify({ model, state: typeof state === "string" ? state : state, questions });
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(baseURL, { method: "POST", headers, body, signal: ac.signal });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        const err = new Error(`Jev API ${res.status} ${res.statusText}: ${txt.slice(0, 800)}`) as Error & { status?: number };
        err.status = res.status;
        if (isRetryableStatus(res.status) && attempt < maxRetries) {
          await sleep(250 * 2 ** attempt + Math.random() * 150);
          lastErr = err;
          continue;
        }
        throw err;
      }
      const json = (await res.json()) as JevResponse;
      if (!json || typeof json !== "object" || !json.answers) throw new Error("Jev API: invalid response shape (missing answers)");
      return json;
    } catch (e) {
      const err = e as Error & { name?: string; status?: number };
      if (err.name === "AbortError") {
        const abortErr = new Error(`Jev API timeout after ${timeoutMs}ms`);
        if (attempt < maxRetries) {
          lastErr = abortErr;
          await sleep(250 * 2 ** attempt);
          continue;
        }
        throw abortErr;
      }
      if (err.status !== undefined && isRetryableStatus(err.status) && attempt < maxRetries) {
        lastErr = err;
        await sleep(250 * 2 ** attempt);
        continue;
      }
      if (attempt < maxRetries && !err.status) {
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
