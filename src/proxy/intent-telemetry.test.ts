import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IntentTelemetry } from "./intent-telemetry.js";

test("raises SLO alert when failure rate exceeds threshold", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "intent-telemetry-"));
  const filePath = path.join(tmpDir, "intent.jsonl");

  const telemetry = await IntentTelemetry.create({
    enabled: true,
    filePath,
    sloWindow: 5,
    sloMaxFailureRate: 0.4,
    sloMinSamples: 3,
  });

  await telemetry.recordOutcome({
    chatId: 1,
    domain: "gmail",
    confidence: 0.8,
    status: "blocked",
    durationMs: 100,
    iterations: 1,
    commandsExecuted: 0,
  });
  await telemetry.recordOutcome({
    chatId: 1,
    domain: "gmail",
    confidence: 0.7,
    status: "incomplete",
    durationMs: 120,
    iterations: 1,
    commandsExecuted: 1,
  });
  await telemetry.recordOutcome({
    chatId: 1,
    domain: "gmail",
    confidence: 0.9,
    status: "success",
    durationMs: 90,
    iterations: 1,
    commandsExecuted: 1,
  });

  const overallAlert = telemetry.getSloAlert();
  assert.ok(overallAlert);
  assert.equal(overallAlert?.scope, "overall");
  assert.equal((overallAlert?.failureRate ?? 0) > 0.4, true);

  const domainAlert = telemetry.getSloAlert("gmail");
  assert.ok(domainAlert);
  assert.equal(domainAlert?.scope, "gmail");
});
