import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeterministicClarification,
  buildPlanningProgressText,
  buildVerificationProgressText,
  buildVisiblePlanHeader,
  deriveObjectiveSlots,
  humanizeObjectivePhase,
  shouldUseDeterministicHandler,
} from "./agentic-helpers.js";
import type { IntentIr } from "./intent-types.js";

function buildIntent(overrides: Partial<IntentIr>): IntentIr {
  return {
    domain: "general",
    action: "chat",
    confidence: 0.95,
    reasons: ["test"],
    ambiguousDomains: [],
    entities: {
      emails: [],
      hasTemporalCue: false,
      hasTaskCue: false,
      hasMailCue: false,
      hasWorkspaceCue: false,
      hasWebCue: false,
    },
    ...overrides,
  };
}

test("deterministic handler requires supported domain and confidence", () => {
  const gmailIntent = buildIntent({
    domain: "gmail",
    action: "send",
    confidence: 0.9,
  });
  assert.equal(shouldUseDeterministicHandler(gmailIntent, 0.84), true);

  const lowConfidence = buildIntent({
    domain: "workspace",
    action: "read",
    confidence: 0.6,
  });
  assert.equal(shouldUseDeterministicHandler(lowConfidence, 0.84), false);

  const generalIntent = buildIntent({
    domain: "general",
    action: "chat",
    confidence: 0.99,
  });
  assert.equal(shouldUseDeterministicHandler(generalIntent, 0.84), false);
});

test("strong schedule create stays deterministic even under a high global threshold", () => {
  const scheduleIntent = buildIntent({
    domain: "schedule",
    action: "create",
    confidence: 0.774,
    entities: {
      emails: [],
      hasTemporalCue: true,
      hasTaskCue: true,
      hasMailCue: false,
      hasWorkspaceCue: false,
      hasWebCue: false,
      schedule: {
        action: "create",
        taskTitle: "hola",
        dueAt: new Date("2026-03-07T12:00:00.000Z"),
      },
    },
  });

  assert.equal(shouldUseDeterministicHandler(scheduleIntent, 0.84), true);
});

test("deterministic clarification asks only for missing mandatory data", () => {
  const missingRecipient = buildIntent({
    domain: "gmail",
    action: "send",
    entities: {
      emails: [],
      hasTemporalCue: false,
      hasTaskCue: false,
      hasMailCue: true,
      hasWorkspaceCue: false,
      hasWebCue: false,
      gmail: {
        kind: "message",
        action: "send",
        subject: "Estado",
      },
    },
  });
  assert.match(buildDeterministicClarification(missingRecipient) ?? "", /destinatario/i);

  const missingWorkspaceContent = buildIntent({
    domain: "workspace",
    action: "create",
    entities: {
      emails: [],
      hasTemporalCue: false,
      hasTaskCue: false,
      hasMailCue: false,
      hasWorkspaceCue: true,
      hasWebCue: false,
      workspace: {
        action: "write",
        path: "docs/reporte.md",
      },
    },
  });
  assert.match(buildDeterministicClarification(missingWorkspaceContent) ?? "", /contenido/i);
});

test("derive objective slots keeps recipient, subject and workspace paths", () => {
  const intent = buildIntent({
    domain: "workspace",
    action: "edit",
    entities: {
      emails: ["equipo@example.com"],
      hasTemporalCue: false,
      hasTaskCue: false,
      hasMailCue: true,
      hasWorkspaceCue: true,
      hasWebCue: false,
      taskRef: "tsk-3",
      gmail: {
        kind: "message",
        action: "send",
        to: "equipo@example.com",
        subject: "Estado",
      },
      workspace: {
        action: "move",
        path: "docs/reporte.md",
        targetPath: "docs/archivo-final.md",
      },
    },
  });

  const slots = deriveObjectiveSlots(intent);
  assert.equal(slots.domain, "workspace");
  assert.equal(slots.action, "edit");
  assert.equal(slots.currentRecipient, "equipo@example.com");
  assert.equal(slots.gmailSubject, "Estado");
  assert.equal(slots.workspacePath, "docs/reporte.md");
  assert.equal(slots.workspaceTarget, "docs/archivo-final.md");
  assert.equal(slots.activeTaskRef, "tsk-3");
});

test("agentic ui labels hide internal iteration counters", () => {
  assert.equal(humanizeObjectivePhase("planning"), "planificacion");
  assert.equal(humanizeObjectivePhase("verifying"), "verificacion");
  assert.equal(buildPlanningProgressText(1), "preparando plan");
  assert.equal(buildPlanningProgressText(2), "ajustando plan");
  assert.equal(buildVisiblePlanHeader(1), "Plan:");
  assert.equal(buildVisiblePlanHeader(3), "Plan ajustado:");
  assert.equal(buildVerificationProgressText(), "verificando resultado");
});
