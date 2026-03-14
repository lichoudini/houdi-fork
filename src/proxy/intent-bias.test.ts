import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IntentBiasStore } from "./intent-bias.js";

test("records and reloads bias per chat", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "intent-bias-"));
  const filePath = path.join(tmpDir, "bias.json");

  const store = await IntentBiasStore.create({
    enabled: true,
    filePath,
  });
  assert.deepEqual(store.getDomainBias(12345), {});

  await store.recordOutcome({
    chatId: 12345,
    domain: "gmail",
    status: "success",
    confidence: 0.8,
  });

  const first = store.getDomainBias(12345);
  assert.equal(typeof first.gmail, "number");
  assert.equal((first.gmail ?? 0) > 0, true);

  const reloaded = await IntentBiasStore.create({
    enabled: true,
    filePath,
  });
  const second = reloaded.getDomainBias(12345);
  assert.equal(typeof second.gmail, "number");
  assert.equal((second.gmail ?? 0) > 0, true);
});

test("does not penalize abstentions or incomplete clarifications", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "intent-bias-neutral-"));
  const filePath = path.join(tmpDir, "bias.json");

  const store = await IntentBiasStore.create({
    enabled: true,
    filePath,
  });

  await store.recordOutcome({
    chatId: 77,
    domain: "gmail",
    status: "incomplete",
    confidence: 0.92,
    abstained: true,
    criticBlocked: true,
  });

  assert.deepEqual(store.getDomainBias(77), {});
});
