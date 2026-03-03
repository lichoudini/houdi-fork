import assert from "node:assert/strict";
import test from "node:test";
import { applyDeterministicRules } from "./verifier.js";
import type { ExecutedCommand } from "./types.js";

function buildCommand(params: {
  command: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}): ExecutedCommand {
  return {
    command: params.command,
    stdout: params.stdout ?? "",
    stderr: params.stderr ?? "",
    exitCode: params.exitCode ?? 0,
    signal: null,
    timedOut: params.timedOut ?? false,
    startedAt: 0,
    finishedAt: 1,
  };
}

test("email objective with draft only is not success", () => {
  const verdict = applyDeterministicRules({
    objective: "Envia un email a cliente@example.com con resumen",
    history: [
      buildCommand({
        command: "gmail-api draft create to=cliente@example.com subject=Resumen body=Hola",
        stdout: "ok=true\naction=draft-create\ndraft_id=dr_123\nmessage_id=msg_1\nthread_id=th_1\n",
      }),
    ],
    llmVerdict: { status: "success", summary: "Listo." },
  });
  assert.equal(verdict.status, "continue");
  assert.match(verdict.summary, /draft/i);
  assert.match(verdict.summary, /dr_123/i);
});

test("email objective requires sent=true and message_id evidence", () => {
  const verdict = applyDeterministicRules({
    objective: "Mandar correo de seguimiento a cliente@example.com",
    history: [
      buildCommand({
        command: "gmail-api send to=cliente@example.com subject=Seguimiento body=Hola",
        stdout: "sent=true\nmessage_id=19a0\nthread_id=7f\n",
      }),
    ],
    llmVerdict: { status: "continue", summary: "Sigo." },
  });
  assert.equal(verdict.status, "success");
  assert.match(verdict.summary, /message_id=19a0/);
});

test("non-email objective keeps existing verdict", () => {
  const verdict = applyDeterministicRules({
    objective: "Lista archivos del workspace",
    history: [buildCommand({ command: "ls -la" })],
    llmVerdict: { status: "success", summary: "Listo." },
  });
  assert.deepEqual(verdict, { status: "success", summary: "Listo." });
});

