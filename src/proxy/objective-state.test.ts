import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProxyObjectiveStateStore } from "./objective-state.js";

test("objective state store tracks lifecycle and slots per chat", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "houdi-objective-state-"));
  const dbPath = path.join(tempDir, "objective.sqlite");
  const store = new ProxyObjectiveStateStore(dbPath);
  await store.init();

  const started = store.startRun({
    chatId: 77,
    userId: 99,
    runId: "run-1",
    objectiveRaw: "envia email con estado",
    activeAgent: "operator",
    domain: "gmail",
    action: "send",
    source: "test",
    phase: "intent",
    slots: {
      domain: "gmail",
      action: "send",
      currentRecipient: "equipo@example.com",
    },
  });

  assert.equal(started.status, "active");
  assert.equal(started.phase, "intent");
  assert.equal(started.slots.currentRecipient, "equipo@example.com");

  const merged = store.mergeSlots(77, "run-1", {
    gmailSubject: "Estado semanal",
    activeTaskRef: "task-9",
  });
  assert.equal(merged?.slots.gmailSubject, "Estado semanal");
  assert.equal(merged?.slots.activeTaskRef, "task-9");

  const planning = store.updatePhase({
    chatId: 77,
    runId: "run-1",
    phase: "planning",
    message: "planner_request",
  });
  assert.equal(planning?.phase, "planning");

  const cancelRequested = store.requestCancel({
    chatId: 77,
    reason: "usuario",
  });
  assert.equal(cancelRequested?.cancelRequested, true);
  assert.equal(cancelRequested?.cancelReason, "usuario");

  const finished = store.finishRun({
    chatId: 77,
    runId: "run-1",
    status: "cancelled",
    phase: "cancelled",
    summary: "Objetivo cancelado",
    reason: "cancelled_by_user",
  });
  assert.equal(finished?.status, "cancelled");
  assert.equal(finished?.phase, "cancelled");
  assert.equal(finished?.summary, "Objetivo cancelado");

  const reloaded = store.getState(77);
  assert.equal(reloaded?.runId, "run-1");
  assert.equal(reloaded?.finishedAtMs !== undefined, true);

  const events = store.listRecentEvents(77, 8);
  assert.equal(events.length >= 4, true);
  assert.equal(events.some((item) => item.message === "objective_started"), true);
  assert.equal(events.some((item) => item.message === "cancel_requested"), true);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("objective state store prunes old events without touching recent ones", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "houdi-objective-state-prune-"));
  const dbPath = path.join(tempDir, "objective.sqlite");
  const store = new ProxyObjectiveStateStore(dbPath);
  await store.init();

  store.startRun({
    chatId: 88,
    runId: "run-prune",
    objectiveRaw: "buscar noticias",
    activeAgent: "operator",
    domain: "web",
    action: "search",
    source: "test",
  });
  store.appendEvent({
    chatId: 88,
    runId: "run-prune",
    phase: "planning",
    status: "active",
    message: "old_event",
    createdAtMs: Date.now() - 10_000,
  });
  store.appendEvent({
    chatId: 88,
    runId: "run-prune",
    phase: "planning",
    status: "active",
    message: "recent_event",
    createdAtMs: Date.now(),
  });

  const removed = store.pruneEvents(Date.now() - 1_000);
  assert.equal(removed >= 1, true);

  const events = store.listRecentEvents(88, 10);
  assert.equal(events.some((item) => item.message === "recent_event"), true);
  assert.equal(events.some((item) => item.message === "old_event"), false);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("objective state store persists semantic conversation state", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "houdi-semantic-state-"));
  const dbPath = path.join(tempDir, "objective.sqlite");
  const store = new ProxyObjectiveStateStore(dbPath);
  await store.init();

  const saved = store.upsertSemanticState({
    chatId: 91,
    activeDomain: "gmail",
    activeAction: "send",
    baseObjective: "enviame un mail con el resumen",
    awaitingClarification: true,
    clarificationQuestion: "¿A que direccion queres mandarlo?",
    pendingSlots: ["gmail_to"],
    candidateInterpretations: [
      { domain: "gmail", action: "send", confidence: 0.83, source: "primary" },
      { domain: "schedule", action: "create", confidence: 0.42, source: "ambiguous" },
    ],
    slotValues: {
      gmail_subject: "Resumen semanal",
    },
    references: {
      lastWorkspacePath: "workspace/docs/resumen.md",
    },
    pendingApproval: {
      capability: "gmail.send",
      summary: "Voy a enviar un email a equipo@example.com.",
      originalObjective: "mandale el resumen al equipo",
      activeAgent: "operator",
      executor: "deterministic",
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    },
    lastExecutor: "clarify",
  });

  assert.equal(saved.awaitingClarification, true);
  assert.equal(saved.pendingSlots[0], "gmail_to");
  assert.equal(saved.slotValues.gmail_subject, "Resumen semanal");
  assert.equal(saved.references.lastWorkspacePath, "workspace/docs/resumen.md");
  assert.equal(saved.pendingApproval?.capability, "gmail.send");

  const cleared = store.clearSemanticClarification(91);
  assert.equal(cleared?.awaitingClarification, false);
  assert.equal(cleared?.pendingSlots.length, 0);
  assert.equal(cleared?.pendingApproval?.capability, "gmail.send");

  const withoutApproval = store.clearPendingApproval(91);
  assert.equal(withoutApproval?.pendingApproval, undefined);

  const reloaded = store.getSemanticState(91);
  assert.equal(reloaded?.activeDomain, "gmail");
  assert.equal(reloaded?.candidateInterpretations.length, 2);
  assert.equal(reloaded?.pendingApproval, undefined);

  store.clearSemanticState(91);
  assert.equal(store.getSemanticState(91), null);

  await fs.rm(tempDir, { recursive: true, force: true });
});
