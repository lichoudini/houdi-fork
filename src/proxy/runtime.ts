import fs from "node:fs/promises";
import { AgentRegistry } from "../agents.js";
import { logInfo } from "../logger.js";
import { TaskRunner } from "../task-runner.js";
import { proxyConfig } from "./config.js";
import { TerminalExecutor } from "./executor.js";
import { ProxyMemory } from "./memory.js";
import { loadProxyModelContext } from "./model-context.js";
import { TerminalPlanner } from "./openai.js";
import { ObjectiveVerifier } from "./verifier.js";
import { ProxyWebApiServer, startProxyWebApiServer } from "./web-api.js";

async function resetWorkspaceDir(): Promise<void> {
  await fs.mkdir(proxyConfig.workspaceDir, { recursive: true });
  const entries = await fs.readdir(proxyConfig.workspaceDir, { withFileTypes: true });
  for (const entry of entries) {
    await fs.rm(`${proxyConfig.workspaceDir}/${entry.name}`, {
      recursive: true,
      force: true,
    });
  }
}

export async function createProxyRuntime(): Promise<{
  registry: AgentRegistry;
  planner: TerminalPlanner;
  executor: TerminalExecutor;
  verifier: ObjectiveVerifier;
  memory: ProxyMemory | null;
  webApi: ProxyWebApiServer | null;
}> {
  if (proxyConfig.resetWorkspaceOnStart) {
    await resetWorkspaceDir();
    logInfo(`Workspace reseteado al iniciar: ${proxyConfig.workspaceDir}`);
  } else {
    await fs.mkdir(proxyConfig.workspaceDir, { recursive: true });
  }

  const registry = new AgentRegistry(proxyConfig.agentsDir, proxyConfig.defaultAgent);
  await registry.load();

  const modelContext = await loadProxyModelContext(proxyConfig.modelContextFile);
  const planner = new TerminalPlanner(proxyConfig.openAiApiKey, modelContext);
  const executor = new TerminalExecutor(new TaskRunner(proxyConfig.execTimeoutMs, proxyConfig.maxStdioChars));
  const verifier = new ObjectiveVerifier(proxyConfig.openAiApiKey);
  const memory = await ProxyMemory.create();
  const webApi = await startProxyWebApiServer();

  return { registry, planner, executor, verifier, memory, webApi };
}
