import { DomainActionRegistry } from "../action-registry.js";
import { buildSemanticReferencesFromBundle } from "./shared.js";
import type { ProxyActionRegistryContext, ProxyActionRegistryDeps } from "./types.js";

export function createProxyActionRegistry(deps: ProxyActionRegistryDeps): DomainActionRegistry<ProxyActionRegistryContext> {
  return new DomainActionRegistry<ProxyActionRegistryContext>([
    {
      id: "schedule-natural",
      canHandle: (bundle) => bundle.suggestedExecutor === "deterministic" && bundle.domain === "schedule",
      execute: async (context) => {
        const outcome = await deps.maybeHandleNaturalScheduleInstruction({
          chatId: context.chatId,
          userId: context.userId,
          text: context.bundle.objectiveText,
          reply: context.reply,
        });
        if (outcome) {
          deps.updateSemanticReferences({
            store: deps.objectiveState,
            chatId: context.chatId,
            references: buildSemanticReferencesFromBundle(context.bundle),
          });
        }
        return outcome;
      },
    },
    {
      id: "domain-direct",
      canHandle: (bundle) => bundle.suggestedExecutor === "deterministic" && bundle.domain !== "schedule",
      execute: async (context) => {
        const outcome = await deps.handleDeterministicIntent({
          chatId: context.chatId,
          userId: context.userId,
          activeAgent: context.activeAgent,
          objectiveRaw: context.bundle.objectiveText,
          intent: context.bundle.intent,
          runId: context.runId,
          reply: context.reply,
          objectiveSignal: context.objectiveSignal,
        });
        if (outcome) {
          deps.updateSemanticReferences({
            store: deps.objectiveState,
            chatId: context.chatId,
            references: buildSemanticReferencesFromBundle(context.bundle),
          });
        }
        return outcome;
      },
    },
  ]);
}
