import assert from "node:assert/strict";
import test from "node:test";
import { ProxyCapabilityPolicy, parseApprovalReply } from "./capability-policy.js";
import { buildIntentIr } from "./intent-ir.js";

test("parseApprovalReply reconoce aprobacion y rechazo naturales", () => {
  assert.equal(parseApprovalReply("sí"), "approve");
  assert.equal(parseApprovalReply("confirmo"), "approve");
  assert.equal(parseApprovalReply("no"), "deny");
  assert.equal(parseApprovalReply("cancelar"), "deny");
  assert.equal(parseApprovalReply("contame más"), null);
});

test("policy gate pide aprobacion para gmail send y no para un saludo", () => {
  const policy = new ProxyCapabilityPolicy({
    policyEngine: {
      isApprovalRequired(capability: string) {
        return capability === "gmail.send";
      },
    } as any,
    approvalTtlMs: 60_000,
    requireExecApproval: false,
  });

  const emailIntent = buildIntentIr("Mandale un email a equipo@example.com con asunto estado semanal");
  const greetingIntent = buildIntentIr("Hola");

  const emailCheck = policy.evaluateDeterministicIntent({ intent: emailIntent });
  const greetingCheck = policy.evaluateDeterministicIntent({ intent: greetingIntent });

  assert.equal(emailCheck?.capability, "gmail.send");
  assert.match(emailCheck?.prompt ?? "", /confirmaci/i);
  assert.equal(greetingCheck, null);
});
