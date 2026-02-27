import process from "node:process";
import readline from "node:readline/promises";
import type { AgentProfile } from "../agents.js";
import { logError, logInfo } from "../logger.js";
import { proxyConfig } from "./config.js";
import { nextLoopGuardState } from "./loop-guard.js";
import { resolveCliMemoryChatId } from "./memory.js";
import { createProxyRuntime } from "./runtime.js";
import type { ExecutedCommand } from "./types.js";
import { presentListingResultForWorkspace, resolveWorkspaceHashtagsInText } from "./workspace-listing.js";

function printHelp(): void {
  const lines = [
    "Comandos:",
    "  /help               Ver ayuda",
    "  /agents             Listar agentes disponibles",
    "  /agent <nombre>     Cambiar agente activo",
    "  /exit               Salir",
    "",
    "Uso:",
    "  Escribe un objetivo en lenguaje natural.",
    "  El agente explicará los pasos y luego ejecutará comandos de terminal.",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function truncateForConsole(text: string, maxChars = 5000): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...[truncado]`;
}

function renderExecution(result: ExecutedCommand): void {
  process.stdout.write(`\n$ ${result.command}\n`);

  const stdout = result.stdout.trimEnd();
  const stderr = result.stderr.trimEnd();

  if (stdout) {
    process.stdout.write(`${truncateForConsole(stdout)}\n`);
  } else {
    process.stdout.write("(sin stdout)\n");
  }

  if (stderr) {
    process.stdout.write(`[stderr]\n${truncateForConsole(stderr)}\n`);
  }

  if (result.timedOut) {
    process.stdout.write("[timeout]\n");
    return;
  }

  if (result.exitCode === null) {
    process.stdout.write(`[signal ${result.signal ?? "unknown"}]\n`);
    return;
  }

  process.stdout.write(`[exit ${result.exitCode}]\n`);
}

async function requestConfirmation(rl: readline.Interface): Promise<boolean> {
  const answer = (await rl.question("\n¿Ejecuto estos comandos? [s/N]: ")).trim().toLowerCase();
  return ["s", "si", "sí", "y", "yes"].includes(answer);
}

async function runObjective(params: {
  objective: string;
  agent: AgentProfile;
  planner: Awaited<ReturnType<typeof createProxyRuntime>>["planner"];
  executor: Awaited<ReturnType<typeof createProxyRuntime>>["executor"];
  verifier: Awaited<ReturnType<typeof createProxyRuntime>>["verifier"];
  memory: Awaited<ReturnType<typeof createProxyRuntime>>["memory"];
  webApi: Awaited<ReturnType<typeof createProxyRuntime>>["webApi"];
  rl: readline.Interface;
}): Promise<void> {
  const objectiveRaw = params.objective.trim();
  if (!objectiveRaw) {
    return;
  }
  let objective = objectiveRaw;
  try {
    const resolved = await resolveWorkspaceHashtagsInText(objectiveRaw, params.agent);
    objective = resolved.text;
    if (resolved.replacements.length > 0) {
      process.stdout.write(
        `\nReferencias resueltas: ${resolved.replacements.map((item) => `${item.tag} -> ${item.path}`).join(", ")}\n`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`No pude resolver hashtags en CLI: ${message}`);
  }

  const memoryChatId = resolveCliMemoryChatId(params.agent);
  const rememberAssistant = async (text: string, source: string): Promise<void> => {
    if (!params.memory) {
      return;
    }
    await params.memory.rememberAssistantTurn({
      chatId: memoryChatId,
      text,
      source,
    });
  };

  if (params.memory) {
    await params.memory.rememberUserTurn({
      chatId: memoryChatId,
      objective: objectiveRaw,
      source: "proxy-cli:user",
    });
  }
  const memoryHits = params.memory
    ? await params.memory.recallForObjective({
        objective,
        chatId: memoryChatId,
      })
    : [];
  const recentConversation = params.memory
    ? await params.memory.getRecentConversation({
        chatId: memoryChatId,
        limit: proxyConfig.recentConversationTurns,
      })
    : [];

  const history: ExecutedCommand[] = [];
  let guard = { lastSignature: "", repeatedCount: 0 };
  let executedCommandsTotal = 0;

  for (let iteration = 1; iteration <= proxyConfig.maxIterations; iteration += 1) {
    const plan = await params.planner.plan({
      objective,
      agent: params.agent,
      history,
      iteration,
      memoryHits,
      recentConversation,
      webApi: params.webApi?.plannerContext ?? null,
    });

    if (plan.action === "reply") {
      const replyText = plan.reply ?? "No tengo una respuesta para eso.";
      process.stdout.write(`\n${replyText}\n`);
      await rememberAssistant(replyText, "proxy-cli:reply");
      return;
    }

    if (plan.action === "done") {
      const doneText = plan.reply ?? "Objetivo completado.";
      process.stdout.write(`\n${doneText}\n`);
      await rememberAssistant(doneText, "proxy-cli:done");
      return;
    }

    const commands = plan.commands ?? [];
    const remaining = Math.max(0, proxyConfig.maxCommandsTotal - executedCommandsTotal);
    if (remaining <= 0) {
      const text = `Límite alcanzado: ${proxyConfig.maxCommandsTotal} comandos ejecutados para este objetivo.`;
      process.stdout.write(`\n${text}\n`);
      await rememberAssistant(text, "proxy-cli:limit");
      return;
    }
    const commandsToRun = commands.slice(0, remaining);

    process.stdout.write(`\nPlan (${iteration}/${proxyConfig.maxIterations}):\n${plan.explanation ?? ""}\n`);
    process.stdout.write("Comandos:\n");
    commandsToRun.forEach((command, index) => {
      process.stdout.write(`${index + 1}. ${command}\n`);
    });
    if (commandsToRun.length < commands.length) {
      process.stdout.write(
        `Aviso: truncado por límite total, ejecutando ${commandsToRun.length} de ${commands.length} comandos.\n`,
      );
    }

    if (proxyConfig.requireConfirmation) {
      const approved = await requestConfirmation(params.rl);
      if (!approved) {
        const text = "Ejecución cancelada por el usuario.";
        process.stdout.write(`${text}\n`);
        await rememberAssistant(text, "proxy-cli:cancelled");
        return;
      }
    }

    const results = await params.executor.runSequence(params.agent, commandsToRun);
    executedCommandsTotal += results.length;
    history.push(...results);

    for (const result of results) {
      const presentable = await presentListingResultForWorkspace(result, params.agent);
      renderExecution(presentable);
    }

    const verification = await params.verifier.verify({
      objective,
      agent: params.agent,
      iteration,
      latestCommands: commandsToRun,
      latestResults: results,
      history,
    });
    if (verification.status === "success") {
      process.stdout.write(`\n${verification.summary}\n`);
      await rememberAssistant(verification.summary, "proxy-cli:verify-success");
      return;
    }
    if (verification.status === "blocked") {
      process.stdout.write(`\n${verification.summary}\n`);
      await rememberAssistant(verification.summary, "proxy-cli:verify-blocked");
      return;
    }

    const guardResult = nextLoopGuardState(guard, commandsToRun, results);
    guard = guardResult.state;
    if (guardResult.shouldStop) {
      const text =
        "Detuve la ejecución porque la secuencia y el resultado se repitieron. El objetivo parece resuelto o estancado.";
      process.stdout.write(`\n${text}\n`);
      await rememberAssistant(text, "proxy-cli:loop-guard");
      return;
    }
  }

  const text = `No se completó el objetivo en ${proxyConfig.maxIterations} iteraciones. Reformula o amplía el objetivo.`;
  process.stdout.write(`\n${text}\n`);
  await rememberAssistant(text, "proxy-cli:max-iterations");
}

function resolveInitialObjective(argv: string[]): string {
  const trimmed = argv.map((value) => value.trim()).filter(Boolean);
  if (trimmed.length === 0) {
    return "";
  }
  return trimmed.join(" ");
}

export async function startTerminalProxyCli(argv = process.argv.slice(2)): Promise<void> {
  if (!proxyConfig.openAiApiKey) {
    throw new Error("Falta OPENAI_API_KEY en el entorno.");
  }

  const runtime = await createProxyRuntime();
  const { registry, planner, executor, verifier, memory, webApi } = runtime;

  let activeAgent = registry.getDefault();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  process.stdout.write("Houdi Proxy CLI (agente <-> terminal)\n");
  process.stdout.write(`Agente activo: ${activeAgent.name} | cwd: ${activeAgent.cwd}\n`);
  process.stdout.write(`Contexto de modelo: ${proxyConfig.modelContextFile}\n`);
  process.stdout.write("Escribe /help para ver comandos de control.\n\n");

  const initialObjective = resolveInitialObjective(argv);
  if (initialObjective) {
    await runObjective({
      objective: initialObjective,
      agent: activeAgent,
      planner,
      executor,
      verifier,
      memory,
      webApi,
      rl,
    });
    rl.close();
    return;
  }

  try {
    while (true) {
      if (process.stdin.readableEnded) {
        break;
      }

      let raw = "";
      try {
        raw = await rl.question("objetivo> ");
      } catch {
        break;
      }

      const line = raw.trim();
      if (!line) {
        continue;
      }

      if (line === "/exit" || line === "/quit") {
        break;
      }

      if (line === "/help") {
        printHelp();
        continue;
      }

      if (line === "/agents") {
        const agents = registry.list();
        process.stdout.write("Agentes disponibles:\n");
        for (const agent of agents) {
          const marker = agent.name === activeAgent.name ? "*" : "-";
          process.stdout.write(`${marker} ${agent.name} (cwd=${agent.cwd}, workspaceOnly=${String(agent.workspaceOnly)})\n`);
        }
        continue;
      }

      if (line.startsWith("/agent ")) {
        const target = line.replace(/^\/agent\s+/, "").trim();
        if (!target) {
          process.stdout.write("Uso: /agent <nombre>\n");
          continue;
        }
        const nextAgent = registry.get(target);
        if (!nextAgent) {
          process.stdout.write(`Agente no encontrado: ${target}\n`);
          continue;
        }
        activeAgent = nextAgent;
        process.stdout.write(`Agente activo: ${activeAgent.name} | cwd: ${activeAgent.cwd}\n`);
        continue;
      }

      await runObjective({
        objective: line,
        agent: activeAgent,
        planner,
        executor,
        verifier,
        memory,
        webApi,
        rl,
      });
    }
  } finally {
    rl.close();
    logInfo("Proxy CLI finalizado");
  }
}

export async function runProxyCliFromProcess(): Promise<void> {
  try {
    await startTerminalProxyCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(message);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  }
}
