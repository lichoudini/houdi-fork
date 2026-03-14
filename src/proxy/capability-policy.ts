import type { AgentCapability, AgentPolicyEngine } from "../agent-policy.js";
import type { IntentIr } from "./intent-ir.js";
import type { PendingApprovalState } from "./objective-state.js";
import type { PlannerResponse } from "./types.js";

export type ApprovalReplyDecision = "approve" | "deny" | null;

export type ApprovalRequirement = {
  capability: AgentCapability;
  summary: string;
  prompt: string;
};

type ProxyCapabilityPolicyOptions = {
  policyEngine: AgentPolicyEngine;
  approvalTtlMs: number;
  requireExecApproval: boolean;
};

function uniqCapabilities(values: AgentCapability[]): AgentCapability[] {
  return Array.from(new Set(values));
}

function humanizeCapability(capability: AgentCapability): string {
  switch (capability) {
    case "gmail.send":
      return "un envio de email";
    case "workspace.delete":
      return "un borrado en el workspace";
    case "exec":
      return "una accion operativa";
    case "reboot":
      return "un reinicio";
    case "selfupdate":
      return "una actualizacion del sistema";
    case "ai-shell":
      return "una ejecucion asistida de shell";
    default:
      return "una accion sensible";
  }
}

function buildApprovalPrompt(summary: string, capability: AgentCapability): string {
  return [
    summary,
    `Necesito tu confirmación para seguir con ${humanizeCapability(capability)}.`,
    'Respondé "sí" para aprobar o "no" para cancelar.',
  ].join("\n");
}

function summarizeDeterministicIntent(intent: IntentIr): { capability: AgentCapability; summary: string } | null {
  if (intent.domain === "gmail" && intent.action === "send") {
    const to = intent.entities.gmail?.to?.trim() ?? "";
    const subject = intent.entities.gmail?.subject?.trim() ?? "";
    const summary = [
      to ? `Voy a enviar un email a ${to}.` : "Voy a enviar un email.",
      subject ? `Asunto: ${subject}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return {
      capability: "gmail.send",
      summary,
    };
  }

  if (intent.domain === "workspace" && intent.action === "delete") {
    const target = intent.entities.workspace?.path?.trim() ?? "ese recurso del workspace";
    return {
      capability: "workspace.delete",
      summary: `Voy a borrar ${target}.`,
    };
  }

  if (intent.domain === "schedule" && intent.action === "create" && intent.entities.schedule?.automationDomain === "gmail") {
    return {
      capability: "gmail.send",
      summary: "Voy a dejar programado un envio de email.",
    };
  }

  return null;
}

function detectPlannerCapabilities(intent: IntentIr, commands: string[]): AgentCapability[] {
  const normalized = commands.map((command) => command.trim().toLowerCase());
  const capabilities: AgentCapability[] = [];

  if (
    intent.domain === "gmail" && intent.action === "send" ||
    normalized.some((command) => /^gmail-api\s+(send|reply|forward)\b/.test(command)) ||
    normalized.some((command) => /^gmail-api\s+draft\s+send\b/.test(command))
  ) {
    capabilities.push("gmail.send");
  }

  if (
    intent.domain === "workspace" && intent.action === "delete" ||
    normalized.some((command) => /(^|\s)rm\b/.test(command)) ||
    normalized.some((command) => /\b-delete\b/.test(command))
  ) {
    capabilities.push("workspace.delete");
  }

  if (commands.length > 0) {
    capabilities.push("exec");
  }

  return uniqCapabilities(capabilities);
}

export function parseApprovalReply(text: string): ApprovalReplyDecision {
  const normalized = text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return null;
  }
  if (/^(si|sí|ok|dale|listo|confirmo|confirmar|aprobar|aprobado|seguir|segui|hazlo|hacelo|mandalo|mandala)$/.test(normalized)) {
    return "approve";
  }
  if (/^(no|cancelar|cancela|cancelado|rechazar|rechazo|parar|para|frenalo|frenala)$/.test(normalized)) {
    return "deny";
  }
  return null;
}

export class ProxyCapabilityPolicy {
  constructor(private readonly options: ProxyCapabilityPolicyOptions) {}

  evaluateDeterministicIntent(params: {
    intent: IntentIr;
    approvedCapabilities?: Set<AgentCapability>;
  }): ApprovalRequirement | null {
    const derived = summarizeDeterministicIntent(params.intent);
    if (!derived) {
      return null;
    }
    if (!this.isCapabilityProtected(derived.capability)) {
      return null;
    }
    if (params.approvedCapabilities?.has(derived.capability)) {
      return null;
    }
    return {
      capability: derived.capability,
      summary: derived.summary,
      prompt: buildApprovalPrompt(derived.summary, derived.capability),
    };
  }

  evaluatePlannerCommands(params: {
    intent: IntentIr;
    plan: PlannerResponse;
    approvedCapabilities?: Set<AgentCapability>;
  }): ApprovalRequirement | null {
    const capabilities = detectPlannerCapabilities(params.intent, params.plan.commands ?? []);
    for (const capability of capabilities) {
      if (params.approvedCapabilities?.has(capability)) {
        continue;
      }
      if (!this.isCapabilityProtected(capability)) {
        continue;
      }
      const summary =
        params.plan.explanation?.trim() ||
        (capability === "gmail.send"
          ? "Voy a ejecutar una secuencia que termina enviando un email."
          : capability === "workspace.delete"
            ? "Voy a ejecutar una secuencia que borra contenido del workspace."
            : "Voy a ejecutar una secuencia operativa para completar el pedido.");
      return {
        capability,
        summary,
        prompt: buildApprovalPrompt(summary, capability),
      };
    }
    return null;
  }

  createPendingApproval(params: {
    requirement: ApprovalRequirement;
    originalObjective: string;
    activeAgent: string;
    executor: PendingApprovalState["executor"];
    plannerAttachmentHint?: string;
  }): PendingApprovalState {
    const createdAtMs = Date.now();
    return {
      capability: params.requirement.capability,
      summary: params.requirement.summary,
      originalObjective: params.originalObjective,
      activeAgent: params.activeAgent,
      executor: params.executor,
      ...(params.plannerAttachmentHint?.trim() ? { plannerAttachmentHint: params.plannerAttachmentHint.trim() } : {}),
      createdAtMs,
      expiresAtMs: createdAtMs + this.options.approvalTtlMs,
    };
  }

  private isCapabilityProtected(capability: AgentCapability): boolean {
    if (capability === "exec") {
      return this.options.requireExecApproval && this.options.policyEngine.isApprovalRequired(capability);
    }
    return this.options.policyEngine.isApprovalRequired(capability);
  }
}
