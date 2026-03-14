import assert from "node:assert/strict";
import test from "node:test";
import { buildIntentIr, shouldAbstainIntent, stripQuotedExecutionNoise, type IntentIr } from "./intent-ir.js";

test("detects schedule intent from reminder with temporal cue", () => {
  const intent = buildIntentIr("Recordame mañana a las 10 pagar expensas");
  assert.equal(intent.domain, "schedule");
  assert.equal(intent.action, "create");
  assert.equal(intent.entities.hasTemporalCue, true);
});

test("detects gmail send intent when explicit recipient exists", () => {
  const intent = buildIntentIr("Envia email a equipo@vrand.biz asunto: estado body: hola");
  assert.equal(intent.domain, "gmail");
  assert.equal(intent.action, "send");
  assert.equal(intent.entities.emails.includes("equipo@vrand.biz"), true);
  assert.equal(intent.entities.gmail?.to, "equipo@vrand.biz");
  assert.equal(intent.entities.gmail?.subject, "estado");
  assert.equal(intent.entities.gmail?.body, "hola");
});

test("detects gmail send intent from structured shorthand without send verb", () => {
  const intent = buildIntentIr("equipo@vrand.biz asunto: estado contenido: hola");
  assert.equal(intent.domain, "gmail");
  assert.equal(intent.action, "send");
  assert.equal(intent.entities.gmail?.to, "equipo@vrand.biz");
  assert.equal(intent.entities.gmail?.subject, "estado");
  assert.equal(intent.entities.gmail?.body, "hola");
});

test("abstains when schedule and gmail are in conflict", () => {
  const intent: IntentIr = {
    domain: "schedule",
    action: "send",
    confidence: 0.83,
    reasons: ["test"],
    ambiguousDomains: ["schedule", "gmail"],
    entities: {
      emails: [],
      hasTemporalCue: true,
      hasTaskCue: true,
      hasMailCue: true,
      hasWorkspaceCue: false,
      hasWebCue: false,
    },
  };
  const abstain = shouldAbstainIntent(intent, 0.7);
  assert.equal(abstain.abstain, true);
  assert.match(abstain.reason ?? "", /conflicto_schedule_vs_gmail/);
});

test("does not abstain on generic chat just because schedule and gmail appear in low-confidence ambiguity", () => {
  const intent: IntentIr = {
    domain: "general",
    action: "chat",
    confidence: 0.12,
    reasons: ["test"],
    ambiguousDomains: ["general", "schedule", "gmail", "workspace"],
    entities: {
      emails: [],
      hasTemporalCue: false,
      hasTaskCue: false,
      hasMailCue: false,
      hasWorkspaceCue: false,
      hasWebCue: false,
    },
  };
  const abstain = shouldAbstainIntent(intent, 0.7);
  assert.equal(abstain.abstain, false);
});

test("strips quoted execution noise block", () => {
  const raw = [
    "Enviar por email este resumen",
    "",
    "Contenido citado (mensaje respondido):",
    "texto anterior",
  ].join("\n");
  const cleaned = stripQuotedExecutionNoise(raw);
  assert.equal(cleaned, "Enviar por email este resumen");
});

test("detects temporal cues for weekdays, iso dates and relative phrases", () => {
  const weekday = buildIntentIr("Recordame el viernes pagar expensas");
  assert.equal(weekday.entities.hasTemporalCue, true);

  const isoDate = buildIntentIr("Recordame el 2026-03-15 llamar a Juan");
  assert.equal(isoDate.entities.hasTemporalCue, true);

  const relative = buildIntentIr("Recordame en un rato revisar correo");
  assert.equal(relative.entities.hasTemporalCue, true);
});

test("routes self-maintenance requests through shared semantic router", () => {
  const intent = buildIntentIr("crea una skill para generar changelogs");
  assert.equal(intent.domain, "self-maintenance");
  assert.equal(intent.action, "create");
  assert.equal(intent.entities.selfMaintenance?.action, "add-skill");
  assert.match(intent.reasons.join(" | "), /semantic_top=self-maintenance/);
});

test("maps document analysis requests to workspace domain", () => {
  const intent = buildIntentIr("resumi el contrato pdf adjunto");
  assert.equal(intent.domain, "workspace");
  assert.equal(intent.action, "read");
  assert.match(intent.reasons.join(" | "), /semantic_/);
});

test("maps gmail recipient management to gmail domain", () => {
  const intent = buildIntentIr("agrega destinatario de correo para ventas");
  assert.equal(intent.domain, "gmail");
  assert.equal(intent.action, "create");
  assert.equal(intent.entities.gmail?.kind, "recipients");
  assert.match(intent.reasons.join(" | "), /gmail/);
});

test("derives workspace action and path from shared workspace parser", () => {
  const intent = buildIntentIr("Editar leo... con otro poema");
  assert.equal(intent.domain, "workspace");
  assert.equal(intent.action, "edit");
  assert.equal(intent.entities.workspace?.action, "write");
  assert.equal(intent.entities.workspace?.path, "leo...");
  assert.equal(intent.entities.workspace?.hasContent, true);
});

test("derives workspace content from shared parser", () => {
  const intent = buildIntentIr("crea docs/reporte.md con contenido resumen semanal");
  assert.equal(intent.domain, "workspace");
  assert.equal(intent.entities.workspace?.action, "write");
  assert.equal(intent.entities.workspace?.path, "docs/reporte.md");
  assert.equal(intent.entities.workspace?.content, "resumen semanal");
});

test("derives schedule entities from shared schedule parser", () => {
  const intent = buildIntentIr("reprograma la tarea 3 para mañana a las 9");
  assert.equal(intent.domain, "schedule");
  assert.equal(intent.action, "edit");
  assert.equal(intent.entities.taskRef, "3");
  assert.equal(intent.entities.schedule?.action, "edit");
  assert.ok(intent.entities.schedule?.dueAt instanceof Date);
});

test("routes typoed reminder nouns to schedule instead of workspace", () => {
  const misspelledReminders = buildIntentIr("Ver recordarorios");
  assert.equal(misspelledReminders.domain, "schedule");
  assert.equal(misspelledReminders.action, "list");

  const misspelledTasks = buildIntentIr("Ver tareaa");
  assert.equal(misspelledTasks.domain, "schedule");
  assert.equal(misspelledTasks.action, "list");
});

test("memory domain avoids create action for recall queries", () => {
  const intent = buildIntentIr("te acordas de lo que hablamos de Max?");
  assert.equal(intent.domain, "memory");
  assert.equal(intent.action, "read");
});

test("keeps explicit workspace delete path instead of downgrading to extension-wide delete", () => {
  const intent = buildIntentIr("Eliminar hola.txt");
  assert.equal(intent.domain, "workspace");
  assert.equal(intent.action, "delete");
  assert.equal(intent.entities.workspace?.path, "hola.txt");
  assert.equal(intent.entities.workspace?.deleteExtensions, undefined);
});

test("generic greeting stays in general domain without inflated ambiguity", () => {
  const intent = buildIntentIr("Hola");
  assert.equal(intent.domain, "general");
  assert.equal(intent.action, "chat");
  assert.deepEqual(intent.ambiguousDomains, ["general"]);
  assert.equal(intent.confidence >= 0.9, true);
});
