import { randomUUID } from "node:crypto";
import type { AgentCapability } from "../agent-policy.js";
import type { AgentProfile } from "../agents.js";
import { abortReasonToText, composeAbortSignal, isAbortError, throwIfAborted } from "./abort-utils.js";
import { deriveObjectiveSlots } from "./agentic-helpers.js";
import type { ActionOutcome } from "./action-registry.js";
import {
  buildClarificationAwareObjective,
  clearClarificationAfterAction,
  persistInterpretationBundle,
} from "./clarification-engine.js";
import { critiquePlannedCommands } from "./intent-critic.js";
import { buildIntentIr, shouldAbstainIntent, stripQuotedExecutionNoise } from "./intent-ir.js";
import { buildIntentPlannerContextBlock, buildRetryPlannerObjective, shouldRetryPlannerReply } from "./intent-planning.js";
import { buildInterpretationBundle } from "./interpretation-bundle.js";
import { nextLoopGuardState } from "./loop-guard.js";
import type { ObjectivePhase, ProxyObjectiveStateStore } from "./objective-state.js";
import type { ProxyCapabilityPolicy } from "./capability-policy.js";
import type { ExecutedCommand, PlannerResponse } from "./types.js";
import { buildPhaseIntroText, buildVisiblePlanText } from "./user-facing.js";
import { resolveWorkspaceHashtagsInText } from "./workspace-listing.js";
import type { ProxyActionRegistryContext } from "./domain-action-handlers.js";

export type ObjectiveRunController = {
  runId: string;
  controller: AbortController;
  objectiveRaw: string;
  startedAtMs: number;
};

export type ObjectiveExecutionResult = {
  status: "success" | "blocked" | "incomplete";
  summary: string;
};

export type ObjectiveExecutionParams = {
  chatId: number;
  userId?: number;
  activeAgent: AgentProfile;
  objectiveRaw: string;
  reply: (text: string) => Promise<unknown>;
  plannerAttachmentHint?: string;
  rememberUserSource?: string;
  approvedCapabilities?: Set<AgentCapability>;
};

type MemoryLike = {
  recallForObjective: (params: { objective: string; chatId: number }) => Promise<unknown[]>;
  getRecentConversation: (params: { chatId: number; limit: number }) => Promise<unknown[]>;
} | null;

type PlannerLike = {
  plan: (params: any) => Promise<PlannerResponse>;
};

type ExecutorLike = {
  runSequence: (
    agent: AgentProfile,
    commands: string[],
    options?: { abortSignal?: AbortSignal },
  ) => Promise<ExecutedCommand[]>;
};

type VerifierLike = {
  verify: (params: any) => Promise<{ status: "success" | "continue" | "blocked"; summary: string }>;
};

type IntentBiasStoreLike = {
  getDomainBias: (chatId: number) => Record<string, number>;
  recordOutcome: (params: any) => Promise<void>;
};

type TelemetryAlert = {
  scope: string;
  failureRate: number;
  threshold: number;
  sampleSize: number;
  windowSize: number;
};

type IntentTelemetryLike = {
  recordDecision: (params: any) => Promise<void>;
  recordOutcome: (params: any) => Promise<void>;
  getSloAlert: (domain?: any) => TelemetryAlert | null;
};

type WebApiLike = {
  plannerContext: any;
} | null;

export type ObjectiveExecutionConfig = {
  intentShadowEnabled: boolean;
  deterministicRoutingThreshold: number;
  objectiveMaxMs: number;
  intentAbstainThreshold: number;
  recentConversationTurns: number;
  maxIterations: number;
  plannerTimeoutMs: number;
  intentCriticEnabled: boolean;
  maxCommandsTotal: number;
  verifierTimeoutMs: number;
};

export type ObjectiveExecutionDeps = {
  config: ObjectiveExecutionConfig;
  objectiveState: ProxyObjectiveStateStore;
  intentBiasStore: IntentBiasStoreLike;
  intentTelemetry: IntentTelemetryLike;
  planner: PlannerLike;
  executor: ExecutorLike;
  verifier: VerifierLike;
  memory: MemoryLike;
  webApi: WebApiLike;
  policyGate: ProxyCapabilityPolicy;
  actionRegistry: {
    execute: (context: ProxyActionRegistryContext) => Promise<{ handlerId: string; outcome: ActionOutcome | null } | null>;
  };
  startTypingHeartbeat: (chatId: number, reply?: (text: string) => Promise<unknown>) => () => void;
  replyProgress: (params: {
    chatId: number;
    reply: (text: string) => Promise<unknown>;
    phase: ObjectivePhase | "status";
    text: string;
  }) => Promise<void>;
  rememberAssistant: (params: { chatId: number; userId?: number; text: string; source: string }) => Promise<void>;
  rememberUser: (params: { chatId: number; userId?: number; text: string; source: string }) => Promise<void>;
  registerActiveObjectiveController: (chatId: number, controller: ObjectiveRunController) => void;
  clearActiveObjectiveController: (chatId: number, runId: string) => void;
  getGmailPlannerContextBlock: (chatId: number) => string;
  resolvePendingDraftSendFromHistory: (rawObjective: string, history: ExecutedCommand[]) => string | null;
  rewritePlannerCommands: (chatId: number, commands: string[]) => { commands: string[]; changed: boolean };
  updateChatExecutionContext: (chatId: number, result: ExecutedCommand) => void;
  presentExecutionResultChunks: (result: ExecutedCommand, activeAgent: AgentProfile) => Promise<string[]>;
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
  logError: (message: string) => void;
};

export function createObjectiveExecutionRunner(deps: ObjectiveExecutionDeps) {
  return async (params: ObjectiveExecutionParams): Promise<ObjectiveExecutionResult> => {
    const startedAtMs = Date.now();
    const typingHeartbeatStop = deps.startTypingHeartbeat(params.chatId, params.reply);
    let finalOutcome:
      | {
          status: "success" | "blocked" | "incomplete";
          summary: string;
          reason: string;
          objectiveStatus: "success" | "blocked" | "incomplete" | "cancelled" | "error";
          phase: ObjectivePhase;
        }
      | null = null;
    let executedCommandsTotal = 0;
    let lastIteration = 0;
    let intentAbstained = false;
    let criticBlocked = false;
    let memoryHitsCount = 0;

    const finish = (
      status: "success" | "blocked" | "incomplete",
      summary: string,
      reason: string,
      objectiveStatus?: "success" | "blocked" | "incomplete" | "cancelled" | "error",
      phase?: ObjectivePhase,
    ): ObjectiveExecutionResult => {
      finalOutcome = {
        status,
        summary,
        reason,
        objectiveStatus:
          objectiveStatus ??
          (status === "success" ? "success" : status === "blocked" ? "blocked" : "incomplete"),
        phase:
          phase ??
          (status === "success" ? "completed" : status === "blocked" ? "blocked" : "clarify"),
      };
      if (status !== "incomplete") {
        clearClarificationAfterAction(deps.objectiveState, params.chatId);
        deps.objectiveState.clearPendingApproval(params.chatId);
      }
      return { status, summary };
    };

    const intentBias = deps.intentBiasStore.getDomainBias(params.chatId);
    const semanticState = deps.objectiveState.getSemanticState(params.chatId);
    const clarificationAwareInput = buildClarificationAwareObjective({
      rawText: params.objectiveRaw,
      semanticState,
    });
    const routingText = stripQuotedExecutionNoise(clarificationAwareInput.objectiveText);
    const rawIntent = buildIntentIr(routingText, {
      domainBias: intentBias,
    });
    const shadowIntent = deps.config.intentShadowEnabled
      ? buildIntentIr(routingText, {
          domainBias: intentBias,
          shadow: true,
        })
      : undefined;
    const bundle = buildInterpretationBundle({
      rawText: params.objectiveRaw,
      objectiveText: clarificationAwareInput.objectiveText,
      intent: rawIntent,
      deterministicThreshold: deps.config.deterministicRoutingThreshold,
      semanticState,
    });
    const intent = bundle.intent;
    const intentPlannerBlock = buildIntentPlannerContextBlock(intent, shadowIntent);
    const runId = randomUUID();
    const derivedSlots = deriveObjectiveSlots(intent);
    const objectiveController = new AbortController();
    const objectiveSignal = composeAbortSignal({
      signal: objectiveController.signal,
      timeoutMs: deps.config.objectiveMaxMs,
    });
    deps.registerActiveObjectiveController(params.chatId, {
      runId,
      controller: objectiveController,
      objectiveRaw: params.objectiveRaw,
      startedAtMs,
    });
    deps.objectiveState.startRun({
      chatId: params.chatId,
      ...(typeof params.userId === "number" ? { userId: params.userId } : {}),
      runId,
      objectiveRaw: bundle.objectiveText,
      activeAgent: params.activeAgent.name,
      domain: intent.domain,
      action: intent.action,
      source: params.rememberUserSource ?? "proxy-telegram:objective",
      phase: "intent",
      slots: derivedSlots,
    });
    persistInterpretationBundle({
      store: deps.objectiveState,
      chatId: params.chatId,
      rawText: params.objectiveRaw,
      bundle,
    });

    try {
      await deps.intentTelemetry.recordDecision({
        chatId: params.chatId,
        ...(typeof params.userId === "number" ? { userId: params.userId } : {}),
        domain: intent.domain,
        action: intent.action,
        confidence: intent.confidence,
        ambiguousDomains: intent.ambiguousDomains,
        reasons: intent.reasons,
        objectivePreview: bundle.objectiveText.replace(/\s+/g, " ").slice(0, 280),
        ...(shadowIntent
          ? {
              shadowDomain: shadowIntent.domain,
              shadowConfidence: shadowIntent.confidence,
            }
          : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logError(`Telegram intent-telemetry decision error chat=${params.chatId}: ${message}`);
    }

    deps.logInfo(
      `Telegram intent chat=${params.chatId} user=${params.userId ?? 0} domain=${intent.domain} action=${intent.action} confidence=${intent.confidence.toFixed(3)} ambiguous=${intent.ambiguousDomains.join(",") || "-"}`,
    );
    if (shadowIntent && shadowIntent.domain !== intent.domain) {
      deps.logWarn(
        `Telegram intent-shadow-divergence chat=${params.chatId} primary=${intent.domain}:${intent.confidence.toFixed(3)} shadow=${shadowIntent.domain}:${shadowIntent.confidence.toFixed(3)}`,
      );
    }

    try {
      const objectiveWithHints = params.plannerAttachmentHint
        ? `${bundle.objectiveText}\n\n${params.plannerAttachmentHint}`
        : bundle.objectiveText;
      let objective = objectiveWithHints;
      try {
        const resolved = await resolveWorkspaceHashtagsInText(objectiveWithHints, params.activeAgent);
        objective = resolved.text;
        if (resolved.replacements.length > 0) {
          const mapping = resolved.replacements.map((item) => `${item.tag}->${item.path}`).join(", ");
          deps.logInfo(`Telegram hashtag-resolve chat=${params.chatId} map="${mapping}"`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.logError(`No pude resolver hashtags en chat=${params.chatId}: ${message}`);
      }

      if (deps.memory && params.rememberUserSource) {
        await deps.rememberUser({
          chatId: params.chatId,
          userId: params.userId,
          text: params.objectiveRaw,
          source: params.rememberUserSource,
        });
      }

      if (bundle.suggestedExecutor === "clarify" && bundle.clarificationQuestion) {
        deps.objectiveState.updatePhase({
          chatId: params.chatId,
          runId,
          phase: "clarify",
          message: "semantic_clarify",
          details: {
            pendingSlots: bundle.missingSlots,
          },
        });
        await params.reply(bundle.clarificationQuestion);
        await deps.rememberAssistant({
          chatId: params.chatId,
          userId: params.userId,
          text: bundle.clarificationQuestion,
          source: "proxy-telegram:semantic-clarify",
        });
        return finish("incomplete", bundle.clarificationQuestion, "semantic_clarify", "incomplete", "clarify");
      }

      const abstention = shouldAbstainIntent(intent, deps.config.intentAbstainThreshold);
      if (abstention.abstain) {
        intentAbstained = true;
        deps.objectiveState.upsertSemanticState({
          chatId: params.chatId,
          activeDomain: intent.domain,
          activeAction: intent.action,
          baseObjective: objective,
          awaitingClarification: true,
          clarificationQuestion:
            abstention.clarification ??
            "No estoy seguro de la intención y prefiero confirmar antes de ejecutar. Decime el objetivo exacto en una frase.",
          pendingSlots: [],
          candidateInterpretations: bundle.candidates,
          slotValues: bundle.slotValues,
          lastExecutor: "clarify",
        });
        deps.objectiveState.updatePhase({
          chatId: params.chatId,
          runId,
          phase: "clarify",
          message: "intent_abstain",
          details: {
            reason: abstention.reason ?? "unknown",
          },
        });
        const text =
          abstention.clarification ??
          "No estoy seguro de la intención y prefiero confirmar antes de ejecutar. Decime el objetivo exacto en una frase.";
        await params.reply(text);
        await deps.rememberAssistant({
          chatId: params.chatId,
          userId: params.userId,
          text,
          source: "proxy-telegram:intent-abstain",
        });
        return finish("incomplete", text, `intent_abstain:${abstention.reason ?? "unknown"}`, "incomplete", "clarify");
      }

      const deterministicApproval =
        bundle.suggestedExecutor === "deterministic"
          ? deps.policyGate.evaluateDeterministicIntent({
              intent,
              approvedCapabilities: params.approvedCapabilities,
            })
          : null;
      if (deterministicApproval) {
        deps.objectiveState.upsertSemanticState({
          chatId: params.chatId,
          pendingApproval: deps.policyGate.createPendingApproval({
            requirement: deterministicApproval,
            originalObjective: params.objectiveRaw,
            activeAgent: params.activeAgent.name,
            executor: "deterministic",
            plannerAttachmentHint: params.plannerAttachmentHint,
          }),
        });
        deps.objectiveState.updatePhase({
          chatId: params.chatId,
          runId,
          phase: "clarify",
          message: "approval_required",
          details: {
            capability: deterministicApproval.capability,
            executor: "deterministic",
          },
        });
        await params.reply(deterministicApproval.prompt);
        await deps.rememberAssistant({
          chatId: params.chatId,
          userId: params.userId,
          text: deterministicApproval.prompt,
          source: "proxy-telegram:approval-required",
        });
        return finish("incomplete", deterministicApproval.prompt, `approval_required:${deterministicApproval.capability}`, "incomplete", "clarify");
      }
      const registryExecution = await deps.actionRegistry.execute({
        bundle: {
          ...bundle,
          objectiveText: objective,
        },
        chatId: params.chatId,
        userId: params.userId,
        activeAgent: params.activeAgent,
        objectiveRaw: objective,
        runId,
        reply: params.reply,
        objectiveSignal,
      });
      if (registryExecution?.outcome) {
        clearClarificationAfterAction(deps.objectiveState, params.chatId);
        const deterministicOutcome = registryExecution.outcome;
        return finish(
          deterministicOutcome.status,
          deterministicOutcome.summary,
          deterministicOutcome.reason,
          deterministicOutcome.status === "success"
            ? "success"
            : deterministicOutcome.status === "blocked"
              ? "blocked"
              : "incomplete",
          deterministicOutcome.status === "success"
            ? "completed"
            : deterministicOutcome.status === "blocked"
              ? "blocked"
              : "clarify",
        );
      }

      const memoryHits = deps.memory
        ? await deps.memory.recallForObjective({
            objective,
            chatId: params.chatId,
          })
        : [];
      memoryHitsCount = memoryHits.length;
      const recentConversation = deps.memory
        ? await deps.memory.getRecentConversation({
            chatId: params.chatId,
            limit: deps.config.recentConversationTurns,
          })
        : [];

      const history: ExecutedCommand[] = [];
      let guard = { lastSignature: "", repeatedCount: 0 };
      let lastCommandsSignature = "";
      let repeatedCommandsCount = 0;
      const forcedDraftSendAttempted = new Set<string>();
      for (let iteration = 1; iteration <= deps.config.maxIterations; iteration += 1) {
        throwIfAborted(objectiveSignal);
        lastIteration = iteration;
        const gmailContextBlock = deps.getGmailPlannerContextBlock(params.chatId);
        const objectiveForPlanner = [objective, intentPlannerBlock, gmailContextBlock].filter(Boolean).join("\n\n");
        const pendingDraftId = deps.resolvePendingDraftSendFromHistory(objective, history);
        const shouldForceDraftSend = Boolean(pendingDraftId && !forcedDraftSendAttempted.has(pendingDraftId));

        await deps.replyProgress({
          chatId: params.chatId,
          reply: params.reply,
          phase: "planning",
          text: buildPhaseIntroText("planning", iteration),
        });
        deps.objectiveState.updatePhase({
          chatId: params.chatId,
          runId,
          phase: "planning",
          message: shouldForceDraftSend ? "planner_forced_draft_send" : "planner_request",
          details: {
            iteration,
            historyLength: history.length,
            memoryHits: memoryHits.length,
          },
        });

        let plan: PlannerResponse = shouldForceDraftSend
          ? {
              action: "commands",
              explanation: "Se detectó un draft previo sin envío confirmado. Fuerzo `gmail-api draft send` para completar el objetivo.",
              commands: [`gmail-api draft send ${pendingDraftId}`],
            }
          : await deps.planner.plan({
              objective: objectiveForPlanner,
              agent: params.activeAgent,
              history,
              iteration,
              memoryHits,
              recentConversation,
              webApi: deps.webApi?.plannerContext ?? null,
              signal: objectiveSignal,
              timeoutMs: deps.config.plannerTimeoutMs,
            });
        const actionableIntent = ["create", "edit", "delete", "send"].includes(intent.action);
        const deservesReplyRetry =
          !shouldForceDraftSend &&
          plan.action === "reply" &&
          actionableIntent &&
          shouldRetryPlannerReply({
            intent,
            iteration,
            replyText: plan.reply ?? "",
          });
        if (deservesReplyRetry) {
          const retriedPlan = await deps.planner.plan({
            objective: buildRetryPlannerObjective(objectiveForPlanner),
            agent: params.activeAgent,
            history,
            iteration,
            memoryHits,
            recentConversation,
            webApi: deps.webApi?.plannerContext ?? null,
            signal: objectiveSignal,
            timeoutMs: deps.config.plannerTimeoutMs,
          });
          deps.logInfo(
            `Telegram plan-retry chat=${params.chatId} user=${params.userId ?? 0} iter=${iteration} prev=reply next=${retriedPlan.action} commands=${retriedPlan.commands?.length ?? 0}`,
          );
          plan = retriedPlan;
        }
        if (shouldForceDraftSend && pendingDraftId) {
          forcedDraftSendAttempted.add(pendingDraftId);
        }
        deps.logInfo(
          `Telegram plan chat=${params.chatId} user=${params.userId ?? 0} iter=${iteration} action=${plan.action} commands=${plan.commands?.length ?? 0}`,
        );

        if (plan.action === "commands" && deps.config.intentCriticEnabled) {
          const critic = critiquePlannedCommands({
            intent,
            objective,
            plan,
          });
          if (!critic.allow) {
            criticBlocked = true;
            const blockedText =
              critic.clarification ??
              "Detuve la ejecución porque el plan no coincide con la intención detectada. Reformulá el pedido.";
            deps.logWarn(
              `Telegram intent-critic-block chat=${params.chatId} user=${params.userId ?? 0} iter=${iteration} reason=${critic.reason} command="${critic.blockedCommand ?? "-"}"`,
            );
            deps.objectiveState.updatePhase({
              chatId: params.chatId,
              runId,
              phase: "blocked",
              message: "intent_critic_block",
              details: {
                iteration,
                reason: critic.reason,
                blockedCommand: critic.blockedCommand ?? null,
              },
            });
            await params.reply(blockedText);
            await deps.rememberAssistant({
              chatId: params.chatId,
              userId: params.userId,
              text: blockedText,
              source: "proxy-telegram:intent-critic-block",
            });
            return finish("blocked", blockedText, `critic_block:${critic.reason}`, "blocked", "blocked");
          }
        }

        if (plan.action === "reply") {
          const replyText = plan.reply ?? "No tengo una respuesta para eso.";
          deps.objectiveState.updatePhase({
            chatId: params.chatId,
            runId,
            phase: "clarify",
            message: "planner_reply",
            details: {
              iteration,
            },
          });
          await params.reply(replyText);
          await deps.rememberAssistant({
            chatId: params.chatId,
            userId: params.userId,
            text: replyText,
            source: "proxy-telegram:reply",
          });
          return finish("incomplete", replyText, "planner_reply", "incomplete", "clarify");
        }

        if (plan.action === "done") {
          const doneText = plan.reply ?? "Objetivo completado.";
          await params.reply(doneText);
          await deps.rememberAssistant({
            chatId: params.chatId,
            userId: params.userId,
            text: doneText,
            source: "proxy-telegram:done",
          });
          return finish("success", doneText, "planner_done", "success", "completed");
        }

        if (plan.action === "commands") {
          const plannerApproval = deps.policyGate.evaluatePlannerCommands({
            intent,
            plan,
            approvedCapabilities: params.approvedCapabilities,
          });
          if (plannerApproval) {
            deps.objectiveState.upsertSemanticState({
              chatId: params.chatId,
              pendingApproval: deps.policyGate.createPendingApproval({
                requirement: plannerApproval,
                originalObjective: params.objectiveRaw,
                activeAgent: params.activeAgent.name,
                executor: "planner",
                plannerAttachmentHint: params.plannerAttachmentHint,
              }),
            });
            deps.objectiveState.updatePhase({
              chatId: params.chatId,
              runId,
              phase: "clarify",
              message: "approval_required",
              details: {
                capability: plannerApproval.capability,
                executor: "planner",
              },
            });
            await params.reply(plannerApproval.prompt);
            await deps.rememberAssistant({
              chatId: params.chatId,
              userId: params.userId,
              text: plannerApproval.prompt,
              source: "proxy-telegram:approval-required",
            });
            return finish("incomplete", plannerApproval.prompt, `approval_required:${plannerApproval.capability}`, "incomplete", "clarify");
          }
        }

        const commands = plan.commands ?? [];
        const remaining = Math.max(0, deps.config.maxCommandsTotal - executedCommandsTotal);
        if (remaining <= 0) {
          const textLimit = "Esto ya se estaba yendo demasiado largo. Prefiero frenarlo aca para no hacer cualquiera.";
          await params.reply(textLimit);
          await deps.rememberAssistant({
            chatId: params.chatId,
            userId: params.userId,
            text: textLimit,
            source: "proxy-telegram:limit",
          });
          return finish("incomplete", textLimit, "command_total_limit", "incomplete", "blocked");
        }
        const commandsToRun = commands.slice(0, remaining);
        const rewritten = deps.rewritePlannerCommands(params.chatId, commandsToRun);
        const rewrittenCommandsToRun = rewritten.commands;
        if (rewritten.changed) {
          deps.logInfo(`Telegram gmail-context-rewrite chat=${params.chatId} iter=${iteration}`);
        }
        await params.reply(buildVisiblePlanText(iteration, plan.explanation));

        await deps.replyProgress({
          chatId: params.chatId,
          reply: params.reply,
          phase: "executing",
          text: buildPhaseIntroText("executing"),
        });
        deps.objectiveState.updatePhase({
          chatId: params.chatId,
          runId,
          phase: "executing",
          message: "run_commands",
          details: {
            iteration,
            commands: rewrittenCommandsToRun,
          },
        });

        const results = await deps.executor.runSequence(params.activeAgent, rewrittenCommandsToRun, {
          abortSignal: objectiveSignal,
        });
        throwIfAborted(objectiveSignal);
        executedCommandsTotal += results.length;
        history.push(...results);
        for (const result of results) {
          deps.logInfo(
            `Telegram exec chat=${params.chatId} iter=${iteration} command="${result.command}" exit=${result.exitCode ?? "null"} timeout=${String(result.timedOut)}`,
          );
          deps.updateChatExecutionContext(params.chatId, result);
        }

        for (const result of results) {
          const chunks = await deps.presentExecutionResultChunks(result, params.activeAgent);
          for (const chunk of chunks) {
            await params.reply(chunk);
          }
        }

        await deps.replyProgress({
          chatId: params.chatId,
          reply: params.reply,
          phase: "verifying",
          text: buildPhaseIntroText("verifying"),
        });
        deps.objectiveState.updatePhase({
          chatId: params.chatId,
          runId,
          phase: "verifying",
          message: "verify_request",
          details: {
            iteration,
            commandsExecuted: executedCommandsTotal,
          },
        });
        const verification = await deps.verifier.verify({
          objective,
          agent: params.activeAgent,
          iteration,
          latestCommands: rewrittenCommandsToRun,
          latestResults: results,
          history,
          signal: objectiveSignal,
          timeoutMs: deps.config.verifierTimeoutMs,
        });
        deps.logInfo(
          `Telegram verify chat=${params.chatId} user=${params.userId ?? 0} iter=${iteration} status=${verification.status} summary="${verification.summary.slice(0, 160)}"`,
        );
        if (verification.status === "success") {
          await params.reply(verification.summary);
          await deps.rememberAssistant({
            chatId: params.chatId,
            userId: params.userId,
            text: verification.summary,
            source: "proxy-telegram:verify-success",
          });
          return finish("success", verification.summary, "verify_success", "success", "completed");
        }
        if (verification.status === "blocked") {
          await params.reply(verification.summary);
          await deps.rememberAssistant({
            chatId: params.chatId,
            userId: params.userId,
            text: verification.summary,
            source: "proxy-telegram:verify-blocked",
          });
          return finish("blocked", verification.summary, "verify_blocked", "blocked", "blocked");
        }

        const commandsSignature = JSON.stringify(rewrittenCommandsToRun.map((item) => item.trim()));
        if (commandsSignature === lastCommandsSignature) {
          repeatedCommandsCount += 1;
        } else {
          repeatedCommandsCount = 0;
        }
        lastCommandsSignature = commandsSignature;

        const allSucceeded =
          results.length > 0 &&
          results.every((item) => Number.isFinite(item.exitCode ?? Number.NaN) && item.exitCode === 0 && !item.timedOut);
        if (verification.status === "continue" && allSucceeded && repeatedCommandsCount >= 1) {
          const repeatedCmdText =
            "Detuve la ejecución porque se repitió el mismo comando con éxito sin avanzar el objetivo. Indícame el siguiente paso o reformula el pedido.";
          deps.logInfo(
            `Telegram repeat-command-guard chat=${params.chatId} user=${params.userId ?? 0} iter=${iteration} repeated=${repeatedCommandsCount + 1}`,
          );
          await params.reply(repeatedCmdText);
          await deps.rememberAssistant({
            chatId: params.chatId,
            userId: params.userId,
            text: repeatedCmdText,
            source: "proxy-telegram:repeat-command-guard",
          });
          return finish("incomplete", repeatedCmdText, "repeat_command_guard", "incomplete", "blocked");
        }

        const guardResult = nextLoopGuardState(guard, rewrittenCommandsToRun, results);
        guard = guardResult.state;
        if (guardResult.shouldStop) {
          const loopText =
            "Detuve la ejecución porque la secuencia y el resultado se repitieron. El objetivo parece resuelto o estancado.";
          await params.reply(loopText);
          await deps.rememberAssistant({
            chatId: params.chatId,
            userId: params.userId,
            text: loopText,
            source: "proxy-telegram:loop-guard",
          });
          return finish("incomplete", loopText, "loop_guard", "incomplete", "blocked");
        }
      }

      const maxIterText = "No llegue a cerrarlo del todo. Si queres, reformulalo o dividilo en pasos mas cortos.";
      await params.reply(maxIterText);
      await deps.rememberAssistant({
        chatId: params.chatId,
        userId: params.userId,
        text: maxIterText,
        source: "proxy-telegram:max-iterations",
      });
      return finish("incomplete", maxIterText, "max_iterations", "incomplete", "blocked");
    } catch (error) {
      if (isAbortError(error) || objectiveSignal?.aborted) {
        const reasonText = abortReasonToText(objectiveSignal ?? objectiveController.signal);
        const cancelText = /timeout|tiempo/i.test(reasonText)
          ? "Lo frene porque ya estaba tardando demasiado."
          : `Lo frene: ${reasonText}`;
        deps.logWarn(`Telegram objective-cancelled chat=${params.chatId} user=${params.userId ?? 0}: ${reasonText}`);
        try {
          await params.reply(cancelText);
        } catch {
          // ignore secondary reply failure
        }
        try {
          await deps.rememberAssistant({
            chatId: params.chatId,
            userId: params.userId,
            text: cancelText,
            source: "proxy-telegram:objective-cancelled",
          });
        } catch {
          // ignore memory failure
        }
        return finish("incomplete", cancelText, "objective_cancelled", "cancelled", "cancelled");
      }
      const message = error instanceof Error ? error.message : String(error);
      const errorText = `Se trabo por un problema operativo: ${message}`;
      deps.logError(`Telegram objective-error chat=${params.chatId} user=${params.userId ?? 0}: ${message}`);
      try {
        await params.reply(errorText);
      } catch {
        // ignore secondary reply failure
      }
      try {
        await deps.rememberAssistant({
          chatId: params.chatId,
          userId: params.userId,
          text: errorText,
          source: "proxy-telegram:objective-error",
        });
      } catch {
        // ignore memory failure
      }
      return finish("blocked", errorText, "objective_exception", "error", "blocked");
    } finally {
      typingHeartbeatStop();
      deps.clearActiveObjectiveController(params.chatId, runId);
      if (finalOutcome) {
        const durationMs = Math.max(0, Date.now() - startedAtMs);
        const outcome = finalOutcome;
        try {
          deps.objectiveState.finishRun({
            chatId: params.chatId,
            runId,
            status: outcome.objectiveStatus,
            phase: outcome.phase,
            summary: outcome.summary,
            reason: outcome.reason,
            details: {
              durationMs,
              iterations: Math.max(1, lastIteration),
              commandsExecuted: executedCommandsTotal,
              memoryHits: memoryHitsCount,
              abstained: intentAbstained,
              criticBlocked,
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          deps.logError(`Telegram objective-state finish error chat=${params.chatId}: ${message}`);
        }
        try {
          await deps.intentTelemetry.recordOutcome({
            chatId: params.chatId,
            ...(typeof params.userId === "number" ? { userId: params.userId } : {}),
            domain: intent.domain,
            confidence: intent.confidence,
            status: outcome.status,
            durationMs,
            iterations: Math.max(1, lastIteration),
            commandsExecuted: executedCommandsTotal,
            reason: outcome.reason,
          });
          const overallAlert = deps.intentTelemetry.getSloAlert();
          if (overallAlert) {
            deps.logWarn(
              `Telegram intent-slo-alert scope=${overallAlert.scope} failRate=${overallAlert.failureRate} threshold=${overallAlert.threshold} sample=${overallAlert.sampleSize}/${overallAlert.windowSize}`,
            );
          }
          const domainAlert = deps.intentTelemetry.getSloAlert(intent.domain);
          if (domainAlert) {
            deps.logWarn(
              `Telegram intent-slo-alert scope=${domainAlert.scope} failRate=${domainAlert.failureRate} threshold=${domainAlert.threshold} sample=${domainAlert.sampleSize}/${domainAlert.windowSize}`,
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          deps.logError(`Telegram intent-telemetry outcome error chat=${params.chatId}: ${message}`);
        }
        try {
          await deps.intentBiasStore.recordOutcome({
            chatId: params.chatId,
            domain: intent.domain,
            status: outcome.status,
            confidence: intent.confidence,
            abstained: intentAbstained,
            criticBlocked,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          deps.logError(`Telegram intent-bias update error chat=${params.chatId}: ${message}`);
        }
      }
    }
  };
}
