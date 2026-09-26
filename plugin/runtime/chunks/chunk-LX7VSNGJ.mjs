// mcp-server/src/gate.ts
var DEFAULT_THRESHOLDS = {
  choice: 0.75,
  noul: 0.75,
  score: 0.65,
  // Guardrails are asymmetric: auto-allowing a dangerous command is far worse
  // than asking, so "safe" must be very confident before we skip the prompt.
  guardrail: 0.95
};
function gateChoice(confidence, threshold = DEFAULT_THRESHOLDS.choice) {
  if (confidence >= threshold) return { action: "auto", reason: `confidence ${confidence.toFixed(2)} >= ${threshold}` };
  return { action: "escalate", reason: `confidence ${confidence.toFixed(2)} < ${threshold} \u2014 escalate to LLM/human for rationale` };
}
function gateNoul(noul, threshold = DEFAULT_THRESHOLDS.noul) {
  const conf = Math.max(noul, 1 - noul);
  if (conf >= threshold) return { action: "auto", reason: `noul ${noul.toFixed(2)} (conf ${conf.toFixed(2)}) >= ${threshold}` };
  return { action: "escalate", reason: `noul ${noul.toFixed(2)} (conf ${conf.toFixed(2)}) < ${threshold} \u2014 ambiguous, ask LLM/human` };
}
function gateScore(confidence, threshold = DEFAULT_THRESHOLDS.score) {
  if (confidence >= threshold) return { action: "auto", reason: `score conf ${confidence.toFixed(2)} >= ${threshold}` };
  return { action: "escalate", reason: `score conf ${confidence.toFixed(2)} < ${threshold} \u2014 low certainty rubric` };
}
function gateGuardrail(noul, safeThreshold = DEFAULT_THRESHOLDS.guardrail) {
  const pSafe = 1 - noul;
  if (pSafe >= safeThreshold) return { action: "auto", reason: `P(safe) ${pSafe.toFixed(2)} >= ${safeThreshold} \u2014 allow` };
  return { action: "escalate", reason: `P(safe) ${pSafe.toFixed(2)} < ${safeThreshold} \u2014 ask before running` };
}
function gateGuardrailFlags(flags, safeThreshold = DEFAULT_THRESHOLDS.guardrail) {
  const values = (Array.isArray(flags) ? flags : Object.values(flags)).filter((v) => typeof v === "number");
  if (!values.length) return { action: "escalate", reason: "no guardrail flags supplied \u2014 ask" };
  return gateGuardrail(Math.max(...values), safeThreshold);
}
function gateAnswer(answer, threshold) {
  if (answer.type === "choice") return gateChoice(answer.confidence ?? 0, threshold);
  if (answer.type === "noul") return gateNoul(answer.noul ?? 0.5, threshold);
  if (answer.type === "score") return gateScore(answer.confidence ?? 0, threshold);
  return { action: "auto", reason: "unknown type" };
}

export {
  DEFAULT_THRESHOLDS,
  gateChoice,
  gateNoul,
  gateScore,
  gateGuardrail,
  gateGuardrailFlags,
  gateAnswer
};
