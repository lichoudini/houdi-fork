import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProfile } from "../agents.js";
import { createObjectiveExecutionRunner } from "./objective-execution.js";

function buildAgent(): AgentProfile {
  return {
    name: "operator",
    cwd: ".",
    workspaceOnly: true,
    allowCommands: ["echo", "gmail-api"],
  };
}

function createObjectiveStateStub() {
  const state = {
    getSemanticState() {
      return null;
    },
    startRun() {},
    upsertSemanticState() {},
    updatePhase() {},
    mergeSlots() {},
    clearSemanticClarification() {},
    clearPendingApproval() {},
    finishRun() {},
  };
  return state as any;
}

function createRunner(overrides: Partial<Parameters<typeof createObjectiveExecutionRunner>[0]> = {}) {
  let plannerCalls = 0;
  let registryCalls = 0;
  const replies: string[] = [];

  const runner = createObjectiveExecutionRunner({
    config: {
      intentShadowEnabled: false,
      deterministicRoutingThreshold: 0.84,
      objectiveMaxMs: 5_000,
      intentAbstainThreshold: 0.4,
      recentConversationTurns: 4,
      maxIterations: 2,
      plannerTimeoutMs: 1_000,
      intentCriticEnabled: true,
      maxCommandsTotal: 4,
      verifierTimeoutMs: 1_000,
    },
    objectiveState: createObjectiveStateStub(),
    intentBiasStore: {
      getDomainBias() {
        return {};
      },
      async recordOutcome() {},
    },
    intentTelemetry: {
      async recordDecision() {},
      async recordOutcome() {},
      getSloAlert() {
        return null;
      },
    },
    planner: {
      async plan() {
        plannerCalls += 1;
        return { action: "reply", reply: "no debería ejecutarse" };
      },
    },
    executor: {
      async runSequence() {
        return [];
      },
    },
    verifier: {
      async verify() {
        return { status: "success" as const, summary: "ok" };
      },
    },
    memory: null,
    webApi: null,
    policyGate: {
      evaluateDeterministicIntent() {
        return null;
      },
      evaluatePlannerCommands() {
        return null;
      },
      createPendingApproval({ requirement, originalObjective, activeAgent, executor, plannerAttachmentHint }: any) {
        return {
          capability: requirement.capability,
          summary: requirement.summary,
          originalObjective,
          activeAgent,
          executor,
          plannerAttachmentHint,
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
        };
      },
    } as any,
    actionRegistry: {
      async execute() {
        registryCalls += 1;
        return null;
      },
    },
    startTypingHeartbeat() {
      return () => {};
    },
    async replyProgress() {},
    async rememberAssistant() {},
    async rememberUser() {},
    registerActiveObjectiveController() {},
    clearActiveObjectiveController() {},
    getGmailPlannerContextBlock() {
      return "";
    },
    resolvePendingDraftSendFromHistory() {
      return null;
    },
    rewritePlannerCommands(_chatId, commands) {
      return { commands, changed: false };
    },
    updateChatExecutionContext() {},
    async presentExecutionResultChunks() {
      return [];
    },
    logInfo() {},
    logWarn() {},
    logError() {},
    ...overrides,
  });

  return {
    runner,
    replies,
    getPlannerCalls: () => plannerCalls,
    getRegistryCalls: () => registryCalls,
    reply: async (text: string) => {
      replies.push(text);
    },
  };
}

test("objective runner asks targeted clarification before planning", async () => {
  const harness = createRunner();

  const result = await harness.runner({
    chatId: 1,
    activeAgent: buildAgent(),
    objectiveRaw: "Mandale un email con asunto estado semanal",
    reply: harness.reply,
    rememberUserSource: "test",
  });

  assert.equal(result.status, "incomplete");
  assert.equal(harness.getPlannerCalls(), 0);
  assert.equal(harness.getRegistryCalls(), 0);
  assert.match(harness.replies.join("\n"), /direccion|destinatario/i);
});

test("objective runner uses deterministic registry before planner", async () => {
  const harness = createRunner({
    config: {
      intentShadowEnabled: false,
      deterministicRoutingThreshold: 0.6,
      objectiveMaxMs: 5_000,
      intentAbstainThreshold: 0.4,
      recentConversationTurns: 4,
      maxIterations: 2,
      plannerTimeoutMs: 1_000,
      intentCriticEnabled: true,
      maxCommandsTotal: 4,
      verifierTimeoutMs: 1_000,
    },
    actionRegistry: {
      async execute() {
        return {
          handlerId: "domain-direct",
          outcome: {
            status: "success" as const,
            summary: "Listado listo.",
            reason: "deterministic_test",
          },
        };
      },
    },
  });

  const result = await harness.runner({
    chatId: 1,
    activeAgent: buildAgent(),
    objectiveRaw: "lista mis emails",
    reply: harness.reply,
    rememberUserSource: "test",
  });

  assert.equal(result.status, "success");
  assert.equal(result.summary, "Listado listo.");
  assert.equal(harness.getPlannerCalls(), 0);
});

test("objective runner asks approval before deterministic gmail send", async () => {
  const harness = createRunner({
    config: {
      intentShadowEnabled: false,
      deterministicRoutingThreshold: 0.6,
      objectiveMaxMs: 5_000,
      intentAbstainThreshold: 0.4,
      recentConversationTurns: 4,
      maxIterations: 2,
      plannerTimeoutMs: 1_000,
      intentCriticEnabled: true,
      maxCommandsTotal: 4,
      verifierTimeoutMs: 1_000,
    },
    policyGate: {
      evaluateDeterministicIntent() {
        return {
          capability: "gmail.send",
          summary: "Voy a enviar un email a equipo@example.com.",
          prompt: 'Voy a enviar un email a equipo@example.com.\\nRespondé \"sí\" para aprobar o \"no\" para cancelar.',
        };
      },
      evaluatePlannerCommands() {
        return null;
      },
      createPendingApproval({ requirement, originalObjective, activeAgent, executor, plannerAttachmentHint }: any) {
        return {
          capability: requirement.capability,
          summary: requirement.summary,
          originalObjective,
          activeAgent,
          executor,
          plannerAttachmentHint,
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
        };
      },
    } as any,
  });

  const result = await harness.runner({
    chatId: 1,
    activeAgent: buildAgent(),
    objectiveRaw: "Mandale un email a equipo@example.com con asunto estado semanal",
    reply: harness.reply,
    rememberUserSource: "test",
  });

  assert.equal(result.status, "incomplete");
  assert.equal(harness.getPlannerCalls(), 0);
  assert.equal(harness.getRegistryCalls(), 0);
  assert.match(harness.replies.join("\\n"), /aprobar/i);
});
