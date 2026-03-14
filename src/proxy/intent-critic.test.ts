import assert from "node:assert/strict";
import test from "node:test";
import { critiquePlannedCommands } from "./intent-critic.js";
import type { IntentIr } from "./intent-ir.js";
import type { PlannerResponse } from "./types.js";

function buildIntent(domain: IntentIr["domain"], action: IntentIr["action"]): IntentIr {
  return {
    domain,
    action,
    confidence: 0.86,
    reasons: ["test"],
    ambiguousDomains: [domain],
    entities: {
      emails: [],
      hasTemporalCue: false,
      hasTaskCue: false,
      hasMailCue: domain === "gmail",
      hasWorkspaceCue: false,
      hasWebCue: false,
    },
  };
}

function commandPlan(commands: string[]): PlannerResponse {
  return {
    action: "commands",
    explanation: "test",
    commands,
  };
}

test("blocks shell operators in plan commands", () => {
  const verdict = critiquePlannedCommands({
    intent: buildIntent("workspace", "edit"),
    objective: "editar archivo",
    plan: commandPlan(["echo hola | cat"]),
  });
  assert.equal(verdict.allow, false);
  assert.match(verdict.reason, /comando_riesgoso/);
});

test("blocks schedule intent that drifts to gmail command", () => {
  const verdict = critiquePlannedCommands({
    intent: buildIntent("schedule", "create"),
    objective: "recordame mañana pagar expensas",
    plan: commandPlan(["gmail-api send to=a@b.com subject=hola body=ok"]),
  });
  assert.equal(verdict.allow, false);
  assert.match(verdict.reason, /desvio_schedule_hacia_gmail/);
});

test("allows gmail send plan with send command", () => {
  const verdict = critiquePlannedCommands({
    intent: buildIntent("gmail", "send"),
    objective: "enviar correo a equipo@vrand.biz",
    plan: commandPlan(["gmail-api send to=equipo@vrand.biz subject=estado body=ok"]),
  });
  assert.equal(verdict.allow, true);
});
