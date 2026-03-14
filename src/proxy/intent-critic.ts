import type { IntentIr } from "./intent-ir.js";
import type { PlannerResponse } from "./types.js";

export type IntentCriticSeverity = "low" | "medium" | "high";

export type IntentCriticDecision = {
  allow: boolean;
  severity: IntentCriticSeverity;
  reason: string;
  clarification?: string;
  blockedCommand?: string;
};

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function containsShellOperators(command: string): boolean {
  return /\|\||&&|\||;|`|>>|>|<|\$\(/.test(command);
}

function detectDangerousCommand(command: string): string | null {
  const normalized = normalize(command);
  if (!normalized) {
    return null;
  }
  if (containsShellOperators(command)) {
    return "contiene operadores de shell no permitidos";
  }
  if (/\b(rm\s+-rf|rm\s+-fr)\b/.test(normalized)) {
    return "contiene borrado destructivo";
  }
  if (/\b(shutdown|reboot|poweroff|halt)\b/.test(normalized)) {
    return "contiene comando de apagado/reinicio";
  }
  if (/\b(mkfs|fdisk|parted|dd\s+if=\/dev\/)\b/.test(normalized)) {
    return "contiene comando de disco de alto riesgo";
  }
  return null;
}

function isGmailCommand(command: string): boolean {
  return normalize(command).startsWith("gmail-api ");
}

function isWebApiCommand(command: string): boolean {
  const normalized = normalize(command);
  return normalized.startsWith("curl ") && normalized.includes("/api/web/");
}

function hasMailCue(text: string): boolean {
  const normalized = normalize(text);
  return (
    /\b(correo|mail|email|gmail|destinatario|asunto|cc|bcc|cco)\b/.test(normalized) ||
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
  );
}

function hasTemporalCue(text: string): boolean {
  const normalized = normalize(text);
  return /\b(hoy|manana|mañana|en\s+\d+|a\s+las|hora|minuto|dia|dias|semanal|diario)\b/.test(normalized);
}

function commandsContainGmailSend(commands: string[]): boolean {
  return commands.some((command) => {
    const normalized = normalize(command);
    return normalized.startsWith("gmail-api send ") || normalized.startsWith("gmail-api draft send ");
  });
}

function commandsContainOnlyNonGmail(commands: string[]): boolean {
  return commands.every((command) => !isGmailCommand(command));
}

function hasScheduleVsGmailConflict(intent: IntentIr): boolean {
  return intent.ambiguousDomains.includes("schedule") && intent.ambiguousDomains.includes("gmail");
}

export function critiquePlannedCommands(params: {
  intent: IntentIr;
  objective: string;
  plan: PlannerResponse;
}): IntentCriticDecision {
  if (params.plan.action !== "commands") {
    return {
      allow: true,
      severity: "low",
      reason: "plan_sin_comandos",
    };
  }

  const commands = params.plan.commands ?? [];
  if (commands.length === 0) {
    return {
      allow: false,
      severity: "high",
      reason: "plan_comandos_vacio",
      clarification: "No recibí comandos válidos para ejecutar. Reformulo y continúo.",
    };
  }

  for (const command of commands) {
    const dangerousReason = detectDangerousCommand(command);
    if (dangerousReason) {
      return {
        allow: false,
        severity: "high",
        reason: `comando_riesgoso:${dangerousReason}`,
        blockedCommand: command,
        clarification:
          "Detuve la ejecución porque el plan incluye un comando riesgoso o con sintaxis no permitida. Reformulá el pedido en pasos más específicos.",
      };
    }
  }

  const objectiveHasMailCue = hasMailCue(params.objective);
  const objectiveHasTemporalCue = hasTemporalCue(params.objective);
  const gmailCommands = commands.filter((command) => isGmailCommand(command));
  const webCommands = commands.filter((command) => isWebApiCommand(command));

  if (hasScheduleVsGmailConflict(params.intent) && gmailCommands.length > 0 && !objectiveHasTemporalCue) {
    return {
      allow: false,
      severity: "high",
      reason: "ambiguedad_schedule_gmail",
      clarification:
        "Antes de ejecutar: ¿querés que lo deje como recordatorio interno (tarea) o que envíe un email ahora?",
      blockedCommand: gmailCommands[0],
    };
  }

  if (params.intent.domain === "schedule" && gmailCommands.length > 0 && !objectiveHasMailCue) {
    return {
      allow: false,
      severity: "high",
      reason: "desvio_schedule_hacia_gmail",
      clarification: "El pedido parece de recordatorio/tarea. Confirmame si querés ejecutar acciones de Gmail.",
      blockedCommand: gmailCommands[0],
    };
  }

  if (
    params.intent.domain === "gmail" &&
    params.intent.action === "send" &&
    commandsContainOnlyNonGmail(commands) &&
    webCommands.length === 0
  ) {
    return {
      allow: false,
      severity: "medium",
      reason: "gmail_send_sin_comando_gmail",
      clarification:
        "El objetivo parece enviar un email, pero el plan no incluye comandos de Gmail. ¿Querés que lo envíe ahora o solo preparar contenido?",
    };
  }

  if (
    params.intent.domain === "gmail" &&
    params.intent.action === "send" &&
    !commandsContainGmailSend(commands) &&
    commands.some((command) => normalize(command).startsWith("gmail-api draft create "))
  ) {
    return {
      allow: true,
      severity: "low",
      reason: "draft_detectado_seguira_envio",
    };
  }

  return {
    allow: true,
    severity: "low",
    reason: "plan_aprobado",
  };
}
