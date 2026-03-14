import assert from "node:assert/strict";
import test from "node:test";
import { IntentSemanticRouter } from "../../intent-semantic-router.js";
import { buildIntentRouterContextFilter } from "./context-filter.js";
import { buildHierarchicalIntentDecision } from "./hierarchical.js";
import { parseIndexedListReferenceIntent } from "./indexed-list-intent.js";
import { resolveBaseSemanticRouting, type ChatScopedRouterLike, type NaturalIntentRouteName } from "./natural-routing-core.js";
import { applyIntentRouteLayers } from "./route-layers.js";

function normalizeIntentText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
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

function buildRouterForTest(): ChatScopedRouterLike {
  const router = new IntentSemanticRouter();
  return {
    router,
    abVariant: "A",
    canaryVersionId: null,
    effectiveAlpha: router.getHybridAlpha(),
    effectiveMinGap: router.getMinScoreGap(),
  };
}

function resolveForText(text: string) {
  return resolveBaseSemanticRouting(
    {
      chatId: 0,
      text,
      normalizedText: normalizeIntentText(text),
      handlerNames: ["self-maintenance", "schedule", "memory", "gmail-recipients", "gmail", "workspace", "document", "web"],
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
          parseIndexedListReferenceIntent: (value) => parseIndexedListReferenceIntent(value, normalizeIntentText),
          getIndexedListContext: () => null,
          getPendingWorkspaceDelete: () => null,
          getPendingWorkspaceDeletePath: () => null,
          getLastGmailResultsCount: () => 0,
          getLastListedFilesCount: () => 0,
        }),
      buildIntentRouterScoreBoosts: () => ({}),
      buildIntentRouterForChat: () => buildRouterForTest(),
      alphaOverrides: {},
    },
  );
}

test("shared semantic routing resolves self-maintenance cues", () => {
  const resolution = resolveForText("crea una skill nueva para resumir PRs");
  assert.equal(resolution.semanticRouteDecision?.handler, "self-maintenance");
  assert.deepEqual(resolution.semanticAllowedCandidates, ["self-maintenance"]);
});

test("shared semantic routing preserves document/file narrowing", () => {
  const resolution = resolveForText("resumi el contrato pdf del workspace");
  assert.ok(resolution.semanticAllowedCandidates.includes("workspace"));
  assert.ok(resolution.semanticAllowedCandidates.includes("document"));
  assert.ok(
    resolution.semanticRouteDecision?.handler === "document" || resolution.semanticRouteDecision?.handler === "workspace",
  );
});
