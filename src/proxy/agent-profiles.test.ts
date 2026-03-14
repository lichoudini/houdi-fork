import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { AgentRegistry } from "../agents.js";

test("operator profile stays workspace-only and without wildcard access", async () => {
  const registry = new AgentRegistry(path.resolve(process.cwd(), "agents"), "operator");
  await registry.load();

  const operator = registry.require("operator");
  assert.equal(operator.workspaceOnly, true);
  assert.equal(operator.allowCommands.includes("*"), false);
  assert.equal(operator.allowCommands.includes("gmail-api"), true);
  assert.equal(operator.allowCommands.includes("curl"), true);
});
