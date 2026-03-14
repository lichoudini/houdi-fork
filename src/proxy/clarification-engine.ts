import type { InterpretationBundle } from "./interpretation-bundle.js";
import type {
  ProxyObjectiveStateStore,
  SemanticConversationState,
  SemanticReferenceState,
} from "./objective-state.js";

export function buildClarificationAwareObjective(params: {
  rawText: string;
  semanticState?: SemanticConversationState | null;
}): { objectiveText: string; mergedFromClarification: boolean } {
  const rawText = params.rawText.trim();
  const semanticState = params.semanticState;
  if (!semanticState?.awaitingClarification || !semanticState.baseObjective?.trim()) {
    return {
      objectiveText: rawText,
      mergedFromClarification: false,
    };
  }
  const nextObjective = [
    semanticState.baseObjective.trim(),
    "",
    "Aclaracion del usuario:",
    rawText,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    objectiveText: nextObjective,
    mergedFromClarification: true,
  };
}

export function persistInterpretationBundle(params: {
  store: ProxyObjectiveStateStore;
  chatId: number;
  rawText: string;
  bundle: InterpretationBundle;
}): void {
  params.store.upsertSemanticState({
    chatId: params.chatId,
    activeDomain: params.bundle.domain,
    activeAction: params.bundle.action,
    baseObjective: params.bundle.suggestedExecutor === "clarify" ? params.bundle.objectiveText : params.bundle.rawText,
    awaitingClarification: params.bundle.suggestedExecutor === "clarify",
    clarificationQuestion: params.bundle.clarificationQuestion ?? "",
    pendingSlots: params.bundle.missingSlots,
    candidateInterpretations: params.bundle.candidates,
    slotValues: params.bundle.slotValues,
    lastExecutor: params.bundle.suggestedExecutor,
  });
}

export function clearClarificationAfterAction(store: ProxyObjectiveStateStore, chatId: number): void {
  store.clearSemanticClarification(chatId);
}

export function updateSemanticReferences(params: {
  store: ProxyObjectiveStateStore;
  chatId: number;
  references: SemanticReferenceState;
}): void {
  params.store.upsertSemanticState({
    chatId: params.chatId,
    references: params.references,
  });
}
