// Developer-only environment adapter. This file is not shipped in the plugin.
import { decide as requestDecision, resolveBackend as resolve } from "../plugin/runtime/client.mjs";

export function resolveBackend(opts = {}) {
  return resolve({
    apiKey: process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY,
    model: process.env.JEV_MODEL,
    baseURL: process.env.JEV_BASE_URL,
    ...opts,
  });
}

export function decide(state, questions, opts = {}) {
  return requestDecision(state, questions, { ...opts, ...resolveBackend(opts) });
}
