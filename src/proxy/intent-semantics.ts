import { detectGmailNaturalIntent, detectGmailRecipientNaturalIntent } from "../domains/gmail/intents.js";
import type { GmailIntentDeps, GmailNaturalIntent, GmailRecipientNaturalIntent } from "../domains/gmail/intents.js";
import { normalizeRecipientName } from "../domains/gmail/recipients-manager.js";
import { createGmailTextParsers } from "../domains/gmail/text-parsers.js";
import {
  detectScheduleNaturalIntent,
  extractScheduleTaskRef,
  parseNaturalScheduleDateTime,
  type ScheduleNaturalIntent,
} from "../domains/schedule/natural.js";
import { detectSelfMaintenanceIntent, type SelfMaintenanceIntent } from "../domains/selfskill/intents.js";
import {
  detectSimpleTextExtensionHint,
  looksLikeWorkspacePathCandidate,
  parseWorkspaceFileIndexReference,
  pickFirstNonEmpty,
} from "../domains/workspace/intent-helpers.js";
import { detectWorkspaceNaturalIntent, type WorkspaceNaturalIntent } from "../domains/workspace/intents.js";
import { createWorkspaceTextParsers } from "../domains/workspace/text-parsers.js";
import type { IntentAction, IntentDomain, IntentEntities } from "./intent-types.js";
import { normalizeIntentText, stripQuotedExecutionNoise } from "./intent-text.js";

type BaseIntentSignals = {
  emails: string[];
  hasTemporalCue: boolean;
  hasTaskCue: boolean;
  hasMailCue: boolean;
  hasWorkspaceCue: boolean;
  hasWebCue: boolean;
  taskRef?: string;
};

type IntentSemanticAnalysis = {
  source: string;
  normalizedText: string;
  signals: BaseIntentSignals;
  gmailIntent: GmailNaturalIntent;
  gmailRecipientIntent: GmailRecipientNaturalIntent;
  workspaceIntent: WorkspaceNaturalIntent;
  scheduleIntent: ScheduleNaturalIntent;
  selfMaintenanceIntent: SelfMaintenanceIntent;
};

type IntentSemanticResolution = {
  action: IntentAction;
  entities: IntentEntities;
  reasons: string[];
};

type IntentEntityExtra = Partial<IntentEntities>;

const gmailTextParsers = createGmailTextParsers({
  normalizeIntentText,
  extractQuotedSegments,
  normalizeRecipientName,
  truncateInline,
  gmailMaxResults: 20,
});

const gmailIntentDeps: GmailIntentDeps = {
  normalizeIntentText,
  extractQuotedSegments,
  extractEmailAddresses: gmailTextParsers.extractEmailAddresses,
  extractRecipientNameFromText: gmailTextParsers.extractRecipientNameFromText,
  inferDefaultSelfEmailRecipient,
  detectGmailAutoContentKind,
  parseGmailLabeledFields: gmailTextParsers.parseGmailLabeledFields,
  extractLiteralBodyRequest: gmailTextParsers.extractLiteralBodyRequest,
  extractNaturalSubjectRequest: gmailTextParsers.extractNaturalSubjectRequest,
  detectCreativeEmailCue: gmailTextParsers.detectCreativeEmailCue,
  detectGmailDraftRequested: gmailTextParsers.detectGmailDraftRequested,
  buildGmailDraftInstruction: gmailTextParsers.buildGmailDraftInstruction,
  shouldAvoidLiteralBodyFallback: gmailTextParsers.shouldAvoidLiteralBodyFallback,
  parseNaturalLimit: gmailTextParsers.parseNaturalLimit,
  buildNaturalGmailQuery: gmailTextParsers.buildNaturalGmailQuery,
  get gmailAccountEmail() {
    return (process.env.GMAIL_ACCOUNT_EMAIL ?? "").trim().toLowerCase();
  },
};

const workspaceTextParsers = createWorkspaceTextParsers({
  normalizeIntentText,
  normalizeWorkspaceRelativePath,
  cleanWorkspacePathPhrase,
  extractQuotedSegments,
});

const workspaceIntentDeps = {
  normalizeIntentText,
  extractQuotedSegments,
  normalizeWorkspaceRelativePath,
  cleanWorkspacePathPhrase,
  extractSimpleFilePathCandidate,
  extractWorkspaceDeletePathCandidate: workspaceTextParsers.extractWorkspaceDeletePathCandidate,
  extractWorkspaceDeleteExtensions: workspaceTextParsers.extractWorkspaceDeleteExtensions,
  extractWorkspaceDeleteContentsPath: workspaceTextParsers.extractWorkspaceDeleteContentsPath,
  extractWorkspaceNameSelectorFromSegment: workspaceTextParsers.extractWorkspaceNameSelectorFromSegment,
  pickFirstNonEmpty,
  detectSimpleTextExtensionHint: (text: string) => detectSimpleTextExtensionHint(text, normalizeIntentText),
  resolveWorkspaceWritePathWithHint,
  extractNaturalWorkspaceWriteContent: workspaceTextParsers.extractNaturalWorkspaceWriteContent,
  looksLikeWorkspacePathCandidate: (raw: string) => looksLikeWorkspacePathCandidate(raw, normalizeWorkspaceRelativePath),
  parseWorkspaceFileIndexReference: (text: string) => parseWorkspaceFileIndexReference(text, normalizeIntentText),
};

function extractQuotedSegments(text: string): string[] {
  const pattern = /"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`/g;
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const value = (match[1] || match[2] || match[3] || "").trim();
    if (value) {
      values.push(value);
    }
  }
  return values;
}

function truncateInline(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  const trimmed = input.slice(0, Math.max(0, maxChars - 3)).trimEnd();
  return `${trimmed}...`;
}

function isValidEmailAddress(raw: string): boolean {
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(raw.trim());
}

function inferDefaultSelfEmailRecipient(text: string): string {
  const normalized = normalizeIntentText(text);
  const selfCue =
    /\b(a mi|a mí|a mi mismo|a mí mismo|a mi correo|a mí correo|a mi mail|a mi email|a mi gmail)\b/.test(normalized) ||
    (/\b(enviame|enviarme|mandame|mandarme)\b/.test(normalized) && /\b(a mi|a mí)\b/.test(normalized));
  if (!selfCue) {
    return "";
  }
  const configured = (process.env.GMAIL_ACCOUNT_EMAIL ?? "").trim().toLowerCase();
  return isValidEmailAddress(configured) ? configured : "";
}

function detectGmailAutoContentKind(
  textNormalized: string,
): "document" | "poem" | "news" | "reminders" | "stoic" | "assistant-last" | undefined {
  if (/\b(s?ultim[oa]s?|noticias?|nove(?:dad(?:es)?|ades?)|actualidad|titulares?|news)\b/.test(textNormalized)) {
    return "news";
  }
  if (/\b(poema|poesia|verso|cancion|canción)\b/.test(textNormalized)) {
    return "poem";
  }
  if (/\b(recordatorios?|tareas?\s+pendientes?)\b/.test(textNormalized)) {
    return "reminders";
  }
  if (/\b(estoico|estoicismo|stoic)\b/.test(textNormalized)) {
    return "stoic";
  }
  return undefined;
}

function normalizeWorkspaceRelativePath(raw: string): string {
  const value = raw.trim().replace(/^workspace\//i, "").replace(/^\/+/, "");
  if (!value) {
    return "";
  }
  const cleaned = value
    .replace(/\\/g, "/")
    .replace(/\s+/g, " ")
    .replace(/[,:;!?]+$/g, "")
    .trim();
  return cleaned;
}

function cleanWorkspacePathPhrase(raw: string): string {
  const rawTrimmed = raw.trim();
  const trailingDots = rawTrimmed.match(/\.{2,}$/)?.[0] ?? "";
  const cleaned = rawTrimmed
    .trim()
    .replace(/^[\s:.,;!?¿¡-]+|[\s:.,;!?¿¡-]+$/g, "")
    .replace(/\s+(?:en|a|hacia)\s*$/i, "");
  const normalized = normalizeWorkspaceRelativePath(cleaned);
  if (!normalized || !trailingDots) {
    return normalized;
  }
  if (normalized.endsWith(trailingDots)) {
    return normalized;
  }
  return `${normalized}${trailingDots}`;
}

function extractSimpleFilePathCandidate(text: string): string {
  const matches = text.matchAll(/\b[\w./-]+\.[a-z0-9]{2,8}\b/gi);
  for (const match of matches) {
    const token = match[0] ?? "";
    if (!token) {
      continue;
    }
    const start = typeof match.index === "number" ? match.index : text.indexOf(token);
    const before = start > 0 ? text[start - 1] ?? "" : "";
    const after = start >= 0 ? text[start + token.length] ?? "" : "";
    if (before === "@" || after === "@") {
      continue;
    }
    return normalizeWorkspaceRelativePath(token);
  }
  return "";
}

function resolveWorkspaceWritePathWithHint(rawPath: string, extensionHint?: string): string {
  const base = normalizeWorkspaceRelativePath(rawPath);
  if (!base) {
    return "";
  }
  if (/\.[a-z0-9]{2,8}$/i.test(base) || !extensionHint) {
    return base;
  }
  return `${base}${extensionHint}`;
}

function createBaseSignals(params: {
  source: string;
  normalizedText: string;
  emails: string[];
  gmailIntent: GmailNaturalIntent;
  gmailRecipientIntent: GmailRecipientNaturalIntent;
  workspaceIntent: WorkspaceNaturalIntent;
  scheduleIntent: ScheduleNaturalIntent;
}): BaseIntentSignals {
  const temporalParsed = parseNaturalScheduleDateTime(params.source);
  const taskRef = params.scheduleIntent.taskRef ?? extractScheduleTaskRef(params.source) ?? undefined;
  const hasMailCue =
    params.gmailRecipientIntent.shouldHandle ||
    params.gmailIntent.shouldHandle ||
    params.emails.length > 0 ||
    /\b(correo|mail|email|gmail|destinatario|asunto|bcc|cc|cco)\b/.test(params.normalizedText);
  const hasWorkspaceCue =
    params.workspaceIntent.shouldHandle ||
    /\b(archivo|archivos|carpeta|carpetas|directorio|workspace|txt|csv|json|md|pdf|docx|xlsx)\b/.test(params.normalizedText);
  const hasWebCue = /\b(web|internet|google|noticias|news|buscar|url|link)\b/.test(params.normalizedText);

  return {
    emails: params.emails,
    hasTemporalCue:
      Boolean(params.scheduleIntent.dueAt) ||
      temporalParsed.hasTemporalSignal ||
      Boolean(params.scheduleIntent.automationInstruction),
    hasTaskCue: params.scheduleIntent.shouldHandle || Boolean(taskRef),
    hasMailCue,
    hasWorkspaceCue,
    hasWebCue,
    ...(taskRef ? { taskRef } : {}),
  };
}

function normalizeDetectedGmailIntent(
  source: string,
  normalizedText: string,
  emails: string[],
  intent: GmailNaturalIntent,
): GmailNaturalIntent {
  const hasSendVerb = /\b(envi\w*|mand\w*|escrib\w*|redact\w*|respond\w*)\b/.test(normalizedText);
  const hasExplicitPayload =
    emails.length > 0 || /\b(asunto|subject|mensaje|body|cc|bcc|destinatario)\s*[:=-]?\b/.test(normalizedText);
  if (!(intent.shouldHandle && intent.action === "status" && hasSendVerb && hasExplicitPayload)) {
    return intent;
  }

  const labeled = gmailTextParsers.parseGmailLabeledFields(source);
  const to = emails[0] ?? inferDefaultSelfEmailRecipient(source) ?? "";
  const subject =
    labeled.subject ||
    gmailTextParsers.extractNaturalSubjectRequest(source) ||
    "Mensaje desde Houdi Agent";
  const body =
    labeled.body ||
    gmailTextParsers.extractLiteralBodyRequest(source) ||
    "Mensaje enviado desde Houdi Agent.";

  return {
    shouldHandle: true,
    action: "send",
    ...(to ? { to } : {}),
    subject,
    body,
    ...(labeled.cc ? { cc: labeled.cc } : {}),
    ...(labeled.bcc ? { bcc: labeled.bcc } : {}),
  };
}

export function analyzeIntentSignals(rawText: string): IntentSemanticAnalysis {
  const source = stripQuotedExecutionNoise(rawText);
  const normalizedText = normalizeIntentText(source);
  const gmailRecipientIntent = detectGmailRecipientNaturalIntent(source, gmailIntentDeps);
  const emails = gmailTextParsers.extractEmailAddresses(source);
  const gmailIntent = normalizeDetectedGmailIntent(
    source,
    normalizedText,
    emails,
    detectGmailNaturalIntent(source, gmailIntentDeps),
  );
  const workspaceIntent = detectWorkspaceNaturalIntent(source, workspaceIntentDeps);
  const scheduleIntent = detectScheduleNaturalIntent(source);
  const selfMaintenanceIntent = detectSelfMaintenanceIntent(source);
  const signals = createBaseSignals({
    source,
    normalizedText,
    emails,
    gmailIntent,
    gmailRecipientIntent,
    workspaceIntent,
    scheduleIntent,
  });
  return {
    source,
    normalizedText,
    signals,
    gmailIntent,
    gmailRecipientIntent,
    workspaceIntent,
    scheduleIntent,
    selfMaintenanceIntent,
  };
}

function mapGenericActionForText(normalizedText: string, domain: IntentDomain): IntentAction {
  if (domain === "workspace") {
    if (/\b(resumi|resume|analiza|analizar|extrae|extraer|que dice|leer documento|abrir documento|contrato|pdf|docx)\b/.test(normalizedText)) {
      return "read";
    }
  }
  if (domain === "web") {
    if (/\b(abre|abrir|open|ver|revisa|leer)\b/.test(normalizedText) && /\b(url|link|sitio|pagina|página)\b/.test(normalizedText)) {
      return "read";
    }
    return /\b(busca|buscar|search|google|noticias|news)\b/.test(normalizedText) ? "search" : "read";
  }
  if (domain === "memory") {
    if (/\b(acordate|acordate de|recorda esto|guarda en memoria|memoriza|no te olvides)\b/.test(normalizedText)) {
      return "create";
    }
    if (/\b(busca|buscar)\b/.test(normalizedText)) {
      return "search";
    }
    if (/\b(te acordas|te acuerdas|recordas|recuerdas|que recuerdas|que sabes|habiamos hablado)\b/.test(normalizedText)) {
      return "read";
    }
    return "chat";
  }
  if (/\b(elimina|eliminar|borra|borrar|quita|quitar|remove|delete|cancela|cancelar)\b/.test(normalizedText)) {
    return "delete";
  }
  if (/\b(edita|editar|cambia|cambiar|modifica|modificar|reprograma|reprogramar|actualiza|actualizar)\b/.test(normalizedText)) {
    return "edit";
  }
  if (/\b(lista|listar|muestra|mostrar|ver|consulta|consultar)\b/.test(normalizedText)) {
    return "list";
  }
  if (/\b(crea|crear|genera|generar|armar|redacta|redactar|escribe|escribir|recorda|recordame|recordar|agenda|agendar|programa|programar)\b/.test(normalizedText)) {
    return "create";
  }
  if (/\b(envia|enviar|manda|mandar|mandalo|mandala|send)\b/.test(normalizedText)) {
    return "send";
  }
  if (/\b(busca|buscar|search|investiga|investigar)\b/.test(normalizedText)) {
    return "search";
  }
  if (/\b(lee|leer|abre|abrir)\b/.test(normalizedText)) {
    return "read";
  }
  return "chat";
}

function resolveGmailActionAndEntities(analysis: IntentSemanticAnalysis): { action: IntentAction; extra: IntentEntityExtra; reasons: string[] } | null {
  if (analysis.gmailRecipientIntent.shouldHandle) {
    const recipientAction = analysis.gmailRecipientIntent.action;
    const action: IntentAction =
      recipientAction === "list"
        ? "list"
        : recipientAction === "delete"
          ? "delete"
          : recipientAction === "update"
            ? "edit"
            : "create";
    return {
      action,
      extra: {
        gmail: {
          kind: "recipients",
          action: recipientAction,
          ...(analysis.gmailRecipientIntent.name ? { recipientName: analysis.gmailRecipientIntent.name } : {}),
          ...(analysis.gmailRecipientIntent.email ? { to: analysis.gmailRecipientIntent.email } : {}),
        },
      },
      reasons: [`gmail_recipients_action=${recipientAction ?? "none"}`],
    };
  }
  if (!analysis.gmailIntent.shouldHandle) {
    return null;
  }
  const gmailAction = analysis.gmailIntent.action;
  const action: IntentAction =
    gmailAction === "send"
      ? "send"
      : gmailAction === "read"
        ? "read"
        : gmailAction === "list" || gmailAction === "status" || gmailAction === "profile"
          ? "list"
          : gmailAction === "trash"
            ? "delete"
            : "edit";
  return {
    action,
    extra: {
      gmail: {
        kind: "message",
        action: gmailAction,
        ...(analysis.gmailIntent.to ? { to: analysis.gmailIntent.to } : {}),
        ...(analysis.gmailIntent.subject ? { subject: analysis.gmailIntent.subject } : {}),
        ...(analysis.gmailIntent.body ? { body: analysis.gmailIntent.body } : {}),
        ...(analysis.gmailIntent.cc ? { cc: analysis.gmailIntent.cc } : {}),
        ...(analysis.gmailIntent.bcc ? { bcc: analysis.gmailIntent.bcc } : {}),
        ...(analysis.gmailIntent.query ? { query: analysis.gmailIntent.query } : {}),
        ...(analysis.gmailIntent.recipientName ? { recipientName: analysis.gmailIntent.recipientName } : {}),
        ...(analysis.gmailIntent.messageId ? { messageId: analysis.gmailIntent.messageId } : {}),
        ...(typeof analysis.gmailIntent.messageIndex === "number" ? { messageIndex: analysis.gmailIntent.messageIndex } : {}),
        ...(typeof analysis.gmailIntent.draftRequested === "boolean" ? { draftRequested: analysis.gmailIntent.draftRequested } : {}),
        ...(analysis.gmailIntent.autoContentKind ? { autoContentKind: analysis.gmailIntent.autoContentKind } : {}),
      },
    },
    reasons: [`gmail_action=${gmailAction ?? "none"}`],
  };
}

function resolveWorkspaceActionAndEntities(
  analysis: IntentSemanticAnalysis,
): { action: IntentAction; extra: IntentEntityExtra; reasons: string[] } | null {
  if (!analysis.workspaceIntent.shouldHandle) {
    return null;
  }
  const workspaceAction = analysis.workspaceIntent.action;
  let action: IntentAction = "edit";
  if (workspaceAction === "list") {
    action = "list";
  } else if (workspaceAction === "read") {
    action = "read";
  } else if (workspaceAction === "delete") {
    action = "delete";
  } else if (workspaceAction === "send") {
    action = "send";
  } else if (workspaceAction === "mkdir") {
    action = "create";
  } else if (workspaceAction === "write") {
    const isEditLike =
      Boolean(analysis.workspaceIntent.append) ||
      /\b(edit|editar|modific|actualiz|complet|agreg|anex|append|insert)\b/.test(analysis.normalizedText);
    action = isEditLike ? "edit" : "create";
  }
  return {
    action,
    extra: {
      workspace: {
        action: workspaceAction,
        ...(analysis.workspaceIntent.path ? { path: analysis.workspaceIntent.path } : {}),
        ...(analysis.workspaceIntent.sourcePath ? { sourcePath: analysis.workspaceIntent.sourcePath } : {}),
        ...(analysis.workspaceIntent.targetPath ? { targetPath: analysis.workspaceIntent.targetPath } : {}),
        ...(analysis.workspaceIntent.selector ? { selector: analysis.workspaceIntent.selector } : {}),
        ...(analysis.workspaceIntent.deleteExtensions ? { deleteExtensions: analysis.workspaceIntent.deleteExtensions } : {}),
        ...(analysis.workspaceIntent.deleteContentsOfPath ? { deleteContentsOfPath: analysis.workspaceIntent.deleteContentsOfPath } : {}),
        ...(analysis.workspaceIntent.append ? { append: true } : {}),
        ...(typeof analysis.workspaceIntent.fileIndex === "number" ? { fileIndex: analysis.workspaceIntent.fileIndex } : {}),
        ...(analysis.workspaceIntent.formatHint ? { formatHint: analysis.workspaceIntent.formatHint } : {}),
        ...(analysis.workspaceIntent.content ? { hasContent: true } : {}),
        ...(analysis.workspaceIntent.content ? { content: analysis.workspaceIntent.content } : {}),
      },
    },
    reasons: [`workspace_action=${workspaceAction ?? "none"}`],
  };
}

function resolveScheduleActionAndEntities(
  analysis: IntentSemanticAnalysis,
): { action: IntentAction; extra: IntentEntityExtra; reasons: string[] } | null {
  if (!analysis.scheduleIntent.shouldHandle) {
    return null;
  }
  return {
    action: analysis.scheduleIntent.action ?? "create",
    extra: {
      ...(analysis.scheduleIntent.taskRef ? { taskRef: analysis.scheduleIntent.taskRef } : {}),
      schedule: {
        action: analysis.scheduleIntent.action,
        ...(analysis.scheduleIntent.taskTitle ? { taskTitle: analysis.scheduleIntent.taskTitle } : {}),
        ...(analysis.scheduleIntent.dueAt ? { dueAt: analysis.scheduleIntent.dueAt } : {}),
        ...(analysis.scheduleIntent.automationInstruction ? { automationInstruction: analysis.scheduleIntent.automationInstruction } : {}),
        ...(analysis.scheduleIntent.automationDomain ? { automationDomain: analysis.scheduleIntent.automationDomain } : {}),
        ...(analysis.scheduleIntent.automationRecurrenceDaily ? { automationRecurrenceDaily: true } : {}),
      },
    },
    reasons: [
      `schedule_action=${analysis.scheduleIntent.action ?? "none"}`,
      ...(analysis.scheduleIntent.dueAt ? [`schedule_due=${analysis.scheduleIntent.dueAt.toISOString()}`] : []),
      ...(analysis.scheduleIntent.automationDomain ? [`schedule_automation=${analysis.scheduleIntent.automationDomain}`] : []),
    ],
  };
}

function resolveSelfMaintenanceActionAndEntities(
  analysis: IntentSemanticAnalysis,
): { action: IntentAction; extra: IntentEntityExtra; reasons: string[] } | null {
  if (!analysis.selfMaintenanceIntent.shouldHandle) {
    return null;
  }
  const action: IntentAction =
    analysis.selfMaintenanceIntent.action === "list-skills"
      ? "list"
      : analysis.selfMaintenanceIntent.action === "delete-skill"
        ? "delete"
        : analysis.selfMaintenanceIntent.action === "add-skill"
          ? "create"
          : "edit";
  return {
    action,
    extra: {
      selfMaintenance: {
        action: analysis.selfMaintenanceIntent.action,
        ...(analysis.selfMaintenanceIntent.instruction ? { instruction: analysis.selfMaintenanceIntent.instruction } : {}),
        ...(typeof analysis.selfMaintenanceIntent.skillIndex === "number" ? { skillIndex: analysis.selfMaintenanceIntent.skillIndex } : {}),
        ...(analysis.selfMaintenanceIntent.skillRef ? { skillRef: analysis.selfMaintenanceIntent.skillRef } : {}),
      },
    },
    reasons: [`self_maintenance_action=${analysis.selfMaintenanceIntent.action ?? "none"}`],
  };
}

function mergeEntities(base: BaseIntentSignals, extra: IntentEntityExtra): IntentEntities {
  const {
    emails: _ignoredEmails,
    hasTemporalCue: _ignoredHasTemporalCue,
    hasTaskCue: _ignoredHasTaskCue,
    hasMailCue: _ignoredHasMailCue,
    hasWorkspaceCue: _ignoredHasWorkspaceCue,
    hasWebCue: _ignoredHasWebCue,
    ...rest
  } = extra;
  return {
    emails: [...base.emails],
    hasTemporalCue: base.hasTemporalCue,
    hasTaskCue: base.hasTaskCue,
    hasMailCue: base.hasMailCue,
    hasWorkspaceCue: base.hasWorkspaceCue,
    hasWebCue: base.hasWebCue,
    ...(base.taskRef ? { taskRef: base.taskRef } : {}),
    ...rest,
  };
}

export function resolveIntentActionAndEntities(params: {
  domain: IntentDomain;
  analysis: IntentSemanticAnalysis;
}): IntentSemanticResolution {
  const { domain, analysis } = params;
  const specific =
    domain === "gmail"
      ? resolveGmailActionAndEntities(analysis)
      : domain === "workspace"
        ? resolveWorkspaceActionAndEntities(analysis)
        : domain === "schedule"
          ? resolveScheduleActionAndEntities(analysis)
          : domain === "self-maintenance"
            ? resolveSelfMaintenanceActionAndEntities(analysis)
            : null;

  const action = specific?.action ?? mapGenericActionForText(analysis.normalizedText, domain);
  const fallbackExtra: IntentEntityExtra =
    !specific && domain === "workspace" && action === "read"
      ? { workspace: { action: "read" } }
      : {};
  const entities = mergeEntities(analysis.signals, specific?.extra ?? fallbackExtra);
  const reasons = specific?.reasons ?? [`generic_action=${action}`];

  return { action, entities, reasons };
}
