#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { decide, type Questions } from "./client.js";
import { gateChoice, gateNoul, gateScore, gateAnswer } from "./gate.js";
import { toAuditEntry } from "./audit.js";
import { lintChoiceCriteria, lintScoreLevels } from "./state.js";

const server = new Server({ name: "claude-jev", version: "0.1.0" }, { capabilities: { tools: {} } });

function parseCriteriaObject(input: string): Record<string, string | null> {
  const parsed = JSON.parse(input);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("criteria must be JSON object");
  return parsed;
}

function logAudit(tool: string, state: string, questions: Questions, res: import("./client.js").JevResponse, latencyMs: number) {
  const gated: Record<string, { action: "auto" | "escalate"; reason: string }> = {};
  for (const [id, ans] of Object.entries(res.answers)) gated[id] = gateAnswer(ans as unknown as { type: string; confidence?: number; noul?: number });
  const entry = toAuditEntry({ tool, model: res.model, backend: "typesafe", state, questions: questions as Record<string, unknown>, answers: res.answers as Record<string, unknown>, latencyMs, usage: res.usage, gated });
  console.error(`[claude-jev] ${entry.at} ${entry.tool} ${entry.model} ${entry.latencyMs}ms hash=${entry.stateHash} gated=${Object.entries(gated).map(([k, v]) => `${k}:${v.action}`).join(",")}`);
  return gated;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "jev_choice",
      description: "Typed Choice via live Jev (System One). Use instead of Claude text when answer is bounded. Returns {choice, probabilities, confidence, gated}. Gate: auto if conf>=0.75 else escalate. Mirrors opencode-openjev jev_choice.",
      inputSchema: {
        type: "object",
        properties: {
          state: { type: "string", description: "State to decide on — ticket, transcript, JSON, diff, etc." },
          instructions: { type: "string", description: "One well-scoped question, e.g. 'Route to team'" },
          criteria: { type: "string", description: 'JSON object option->description, e.g. \'{"billing":"pay","tech":"bug"}\'' },
          model: { type: "string", description: "Override model (default jev-latest -> jev-1.13.0)" },
        },
        required: ["state", "instructions", "criteria"],
      },
    },
    {
      name: "jev_noul",
      description: "Typed Noul (yes/no) via live Jev. Returns {noul 0..1, is_yes, confidence, gated}. Mirrors opencode jev_noul.",
      inputSchema: {
        type: "object",
        properties: {
          state: { type: "string" },
          instructions: { type: "string", description: "Yes/no question" },
          true_desc: { type: "string" },
          false_desc: { type: "string" },
          model: { type: "string" },
        },
        required: ["state", "instructions"],
      },
    },
    {
      name: "jev_score",
      description: "Typed Score via live Jev. Returns {score, probabilities, confidence, legend, gated}. Mirrors opencode jev_score.",
      inputSchema: {
        type: "object",
        properties: {
          state: { type: "string" },
          instructions: { type: "string" },
          criteria: { type: "string", description: 'JSON array of levels, e.g. \'["low","medium","high"]\'' },
          model: { type: "string" },
        },
        required: ["state", "instructions", "criteria"],
      },
    },
    {
      name: "jev_ask",
      description: "Parallel live Jev: send state + map of typed questions (choice/noul/score) → one 70-500ms call. Each answer includes gated. Mirrors opencode jev_ask.",
      inputSchema: {
        type: "object",
        properties: {
          state: { type: "string" },
          questions: { type: "string", description: 'JSON map id->Question {type,instructions,criteria}' },
          model: { type: "string" },
        },
        required: ["state", "questions"],
      },
    },
    {
      name: "jev_doctor",
      description: "Check live Jev wiring: auth + smoke decision. Requires TYPESAFE_API_KEY. Mirrors opencode jev_doctor.",
      inputSchema: { type: "object", properties: { probe_state: { type: "string" } } },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params as { name: string; arguments: Record<string, string> };
  try {
    let result: unknown;
    switch (name) {
      case "jev_choice": {
        const t0 = Date.now();
        const criteria = parseCriteriaObject(args.criteria);
        const w = lintChoiceCriteria(criteria);
        if (w.length) console.error(`[claude-jev] jev_choice lint: ${w.join(" | ")}`);
        const res = await decide(args.state, { q: { type: "choice", instructions: args.instructions, criteria } }, { model: args.model });
        const a = res.answers.q as import("./client.js").ChoiceAnswer;
        const gated = gateChoice(a.confidence);
        const questions: Questions = { q: { type: "choice", instructions: args.instructions, criteria } };
        logAudit("jev_choice", args.state, questions, res, Date.now() - t0);
        result = { model: res.model, choice: a.choice, probabilities: a.probabilities, confidence: a.confidence, gated, warnings: w.length ? w : undefined, usage: res.usage };
        break;
      }
      case "jev_noul": {
        const t0 = Date.now();
        const questions: Questions = { q: { type: "noul", instructions: args.instructions, criteria: args.true_desc || args.false_desc ? { true: args.true_desc, false: args.false_desc } : undefined } };
        const res = await decide(args.state, questions, { model: args.model });
        const a = res.answers.q as import("./client.js").NoulAnswer;
        const gated = gateNoul(a.noul);
        logAudit("jev_noul", args.state, questions, res, Date.now() - t0);
        result = { model: res.model, noul: a.noul, is_yes: a.noul > 0.5, confidence: Math.max(a.noul, 1 - a.noul), gated, usage: res.usage };
        break;
      }
      case "jev_score": {
        const t0 = Date.now();
        const levels = JSON.parse(args.criteria) as string[];
        const w = lintScoreLevels(levels);
        if (w.length) console.error(`[claude-jev] jev_score lint: ${w.join(" | ")}`);
        const questions: Questions = { q: { type: "score", instructions: args.instructions, criteria: levels } };
        const res = await decide(args.state, questions, { model: args.model });
        const a = res.answers.q as import("./client.js").ScoreAnswer;
        const gated = gateScore(a.confidence);
        logAudit("jev_score", args.state, questions, res, Date.now() - t0);
        result = { model: res.model, score: a.score, probabilities: a.probabilities, confidence: a.confidence, legend: a.legend, gated, warnings: w.length ? w : undefined, usage: res.usage };
        break;
      }
      case "jev_ask": {
        const t0 = Date.now();
        const questions = JSON.parse(args.questions) as Questions;
        for (const [id, q] of Object.entries(questions)) if (q.type === "choice") { const w = lintChoiceCriteria((q as import("./client.js").ChoiceQuestion).criteria); if (w.length) console.error(`[claude-jev] jev_ask ${id} lint: ${w.join(" | ")}`); }
        const res = await decide(args.state, questions, { model: args.model });
        const gated: Record<string, { action: "auto" | "escalate"; reason: string }> = {};
        for (const [id, ans] of Object.entries(res.answers)) gated[id] = gateAnswer(ans as unknown as { type: string; confidence?: number; noul?: number });
        logAudit("jev_ask", args.state, questions, res, Date.now() - t0);
        result = { ...res, gated };
        break;
      }
      case "jev_doctor": {
        const probe = args.probe_state || "Help! payouts failing 3 days.";
        const res = await decide(probe, {
          is_urgent: { type: "noul", instructions: "Does this convey urgency?" },
          team: { type: "choice", instructions: "Route to team", criteria: { billing: "pay", technical: "bug", sales: "buy", spam: "junk" } },
        });
        result = { ok: true, model: res.model, answers: res.answers, usage: res.usage };
        break;
      }
      default:
        throw new Error(`unknown tool ${name}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: (e as Error).message }, null, 2) }], isError: true };
  }
});

async function main() {
  await server.connect(new StdioServerTransport());
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
