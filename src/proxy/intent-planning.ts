import { proxyConfig } from "./config.js";
import type { IntentIr } from "./intent-ir.js";

const MISSING_DATA_REPLY_PATTERN = /\b(falta|indica|indicame|necesito|asunto|contenido|destinatario|confirm)\b/i;

export function buildIntentPlannerContextBlock(intent: IntentIr, shadowIntent?: IntentIr): string {
  const lines: string[] = [
    "Contexto de intención inferida (priorizar este encuadre):",
    `- domain=${intent.domain}`,
    `- action=${intent.action}`,
    `- confidence=${intent.confidence.toFixed(3)}`,
    `- ambiguous=${intent.ambiguousDomains.join(",") || "-"}`,
    `- reasons=${intent.reasons.join(" | ")}`,
  ];

  if (shadowIntent) {
    lines.push(`- shadow_domain=${shadowIntent.domain}`);
    lines.push(`- shadow_confidence=${shadowIntent.confidence.toFixed(3)}`);
  }

  if (intent.entities.taskRef) {
    lines.push(`- task_ref=${intent.entities.taskRef}`);
  }
  if (intent.entities.schedule?.dueAt) {
    lines.push(`- schedule_due_at=${intent.entities.schedule.dueAt.toISOString()}`);
  }
  if (intent.entities.schedule?.automationDomain) {
    lines.push(`- schedule_automation_domain=${intent.entities.schedule.automationDomain}`);
  }
  if (intent.entities.gmail?.to) {
    lines.push(`- gmail_to=${intent.entities.gmail.to}`);
  }
  if (intent.entities.gmail?.subject) {
    lines.push(`- gmail_subject=${intent.entities.gmail.subject}`);
  }
  if (intent.entities.workspace?.path) {
    lines.push(`- workspace_path=${intent.entities.workspace.path}`);
  }
  if (intent.entities.workspace?.targetPath) {
    lines.push(`- workspace_target=${intent.entities.workspace.targetPath}`);
  }
  if (intent.entities.selfMaintenance?.action) {
    lines.push(`- self_maintenance_action=${intent.entities.selfMaintenance.action}`);
  }

  if (intent.domain === "gmail" && intent.action === "send") {
    lines.push(
      "Regla fuerte: completar envío real en esta ejecución (gmail-api send o gmail-api draft send) y confirmar sent=true + message_id.",
    );
  }

  if (intent.domain === "schedule" && intent.entities.hasMailCue && intent.entities.hasTemporalCue) {
    lines.push(
      "Regla fuerte: si hay señal temporal + mail, prioriza programar tarea/automatización; no enviar email inmediato salvo pedido explícito.",
    );
  }

  if (intent.domain === "self-maintenance") {
    lines.push(
      "Regla fuerte: prioriza cambios controlados sobre el agente, skills o repo local; evita acciones externas si no son imprescindibles.",
    );
  }

  return lines.join("\n");
}

export function plannerReplyNeedsMissingData(replyText: string): boolean {
  return MISSING_DATA_REPLY_PATTERN.test((replyText || "").trim());
}

export function shouldRetryPlannerReply(params: {
  intent: IntentIr;
  iteration: number;
  replyText: string;
  routingThreshold?: number;
}): boolean {
  const actionableIntent = ["create", "edit", "delete", "send"].includes(params.intent.action);
  const threshold = params.routingThreshold ?? proxyConfig.intentRoutingThreshold;
  if (!actionableIntent) {
    return false;
  }
  if (params.iteration !== 1) {
    return false;
  }
  if (params.intent.domain === "general") {
    return false;
  }
  if (params.intent.confidence < threshold) {
    return false;
  }
  if (plannerReplyNeedsMissingData(params.replyText)) {
    return false;
  }
  return true;
}

export function buildRetryPlannerObjective(objectiveForPlanner: string): string {
  return [
    objectiveForPlanner,
    "Restricción adicional:",
    "- No uses action='reply' en esta iteración.",
    "- Si no hay bloqueo real, devuelve action='commands' con pasos concretos.",
    "- Usa comandos válidos y ejecutables en este entorno.",
  ].join("\n");
}
