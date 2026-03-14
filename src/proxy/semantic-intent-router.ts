import { buildIntentRouterContextFilter } from "../domains/router/context-filter.js";
import { buildHierarchicalIntentDecision } from "../domains/router/hierarchical.js";
import { parseIndexedListReferenceIntent } from "../domains/router/indexed-list-intent.js";
import {
  resolveBaseSemanticRouting,
  type ChatScopedRouterLike,
  type NaturalIntentRouteName,
  type RouterScoreBoosts,
} from "../domains/router/natural-routing-core.js";
import { applyIntentRouteLayers } from "../domains/router/route-layers.js";
import { IntentSemanticRouter } from "../intent-semantic-router.js";
import { normalizeIntentText } from "./intent-text.js";

type ProxyIntentDomain = "self-maintenance" | "schedule" | "gmail" | "workspace" | "web" | "memory" | "general";

type ResolveSemanticIntentDomainParams = {
  rawText: string;
  normalizedText: string;
  domainBias: Partial<Record<ProxyIntentDomain, number>>;
  shadow: boolean;
};

type ResolveSemanticIntentDomainResult = {
  scores: Record<ProxyIntentDomain, number>;
  reasons: string[];
};

const PROXY_ROUTE_NAMES: NaturalIntentRouteName[] = [
  "self-maintenance",
  "schedule",
  "memory",
  "gmail-recipients",
  "gmail",
  "workspace",
  "document",
  "web",
];

const ROUTE_TO_DOMAIN: Record<NaturalIntentRouteName, ProxyIntentDomain> = {
  "self-maintenance": "self-maintenance",
  schedule: "schedule",
  memory: "memory",
  "gmail-recipients": "gmail",
  gmail: "gmail",
  workspace: "workspace",
  document: "workspace",
  web: "web",
};

const PROXY_DOMAIN_LIST: ProxyIntentDomain[] = ["self-maintenance", "schedule", "gmail", "workspace", "web", "memory", "general"];

const semanticRouter = new IntentSemanticRouter();

function createDomainScores(): Record<ProxyIntentDomain, number> {
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

function narrowRouteCandidates(
  candidates: NaturalIntentRouteName[],
  allowed: NaturalIntentRouteName[],
  options?: { strict?: boolean },
): { allowed: NaturalIntentRouteName[]; exhausted: boolean } {
  const allowedSet = new Set(allowed);
  const next = candidates.filter((candidate) => allowedSet.has(candidate));
  if (next.length > 0) {
    return { allowed: next, exhausted: false };
  }
  if (options?.strict) {
    return { allowed: [], exhausted: true };
  }
  return { allowed: candidates, exhausted: false };
}

function buildIntentRouterForProxy(): ChatScopedRouterLike {
  return {
    router: semanticRouter,
    abVariant: "A",
    canaryVersionId: null,
    effectiveAlpha: semanticRouter.getHybridAlpha(),
    effectiveMinGap: semanticRouter.getMinScoreGap(),
  };
}

function buildRouteBoosts(domainBias: Partial<Record<ProxyIntentDomain, number>>, shadow: boolean): RouterScoreBoosts {
  const boosts: RouterScoreBoosts = {};
  const shadowFactor = shadow ? 0.88 : 1;
  const addBoost = (route: NaturalIntentRouteName, value: number) => {
    boosts[route] = (boosts[route] ?? 0) + value * shadowFactor;
  };

  for (const domain of PROXY_DOMAIN_LIST) {
    const bias = domainBias[domain];
    if (typeof bias !== "number" || !Number.isFinite(bias) || Math.abs(bias) < 0.001) {
      continue;
    }
    if (domain === "gmail") {
      addBoost("gmail", bias);
      addBoost("gmail-recipients", bias * 0.9);
    } else if (domain === "workspace") {
      addBoost("workspace", bias);
      addBoost("document", bias * 0.85);
    } else if (domain === "self-maintenance") {
      addBoost("self-maintenance", bias);
    } else if (domain !== "general") {
      addBoost(domain, bias);
    }
  }
  return boosts;
}

function addRouteWeight(scores: Record<ProxyIntentDomain, number>, route: NaturalIntentRouteName, value: number): void {
  const domain = ROUTE_TO_DOMAIN[route];
  scores[domain] += value;
}

function addAllowedWeights(
  scores: Record<ProxyIntentDomain, number>,
  routes: NaturalIntentRouteName[],
  value: number,
): void {
  for (const route of routes) {
    addRouteWeight(scores, route, value);
  }
}

function uniqueDomains(routes: NaturalIntentRouteName[]): ProxyIntentDomain[] {
  return Array.from(new Set(routes.map((route) => ROUTE_TO_DOMAIN[route])));
}

export function resolveSemanticIntentDomain(params: ResolveSemanticIntentDomainParams): ResolveSemanticIntentDomainResult {
  const resolution = resolveBaseSemanticRouting(
    {
      chatId: 0,
      text: params.rawText,
      normalizedText: params.normalizedText,
      handlerNames: PROXY_ROUTE_NAMES,
    },
    {
      getIndexedListKind: () => null,
      hasPendingWorkspaceDeleteConfirmation: () => false,
      applyIntentRouteLayers,
      narrowRouteCandidates,
      buildHierarchicalIntentDecision,
      buildIntentRouterContextFilter: (input) =>
        buildIntentRouterContextFilter(input, {
          normalizeIntentText,
          parseIndexedListReferenceIntent: (text) => parseIndexedListReferenceIntent(text, normalizeIntentText),
          getIndexedListContext: () => null,
          getPendingWorkspaceDelete: () => null,
          getPendingWorkspaceDeletePath: () => null,
          getLastGmailResultsCount: () => 0,
          getLastListedFilesCount: () => 0,
        }),
      buildIntentRouterScoreBoosts: () => buildRouteBoosts(params.domainBias, params.shadow),
      buildIntentRouterForChat: () => buildIntentRouterForProxy(),
      alphaOverrides: {},
    },
  );

  const scores = createDomainScores();
  const reasons: string[] = [];
  const shadowFactor = params.shadow ? 0.88 : 1;
  const weighted = (value: number) => value * shadowFactor;
  const hasSemanticNarrowing =
    Boolean(resolution.routerLayerDecision) || Boolean(resolution.effectiveHierarchyDecision) || Boolean(resolution.routeFilterDecision);

  if (resolution.routerLayerDecision) {
    reasons.push(`semantic_layer=${resolution.routerLayerDecision.reason}`);
    addAllowedWeights(scores, resolution.layerAllowedCandidates, weighted(resolution.routerLayerDecision.strict ? 0.3 : 0.14));
  }

  if (resolution.effectiveHierarchyDecision) {
    reasons.push(`semantic_hierarchy=${resolution.effectiveHierarchyDecision.reason}`);
    addAllowedWeights(
      scores,
      resolution.hierarchyAllowedCandidates,
      weighted(resolution.effectiveHierarchyDecision.strict ? 0.26 : 0.12),
    );
  }

  if (resolution.routeFilterDecision) {
    reasons.push(`semantic_context=${resolution.routeFilterDecision.reason}`);
    addAllowedWeights(
      scores,
      resolution.semanticAllowedCandidates,
      weighted(resolution.routeFilterDecision.strict ? 0.32 : 0.16),
    );
  }

  if (resolution.semanticRouteDecision) {
    reasons.push(
      `semantic_top=${resolution.semanticRouteDecision.handler}:${resolution.semanticRouteDecision.score.toFixed(3)}`,
      `semantic_reason=${resolution.semanticRouteDecision.reason}`,
    );
    for (const alternative of resolution.semanticRouteDecision.alternatives) {
      addRouteWeight(scores, alternative.name as NaturalIntentRouteName, weighted(alternative.score * 3.25));
    }
    addRouteWeight(scores, resolution.semanticRouteDecision.handler as NaturalIntentRouteName, weighted(1.15));
  } else if (resolution.semanticAllowedCandidates.length > 0) {
    const narrowedDomains = uniqueDomains(resolution.semanticAllowedCandidates);
    if (narrowedDomains.length === 1) {
      scores[narrowedDomains[0]] += weighted(1.1);
      reasons.push(`semantic_allowed=${narrowedDomains[0]}`);
    } else if (hasSemanticNarrowing || resolution.hasMailContext || resolution.hasMemoryRecallCue) {
      addAllowedWeights(scores, resolution.semanticAllowedCandidates, weighted(0.18));
      reasons.push(`semantic_candidates=${narrowedDomains.join(",")}`);
    }
  }

  if (resolution.strictNarrowingExhausted) {
    scores.general += weighted(0.2);
    reasons.push("semantic_narrowing_exhausted");
  }

  return { scores, reasons };
}
