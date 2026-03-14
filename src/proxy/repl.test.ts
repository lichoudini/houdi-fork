import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProfile } from "../agents.js";
import { runObjective } from "./repl.js";

function buildAgent(): AgentProfile {
  return {
    name: "operator",
    cwd: ".",
    workspaceOnly: true,
    allowCommands: ["echo", "gmail-api"],
  };
}

function createWriter() {
  const chunks: string[] = [];
  return {
    write(text: string) {
      chunks.push(text);
    },
    flush(): string {
      return chunks.join("");
    },
  };
}

function createRlStub() {
  return {
    question: async () => "n",
  } as never;
}

test("runObjective abstains before planning when intent is ambiguous", async () => {
  const writer = createWriter();
  let plannerCalls = 0;
  let executorCalls = 0;

  await runObjective({
    objective: "recordame en un rato revisar correo",
    agent: buildAgent(),
    planner: {
      async plan() {
        plannerCalls += 1;
        return { action: "reply", reply: "no debería llegar" };
      },
    } as never,
    executor: {
      async runSequence() {
        executorCalls += 1;
        return [];
      },
    } as never,
    verifier: {} as never,
    memory: null,
    webApi: null,
    rl: createRlStub(),
    write: writer.write,
  });

  assert.equal(plannerCalls, 0);
  assert.equal(executorCalls, 0);
  assert.match(writer.flush(), /No estoy/i);
});

test("runObjective retries an actionable reply into executable commands", async () => {
  const writer = createWriter();
  let plannerCalls = 0;
  let executedCommands: string[] = [];

  await runObjective({
    objective: "crea un archivo hola.txt con contenido hola",
    agent: buildAgent(),
    planner: {
      async plan() {
        plannerCalls += 1;
        if (plannerCalls === 1) {
          return { action: "reply", reply: "Voy a revisar eso." };
        }
        return {
          action: "commands",
          explanation: "Creo el archivo.",
          commands: ["echo hola"],
        };
      },
    } as never,
    executor: {
      async runSequence(_agent: AgentProfile, commands: string[]) {
        executedCommands = [...commands];
        return [
          {
            command: commands[0],
            stdout: "hola\n",
            stderr: "",
            exitCode: 0,
            signal: null,
            timedOut: false,
            startedAt: 0,
            finishedAt: 1,
          },
        ];
      },
    } as never,
    verifier: {
      async verify() {
        return {
          status: "success",
          summary: "Objetivo completado.",
        };
      },
    } as never,
    memory: null,
    webApi: null,
    rl: createRlStub(),
    write: writer.write,
  });

  assert.equal(plannerCalls, 2);
  assert.deepEqual(executedCommands, ["echo hola"]);
  assert.match(writer.flush(), /Reintentando con plan ejecutable/);
  assert.match(writer.flush(), /Objetivo completado/);
});

test("runObjective blocks plans rejected by the intent critic", async () => {
  const writer = createWriter();
  let executorCalls = 0;

  await runObjective({
    objective: "recordame mañana pagar expensas",
    agent: buildAgent(),
    planner: {
      async plan() {
        return {
          action: "commands",
          explanation: "Enviaré un email.",
          commands: ["gmail-api send to=a@b.com subject=hola body=ok"],
        };
      },
    } as never,
    executor: {
      async runSequence() {
        executorCalls += 1;
        return [];
      },
    } as never,
    verifier: {} as never,
    memory: null,
    webApi: null,
    rl: createRlStub(),
    write: writer.write,
  });

  assert.equal(executorCalls, 0);
  assert.match(writer.flush(), /recordatorio\/tarea|Gmail/i);
});
