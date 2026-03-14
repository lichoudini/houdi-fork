import assert from "node:assert/strict";
import test from "node:test";
import { buildClarificationAwareObjective } from "./clarification-engine.js";
import { buildInterpretationBundle } from "./interpretation-bundle.js";
import { buildIntentIr } from "./intent-ir.js";
import type { SemanticConversationState } from "./objective-state.js";

test("interpretation bundle asks for missing gmail recipient", () => {
  const objectiveText = "Mandale un email con asunto estado semanal";
  const bundle = buildInterpretationBundle({
    rawText: objectiveText,
    objectiveText,
    intent: buildIntentIr(objectiveText),
    deterministicThreshold: 0.84,
  });

  assert.equal(bundle.domain, "gmail");
  assert.equal(bundle.suggestedExecutor, "clarify");
  assert.equal(bundle.missingSlots.includes("gmail_to"), true);
  assert.match(bundle.clarificationQuestion ?? "", /direccion/i);
});

test("clarification-aware objective reuses base objective and unlocks deterministic schedule action", () => {
  const semanticState: SemanticConversationState = {
    chatId: 1,
    activeDomain: "schedule",
    activeAction: "create",
    baseObjective: "Recordame pagar expensas",
    awaitingClarification: true,
    clarificationQuestion: "¿Para cuando queres que lo agende?",
    pendingSlots: ["schedule_due_at"],
    candidateInterpretations: [{ domain: "schedule", action: "create", confidence: 0.8, source: "primary" }],
    slotValues: {
      schedule_title: "pagar expensas",
    },
    references: {},
    lastExecutor: "clarify",
    updatedAtMs: Date.now(),
  };

  const prepared = buildClarificationAwareObjective({
    rawText: "mañana a las 9",
    semanticState,
  });
  const bundle = buildInterpretationBundle({
    rawText: "mañana a las 9",
    objectiveText: prepared.objectiveText,
    intent: buildIntentIr(prepared.objectiveText),
    deterministicThreshold: 0.6,
    semanticState,
  });

  assert.equal(prepared.mergedFromClarification, true);
  assert.equal(bundle.domain, "schedule");
  assert.equal(bundle.missingSlots.length, 0);
  assert.equal(bundle.suggestedExecutor, "deterministic");
});

test("workspace write without concrete path asks for clarification instead of executing", () => {
  const objectiveText = "Crear un archivo con una historia";
  const bundle = buildInterpretationBundle({
    rawText: objectiveText,
    objectiveText,
    intent: buildIntentIr(objectiveText),
    deterministicThreshold: 0.68,
  });

  assert.equal(bundle.domain, "workspace");
  assert.equal(bundle.action, "create");
  assert.equal(bundle.suggestedExecutor, "clarify");
  assert.equal(bundle.missingSlots.includes("workspace_path"), true);
  assert.equal(bundle.slotValues.workspace_content, "una historia");
});

test("strong schedule reminder stays deterministic even with gmail-biased chat state", () => {
  const objectiveText = "Recordatorio para mañana 9am hola";
  const bundle = buildInterpretationBundle({
    rawText: objectiveText,
    objectiveText,
    intent: buildIntentIr(objectiveText, {
      domainBias: {
        "self-maintenance": 0,
        schedule: 0,
        gmail: 1.003,
        workspace: -0.089,
        web: 0.045,
        memory: 0,
        general: 0,
      },
    }),
    deterministicThreshold: 0.84,
  });

  assert.equal(bundle.domain, "schedule");
  assert.equal(bundle.suggestedExecutor, "deterministic");
  assert.equal(bundle.missingSlots.length, 0);
});
