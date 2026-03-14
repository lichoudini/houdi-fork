import { throwIfAborted } from "./abort-utils.js";
import { buildDeterministicClarification } from "./agentic-helpers.js";
import { createGmailDeterministicHandler } from "./domain-actions/gmail-handler.js";
import { createProxyActionRegistry } from "./domain-actions/registry.js";
import { createNaturalScheduleHandler } from "./domain-actions/schedule-handler.js";
import { buildSemanticReferencesFromBundle } from "./domain-actions/shared.js";
import type { DeterministicIntentHandlerDeps, DeterministicIntentHandler } from "./domain-actions/types.js";
import { createWebDeterministicHandler } from "./domain-actions/web-handler.js";
import { createWorkspaceDeterministicHandler } from "./domain-actions/workspace-handler.js";

export type {
  DeterministicIntentParams,
  DeterministicIntentHandler,
  NaturalScheduleHandler,
  ProxyActionRegistryContext,
} from "./domain-actions/types.js";
export { buildSemanticReferencesFromBundle, createNaturalScheduleHandler, createProxyActionRegistry };

export function createDeterministicIntentHandler(deps: DeterministicIntentHandlerDeps): DeterministicIntentHandler {
  const gmailHandler = createGmailDeterministicHandler(deps);
  const workspaceHandler = createWorkspaceDeterministicHandler(deps);
  const webHandler = createWebDeterministicHandler(deps);

  return async (params) => {
    if (params.intent.domain === "general" || params.intent.domain === "memory") {
      return null;
    }

    const replyAndRemember = async (text: string, source: string): Promise<void> => {
      await deps.replyLong(params.reply, text);
      await deps.rememberAssistant({
        chatId: params.chatId,
        userId: params.userId,
        text,
        source,
      });
    };

    const clarification = buildDeterministicClarification(params.intent);
    if (clarification) {
      deps.objectiveState.updatePhase({
        chatId: params.chatId,
        runId: params.runId,
        phase: "clarify",
        message: "deterministic_clarification",
      });
      await replyAndRemember(clarification, "proxy-telegram:deterministic-clarify");
      return {
        status: "incomplete",
        summary: clarification,
        reason: "deterministic_clarification",
      };
    }

    throwIfAborted(params.objectiveSignal);
    await deps.replyProgress({
      chatId: params.chatId,
      reply: params.reply,
      phase: "executing",
      text: "Voy directo a resolverlo.",
    });
    deps.objectiveState.updatePhase({
      chatId: params.chatId,
      runId: params.runId,
      phase: "executing",
      message: `deterministic:${params.intent.domain}:${params.intent.action}`,
    });

    const context = {
      ...params,
      objectiveState: deps.objectiveState,
      replyAndRemember,
    };

    return (await gmailHandler(context)) ?? (await workspaceHandler(context)) ?? (await webHandler(context));
  };
}
