import { analyzeIntentSignals, resolveIntentActionAndEntities } from "./intent-semantics.js";
import { resolveSemanticIntentDomain } from "./semantic-intent-router.js";
import { normalizeIntentText, stripQuotedExecutionNoise } from "./intent-text.js";
import type { IntentAbstention, IntentDomain, IntentEntities, IntentIr } from "./intent-types.js";

export type { IntentAbstention, IntentAction, IntentDomain, IntentEntities, IntentIr } from "./intent-types.js";

type BuildIntentIrOptions = {
  domainBias?: Partial<Record<IntentDomain, number>>;
  shadow?: boolean;
};

const DOMAIN_LIST: IntentDomain[] = ["self-maintenance", "schedule", "gmail", "workspace", "web", "memory", "general"];

function roundConfidence(value: number): number {
  const bounded = Math.max(0, Math.min(1, value));
  return Math.round(bounded * 1000) / 1000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function createZeroScores(): Record<IntentDomain, number> {
  return {
    "self-maintenance": 0,
    schedule: 0,
    gmail: 0,
    workspace: 0,
    web: 0,
    memory: 0,
    general: 0,
  };
}

function scoreLexicalDomains(params: {
  normalized: string;
  entities: IntentEntities;
  analysis: ReturnType<typeof analyzeIntentSignals>;
}): Record<IntentDomain, number> {
  const scores = createZeroScores();
  scores.general = 0.5;

  if (params.analysis.selfMaintenanceIntent.shouldHandle) {
    scores["self-maintenance"] += 2.8;
  }
  if (params.entities.hasTaskCue) {
    scores.schedule += 2.2;
  }
  if (params.entities.hasTemporalCue) {
    scores.schedule += 1.6;
  }
  if (params.analysis.scheduleIntent.shouldHandle) {
    scores.schedule += 2.4;
  }

  if (params.entities.hasMailCue) {
    scores.gmail += 2.1;
  }
  if (params.entities.emails.length > 0) {
    scores.gmail += 1.8;
  }
  if (params.analysis.gmailIntent.shouldHandle || params.analysis.gmailRecipientIntent.shouldHandle) {
    scores.gmail += 2.1;
  }
  if (
    params.analysis.scheduleIntent.shouldHandle &&
    params.entities.hasTemporalCue &&
    params.analysis.gmailIntent.shouldHandle &&
    ["list", "read", "status", "profile"].includes(params.analysis.gmailIntent.action ?? "")
  ) {
    scores.schedule += 1.8;
    scores.gmail = Math.max(0, scores.gmail - 0.9);
  }

  if (params.entities.hasWorkspaceCue) {
    scores.workspace += 2.3;
  }
  if (params.analysis.workspaceIntent.shouldHandle) {
    scores.workspace += 2;
  }

  if (params.entities.hasWebCue) {
    scores.web += 2.2;
  }
  if (/\b(noticias|internet|web|google|buscar|url|link)\b/.test(params.normalized)) {
    scores.web += 1.4;
  }

  if (/\b(acordas|acuerdas|memoria|recordas que|habiamos hablado|hablamos de|te acordas|te acuerdas)\b/.test(params.normalized)) {
    scores.memory += 2.2;
  }
  if (/\b(busca en memoria|que recuerdas|que sabes de)\b/.test(params.normalized)) {
    scores.memory += 1.3;
  }

  return scores;
}

function mergeDomainScores(...vectors: Array<Record<IntentDomain, number>>): Record<IntentDomain, number> {
  const merged = createZeroScores();
  for (const vector of vectors) {
    for (const domain of DOMAIN_LIST) {
      merged[domain] += vector[domain] ?? 0;
    }
  }
  return merged;
}

function applyDomainBiasAndShadow(
  scores: Record<IntentDomain, number>,
  domainBias: Partial<Record<IntentDomain, number>>,
  shadow: boolean,
): Record<IntentDomain, number> {
  const shadowFactor = shadow ? 0.88 : 1;
  const next = createZeroScores();
  for (const domain of DOMAIN_LIST) {
    next[domain] = scores[domain] * shadowFactor + (domainBias[domain] ?? 0);
  }
  return next;
}

function resolveDomain(scores: Record<IntentDomain, number>): {
  domain: IntentDomain;
  ambiguousDomains: IntentDomain[];
  confidence: number;
} {
  const ranked = [...DOMAIN_LIST]
    .map((domain) => ({ domain, score: scores[domain] ?? 0 }))
    .sort((a, b) => b.score - a.score);

  const top = ranked[0] ?? { domain: "general" as IntentDomain, score: 0 };
  const second = ranked[1] ?? { domain: "general" as IntentDomain, score: 0 };
  const total = ranked.reduce((acc, item) => acc + Math.max(0, item.score), 0);
  const gap = top.score - second.score;
  let confidence = total > 0 ? top.score / total : 0.4;
  if (gap <= 0.35) {
    confidence -= 0.18;
  } else if (gap <= 0.8) {
    confidence -= 0.08;
  }
  confidence = clamp(confidence, 0.05, 0.98);

  const ambiguousDomains = ranked.filter((item) => top.score - item.score <= 0.45).map((item) => item.domain);
  return {
    domain: top.domain,
    ambiguousDomains,
    confidence: roundConfidence(confidence),
  };
}

export { normalizeIntentText, stripQuotedExecutionNoise };

export function buildIntentIr(rawText: string, options: BuildIntentIrOptions = {}): IntentIr {
  const source = stripQuotedExecutionNoise(rawText);
  const normalized = normalizeIntentText(source);
  const domainBias = options.domainBias ?? {};
  const shadow = Boolean(options.shadow);

  const analysis = analyzeIntentSignals(source);
  const baseEntities: IntentEntities = {
    emails: [...analysis.signals.emails],
    hasTemporalCue: analysis.signals.hasTemporalCue,
    hasTaskCue: analysis.signals.hasTaskCue,
    hasMailCue: analysis.signals.hasMailCue,
    hasWorkspaceCue: analysis.signals.hasWorkspaceCue,
    hasWebCue: analysis.signals.hasWebCue,
    ...(analysis.signals.taskRef ? { taskRef: analysis.signals.taskRef } : {}),
  };

  const lexicalScores = scoreLexicalDomains({
    normalized,
    entities: baseEntities,
    analysis,
  });
  const semanticScores = resolveSemanticIntentDomain({
    rawText: source,
    normalizedText: normalized,
    domainBias,
    shadow,
  });
  const scores = applyDomainBiasAndShadow(mergeDomainScores(lexicalScores, semanticScores.scores), domainBias, shadow);
  const domainResolved = resolveDomain(scores);
  const semanticResolution = resolveIntentActionAndEntities({
    domain: domainResolved.domain,
    analysis,
  });

  const reasons = [
    `action=${semanticResolution.action}`,
    ...semanticResolution.reasons.slice(0, 3),
    ...semanticScores.reasons.slice(0, 4),
    ...Object.entries(scores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([domain, score]) => `${domain}:${score.toFixed(2)}`),
  ];

  return {
    domain: domainResolved.domain,
    action: semanticResolution.action,
    confidence: domainResolved.confidence,
    reasons,
    ambiguousDomains: domainResolved.ambiguousDomains,
    entities: semanticResolution.entities,
  };
}

export function shouldAbstainIntent(intent: IntentIr, threshold: number): IntentAbstention {
  const riskyAction = ["create", "delete", "edit", "send"].includes(intent.action);
  const hasRelevantScheduleMailSignals =
    intent.domain === "schedule" ||
    intent.domain === "gmail" ||
    intent.entities.hasTemporalCue ||
    intent.entities.hasTaskCue ||
    intent.entities.hasMailCue ||
    intent.action === "send";
  const hasConflict =
    hasRelevantScheduleMailSignals &&
    intent.ambiguousDomains.length >= 2 &&
    intent.ambiguousDomains.includes("schedule") &&
    intent.ambiguousDomains.includes("gmail");
  if (!riskyAction && !hasConflict) {
    return { abstain: false };
  }
  if (intent.confidence >= threshold && !hasConflict) {
    return { abstain: false };
  }
  if (hasConflict) {
    return {
      abstain: true,
      reason: "conflicto_schedule_vs_gmail",
      clarification:
        "¿Querés que lo programe como recordatorio interno (tarea) o como envío de email programado?",
    };
  }
  return {
    abstain: true,
    reason: `baja_confianza_${intent.confidence}`,
    clarification: "No estoy 100% seguro de la intención. ¿Querés que ejecute esta acción tal cual o la ajustamos?",
  };
}
