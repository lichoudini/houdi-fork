import assert from "node:assert/strict";
import test from "node:test";
import { DomainActionRegistry } from "./action-registry.js";
import { buildInterpretationBundle } from "./interpretation-bundle.js";
import { buildIntentIr } from "./intent-ir.js";

test("action registry dispatches the first matching handler", async () => {
  const bundle = buildInterpretationBundle({
    rawText: "Busca noticias de IA",
    objectiveText: "Busca noticias de IA",
    intent: buildIntentIr("Busca noticias de IA"),
    deterministicThreshold: 0.2,
  });

  const registry = new DomainActionRegistry<{ bundle: typeof bundle; trace: string[] }>([
    {
      id: "gmail",
      canHandle: (candidate) => candidate.domain === "gmail",
      execute: async () => null,
    },
    {
      id: "web",
      canHandle: (candidate) => candidate.domain === "web",
      execute: async (context) => {
        context.trace.push("web");
        return {
          status: "success",
          summary: "ok",
          reason: "web_search",
        };
      },
    },
  ]);

  const trace: string[] = [];
  const result = await registry.execute({
    bundle,
    trace,
  });

  assert.equal(result?.handlerId, "web");
  assert.equal(result?.outcome?.status, "success");
  assert.deepEqual(trace, ["web"]);
});
