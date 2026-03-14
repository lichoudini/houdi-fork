import type { SemanticRouteDecision } from "../intent-semantic-router.js";
import {
  resolveBaseSemanticRouting,
  type BaseSemanticRoutingResolution,
  type ChatScopedRouterLike,
  type HierarchicalIntentDecisionLike,
  type IntentRouterFilterDecision,
  type NaturalIntentRouteName,
  type RouteLayerDecisionLike,
  type RouterScoreBoosts,
} from "../domains/router/natural-routing-core.js";

export type {
  ChatScopedRouterLike,
  HierarchicalIntentDecisionLike,
  IntentRouterFilterDecision,
  NaturalIntentRouteName,
  RouteLayerDecisionLike,
  RouterScoreBoosts,
} from "../domains/router/natural-routing-core.js";

export type NaturalIntentHandlerName = NaturalIntentRouteName | "none";
export type RoutingResolution = BaseSemanticRoutingResolution & {
  semanticCalibratedConfidence: number | null;
  semanticGap: number | null;
  shadowRouteDecision: SemanticRouteDecision | null;
  aiRouteDecision: { handler: NaturalIntentHandlerName; reason?: string } | null;
  ensembleTop: Array<{ name: NaturalIntentRouteName; score: number }>;
  routedHandlerNames: NaturalIntentRouteName[];
  chatScopedRouterMeta: {
    effectiveAlpha: number;
    effectiveMinGap: number;
  };
};

export type ResolveNaturalIntentRoutingDeps = {
  getIndexedListKind: (chatId: number) => "workspace-list" | "stored-files" | "web-results" | "gmail-list" | null;
  hasPendingWorkspaceDeleteConfirmation: (chatId: number) => boolean;
  applyIntentRouteLayers: (
    candidates: NaturalIntentRouteName[],
    params: {
      normalizedText: string;
      hasMailContext: boolean;
      hasMemoryRecallCue: boolean;
      indexedListKind: "workspace-list" | "stored-files" | "web-results" | "gmail-list" | null;
      hasPendingWorkspaceDelete: boolean;
    },
  ) => RouteLayerDecisionLike | null;
  narrowRouteCandidates: (
    candidates: NaturalIntentRouteName[],
    allowed: NaturalIntentRouteName[],
    options?: { strict?: boolean },
  ) => { allowed: NaturalIntentRouteName[]; exhausted: boolean };
  buildHierarchicalIntentDecision: (params: {
    normalizedText: string;
    candidates: NaturalIntentRouteName[];
    hasMailContext: boolean;
    hasMemoryRecallCue: boolean;
    indexedListKind: "workspace-list" | "stored-files" | "web-results" | "gmail-list" | null;
    hasPendingWorkspaceDelete: boolean;
  }) => HierarchicalIntentDecisionLike | null;
  buildIntentRouterContextFilter: (params: {
    chatId: number;
    text: string;
    candidates: NaturalIntentRouteName[];
    hasMailContext: boolean;
    hasMemoryRecallCue: boolean;
  }) => IntentRouterFilterDecision | null;
  buildIntentRouterScoreBoosts: (params: {
    chatId: number;
    text: string;
    hasMailContext: boolean;
    hasMemoryRecallCue: boolean;
  }) => RouterScoreBoosts;
  buildIntentRouterForChat: (chatId: number) => ChatScopedRouterLike;
  alphaOverrides: Record<string, number>;
  calibrateConfidence: (handler: string, score: number) => number;
  shouldRunIntentShadowMode: (chatId: number, text: string) => boolean;
  runShadowRoute: (params: {
    text: string;
    allowed: NaturalIntentRouteName[];
    boosts: RouterScoreBoosts;
    alphaOverrides: Record<string, number>;
    topK: number;
  }) => SemanticRouteDecision | null;
  shouldRunAiJudgeForEnsemble: (decision: SemanticRouteDecision | null) => boolean;
  classifyNaturalIntentRouteWithAi: (params: {
    chatId: number;
    text: string;
    candidates: NaturalIntentRouteName[];
  }) => Promise<{ handler: NaturalIntentHandlerName; reason?: string } | null>;
  rankIntentCandidatesWithEnsemble: (params: {
    candidates: NaturalIntentRouteName[];
    semanticAlternatives?: Array<{ name: string; score: number }>;
    aiSelected: NaturalIntentRouteName | null;
    layerAllowed: NaturalIntentRouteName[];
    contextualBoosts: RouterScoreBoosts;
    calibratedConfidence: number | null;
  }) => Array<{ name: string; score: number }>;
};

export async function resolveNaturalIntentRouting(
  params: {
    chatId: number;
    text: string;
    normalizedText: string;
    handlerNames: NaturalIntentRouteName[];
  },
  deps: ResolveNaturalIntentRoutingDeps,
): Promise<RoutingResolution> {
  const baseResolution = resolveBaseSemanticRouting(params, {
    getIndexedListKind: deps.getIndexedListKind,
    hasPendingWorkspaceDeleteConfirmation: deps.hasPendingWorkspaceDeleteConfirmation,
    applyIntentRouteLayers: deps.applyIntentRouteLayers,
    narrowRouteCandidates: deps.narrowRouteCandidates,
    buildHierarchicalIntentDecision: deps.buildHierarchicalIntentDecision,
    buildIntentRouterContextFilter: deps.buildIntentRouterContextFilter,
    buildIntentRouterScoreBoosts: deps.buildIntentRouterScoreBoosts,
    buildIntentRouterForChat: deps.buildIntentRouterForChat,
    alphaOverrides: deps.alphaOverrides,
  });

  let semanticGap: number | null = null;
  let semanticCalibratedConfidence: number | null = null;
  if (baseResolution.semanticRouteDecision) {
    const second = baseResolution.semanticRouteDecision.alternatives[1];
    semanticGap = second ? baseResolution.semanticRouteDecision.score - second.score : null;
    semanticCalibratedConfidence = deps.calibrateConfidence(
      baseResolution.semanticRouteDecision.handler,
      baseResolution.semanticRouteDecision.score,
    );
  }

  const shadowRouteDecision =
    baseResolution.semanticAllowedCandidates.length > 0 && deps.shouldRunIntentShadowMode(params.chatId, params.text)
      ? deps.runShadowRoute({
          text: params.text,
          allowed: baseResolution.semanticAllowedCandidates,
          boosts: baseResolution.routeScoreBoosts,
          alphaOverrides: deps.alphaOverrides,
          topK: 5,
        })
      : null;

  const aiRouteDecision = deps.shouldRunAiJudgeForEnsemble(baseResolution.semanticRouteDecision)
    ? await deps.classifyNaturalIntentRouteWithAi({
        chatId: params.chatId,
        text: params.text,
        candidates: baseResolution.semanticAllowedCandidates,
      })
    : null;

  const ranked = deps.rankIntentCandidatesWithEnsemble({
    candidates: baseResolution.semanticAllowedCandidates,
    semanticAlternatives: baseResolution.semanticRouteDecision?.alternatives,
    aiSelected:
      aiRouteDecision?.handler && aiRouteDecision.handler !== "none" ? (aiRouteDecision.handler as NaturalIntentRouteName) : null,
    layerAllowed: baseResolution.layerAllowedCandidates,
    contextualBoosts: baseResolution.routeScoreBoosts,
    calibratedConfidence: semanticCalibratedConfidence,
  });

  const ensembleTop = ranked
    .map((item) => ({
      name: item.name as NaturalIntentRouteName,
      score: item.score,
    }))
    .slice(0, 5);

  const routedHandlerNames = (() => {
    if (ensembleTop.length === 0) {
      return baseResolution.routeCandidates;
    }
    const ordered = ensembleTop.map((item) => item.name);
    const used = new Set(ordered);
    return [...ordered, ...baseResolution.routeCandidates.filter((name) => !used.has(name))];
  })();

  return {
    ...baseResolution,
    semanticCalibratedConfidence,
    semanticGap,
    shadowRouteDecision,
    aiRouteDecision,
    ensembleTop,
    routedHandlerNames,
  };
}
