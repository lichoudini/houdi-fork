import type {
  GmailAccountStatus,
  GmailMessageDetail,
  GmailMessageSummary,
} from "../gmail-account.js";
import { humanizeObjectivePhase } from "./agentic-helpers.js";
import type {
  ObjectiveEventRecord,
  ObjectivePhase,
  ObjectiveStateRecord,
  ObjectiveStatus,
} from "./objective-state.js";
import type { ExecutedCommand } from "./types.js";

type WorkspaceEntryView = {
  name: string;
  kind: "dir" | "file" | "link" | "other";
  size?: number;
};

function truncateInline(text: string, maxChars = 220): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) {
    return clean;
  }
  return `${clean.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("es-AR").format(value);
}

function buildGmailMissingText(missing: string[]): string {
  const labels = missing
    .map((item) => {
      switch (item) {
        case "GMAIL_CLIENT_ID":
        case "GMAIL_CLIENT_SECRET":
          return "las credenciales de la app";
        case "GMAIL_REFRESH_TOKEN":
          return "la autorizacion de la cuenta";
        default:
          return "parte de la configuracion";
      }
    })
    .filter(Boolean);
  const unique = Array.from(new Set(labels));
  if (unique.length === 0) {
    return "algunos datos de configuracion";
  }
  if (unique.length === 1) {
    return unique[0] ?? "datos de configuracion";
  }
  return `${unique.slice(0, -1).join(", ")} y ${unique[unique.length - 1]}`;
}

function humanizeObjectiveStatus(status: ObjectiveStatus): string {
  switch (status) {
    case "active":
      return "en curso";
    case "success":
      return "resuelto";
    case "blocked":
      return "bloqueado";
    case "incomplete":
      return "esperando una aclaracion";
    case "cancelled":
      return "cancelado";
    case "error":
      return "con problema";
    default:
      return status;
  }
}

function humanizeObjectiveEventMessage(event: ObjectiveEventRecord): string {
  if (event.message.startsWith("deterministic:")) {
    return "resolviendolo por la via directa";
  }
  switch (event.message) {
    case "planner_request":
      return "armando el plan";
    case "planner_forced_draft_send":
      return "cerrando un envio pendiente";
    case "run_commands":
      return "haciendo el trabajo necesario";
    case "verify_request":
      return "revisando que haya quedado bien";
    case "intent_abstain":
      return "esperando una aclaracion tuya";
    case "approval_required":
      return "esperando tu confirmación para una acción sensible";
    case "deterministic_clarification":
      return "pidiendo el dato que faltaba";
    case "planner_reply":
      return "respondiendo sin ejecutar nada";
    case "intent_critic_block":
      return "frenando un plan que no cerraba";
    default:
      return event.phase === "completed"
        ? "objetivo resuelto"
        : event.phase === "blocked"
          ? "objetivo frenado"
          : event.phase === "cancelled"
            ? "objetivo cancelado"
            : truncateInline(event.message.replace(/[_:]+/g, " "), 80);
  }
}

export function buildFriendlyObjectiveStatusText(params: {
  current: ObjectiveStateRecord;
  queueDepth: number;
  events: ObjectiveEventRecord[];
}): string {
  const { current } = params;
  const lines = [
    `Estado general: ${humanizeObjectiveStatus(current.status)}.`,
    `Objetivo: ${truncateInline(current.objectiveRaw, 220)}`,
    `Ahora mismo: ${humanizeObjectivePhase(current.phase)}.`,
    `Ultima actualizacion: ${new Date(current.updatedAtMs).toLocaleString("es-AR", { hour12: false })}`,
  ];
  if (current.summary) {
    lines.push(`Ultimo resumen: ${truncateInline(current.summary, 220)}`);
  }
  if (current.cancelRequested) {
    lines.push("Hay una cancelacion pedida para este objetivo.");
  }
  if (params.queueDepth > 0) {
    lines.push(`Ademas tengo ${params.queueDepth} mensaje(s) esperando en este chat.`);
  }
  if (params.events.length > 0) {
    lines.push("Movimientos recientes:");
    for (const event of params.events.slice(0, 5)) {
      lines.push(
        `- ${new Date(event.createdAtMs).toLocaleTimeString("es-AR", { hour12: false })}: ${humanizeObjectiveEventMessage(event)}`,
      );
    }
  }
  return lines.join("\n");
}

export function buildPhaseIntroText(phase: ObjectivePhase | "status", iteration = 1): string {
  switch (phase) {
    case "planning":
      return iteration > 1
        ? "Estoy ajustando el plan porque encontre una mejor vuelta."
        : "Estoy armando la mejor manera de resolverlo.";
    case "executing":
      return "Estoy haciendo la parte operativa.";
    case "verifying":
      return "Estoy revisando que haya quedado bien.";
    case "clarify":
      return "Necesito afinar un dato antes de seguir.";
    case "intent":
      return "Estoy entendiendo bien lo que queres hacer.";
    case "queued":
      return "Ya lo puse en cola.";
    case "status":
      return "Te cuento en que quedo.";
    default:
      return `Estoy en ${humanizeObjectivePhase(phase)}.`;
  }
}

const HEARTBEAT_BY_PHASE: Record<"planning" | "executing" | "verifying", string[]> = {
  planning: [
    "Estoy ordenando las ideas. Sin humo, con tornillos.",
    "Sigo pensando la mejor jugada. Prometo no improvisar con un martillo.",
    "Estoy peleando contra varias opciones a la vez. Por ahora voy ganando.",
  ],
  executing: [
    "Estoy moviendo piezas por atras. Nada exploto de momento.",
    "Sigo con la parte pesada. El teclado ya acepto su destino.",
    "Estoy haciendo magia de la aburrida: la que despues funciona.",
  ],
  verifying: [
    "Estoy chequeando dos veces para no venderte fruta.",
    "Le estoy pasando una segunda mirada, como quien revisa si cerro el gas.",
    "Estoy validando el resultado. Desconfio sanamente de los milagros instantaneos.",
  ],
};

export function pickHeartbeatMessage(
  phase: ObjectivePhase,
  sequence: number,
): string | undefined {
  if (!(phase in HEARTBEAT_BY_PHASE)) {
    return undefined;
  }
  const bucket = HEARTBEAT_BY_PHASE[phase as keyof typeof HEARTBEAT_BY_PHASE];
  if (bucket.length === 0) {
    return undefined;
  }
  return bucket[(Math.max(1, sequence) - 1) % bucket.length];
}

export function buildVisiblePlanText(iteration: number, explanation?: string): string {
  const intro = iteration > 1 ? "Ajuste el plan para destrabarlo." : "Voy con esto:";
  const body = explanation?.trim() || "Tengo una ruta clara para resolverlo.";
  return `${intro}\n${body}`;
}

export function buildExecutionReplyText(result: ExecutedCommand): string | null {
  const command = result.command.trim().toLowerCase();
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();

  if (result.timedOut) {
    return "Una parte del trabajo tardo demasiado y la corte para no dejarte esperando de mas.";
  }

  if (result.exitCode !== 0) {
    const detail = stderr || stdout;
    if (!detail) {
      return "Una de las acciones no salio bien y no devolvio un detalle util.";
    }
    return `Una de las acciones no salio bien.\n${detail.slice(0, 1800)}`;
  }

  if (command.startsWith("gmail-api ")) {
    return null;
  }

  if (!stdout && !stderr) {
    return null;
  }

  if (stdout) {
    return stdout.slice(0, 2500);
  }

  return `Nota:\n${stderr.slice(0, 1200)}`;
}

export function buildFriendlyGmailStatusText(status: GmailAccountStatus): string {
  if (!status.enabled) {
    return "La integracion con Gmail esta apagada en este entorno.";
  }
  if (status.configured) {
    return status.accountEmail
      ? `Gmail esta listo para usar con la cuenta ${status.accountEmail}.`
      : "Gmail esta listo para usar.";
  }
  return `Todavia no puedo usar Gmail porque falta completar ${buildGmailMissingText(status.missing)}.`;
}

export function buildFriendlyGmailProfileText(profile: {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
}): string {
  return [
    `La cuenta conectada es ${profile.emailAddress}.`,
    `Tiene ${formatNumber(profile.messagesTotal)} mensajes y ${formatNumber(profile.threadsTotal)} conversaciones registradas.`,
  ].join("\n");
}

export function buildFriendlyGmailListText(messages: GmailMessageSummary[]): string {
  if (messages.length === 0) {
    return "No encontre emails para esa busqueda.";
  }
  const lines = [
    `Encontre ${messages.length} email(s). Si queres, despues podes decir "abrime el 2" o "marca como leido el 3".`,
  ];
  for (const [index, item] of messages.entries()) {
    lines.push(`${index + 1}. ${item.subject || "(sin asunto)"}`);
    lines.push(`De: ${item.from || "-"}`);
    if (item.date) {
      lines.push(`Fecha: ${item.date}`);
    }
    if (item.snippet.trim()) {
      lines.push(`Resumen: ${truncateInline(item.snippet, 180)}`);
    }
    if (index < messages.length - 1) {
      lines.push("");
    }
  }
  return lines.join("\n");
}

export function buildFriendlyGmailReadText(detail: GmailMessageDetail): string {
  const lines = [
    `Asunto: ${detail.subject || "(sin asunto)"}`,
    `De: ${detail.from || "-"}`,
  ];
  if (detail.to) {
    lines.push(`Para: ${detail.to}`);
  }
  if (detail.date) {
    lines.push(`Fecha: ${detail.date}`);
  }
  if ((detail.attachments ?? []).length > 0) {
    const attachments = detail.attachments
      .slice(0, 5)
      .map((item) => item.filename || "adjunto")
      .join(", ");
    lines.push(`Adjuntos: ${attachments}`);
  }
  lines.push("");
  lines.push(detail.bodyText || detail.snippet || "(No encontre texto legible en el cuerpo)");
  return lines.join("\n");
}

export function buildFriendlyGmailSendText(params: { to: string; subject: string }): string {
  return [
    `Listo, ya envie el email a ${params.to}.`,
    `Asunto: ${params.subject}`,
  ].join("\n");
}

export function buildFriendlyGmailModifyText(action: string): string {
  switch (action) {
    case "markread":
      return "Listo, lo marque como leido.";
    case "markunread":
      return "Listo, lo marque como no leido.";
    case "trash":
      return "Listo, lo mande a la papelera.";
    case "untrash":
      return "Listo, lo saque de la papelera.";
    case "star":
      return "Listo, lo deje destacado.";
    case "unstar":
      return "Listo, le saque el destacado.";
    default:
      return "Listo, ya hice el cambio en ese email.";
  }
}

function buildWorkspaceEntryLine(
  entry: WorkspaceEntryView,
  index: number,
  formatBytes: (bytes: number) => string,
): string {
  const kind = entry.kind === "dir" ? "carpeta" : entry.kind === "file" ? "archivo" : entry.kind;
  const suffix = entry.kind === "dir" ? "/" : "";
  const sizeText = typeof entry.size === "number" ? ` (${formatBytes(entry.size)})` : "";
  return `${index + 1}. ${kind} ${entry.name}${suffix}${sizeText}`;
}

export function buildFriendlyWorkspaceListText(params: {
  relPath: string;
  entries: WorkspaceEntryView[];
  truncated: boolean;
  formatBytes: (bytes: number) => string;
}): string {
  if (params.entries.length === 0) {
    return `En ${params.relPath} no encontre nada.`;
  }
  const lines = [`En ${params.relPath} encontre:`];
  for (const [index, entry] of params.entries.entries()) {
    lines.push(buildWorkspaceEntryLine(entry, index, params.formatBytes));
  }
  if (params.truncated) {
    lines.push("");
    lines.push("Te muestro una version resumida para no inundarte el chat.");
  }
  return lines.join("\n");
}

export function buildFriendlyWorkspaceWriteText(params: {
  relPath: string;
  size: number;
  created: boolean;
  appended?: boolean;
  formatBytes: (bytes: number) => string;
}): string {
  const verb = params.appended ? "agregue contenido a" : params.created ? "cree" : "actualice";
  return `Listo, ${verb} ${params.relPath}. Quedo en ${params.formatBytes(params.size)}.`;
}

export function buildFriendlyWorkspaceMoveText(from: string, to: string): string {
  return `Listo, movi ${from} a ${to}.`;
}

export function buildFriendlyWorkspaceDeleteText(
  relPath: string,
  kind: "dir" | "file" | "other",
): string {
  const target = kind === "dir" ? "la carpeta" : kind === "file" ? "el archivo" : "la ruta";
  return `Listo, elimine ${target} ${relPath}.`;
}

export function buildFriendlyWorkspaceReadText(params: {
  relPath: string;
  text: string;
  truncated?: boolean;
}): string {
  const lines = [`Te dejo el contenido de ${params.relPath}:`, ""];
  if (params.truncated) {
    lines.push("Te muestro un extracto porque el archivo era largo.");
    lines.push("");
  }
  lines.push(params.text || "(No encontre texto legible)");
  return lines.join("\n");
}
