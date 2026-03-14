import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExecutionReplyText,
  buildFriendlyGmailStatusText,
  buildFriendlyObjectiveStatusText,
  buildPhaseIntroText,
  buildVisiblePlanText,
  pickHeartbeatMessage,
} from "./user-facing.js";
import type { ObjectiveEventRecord, ObjectiveStateRecord } from "./objective-state.js";

test("phase intros and heartbeat stay user friendly", () => {
  assert.match(buildPhaseIntroText("planning", 1), /armando/i);
  assert.match(buildPhaseIntroText("planning", 2), /ajustando/i);
  assert.match(buildVisiblePlanText(1, "Voy a revisar y ordenar todo."), /Voy con esto/i);
  assert.equal(Boolean(pickHeartbeatMessage("executing", 2)), true);
});

test("execution replies hide shell details", () => {
  assert.equal(
    buildExecutionReplyText({
      command: "gmail-api send to=test@example.com subject=Hola body=Texto",
      stdout: "sent=true\nmessage_id=123",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      startedAt: 0,
      finishedAt: 1,
    }),
    null,
  );

  const failure = buildExecutionReplyText({
    command: "cat archivo-que-no-existe.txt",
    stdout: "",
    stderr: "No such file or directory",
    exitCode: 1,
    signal: null,
    timedOut: false,
    startedAt: 0,
    finishedAt: 1,
  });
  assert.match(failure ?? "", /no salio bien/i);
  assert.doesNotMatch(failure ?? "", /\[exit|\$ /i);
});

test("gmail status hides env flags", () => {
  const configured = buildFriendlyGmailStatusText({
    enabled: true,
    configured: true,
    missing: [],
    accountEmail: "equipo@example.com",
    maxResults: 10,
  });
  assert.match(configured, /equipo@example.com/);
  assert.doesNotMatch(configured, /configured|enabled|maxResults/i);

  const missing = buildFriendlyGmailStatusText({
    enabled: true,
    configured: false,
    missing: ["GMAIL_CLIENT_ID", "GMAIL_REFRESH_TOKEN"],
    accountEmail: "",
    maxResults: 10,
  });
  assert.match(missing, /credenciales|autorizacion/i);
  assert.doesNotMatch(missing, /GMAIL_/);
});

test("objective status view avoids internal ids and codes", () => {
  const current: ObjectiveStateRecord = {
    chatId: 1,
    runId: "run-123",
    userId: 9,
    objectiveRaw: "Mandar un mail con el resumen",
    activeAgent: "operator",
    domain: "gmail",
    action: "send",
    source: "telegram",
    phase: "verifying",
    status: "active",
    slots: {},
    cancelRequested: false,
    summary: "El borrador ya salio y estoy revisando que quede bien.",
    reason: undefined,
    startedAtMs: Date.now() - 5_000,
    updatedAtMs: Date.now(),
    finishedAtMs: undefined,
  };
  const events: ObjectiveEventRecord[] = [
    {
      id: 1,
      chatId: 1,
      runId: "run-123",
      phase: "planning",
      status: "active",
      message: "planner_request",
      createdAtMs: Date.now() - 3_000,
      detailsJson: undefined,
    },
  ];
  const text = buildFriendlyObjectiveStatusText({
    current,
    queueDepth: 2,
    events,
  });
  assert.match(text, /Estado general/i);
  assert.match(text, /mensaje\(s\) esperando/i);
  assert.doesNotMatch(text, /run_id|slots|cola_chat|planner_request/i);
});
