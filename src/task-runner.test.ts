import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProfile } from "./agents.js";
import { TaskRunner } from "./task-runner.js";

function buildAgent(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: "test-agent",
    cwd: ".",
    allowCommands: ["echo"],
    workspaceOnly: false,
    ...overrides,
  };
}

test("runs commands without shell interpretation", async () => {
  const runner = new TaskRunner(2_000, 4_000);
  const running = runner.start(buildAgent(), "echo hello && uname");
  const result = await running.done;

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "hello && uname");
});

test("blocks workspace path escapes", () => {
  const runner = new TaskRunner(2_000, 4_000);

  assert.throws(
    () =>
      runner.start(
        buildAgent({
          allowCommands: ["cat"],
          workspaceOnly: true,
        }),
        "cat ../secret.txt",
      ),
    /escapes workspace-only policy/,
  );
});
