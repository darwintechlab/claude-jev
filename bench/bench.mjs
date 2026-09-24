#!/usr/bin/env node
// Live-only bench — same logic as OpenJev/bench/bench.mjs but no mock
import { performance } from "node:perf_hooks";
import { decide } from "../mcp-server/dist/client.js";

const tickets = [
  { state: "Help! payouts failing 3 days — order #48281 hasn't cleared.", expect: "billing" },
  { state: "Login loop after MFA — can't access dashboard, 500 on /auth/callback", expect: "technical" },
  { state: "What does enterprise plan cost for 50 seats? Need invoice.", expect: "sales" },
  { state: "WIN FREE CRYPTO click here!!!", expect: "spam" },
  { state: "Refund for invoice INV-9921 — charged twice.", expect: "billing" },
  { state: "API returns 429 even at 2 req/s — docs say 10 req/s limit.", expect: "technical" },
  { state: "Can I upgrade mid-cycle and prorate?", expect: "sales" },
  { state: "You have been pre-approved for a loan — reply with SSN", expect: "spam" },
  { state: "Payout webhook not firing for ACH — logs show 200 but no event.", expect: "technical" },
  { state: "Billing address change for next invoice — VAT ID updated.", expect: "billing" },
];
const criteria = {
  billing: "payments, invoices, payouts, refunds, VAT",
  technical: "bugs, outages, API, auth, webhooks, errors",
  sales: "buying, pricing, plans, upgrade, seats",
  spam: "irrelevant, scam, promotion, unsolicited",
};

function pct(a, p) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.ceil((p / 100) * s.length) - 1];
}

if (!process.env.TYPESAFE_API_KEY) {
  console.error("TYPESAFE_API_KEY required (live-only). Set TYPESAFE_API_KEY=ts_... and re-run.");
  process.exit(1);
}

console.log(`\n=== claude-jev live bench — jev-1.13.0 — ${new Date().toISOString()} ===`);
await decide("warmup", { q: { type: "noul", instructions: "warm?" } });

const l1 = [];
for (let i = 0; i < 15; i++) {
  const t0 = performance.now();
  const r = await decide(tickets[0].state, { team: { type: "choice", instructions: "Route to team", criteria } });
  l1.push(performance.now() - t0);
  if (i === 0) console.log(`warm sample: ${r.model} team=${r.answers.team.choice} conf=${r.answers.team.confidence.toFixed(2)}`);
  await new Promise((s) => setTimeout(s, 120));
}
console.log(`1q 15 runs — p50 ${pct(l1, 50).toFixed(1)}ms p95 ${pct(l1, 95).toFixed(1)}ms mean ${(l1.reduce((a, b) => a + b, 0) / l1.length).toFixed(1)}ms`);

const l27 = [];
for (let i = 0; i < 8; i++) {
  const qs = Object.fromEntries(Array.from({ length: 27 }, (_, k) => [`q${k}`, { type: "choice", instructions: "Route to team", criteria }]));
  const t0 = performance.now();
  await decide(tickets[0].state, qs);
  l27.push(performance.now() - t0);
  await new Promise((s) => setTimeout(s, 120));
}
console.log(`27q 8 runs — p50 ${pct(l27, 50).toFixed(1)}ms mean ${(l27.reduce((a, b) => a + b, 0) / l27.length).toFixed(1)}ms overhead +${(l27.reduce((a, b) => a + b, 0) / l27.length - l1.reduce((a, b) => a + b, 0) / l1.length).toFixed(1)}ms`);

let ok = 0;
for (const t of tickets) {
  const r = await decide(t.state, { team: { type: "choice", instructions: "Route to team", criteria } });
  const c = r.answers.team.choice === t.expect;
  if (c) ok++;
  console.log(`${c ? "✓" : "✗"} expect=${t.expect} got=${r.answers.team.choice} conf=${r.answers.team.confidence.toFixed(2)}  "${t.state.slice(0, 52)}..."`);
  await new Promise((s) => setTimeout(s, 80));
}
console.log(`\naccuracy ${ok}/${tickets.length} (${(ok / tickets.length * 100).toFixed(1)}%)`);

const t0 = performance.now();
for (let i = 0; i < 10; i++) await decide(tickets[0].state, { q: { type: "choice", instructions: "Route", criteria } });
const seq = performance.now() - t0;
const t1 = performance.now();
await decide(tickets[0].state, Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`q${i}`, { type: "choice", instructions: "Route", criteria }])));
const par = performance.now() - t1;
console.log(`seq 10×1q ${seq.toFixed(1)}ms  par 1×10q ${par.toFixed(1)}ms  ${(seq / par).toFixed(1)}×`);
