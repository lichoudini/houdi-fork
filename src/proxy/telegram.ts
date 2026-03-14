import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createReadStream } from "node:fs";
import { ChatMessageQueue } from "../chat-message-queue.js";
import { DocumentReader } from "../document-reader.js";
import { GmailAccountService } from "../gmail-account.js";
import { Bot, GrammyError, HttpError, InputFile, type Context } from "grammy";
import OpenAI from "openai";
import type { AgentProfile } from "../agents.js";
import { AgentPolicyEngine } from "../agent-policy.js";
import { WorkspaceFilesService } from "../domains/workspace/workspace-files-service.js";
import { detectGmailNaturalIntent } from "../domains/gmail/intents.js";
import { normalizeRecipientName } from "../domains/gmail/recipients-manager.js";
import { createGmailTextParsers } from "../domains/gmail/text-parsers.js";
import {
  detectScheduledAutomationIntent,
  type ScheduledAutomationDomain,
} from "../domains/schedule/automation-intent.js";
import { logError, logInfo, logWarn } from "../logger.js";
import { ScheduledTaskSqliteService } from "../scheduled-tasks-sqlite.js";
import { type WebSearchResult, WebBrowser } from "../web-browser.js";
import { humanizeObjectivePhase } from "./agentic-helpers.js";
import {
  createDeterministicIntentHandler,
  createNaturalScheduleHandler,
  createProxyActionRegistry,
} from "./domain-action-handlers.js";
import {
  updateSemanticReferences,
} from "./clarification-engine.js";
import { proxyConfig } from "./config.js";
import { ProxyCapabilityPolicy, parseApprovalReply } from "./capability-policy.js";
import { IntentBiasStore } from "./intent-bias.js";
import { buildIntentIr, stripQuotedExecutionNoise, type IntentIr } from "./intent-ir.js";
import { ProxyObjectiveStateStore, type ObjectivePhase, type ObjectiveSlots } from "./objective-state.js";
import { createObjectiveExecutionRunner, type ObjectiveRunController } from "./objective-execution.js";
import { IntentTelemetry } from "./intent-telemetry.js";
import { buildObjectiveFromUserTextAndReplyQuote, extractReplyTextFromTelegramEnvelope } from "./reply-quote.js";
import { createProxyRuntime } from "./runtime.js";
import type { ExecutedCommand, PlannerResponse } from "./types.js";
import {
  buildExecutionReplyText,
  buildFriendlyGmailSendText,
  buildFriendlyObjectiveStatusText,
  pickHeartbeatMessage,
} from "./user-facing.js";
import { presentListingResultForWorkspace, resolveWorkspaceHashtagsInText } from "./workspace-listing.js";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
]);

const MAX_TELEGRAM_UPLOAD_BYTES = 49_000_000;
const SIMPLE_TEXT_EXTENSIONS = new Set([".txt", ".json", ".md", ".csv", ".jsonl", ".log", ".yaml", ".yml", ".xml", ".html", ".htm"]);

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${Math.max(0, Math.floor(bytes || 0))}b`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}kb`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}mb`;
}

function normalizeWorkspaceRelativePath(raw: string): string {
  const value = raw.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (!value || value === ".") {
    return "";
  }
  return value.replace(/^workspace\//i, "").replace(/^\.\/+/, "");
}

function isSimpleTextFilePath(relativePath: string): boolean {
  return SIMPLE_TEXT_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

async function safePathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseBooleanEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (typeof raw !== "string") {
    return defaultValue;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on", "si", "sí", "s"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "n"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function createWorkspaceFilesService(agent: AgentProfile): WorkspaceFilesService {
  const workspaceRoot = path.resolve(process.cwd(), agent.cwd);
  return new WorkspaceFilesService(
    workspaceRoot,
    normalizeWorkspaceRelativePath,
    isSimpleTextFilePath,
    formatBytes,
    safePathExists,
    SIMPLE_TEXT_EXTENSIONS,
  );
}

function createDocumentReader(agent: AgentProfile): DocumentReader {
  const workspaceRoot = path.resolve(process.cwd(), agent.cwd);
  return new DocumentReader({
    baseDir: workspaceRoot,
    maxFileBytes: 20_000_000,
    maxTextChars: 20_000,
  });
}

async function expandWorkspacePathForDirectUse(
  service: WorkspaceFilesService,
  rawPath: string | undefined,
  options?: { allowFuzzy?: boolean; extensionFilters?: string[] },
): Promise<string> {
  const normalized = normalizeWorkspaceRelativePath(rawPath ?? "");
  if (!normalized) {
    return "";
  }
  if (service.hasEllipsisPathPlaceholder(normalized)) {
    const resolved = await service.resolveEllipsisPathPlaceholder(normalized);
    return resolved.resolvedPath;
  }
  if (options?.allowFuzzy) {
    const resolved = await service.resolveExistingPathCandidate(normalized, options);
    if (resolved.ambiguous) {
      throw new Error(`Ruta ambigua. Coincidencias: ${resolved.matches.slice(0, 8).join(", ")}`);
    }
    if (resolved.matches.length > 0) {
      return resolved.resolvedPath;
    }
  }
  return normalized;
}

function buildWebResultsListText(query: string, hits: WebSearchResult[]): string {
  const lines = [`Resultados web para: ${query}`];
  hits.forEach((hit, index) => {
    lines.push(`${index + 1}. ${truncateInline(hit.title || hit.url, 140)}`);
    lines.push(`url: ${hit.url}`);
    if (hit.snippet.trim()) {
      lines.push(`detalle: ${truncateInline(hit.snippet, 220)}`);
    }
  });
  return lines.join("\n");
}

function createGmailAccountService(): GmailAccountService {
  return new GmailAccountService({
    enabled: parseBooleanEnv(process.env.ENABLE_GMAIL_ACCOUNT, Boolean(process.env.GMAIL_REFRESH_TOKEN)),
    clientId: process.env.GMAIL_CLIENT_ID?.trim(),
    clientSecret: process.env.GMAIL_CLIENT_SECRET?.trim(),
    refreshToken: process.env.GMAIL_REFRESH_TOKEN?.trim(),
    accountEmail: process.env.GMAIL_ACCOUNT_EMAIL?.trim(),
    maxResults: Number.parseInt(process.env.GMAIL_MAX_RESULTS ?? "", 10) || 10,
  });
}

function chunkText(input: string, maxChars = 3500): string[] {
  const text = input.trim();
  if (!text) {
    return [];
  }
  const out: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    out.push(text.slice(cursor, cursor + maxChars));
    cursor += maxChars;
  }
  return out;
}

function isAllowedUser(userId: number): boolean {
  if (proxyConfig.telegramAllowedUserIds.size === 0) {
    return true;
  }
  return proxyConfig.telegramAllowedUserIds.has(userId);
}

function normalizeTelegramCommand(raw: string): string {
  const normalized = raw.trim();
  return normalized.replace(/^\/([a-z]+)@[A-Za-z0-9_]+(?=\s|$)/i, "/$1");
}

function formatHelp(activeAgent: AgentProfile): string {
  return [
    "Houdi Proxy (Telegram)",
    `Agente activo: ${activeAgent.name}`,
    "",
    "Comandos:",
    "/help - ayuda",
    "/agents - listar agentes",
    "/agent <nombre> - cambiar agente activo",
    "/task - listar tareas programadas",
    "/task add <cuando> | <detalle|accion>",
    "/task del <n|id|last>",
    "/task edit <n|id> | <nuevo cuando> | <nuevo detalle opcional>",
    "/adjuntar <archivo|#tag> - enviar adjunto desde workspace",
    "/status - ver estado del objetivo actual o último",
    "/cancel - cancelar el objetivo activo",
    "",
    "Luego escribe un objetivo natural y el agente:",
    "1) piensa una ruta razonable",
    "2) hace el trabajo necesario",
    "3) te devuelve un resultado entendible",
    "",
    "Tambien puedes adjuntar imagenes para analisis.",
    "Tambien puedes enviar audios para transcribir y ejecutar acciones.",
  ].join("\n");
}

function extractTextOutput(response: unknown): string {
  const fromTopLevel =
    typeof (response as { output_text?: unknown })?.output_text === "string"
      ? (response as { output_text: string }).output_text.trim()
      : "";
  if (fromTopLevel) {
    return fromTopLevel;
  }

  const output = (response as { output?: unknown })?.output;
  if (!Array.isArray(output)) {
    return "";
  }

  const chunks: string[] = [];
  for (const item of output) {
    const content = (item as { content?: unknown })?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if ((part as { type?: unknown })?.type !== "output_text") {
        continue;
      }
      const text = (part as { text?: unknown })?.text;
      if (typeof text === "string" && text.trim()) {
        chunks.push(text.trim());
      }
    }
  }

  return chunks.join("\n\n").trim();
}

function toHashtagToken(rawPath: string): string {
  const normalized = rawPath
    .replace(/\/+$/g, "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "archivo";
}

function fileReference(pathInWorkspace: string): string {
  const cleanPath = pathInWorkspace.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!cleanPath) {
    return "#archivo";
  }
  const tag = /\s/.test(cleanPath) ? toHashtagToken(cleanPath) : cleanPath;
  return `${cleanPath} #${tag}`;
}

function extensionFromMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpeg" || normalized === "image/jpg") {
    return ".jpg";
  }
  if (normalized === "image/png") {
    return ".png";
  }
  if (normalized === "image/webp") {
    return ".webp";
  }
  if (normalized === "image/gif") {
    return ".gif";
  }
  if (normalized === "image/bmp") {
    return ".bmp";
  }
  if (normalized === "image/tiff") {
    return ".tiff";
  }
  if (normalized === "image/heic") {
    return ".heic";
  }
  if (normalized === "image/heif") {
    return ".heif";
  }
  return ".img";
}

function isImagePath(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(extension);
}

function sanitizeFileName(rawName: string): string {
  const normalized = rawName
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
  return normalized || "imagen";
}

function safeRelativePath(rawValue: string): string {
  const trimmed = rawValue.trim().replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
  const noPrefix = trimmed.replace(/^\.\/+/, "");
  return noPrefix;
}

function resolveWorkspaceFile(agent: AgentProfile, rawPath: string): { absolutePath: string; relativePath: string } {
  const workspaceRoot = path.resolve(process.cwd(), agent.cwd);
  const requested = safeRelativePath(rawPath);
  if (!requested) {
    throw new Error("Falta el archivo a adjuntar. Usa /adjuntar <archivo|#tag>.");
  }
  const absolutePath = path.resolve(workspaceRoot, requested);
  if (absolutePath !== workspaceRoot && !absolutePath.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error("Solo se pueden adjuntar archivos dentro del workspace del agente.");
  }
  const relativePath = path.relative(workspaceRoot, absolutePath).replace(/\\/g, "/");
  return { absolutePath, relativePath };
}

async function findLatestWorkspaceImage(agent: AgentProfile): Promise<string | null> {
  const workspaceRoot = path.resolve(process.cwd(), agent.cwd);
  await fs.mkdir(workspaceRoot, { recursive: true });

  let latest: { relativePath: string; mtimeMs: number } | null = null;
  const queue: Array<{ absoluteDir: string; relativeDir: string }> = [{ absoluteDir: workspaceRoot, relativeDir: "" }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const entries = await fs.readdir(current.absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = current.relativeDir ? `${current.relativeDir}/${entry.name}` : entry.name;
      const absolutePath = path.join(current.absoluteDir, entry.name);
      if (entry.isDirectory()) {
        queue.push({ absoluteDir: absolutePath, relativeDir: relativePath });
        continue;
      }
      if (!entry.isFile() || !isImagePath(entry.name)) {
        continue;
      }
      const stats = await fs.stat(absolutePath);
      if (!latest || stats.mtimeMs > latest.mtimeMs) {
        latest = { relativePath, mtimeMs: stats.mtimeMs };
      }
    }
  }

  return latest?.relativePath ?? null;
}

async function sendWorkspaceAttachment(ctx: Context, agent: AgentProfile, rawPath: string): Promise<string> {
  const { absolutePath, relativePath } = resolveWorkspaceFile(agent, rawPath);
  const stats = await fs.stat(absolutePath);
  if (!stats.isFile()) {
    throw new Error(`No es un archivo: ${relativePath}`);
  }
  if (stats.size > MAX_TELEGRAM_UPLOAD_BYTES) {
    throw new Error(`Archivo demasiado grande para Telegram (${stats.size} bytes).`);
  }

  const caption = `Adjunto: ${fileReference(relativePath)}`;
  const buildInputFile = (): InputFile => new InputFile(absolutePath);
  const looksLikeImage = isImagePath(absolutePath);

  if (looksLikeImage && stats.size <= 9_500_000) {
    try {
      await ctx.replyWithPhoto(buildInputFile(), { caption });
      return relativePath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`No pude enviar como foto (${relativePath}). Reintento como documento. Detalle: ${message}`);
    }
  }

  await ctx.replyWithDocument(buildInputFile(), { caption });
  return relativePath;
}

async function downloadTelegramFileBuffer(params: {
  botToken: string;
  filePath: string;
  maxBytes: number;
}): Promise<Buffer> {
  const fileUrl = `https://api.telegram.org/file/bot${params.botToken}/${params.filePath}`;
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`No pude descargar archivo de Telegram (${response.status}).`);
  }

  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > params.maxBytes) {
      throw new Error(`Archivo demasiado grande (${contentLength} bytes). Máximo: ${params.maxBytes}.`);
    }
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > params.maxBytes) {
    throw new Error(`Archivo demasiado grande (${bytes.length} bytes). Máximo: ${params.maxBytes}.`);
  }

  return bytes;
}

function extensionFromAudioMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "audio/ogg" || normalized === "application/ogg") {
    return ".ogg";
  }
  if (normalized === "audio/mpeg") {
    return ".mp3";
  }
  if (normalized === "audio/wav" || normalized === "audio/x-wav") {
    return ".wav";
  }
  if (normalized === "audio/mp4" || normalized === "audio/m4a" || normalized === "audio/x-m4a") {
    return ".m4a";
  }
  if (normalized === "audio/webm") {
    return ".webm";
  }
  return ".audio";
}

async function transcribeAudioWithOpenAi(params: {
  client: OpenAI;
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<string> {
  const runtimeDir = path.resolve(process.cwd(), "runtime");
  await fs.mkdir(runtimeDir, { recursive: true });
  const extension = path.extname(params.fileName) || extensionFromAudioMimeType(params.mimeType);
  const tempName = `audio_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}${extension}`;
  const tempPath = path.join(runtimeDir, tempName);
  await fs.writeFile(tempPath, params.bytes);
  try {
    const response = await params.client.audio.transcriptions.create({
      model: proxyConfig.audioModel,
      file: createReadStream(tempPath),
      ...(proxyConfig.audioLanguage ? { language: proxyConfig.audioLanguage } : {}),
    });
    return typeof response.text === "string" ? response.text.trim() : "";
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

async function archiveImageInWorkspace(params: {
  agent: AgentProfile;
  chatId: number;
  messageId: number;
  bytes: Buffer;
  mimeType: string;
  originalName?: string;
  telegramFilePath: string;
}): Promise<{ absolutePath: string; relativePath: string; bytes: number; mimeType: string }> {
  const workspaceRoot = path.resolve(process.cwd(), params.agent.cwd);
  await fs.mkdir(workspaceRoot, { recursive: true });

  const filePathExt = path.extname(params.telegramFilePath).toLowerCase();
  const originalNameExt = params.originalName ? path.extname(params.originalName).toLowerCase() : "";
  const extension =
    (originalNameExt && IMAGE_EXTENSIONS.has(originalNameExt) ? originalNameExt : "") ||
    (filePathExt && IMAGE_EXTENSIONS.has(filePathExt) ? filePathExt : "") ||
    extensionFromMimeType(params.mimeType);

  const timestamp = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "_").slice(0, 15);
  const baseFromOriginal = params.originalName
    ? sanitizeFileName(path.basename(params.originalName, path.extname(params.originalName)))
    : "";
  const baseName = baseFromOriginal || `imagen_${params.chatId}_${params.messageId}_${timestamp}`;

  let candidateName = `${baseName}${extension}`;
  let absolutePath = path.join(workspaceRoot, candidateName);
  let suffix = 2;
  while (true) {
    try {
      await fs.access(absolutePath);
      candidateName = `${baseName}_${suffix}${extension}`;
      absolutePath = path.join(workspaceRoot, candidateName);
      suffix += 1;
    } catch {
      break;
    }
  }

  await fs.writeFile(absolutePath, params.bytes);
  const relativePath = path.relative(workspaceRoot, absolutePath).replace(/\\/g, "/");

  return {
    absolutePath,
    relativePath,
    bytes: params.bytes.length,
    mimeType: params.mimeType,
  };
}

async function analyzeImageWithOpenAi(params: {
  client: OpenAI;
  bytes: Buffer;
  mimeType: string;
  caption: string;
}): Promise<string> {
  const dataUrl = `data:${params.mimeType};base64,${params.bytes.toString("base64")}`;
  const caption = params.caption.trim();
  const captionLine = caption ? `Texto del usuario: ${caption}` : "Texto del usuario: (sin texto)";

  const response = await params.client.responses.create({
    model: proxyConfig.openAiModel,
    max_output_tokens: proxyConfig.imageAnalysisMaxOutputTokens,
    input: [
      {
        role: "system",
        content:
          "Eres un analista visual. Debes describir lo que observas de forma clara, breve y en espanol. Si hay dudas, explicitalas.",
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              "Analiza esta imagen.",
              "Devuelve: descripcion, elementos relevantes y advertencias/incertidumbre si aplica.",
              captionLine,
            ].join("\n"),
          },
          {
            type: "input_image",
            image_url: dataUrl,
            detail: "auto",
          },
        ],
      },
    ],
  });

  const text = extractTextOutput(response).trim();
  if (!text) {
    return "No pude extraer un analisis util de la imagen.";
  }
  return text;
}

type AttachmentIntent =
  | { kind: "none" }
  | { kind: "send"; target: string }
  | { kind: "send_latest" };

function parseAttachmentIntent(rawText: string, normalizedText: string): AttachmentIntent {
  const sendCommandMatch = normalizedText.match(/^\/(?:adjuntar|attach|send)(?:\s+(.+))?$/i);
  if (sendCommandMatch) {
    const target = (sendCommandMatch[1] ?? "").trim();
    if (target) {
      return { kind: "send", target };
    }
    return { kind: "send_latest" };
  }

  const folded = rawText.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  const asksToSendInChat = /\b(adjunt(?:a|ar|ame)|enviame|mandame|pasame)\b/i.test(folded);
  if (!asksToSendInChat) {
    return { kind: "none" };
  }
  const hashtag = rawText.match(/#([^\s#]+)/)?.[0] ?? "";
  if (hashtag) {
    return { kind: "send", target: hashtag };
  }
  if (/\b(imagen|captura|foto|screenshot|screen|recien|anterior|ultima)\b/i.test(rawText)) {
    return { kind: "send_latest" };
  }
  return { kind: "none" };
}

function isExplicitAttachmentCommand(normalizedText: string): boolean {
  return /^\/(?:adjuntar|attach|send)(?:\s|$)/i.test(normalizedText);
}

function looksLikeEmailIntent(rawText: string): boolean {
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(rawText)) {
    return true;
  }
  const folded = rawText.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  return /\b(correo|email|mail|gmail|destinatario|asunto|cc|cco|bcc)\b/i.test(folded);
}

type ScheduleNaturalAction = "create" | "list" | "delete" | "edit";

type ScheduleNaturalIntent = {
  shouldHandle: boolean;
  action?: ScheduleNaturalAction;
  taskRef?: string;
  taskTitle?: string;
  dueAt?: Date;
  automationInstruction?: string;
  automationDomain?: ScheduledAutomationDomain;
  automationRecurrenceDaily?: boolean;
};

type ScheduledGmailSendPayload = {
  kind: "gmail-send";
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
};

type ScheduledNaturalIntentPayload = {
  instruction: string;
  gmailSend?: ScheduledGmailSendPayload;
  recurrence?: {
    frequency: "daily";
  };
};

const SCHEDULE_WEEKDAY_TO_INDEX: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
};

const SCHEDULE_MONTH_TO_INDEX: Record<string, number> = {
  enero: 0,
  febrero: 1,
  marzo: 2,
  abril: 3,
  mayo: 4,
  junio: 5,
  julio: 6,
  agosto: 7,
  septiembre: 8,
  setiembre: 8,
  octubre: 9,
  noviembre: 10,
  diciembre: 11,
};

const SCHEDULE_SPOKEN_HOUR_TO_NUMBER: Record<string, number> = {
  un: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
};

function normalizeIntentText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

type WorkspaceDocumentCreateIntent = {
  shouldHandle: boolean;
  filePath?: string;
  content?: string;
  missing?: "path" | "content";
};

function detectWorkspaceDocumentCreateIntent(rawText: string): WorkspaceDocumentCreateIntent {
  const original = stripQuotedExecutionNoise(rawText.trim());
  if (!original) {
    return { shouldHandle: false };
  }

  const normalized = normalizeIntentText(original);
  const hasCreateVerb =
    /\b(crea|crear|genera|generar|escribe|escribir|arma|armar|guardar|guarda|haceme|hazme|hacer)\b/.test(normalized);
  const hasDocumentCue = /\b(archivo|documento|txt|texto|fichero|nota)\b/.test(normalized);
  if (!hasCreateVerb || !hasDocumentCue) {
    return { shouldHandle: false };
  }

  const explicitPath =
    original.match(/\b([A-Za-z0-9][A-Za-z0-9._/-]*\.(?:txt|md|json|csv|log))\b/)?.[1] ??
    original.match(/\b(?:archivo|documento|fichero)\s+([A-Za-z0-9][A-Za-z0-9._/-]*)\b/i)?.[1];
  const filePathBase = (explicitPath ?? "").trim().replace(/^['"`]+|['"`]+$/g, "").replace(/[),.;:!?]+$/g, "");
  const filePath = filePathBase && /\.[A-Za-z0-9]+$/.test(filePathBase) ? filePathBase : filePathBase ? `${filePathBase}.txt` : "";

  const labeledContent =
    original.match(/\b(?:contenido|texto|body)\s*[:=-]\s*([\s\S]+)$/i)?.[1] ??
    original.match(/\bcon(?:\s+el)?\s+contenido\s+([\s\S]+)$/i)?.[1] ??
    "";
  const quoted = extractQuotedSegments(original);
  const rawContent = (labeledContent || quoted[quoted.length - 1] || "").trim();
  const content = rawContent.replace(/^['"`]+|['"`]+$/g, "").trim();

  if (!filePath) {
    return { shouldHandle: true, missing: "path" };
  }
  if (!content) {
    return { shouldHandle: true, filePath, missing: "content" };
  }
  return {
    shouldHandle: true,
    filePath,
    content,
  };
}

function truncateInline(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  const trimmed = input.slice(0, Math.max(0, maxChars - 3)).trimEnd();
  return `${trimmed}...`;
}

function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60 * 1000);
}

function parseScheduleRelativeDateTime(normalized: string, now: Date): Date | null {
  const inPattern =
    normalized.match(
      /\b(?:en|dentro\s+de)\s+(\d{1,3}|un|una|media)\s*(minuto|minutos|min|mins|hora|horas|h|hs|dia|dias|semana|semanas)\b/,
    ) ?? normalized.match(/\b(\d{1,3})\s*(minuto|minutos|hora|horas|dia|dias|semana|semanas)\b/);
  if (inPattern) {
    const rawAmount = (inPattern[1] ?? "").trim();
    const unit = (inPattern[2] ?? "").trim();
    let amount = 0;
    if (rawAmount === "un" || rawAmount === "una") {
      amount = 1;
    } else if (rawAmount === "media") {
      amount = 0.5;
    } else {
      const parsed = Number.parseFloat(rawAmount);
      amount = Number.isFinite(parsed) ? parsed : 0;
    }
    if (amount > 0) {
      const minuteUnits = ["minuto", "minutos", "min", "mins"];
      const hourUnits = ["hora", "horas", "h", "hs"];
      const dayUnits = ["dia", "dias"];
      const weekUnits = ["semana", "semanas"];
      let minutesToAdd = 0;
      if (minuteUnits.includes(unit)) {
        minutesToAdd = Math.round(amount);
      } else if (hourUnits.includes(unit)) {
        minutesToAdd = Math.round(amount * 60);
      } else if (dayUnits.includes(unit)) {
        minutesToAdd = Math.round(amount * 24 * 60);
      } else if (weekUnits.includes(unit)) {
        minutesToAdd = Math.round(amount * 7 * 24 * 60);
      }
      if (minutesToAdd > 0) {
        return addMinutes(now, minutesToAdd);
      }
    }
  }

  if (/\ben un rato\b/.test(normalized)) {
    return addMinutes(now, 30);
  }
  if (/\bahora\b/.test(normalized) && /\b(recorda|recuerda|tarea|recordatorio|agenda|programa)\b/.test(normalized)) {
    return addMinutes(now, 1);
  }

  return null;
}

function parseScheduleTime(normalized: string): { hour: number; minute: number } | null {
  const applyDayPeriod = (hourInput: number, periodRaw?: string): number | null => {
    if (!Number.isFinite(hourInput) || hourInput < 0 || hourInput > 23) {
      return null;
    }
    const period = (periodRaw ?? "").toLowerCase();
    if (!period) {
      return hourInput;
    }
    if (period === "tarde" || period === "noche") {
      return hourInput < 12 ? hourInput + 12 : hourInput;
    }
    if (period === "manana" || period === "madrugada") {
      if (hourInput === 12) {
        return 0;
      }
      return hourInput;
    }
    return hourInput;
  };

  if (/\bmediodia\b/.test(normalized)) {
    return { hour: 12, minute: 0 };
  }
  if (/\bmedianoche\b/.test(normalized)) {
    return { hour: 0, minute: 0 };
  }

  const spokenHalf = normalized.match(
    /\ba\s+las\s+(un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\s+y\s+media(?:\s+de\s+la\s+(manana|tarde|noche|madrugada))?\b/,
  );
  if (spokenHalf) {
    const word = spokenHalf[1] ?? "";
    const rawHour = SCHEDULE_SPOKEN_HOUR_TO_NUMBER[word];
    const hour = applyDayPeriod(rawHour, spokenHalf[2] ?? "");
    if (typeof hour === "number") {
      return { hour, minute: 30 };
    }
    return null;
  }

  const hhmm = normalized.match(/\b(?:a\s+las\s+)?(\d{1,2})(?::|\.)(\d{2})\s*(am|pm)?\s*(?:h|hs)?\b/);
  if (hhmm) {
    let hour = Number.parseInt(hhmm[1] ?? "", 10);
    const minute = Number.parseInt(hhmm[2] ?? "", 10);
    const ampm = (hhmm[3] ?? "").toLowerCase();
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) {
      return null;
    }
    if (ampm) {
      if (hour < 1 || hour > 12) {
        return null;
      }
      if (ampm === "pm" && hour < 12) {
        hour += 12;
      }
      if (ampm === "am" && hour === 12) {
        hour = 0;
      }
    }
    if (hour < 0 || hour > 23) {
      return null;
    }
    const dayPeriod = normalized.match(
      /\b(?:a\s+las\s+)?\d{1,2}(?::|\.)\d{2}\s*(?:am|pm)?\s*(?:de\s+la\s+(manana|tarde|noche|madrugada))\b/,
    )?.[1];
    if (!ampm && dayPeriod) {
      const adjusted = applyDayPeriod(hour, dayPeriod);
      if (typeof adjusted !== "number") {
        return null;
      }
      hour = adjusted;
    }
    return { hour, minute };
  }

  const ampmOnly = normalized.match(/\b(?:a\s+las\s+)?(\d{1,2})\s*(am|pm)\b/);
  if (ampmOnly) {
    let hour = Number.parseInt(ampmOnly[1] ?? "", 10);
    const ampm = (ampmOnly[2] ?? "").toLowerCase();
    if (!Number.isFinite(hour) || hour < 1 || hour > 12) {
      return null;
    }
    if (ampm === "pm" && hour < 12) {
      hour += 12;
    }
    if (ampm === "am" && hour === 12) {
      hour = 0;
    }
    return { hour, minute: 0 };
  }

  const simple = normalized.match(/\ba\s+las\s+(\d{1,2})(?:\s+de\s+la\s+(manana|tarde|noche|madrugada))?\b/);
  if (simple) {
    const hourRaw = Number.parseInt(simple[1] ?? "", 10);
    if (!Number.isFinite(hourRaw) || hourRaw < 0 || hourRaw > 23) {
      return null;
    }
    const hour = applyDayPeriod(hourRaw, simple[2] ?? "");
    if (typeof hour !== "number") {
      return null;
    }
    return { hour, minute: 0 };
  }

  const compactHour = normalized.match(/(?<![:.])\b(?:a\s+las\s+)?(\d{1,2})\s*(h|hs)\b/);
  if (compactHour) {
    const hour = Number.parseInt(compactHour[1] ?? "", 10);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
      return null;
    }
    return { hour, minute: 0 };
  }

  return null;
}

function parseScheduleExplicitDate(
  normalized: string,
  now: Date,
): { year: number; month: number; day: number; fromKeywordToday: boolean } | null {
  const yearNow = now.getFullYear();
  const monthNow = now.getMonth();
  const dayNow = now.getDate();

  if (/\bpasado manana\b/.test(normalized)) {
    const date = new Date(yearNow, monthNow, dayNow + 2, 0, 0, 0, 0);
    return {
      year: date.getFullYear(),
      month: date.getMonth(),
      day: date.getDate(),
      fromKeywordToday: false,
    };
  }
  if (/\bmanana\b/.test(normalized)) {
    const date = new Date(yearNow, monthNow, dayNow + 1, 0, 0, 0, 0);
    return {
      year: date.getFullYear(),
      month: date.getMonth(),
      day: date.getDate(),
      fromKeywordToday: false,
    };
  }
  if (/\bhoy\b/.test(normalized)) {
    return {
      year: yearNow,
      month: monthNow,
      day: dayNow,
      fromKeywordToday: true,
    };
  }

  const isoDate = normalized.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (isoDate) {
    const year = Number.parseInt(isoDate[1] ?? "", 10);
    const month = Number.parseInt(isoDate[2] ?? "", 10) - 1;
    const day = Number.parseInt(isoDate[3] ?? "", 10);
    const candidate = new Date(year, month, day, 0, 0, 0, 0);
    if (candidate.getFullYear() === year && candidate.getMonth() === month && candidate.getDate() === day) {
      return { year, month, day, fromKeywordToday: false };
    }
  }

  const slashDate = normalized.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slashDate) {
    const day = Number.parseInt(slashDate[1] ?? "", 10);
    const month = Number.parseInt(slashDate[2] ?? "", 10) - 1;
    let year = yearNow;
    if (slashDate[3]) {
      const rawYear = Number.parseInt(slashDate[3] ?? "", 10);
      year = rawYear < 100 ? 2000 + rawYear : rawYear;
    }
    const candidate = new Date(year, month, day, 0, 0, 0, 0);
    if (candidate.getFullYear() === year && candidate.getMonth() === month && candidate.getDate() === day) {
      return { year, month, day, fromKeywordToday: false };
    }
  }

  const longDate = normalized.match(
    /\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de\s+(\d{2,4}))?\b/,
  );
  if (longDate) {
    const day = Number.parseInt(longDate[1] ?? "", 10);
    const monthName = longDate[2] ?? "";
    const month = SCHEDULE_MONTH_TO_INDEX[monthName];
    let year = yearNow;
    if (longDate[3]) {
      const rawYear = Number.parseInt(longDate[3] ?? "", 10);
      year = rawYear < 100 ? 2000 + rawYear : rawYear;
    }
    if (typeof month === "number") {
      const candidate = new Date(year, month, day, 0, 0, 0, 0);
      if (candidate.getFullYear() === year && candidate.getMonth() === month && candidate.getDate() === day) {
        return { year, month, day, fromKeywordToday: false };
      }
    }
  }

  const weekday = normalized.match(/\b(?:(proximo)\s+)?(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/);
  if (weekday) {
    const forceNext = Boolean(weekday[1]);
    const targetName = weekday[2] ?? "";
    const targetDow = SCHEDULE_WEEKDAY_TO_INDEX[targetName];
    if (typeof targetDow === "number") {
      const currentDow = now.getDay();
      let delta = (targetDow - currentDow + 7) % 7;
      if (delta === 0 && forceNext) {
        delta = 7;
      }
      const candidate = new Date(yearNow, monthNow, dayNow + delta, 0, 0, 0, 0);
      return {
        year: candidate.getFullYear(),
        month: candidate.getMonth(),
        day: candidate.getDate(),
        fromKeywordToday: delta === 0,
      };
    }
  }

  return null;
}

function parseNaturalScheduleDateTime(text: string, nowInput?: Date): { dueAt?: Date; hasTemporalSignal: boolean } {
  const now = nowInput ? new Date(nowInput.getTime()) : new Date();
  const normalized = normalizeIntentText(text);

  const relative = parseScheduleRelativeDateTime(normalized, now);
  if (relative) {
    return { dueAt: relative, hasTemporalSignal: true };
  }

  const datePart = parseScheduleExplicitDate(normalized, now);
  const timePart = parseScheduleTime(normalized);
  const hasTemporalSignal = Boolean(datePart || timePart);
  if (!hasTemporalSignal) {
    return { hasTemporalSignal: false };
  }

  const base = datePart
    ? new Date(datePart.year, datePart.month, datePart.day, 0, 0, 0, 0)
    : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

  if (timePart) {
    base.setHours(timePart.hour, timePart.minute, 0, 0);
  } else if (datePart?.fromKeywordToday) {
    const soon = addMinutes(now, 10);
    base.setHours(soon.getHours(), soon.getMinutes(), 0, 0);
  } else {
    base.setHours(9, 0, 0, 0);
  }

  if (!datePart && timePart && base.getTime() <= now.getTime()) {
    base.setDate(base.getDate() + 1);
  }

  return { dueAt: base, hasTemporalSignal: true };
}

function stripScheduleTemporalPhrases(text: string): string {
  return text
    .replace(
      /\b(?:en|dentro\s+de)\s+(\d{1,3}|un|una|media)\s*(?:minuto|minutos|min|mins|hora|horas|h|hs|d[ií]a|d[ií]as|semana|semanas)\b/gi,
      " ",
    )
    .replace(/\bpasado\s+ma(?:ñ|n)ana\b/gi, " ")
    .replace(/\bma(?:ñ|n)ana\b/gi, " ")
    .replace(/\bhoy\b/gi, " ")
    .replace(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g, " ")
    .replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, " ")
    .replace(
      /\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de\s+(\d{2,4}))?\b/gi,
      " ",
    )
    .replace(/\b(?:(proximo)\s+)?(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/gi, " ")
    .replace(/\bmediod[ií]a\b/gi, " ")
    .replace(/\bmedianoche\b/gi, " ")
    .replace(/\b(?:a\s+las\s+)?(\d{1,2})(?::|\.)(\d{2})\s*(?:am|pm)?\s*(?:h|hs)?\b/gi, " ")
    .replace(
      /\ba\s+las\s+(?:un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\s+y\s+media(?:\s+de\s+la\s+(?:manana|mañana|tarde|noche|madrugada))?\b/gi,
      " ",
    )
    .replace(/\ba\s+las\s+(\d{1,2})\s+de\s+la\s+(?:manana|mañana|tarde|noche|madrugada)\b/gi, " ")
    .replace(/(?<![:.])\b(?:a\s+las\s+)?(\d{1,2})\s*(?:h|hs)\b/gi, " ")
    .replace(/\b(?:a\s+las\s+)?(\d{1,2})\s*(?:am|pm)\b/gi, " ")
    .replace(/\ba\s+las\s+(\d{1,2})\b/gi, " ")
    .replace(/\ben un rato\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeScheduleTitle(raw: string): string {
  const cleaned = raw
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^(de|para|que|sobre|acerca de)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncateInline(cleaned, 400);
}

function extractQuotedSegments(text: string): string[] {
  const pattern = /"([^"\n]+)"|'([^'\n]+)'/g;
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const value = (match[1] || match[2] || "").trim();
    if (value) {
      values.push(value);
    }
  }
  return values;
}

function isValidEmailAddress(raw: string): boolean {
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(raw.trim());
}

function sanitizeEmailList(raw: string): string {
  if (!raw.trim()) {
    return "";
  }
  const deduped = new Set<string>();
  for (const token of raw.split(/[,\s;]+/)) {
    const email = token.trim().toLowerCase();
    if (!email || !isValidEmailAddress(email)) {
      continue;
    }
    deduped.add(email);
  }
  return [...deduped].join(",");
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

function detectGmailAutoContentKindForSchedule(
  textNormalized: string,
): "document" | "poem" | "news" | "reminders" | "stoic" | "assistant-last" | undefined {
  if (/\b(noticias?|news|nove(?:dad(?:es)?|ades?)|titulares?|actualidad)\b/.test(textNormalized)) {
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

function buildScheduledGmailSendPayload(params: {
  rawText: string;
  instruction: string;
  taskTitle: string;
}): { payload?: ScheduledGmailSendPayload; errorText?: string } {
  const parsers = createGmailTextParsers({
    normalizeIntentText,
    extractQuotedSegments,
    normalizeRecipientName,
    truncateInline,
    gmailMaxResults: 20,
  });

  const deps = {
    normalizeIntentText,
    extractQuotedSegments,
    extractEmailAddresses: parsers.extractEmailAddresses,
    extractRecipientNameFromText: parsers.extractRecipientNameFromText,
    inferDefaultSelfEmailRecipient,
    detectGmailAutoContentKind: detectGmailAutoContentKindForSchedule,
    parseGmailLabeledFields: parsers.parseGmailLabeledFields,
    extractLiteralBodyRequest: parsers.extractLiteralBodyRequest,
    extractNaturalSubjectRequest: parsers.extractNaturalSubjectRequest,
    detectCreativeEmailCue: parsers.detectCreativeEmailCue,
    detectGmailDraftRequested: parsers.detectGmailDraftRequested,
    buildGmailDraftInstruction: parsers.buildGmailDraftInstruction,
    shouldAvoidLiteralBodyFallback: parsers.shouldAvoidLiteralBodyFallback,
    parseNaturalLimit: parsers.parseNaturalLimit,
    buildNaturalGmailQuery: parsers.buildNaturalGmailQuery,
    gmailAccountEmail: (process.env.GMAIL_ACCOUNT_EMAIL ?? "").trim().toLowerCase(),
  };

  const primaryIntent = detectGmailNaturalIntent(params.rawText, deps);
  const fallbackIntent = params.instruction.trim()
    ? detectGmailNaturalIntent(params.instruction, deps)
    : ({ shouldHandle: false } as ReturnType<typeof detectGmailNaturalIntent>);
  const intent =
    primaryIntent.shouldHandle && primaryIntent.action === "send"
      ? primaryIntent
      : fallbackIntent.shouldHandle && fallbackIntent.action === "send"
        ? fallbackIntent
        : null;
  if (!intent) {
    const fallbackToCandidate =
      parsers.extractEmailAddresses(`${params.rawText} ${params.instruction}`)[0] ??
      inferDefaultSelfEmailRecipient(params.rawText) ??
      inferDefaultSelfEmailRecipient(params.instruction);
    const fallbackTo = (fallbackToCandidate ?? "").trim().toLowerCase();
    if (!fallbackTo || !isValidEmailAddress(fallbackTo)) {
      return {
        errorText:
          "No pude estructurar el envío de email. Formato sugerido: 'programa enviar mail a usuario@dominio.com asunto: ... mensaje: ...'.",
      };
    }

    const fallbackBodySeed =
      params.instruction.trim() ||
      params.taskTitle.trim() ||
      params.rawText.trim();
    const fallbackBody = truncateInline(
      fallbackBodySeed
        .replace(
          /\b(?:enviar|enviame|enviarme|mandar|mandame|mandarme|programar|programa|mail|email|correo|gmail)\b/gi,
          " ",
        )
        .replace(/\b(?:a|para)\s+[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim() || fallbackBodySeed,
      8_000,
    );
    const fallbackSubject = /\b(noticias?|news|novedades?|actualidad|titulares?)\b/i.test(fallbackBody)
      ? "Resumen programado"
      : "Recordatorio programado";
    return {
      payload: {
        kind: "gmail-send",
        to: fallbackTo,
        subject: fallbackSubject,
        body: fallbackBody,
      },
    };
  }

  const to = (intent.to ?? "").trim().toLowerCase();
  if (!to || !isValidEmailAddress(to)) {
    return {
      errorText:
        "Para programar un envío de email necesito destinatario válido. Ejemplo: '... a usuario@dominio.com ...'.",
    };
  }

  const ccRaw = sanitizeEmailList(intent.cc ?? "");
  const bccRaw = sanitizeEmailList(intent.bcc ?? "");
  const cc = ccRaw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && item !== to)
    .join(",");
  const bcc = bccRaw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && item !== to && !cc.split(",").includes(item))
    .join(",");
  const subject =
    sanitizeScheduleTitle((intent.subject ?? "").trim()) ||
    sanitizeScheduleTitle(params.taskTitle) ||
    "Recordatorio programado";
  const bodySeed =
    (intent.body ?? "").trim() ||
    params.instruction.trim() ||
    params.taskTitle.trim() ||
    params.rawText.trim();
  const body = truncateInline(bodySeed, 8_000);

  if (!body) {
    return {
      errorText:
        "Para programar un envío de email necesito contenido del mensaje. Ejemplo: 'mensaje: Recordatorio de facturación'.",
    };
  }

  return {
    payload: {
      kind: "gmail-send",
      to,
      subject,
      body,
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
    },
  };
}

function buildScheduledNaturalIntentPayload(params: {
  rawText: string;
  instruction: string;
  taskTitle: string;
  automationDomain?: ScheduledAutomationDomain;
  recurrenceDaily?: boolean;
}): { payload?: ScheduledNaturalIntentPayload; responseHints: string[]; errorText?: string } {
  const instruction = params.instruction.trim();
  if (!instruction) {
    return {
      responseHints: [],
      errorText: "No hay instrucción para la automatización programada.",
    };
  }
  const payload: ScheduledNaturalIntentPayload = {
    instruction,
    ...(params.recurrenceDaily ? { recurrence: { frequency: "daily" as const } } : {}),
  };
  const responseHints: string[] = [];

  if (params.automationDomain === "gmail") {
    const gmailPayload = buildScheduledGmailSendPayload({
      rawText: params.rawText,
      instruction,
      taskTitle: params.taskTitle,
    });
    if (!gmailPayload.payload) {
      return {
        responseHints,
        errorText: gmailPayload.errorText ?? "No pude preparar el envío programado de email.",
      };
    }
    payload.gmailSend = gmailPayload.payload;
    responseHints.push(`mail_to: ${gmailPayload.payload.to}`);
    responseHints.push(`mail_subject: ${gmailPayload.payload.subject}`);
    responseHints.push("modo: gmail-send-deterministico");
  }

  return { payload, responseHints };
}

function extractTaskTitleForCreate(text: string): string {
  const quoted = extractQuotedSegments(text);
  if (quoted.length > 0) {
    return sanitizeScheduleTitle(quoted.join(" "));
  }

  const cleaned = stripScheduleTemporalPhrases(normalizeIntentText(text))
    .replace(
      /\b(record(?:a|á)(?:me|rme|r)?|recuerd(?:a|á)(?:me|r)?|agend(?:a|á)(?:me|r)?|program(?:a|á)(?:r)?|cre(?:a|á)(?:r)?|gener(?:a|á)(?:r)?|tareas?|recordatorios?|por\s+favor|porfa)\b/gi,
      " ",
    )
    .replace(/\b(hac(?:e|é)(?:r)?me)\s+acordar\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitizeScheduleTitle(cleaned);
}

function extractTaskTitleForEdit(text: string): string {
  const quoted = extractQuotedSegments(text);
  if (quoted.length > 0) {
    return sanitizeScheduleTitle(quoted.join(" "));
  }

  const explicit =
    text.match(/\b(?:texto|descripcion|descripción|detalle|mensaje)\s*[:=-]\s*(.+)$/i)?.[1]?.trim() ??
    text.match(/\b(?:que diga|que sea)\s+(.+)$/i)?.[1]?.trim() ??
    "";
  if (explicit) {
    return sanitizeScheduleTitle(explicit);
  }

  const cleaned = stripScheduleTemporalPhrases(normalizeIntentText(text))
    .replace(
      /\b(edit(?:a|á|ar)|cambi(?:a|á|ar)|modific(?:a|á|ar)|reprogram(?:a|á|ar)|muev(?:e|é|er)|actualiz(?:a|á|ar)|pospon(?:e|é|er)|tarea|recordatorio|numero|nro|#)\b/gi,
      " ",
    )
    .replace(/\btsk[-_][a-z0-9._-]*\.{0,}\b/gi, " ")
    .replace(/\b\d{1,3}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitizeScheduleTitle(cleaned);
}

function extractScheduleTaskRef(text: string): string | null {
  const normalized = normalizeIntentText(text);
  if (/\b(ultima|ultimo|last)\b/.test(normalized)) {
    return "last";
  }

  const taskPrefixWithDots =
    text.match(/(?:^|[\s"'`(])((?:tsk[-_][a-z0-9_-]*\.{2,}))/i)?.[1] ??
    text.match(/(?:^|[\s"'`(])[a-z0-9]+_((?:tsk[-_][a-z0-9_-]*\.{2,}))/i)?.[1];
  if (taskPrefixWithDots) {
    return taskPrefixWithDots;
  }

  const taskId =
    text.match(/\btsk[-_][a-z0-9-]+\b/i)?.[0] ??
    text.match(/\b[a-z0-9]+_(tsk[-_][a-z0-9-]+)\b/i)?.[1];
  if (taskId) {
    return taskId;
  }

  const numeric =
    normalized.match(/\b(?:tarea|recordatorio)\s*(?:numero|nro|#)?\s*(\d{1,3})\b/)?.[1] ??
    normalized.match(/\b(?:numero|nro|#)\s*(\d{1,3})\b/)?.[1];
  if (numeric) {
    return numeric;
  }
  return null;
}

function detectScheduleNaturalIntent(text: string): ScheduleNaturalIntent {
  const original = text.trim();
  if (!original) {
    return { shouldHandle: false };
  }

  const normalized = normalizeIntentText(original);
  const hasTaskRefCue = /\btsk(?:[-_][a-z0-9._-]*)?\b/i.test(original);
  const scheduleNouns = /\b(recordatorio|recordatorios|tarea|tareas|agenda)\b/.test(normalized) || hasTaskRefCue;
  const parsedSchedule = parseNaturalScheduleDateTime(original, new Date());
  const automation = detectScheduledAutomationIntent({
    text: original,
    normalizeIntentText,
    stripScheduleTemporalPhrases,
    sanitizeTitle: sanitizeScheduleTitle,
  });
  const hasReminderVerb =
    /\b(recordar|recorda|recordame|recordarme|recuerda|recuerdame|agenda|agendame|agendar|programa|programar|fijar|fijame|fija)\b/.test(
      normalized,
    ) ||
    /\b(haceme|hacerme|hace(?:r)?me)\s+acordar\b/.test(normalized) ||
    (/\b(enviame|enviarme|mandame|mandarme|me\s+mandas|me\s+envias|me\s+envías)\b/.test(normalized) &&
      /\b(correo|mail|email|gmail)\b/.test(normalized));
  const hasExplicitScheduleCue =
    scheduleNouns ||
    hasReminderVerb ||
    /\b(pon(?:e|eme)?|deja(?:me)?|anota(?:me)?)\b.*\b(recordatorio|tarea|agenda)\b/.test(normalized);

  const listRequested =
    /\b(lista|listar|mostra|mostrar|ver|cuales|cuantas|pendientes)\b/.test(normalized) && scheduleNouns;
  if (listRequested || (/\b(?:mis\s+)?(?:tareas|recordatorios)\b/.test(normalized) && /\b(que|cuales|ver|mostrar)\b/.test(normalized))) {
    return { shouldHandle: true, action: "list" };
  }

  const deleteRequested =
    /\b(elimina|eliminar|borra|borrar|quita|quitar|cancela|cancelar|remove|delete)\b/.test(normalized) && scheduleNouns;
  if (deleteRequested) {
    return {
      shouldHandle: true,
      action: "delete",
      taskRef: extractScheduleTaskRef(original) ?? undefined,
    };
  }

  const editRequested =
    /\b(edita|editar|cambia|cambiar|modifica|modificar|reprograma|reprogramar|mueve|mover|actualiza|actualizar|pospone|posponer)\b/.test(
      normalized,
    ) && scheduleNouns;
  if (editRequested) {
    const taskRef = extractScheduleTaskRef(original) ?? undefined;
    const taskTitle = extractTaskTitleForEdit(original);
    return {
      shouldHandle: true,
      action: "edit",
      taskRef,
      ...(taskTitle ? { taskTitle } : {}),
      ...(parsedSchedule.dueAt ? { dueAt: parsedSchedule.dueAt } : {}),
    };
  }

  const createRequested = hasReminderVerb && (scheduleNouns || parsedSchedule.hasTemporalSignal);
  const scheduledAutomationRequested =
    parsedSchedule.hasTemporalSignal && hasExplicitScheduleCue && Boolean(automation.instruction);
  if (scheduledAutomationRequested) {
    const taskTitle = sanitizeScheduleTitle(`Automatizacion: ${automation.instruction ?? "accion"}`);
    return {
      shouldHandle: true,
      action: "create",
      ...(taskTitle ? { taskTitle } : {}),
      ...(automation.instruction ? { automationInstruction: automation.instruction } : {}),
      ...(automation.domain ? { automationDomain: automation.domain } : {}),
      ...(automation.recurrenceDaily ? { automationRecurrenceDaily: true } : {}),
      ...(parsedSchedule.dueAt ? { dueAt: parsedSchedule.dueAt } : {}),
    };
  }

  if (createRequested || (scheduleNouns && parsedSchedule.hasTemporalSignal)) {
    const taskTitle = extractTaskTitleForCreate(original);
    return {
      shouldHandle: true,
      action: "create",
      ...(taskTitle ? { taskTitle } : {}),
      ...(parsedSchedule.dueAt ? { dueAt: parsedSchedule.dueAt } : {}),
    };
  }

  return { shouldHandle: false };
}

function formatScheduleDateTime(date: Date): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  return `${date.toLocaleString("es-AR", { hour12: false })} (${tz})`;
}

function formatScheduleTaskLines(
  tasks: Array<{ id: string; title: string; dueAt: string; deliveryKind?: string }>,
): string[] {
  return tasks.map((task, index) => {
    const due = new Date(task.dueAt);
    const dueLabel = Number.isNaN(due.getTime()) ? task.dueAt : due.toLocaleString("es-AR", { hour12: false });
    const deliveryLabel = task.deliveryKind === "natural-intent" ? "\nTipo: automatizacion" : "";
    return `${index + 1}. ${task.title}\nPara: ${dueLabel}${deliveryLabel}`;
  });
}

function parseScheduledNaturalIntentPayload(raw?: string): ScheduledNaturalIntentPayload | null {
  if (!raw || !raw.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { instruction?: unknown; recurrence?: unknown; gmailSend?: unknown };
    const instruction = typeof parsed.instruction === "string" ? parsed.instruction.trim() : "";
    if (!instruction) {
      return null;
    }
    const recurrenceRaw = parsed.recurrence as { frequency?: unknown } | undefined;
    const frequency = typeof recurrenceRaw?.frequency === "string" ? recurrenceRaw.frequency.trim().toLowerCase() : "";
    const gmailRaw = parsed.gmailSend as
      | {
          kind?: unknown;
          to?: unknown;
          subject?: unknown;
          body?: unknown;
          cc?: unknown;
          bcc?: unknown;
        }
      | undefined;
    const parsedCc = typeof gmailRaw?.cc === "string" ? sanitizeEmailList(gmailRaw.cc) : "";
    const parsedBcc = typeof gmailRaw?.bcc === "string" ? sanitizeEmailList(gmailRaw.bcc) : "";
    const gmailSend =
      gmailRaw &&
      gmailRaw.kind === "gmail-send" &&
      typeof gmailRaw.to === "string" &&
      typeof gmailRaw.subject === "string" &&
      typeof gmailRaw.body === "string"
        ? {
            kind: "gmail-send" as const,
            to: gmailRaw.to.trim().toLowerCase(),
            subject: gmailRaw.subject.trim(),
            body: gmailRaw.body.trim(),
            ...(parsedCc ? { cc: parsedCc } : {}),
            ...(parsedBcc ? { bcc: parsedBcc } : {}),
          }
        : undefined;
    if (gmailSend && (!isValidEmailAddress(gmailSend.to) || !gmailSend.subject || !gmailSend.body)) {
      return null;
    }
    return {
      instruction,
      ...(gmailSend ? { gmailSend } : {}),
      ...(frequency === "daily" ? { recurrence: { frequency: "daily" as const } } : {}),
    };
  } catch {
    return null;
  }
}

function buildNextDailyOccurrence(baseIso: string, nowInput?: Date): Date {
  const base = new Date(baseIso);
  if (!Number.isFinite(base.getTime())) {
    const fallback = nowInput ? new Date(nowInput.getTime()) : new Date();
    fallback.setDate(fallback.getDate() + 1);
    return fallback;
  }
  const now = nowInput ? new Date(nowInput.getTime()) : new Date();
  const next = new Date(base.getTime());
  next.setDate(next.getDate() + 1);
  while (next.getTime() <= now.getTime() + 10_000) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

type GmailAttachmentContext = {
  index: number;
  filename: string;
  attachmentId?: string;
};

type GmailMessageContext = {
  id: string;
  threadId?: string;
  subject?: string;
  attachments: GmailAttachmentContext[];
  updatedAtMs: number;
};

type GmailChatContext = {
  listedMessageIds: string[];
  lastMessageId?: string;
  lastAttachmentId?: string;
  lastAttachmentMessageId?: string;
  messagesById: Map<string, GmailMessageContext>;
};

function normalizeReferenceToken(raw: string): string {
  return raw
    .trim()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_#-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseCommandTokens(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const char of raw) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) {
    current += "\\";
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function serializeCommandTokens(tokens: string[]): string {
  return tokens
    .map((token) => {
      if (!token) {
        return '""';
      }
      if (!/[\s"'\\$`<>|;&()]/.test(token)) {
        return token;
      }
      return `"${token.replace(/(["\\$`])/g, "\\$1")}"`;
    })
    .join(" ");
}

function createGmailChatContext(): GmailChatContext {
  return {
    listedMessageIds: [],
    messagesById: new Map<string, GmailMessageContext>(),
  };
}

function getGmailChatContext(stateByChat: Map<number, GmailChatContext>, chatId: number): GmailChatContext {
  const existing = stateByChat.get(chatId);
  if (existing) {
    return existing;
  }
  const next = createGmailChatContext();
  stateByChat.set(chatId, next);
  return next;
}

function parseOutputField(stdout: string, field: string): string | undefined {
  const pattern = new RegExp(`^${field}=([^\\r\\n]+)$`, "m");
  const match = stdout.match(pattern);
  return match?.[1]?.trim();
}

function buildGmailSendCommandFromPayload(payload: ScheduledGmailSendPayload): string {
  const tokens = [
    "gmail-api",
    "send",
    `to=${payload.to}`,
    `subject=${payload.subject}`,
    `body=${payload.body}`,
    ...(payload.cc ? [`cc=${payload.cc}`] : []),
    ...(payload.bcc ? [`bcc=${payload.bcc}`] : []),
  ];
  return serializeCommandTokens(tokens);
}

type GmailSendExecutionEvidence = {
  sent: boolean;
  messageId?: string;
  threadId?: string;
  reason?: string;
};

function parseGmailSendExecutionEvidence(result: ExecutedCommand): GmailSendExecutionEvidence {
  if (result.timedOut) {
    return { sent: false, reason: "timeout en gmail-api send" };
  }
  if (!Number.isFinite(result.exitCode ?? Number.NaN) || result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    return {
      sent: false,
      reason: stderr ? truncateInline(stderr, 240) : `exit=${result.exitCode ?? "null"}`,
    };
  }
  const sent = /\bsent=true\b/i.test(result.stdout);
  const messageId = parseOutputField(result.stdout, "message_id");
  const threadId = parseOutputField(result.stdout, "thread_id");
  if (!sent || !messageId) {
    return {
      sent: false,
      reason: "Falta evidencia sent=true/message_id en salida de gmail-api send.",
      ...(threadId ? { threadId } : {}),
    };
  }
  return {
    sent: true,
    messageId,
    ...(threadId ? { threadId } : {}),
  };
}

function objectiveLooksLikeEmailSend(rawObjective: string): boolean {
  const normalized = normalizeIntentText(rawObjective);
  return (
    /\b(send|envi\w*|mand\w*|correo|mail|email|gmail)\b/.test(normalized) &&
    /\b(envi\w*|mand\w*|send)\b/.test(normalized) &&
    /\b(correo|mail|email|gmail)\b/.test(normalized)
  );
}

function resolvePendingDraftSendFromHistory(rawObjective: string, history: ExecutedCommand[]): string | null {
  if (!objectiveLooksLikeEmailSend(rawObjective)) {
    return null;
  }
  let lastDraftId: string | null = null;
  let hasSuccessfulSend = false;

  for (const item of history) {
    const command = item.command.trim().toLowerCase();
    if (command.startsWith("gmail-api send ") || command.startsWith("gmail-api draft send ")) {
      if (item.exitCode === 0 && /\bsent=true\b/i.test(item.stdout) && Boolean(parseOutputField(item.stdout, "message_id"))) {
        hasSuccessfulSend = true;
      }
      continue;
    }
    if (!command.startsWith("gmail-api draft create ")) {
      continue;
    }
    if (item.exitCode !== 0) {
      continue;
    }
    const draftId = parseOutputField(item.stdout, "draft_id");
    if (draftId) {
      lastDraftId = draftId;
    }
  }

  if (hasSuccessfulSend) {
    return null;
  }
  return lastDraftId;
}

function parseListedMessageIds(stdout: string): string[] {
  const ids: string[] = [];
  const regex = /^id=([^\r\n]+)$/gm;
  for (const match of stdout.matchAll(regex)) {
    const id = (match[1] ?? "").trim();
    if (id) {
      ids.push(id);
    }
  }
  return ids;
}

function parseReadAttachments(stdout: string): GmailAttachmentContext[] {
  const line = stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.toLowerCase().startsWith("adjuntos:"));
  if (!line) {
    return [];
  }
  const raw = line.replace(/^adjuntos:\s*/i, "").trim();
  if (!raw || raw === "-") {
    return [];
  }
  const names = raw
    .split(",")
    .map((item) => item.trim().replace(/\s+\(\d+\s+bytes\)\s*$/i, ""))
    .filter(Boolean);
  return names.map((filename, idx) => ({
    index: idx + 1,
    filename,
  }));
}

function parseAttachmentList(stdout: string): GmailAttachmentContext[] {
  const rows: GmailAttachmentContext[] = [];
  for (const lineRaw of stdout.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) {
      continue;
    }
    const match = line.match(/^(\d+)\.\s+(.+?)\s+\|\s+id=([^|]+)\s+\|\s+mime=[^|]+\s+\|\s+size=\d+$/i);
    if (!match) {
      continue;
    }
    const index = Number.parseInt(match[1] ?? "", 10);
    const filename = (match[2] ?? "").trim();
    const attachmentIdRaw = (match[3] ?? "").trim();
    if (!Number.isFinite(index) || index <= 0 || !filename) {
      continue;
    }
    rows.push({
      index,
      filename,
      ...(attachmentIdRaw && attachmentIdRaw !== "inline-data" ? { attachmentId: attachmentIdRaw } : {}),
    });
  }
  return rows;
}

function ensureMessageContext(ctx: GmailChatContext, messageId: string): GmailMessageContext {
  const existing = ctx.messagesById.get(messageId);
  if (existing) {
    return existing;
  }
  const created: GmailMessageContext = {
    id: messageId,
    attachments: [],
    updatedAtMs: Date.now(),
  };
  ctx.messagesById.set(messageId, created);
  return created;
}

function updateMessageContext(
  ctx: GmailChatContext,
  messageId: string,
  patch: {
    threadId?: string;
    subject?: string;
    attachments?: GmailAttachmentContext[];
  },
): void {
  const message = ensureMessageContext(ctx, messageId);
  if (patch.threadId) {
    message.threadId = patch.threadId;
  }
  if (patch.subject) {
    message.subject = patch.subject;
  }
  if (patch.attachments) {
    message.attachments = patch.attachments;
    const withId = patch.attachments.find((item) => item.attachmentId)?.attachmentId;
    if (withId) {
      ctx.lastAttachmentId = withId;
      ctx.lastAttachmentMessageId = messageId;
    }
  }
  message.updatedAtMs = Date.now();
  ctx.lastMessageId = messageId;
}

function updateGmailContextFromExecution(ctx: GmailChatContext, result: ExecutedCommand): void {
  const command = result.command.trim();
  if (!/^gmail-api\b/i.test(command)) {
    return;
  }

  const tokens = parseCommandTokens(command);
  const primary = (tokens[1] ?? "").toLowerCase();
  if (!primary) {
    return;
  }

  if ((primary === "inbox" || primary === "list") && result.exitCode === 0) {
    const listed = parseListedMessageIds(result.stdout);
    if (listed.length > 0) {
      ctx.listedMessageIds = listed;
      ctx.lastMessageId = listed[0];
      for (const id of listed) {
        ensureMessageContext(ctx, id);
      }
    }
    return;
  }

  if (primary === "read" && result.exitCode === 0) {
    const messageId = parseOutputField(result.stdout, "id") || tokens[2];
    if (!messageId) {
      return;
    }
    const threadId = parseOutputField(result.stdout, "thread");
    const subject = parseOutputField(result.stdout, "subject");
    const attachments = parseReadAttachments(result.stdout);
    updateMessageContext(ctx, messageId, {
      ...(threadId ? { threadId } : {}),
      ...(subject ? { subject } : {}),
      attachments,
    });
    return;
  }

  if (["send", "reply", "forward"].includes(primary) && result.exitCode === 0) {
    const messageId = parseOutputField(result.stdout, "message_id");
    const threadId = parseOutputField(result.stdout, "thread_id");
    if (messageId) {
      updateMessageContext(ctx, messageId, {
        ...(threadId ? { threadId } : {}),
      });
    }
    return;
  }

  if (primary === "attachment") {
    const sub = (tokens[2] ?? "").toLowerCase();
    if (sub === "list" && result.exitCode === 0) {
      const messageId = (tokens[3] ?? "").trim();
      if (!messageId) {
        return;
      }
      const attachments = parseAttachmentList(result.stdout);
      updateMessageContext(ctx, messageId, { attachments });
      return;
    }
    if (sub === "download" && result.exitCode === 0) {
      const messageId = parseOutputField(result.stdout, "message_id") || (tokens[3] ?? "").trim();
      if (!messageId) {
        return;
      }
      const attachmentId = parseOutputField(result.stdout, "attachment_id");
      const filename = parseOutputField(result.stdout, "filename") || "adjunto";
      const attachments = attachmentId
        ? [{ index: 1, filename, attachmentId }]
        : [{ index: 1, filename }];
      updateMessageContext(ctx, messageId, { attachments });
      if (attachmentId) {
        ctx.lastAttachmentId = attachmentId;
        ctx.lastAttachmentMessageId = messageId;
      }
      return;
    }
  }
}

const MESSAGE_REFERENCE_ALIASES = new Set([
  "ese",
  "ese_mail",
  "ese_email",
  "correo_actual",
  "mail_actual",
  "ultimo",
  "ultimo_mail",
  "ultimo_email",
  "latest",
  "last",
  "current",
  "current_mail",
  "current_email",
]);

const ATTACHMENT_REFERENCE_ALIASES = new Set([
  "adjunto",
  "ese_adjunto",
  "adjunto_actual",
  "ultimo_adjunto",
  "latest",
  "last",
  "current",
  "current_attachment",
]);

function pickDefaultMessageId(ctx: GmailChatContext): string | undefined {
  return ctx.lastMessageId || ctx.listedMessageIds[0];
}

function resolveMessageReference(token: string | undefined, ctx: GmailChatContext): string | undefined {
  const raw = (token ?? "").trim();
  if (!raw) {
    return pickDefaultMessageId(ctx);
  }

  const normalized = normalizeReferenceToken(raw);
  if (!normalized) {
    return pickDefaultMessageId(ctx);
  }
  if (/^<\s*messageid\s*>$/i.test(raw) || normalized === "messageid") {
    return pickDefaultMessageId(ctx);
  }
  if (MESSAGE_REFERENCE_ALIASES.has(normalized)) {
    return pickDefaultMessageId(ctx);
  }
  const indexMatch = raw.match(/^#?(\d+)$/);
  if (indexMatch) {
    const index = Number.parseInt(indexMatch[1] ?? "", 10);
    if (Number.isFinite(index) && index > 0) {
      return ctx.listedMessageIds[index - 1];
    }
  }
  return undefined;
}

function getAttachmentsForMessage(ctx: GmailChatContext, messageId: string | undefined): GmailAttachmentContext[] {
  if (!messageId) {
    return [];
  }
  return ctx.messagesById.get(messageId)?.attachments ?? [];
}

function resolveAttachmentSelector(
  token: string | undefined,
  messageId: string | undefined,
  ctx: GmailChatContext,
): string | undefined {
  const raw = (token ?? "").trim();
  const attachments = getAttachmentsForMessage(ctx, messageId);
  const defaultAttachmentByIndex = attachments.find((item) => item.index === 1);
  const defaultAttachmentId =
    attachments.find((item) => item.attachmentId)?.attachmentId ||
    (ctx.lastAttachmentMessageId === messageId ? ctx.lastAttachmentId : undefined);

  if (!raw) {
    if (defaultAttachmentId) {
      return `id:${defaultAttachmentId}`;
    }
    if (defaultAttachmentByIndex) {
      return "#1";
    }
    return undefined;
  }

  if (/^id:\s*<\s*attachmentid\s*>$/i.test(raw) || /^<\s*attachmentid\s*>$/i.test(raw)) {
    if (defaultAttachmentId) {
      return `id:${defaultAttachmentId}`;
    }
    if (defaultAttachmentByIndex) {
      return "#1";
    }
    return undefined;
  }

  const normalized = normalizeReferenceToken(raw);
  if (ATTACHMENT_REFERENCE_ALIASES.has(normalized)) {
    if (defaultAttachmentId) {
      return `id:${defaultAttachmentId}`;
    }
    if (defaultAttachmentByIndex) {
      return "#1";
    }
    return undefined;
  }

  const indexMatch = raw.match(/^#?(\d+)$/);
  if (indexMatch) {
    const index = Number.parseInt(indexMatch[1] ?? "", 10);
    if (Number.isFinite(index) && index > 0) {
      return `#${index}`;
    }
  }

  if (normalized === "id_attachmentid" && defaultAttachmentId) {
    return `id:${defaultAttachmentId}`;
  }
  return undefined;
}

function rewriteGmailCommandWithContext(command: string, ctx: GmailChatContext): string {
  const tokens = parseCommandTokens(command);
  if ((tokens[0] ?? "").toLowerCase() !== "gmail-api") {
    return command;
  }
  if (tokens.length < 2) {
    return command;
  }

  const primary = (tokens[1] ?? "").toLowerCase();
  let changed = false;
  const setToken = (index: number, value: string | undefined): void => {
    if (!value) {
      return;
    }
    if ((tokens[index] ?? "") === value) {
      return;
    }
    tokens[index] = value;
    changed = true;
  };

  const applyMessageAt = (index: number): string | undefined => {
    const resolved = resolveMessageReference(tokens[index], ctx);
    if (resolved) {
      setToken(index, resolved);
      return resolved;
    }
    return tokens[index];
  };

  if (["read", "delete", "trash", "markread", "markunread", "untrash", "star", "unstar", "reply", "forward"].includes(primary)) {
    applyMessageAt(2);
  } else if (primary === "modify") {
    applyMessageAt(3);
  } else if (primary === "attachment") {
    const sub = (tokens[2] ?? "").toLowerCase();
    if (sub === "list") {
      applyMessageAt(3);
    } else if (sub === "download") {
      const resolvedMessageId = applyMessageAt(3);
      const selectorResolved = resolveAttachmentSelector(tokens[4], resolvedMessageId, ctx);
      if (selectorResolved) {
        setToken(4, selectorResolved);
      }
    }
  }

  for (let i = 0; i < tokens.length; i += 1) {
    if (/^<\s*messageid\s*>$/i.test(tokens[i] ?? "")) {
      const fallbackId = pickDefaultMessageId(ctx);
      if (fallbackId) {
        setToken(i, fallbackId);
      }
    }
  }

  if (!changed) {
    return command;
  }
  return serializeCommandTokens(tokens);
}

function buildGmailPlannerContextBlock(ctx: GmailChatContext): string {
  const lines: string[] = [];
  if (ctx.lastMessageId) {
    lines.push(`ultimo_message_id=${ctx.lastMessageId}`);
  }
  if (ctx.listedMessageIds.length > 0) {
    const indexed = ctx.listedMessageIds.slice(0, 10).map((id, idx) => `#${idx + 1}=${id}`).join(", ");
    lines.push(`mails_indexados=${indexed}`);
  }

  const defaultMessageId = pickDefaultMessageId(ctx);
  const attachments = getAttachmentsForMessage(ctx, defaultMessageId).slice(0, 10);
  if (defaultMessageId && attachments.length > 0) {
    const indexedAttachments = attachments
      .map((item) => `#${item.index}=${item.filename}${item.attachmentId ? `(id:${item.attachmentId})` : ""}`)
      .join(", ");
    lines.push(`adjuntos_${defaultMessageId}=${indexedAttachments}`);
  }

  if (lines.length === 0) {
    return "";
  }

  return [
    "Contexto Gmail resuelto (usar IDs reales):",
    ...lines,
    "Regla: nunca uses placeholders como <messageId> o <attachmentId>.",
  ].join("\n");
}

export async function startTerminalProxyTelegramBot(): Promise<void> {
  if (!proxyConfig.openAiApiKey) {
    throw new Error("Falta OPENAI_API_KEY en el entorno.");
  }
  if (!proxyConfig.telegramBotToken) {
    throw new Error("Falta TELEGRAM_BOT_TOKEN en el entorno.");
  }

  const runtime = await createProxyRuntime();
  const { registry, planner, executor, verifier, memory, webApi } = runtime;
  const bot = new Bot(proxyConfig.telegramBotToken);
  const imageClient = new OpenAI({ apiKey: proxyConfig.openAiApiKey });
  const chatQueue = new ChatMessageQueue();
  const objectiveState = new ProxyObjectiveStateStore(proxyConfig.objectiveStateDbPath);
  await objectiveState.init();
  const agentPolicy = new AgentPolicyEngine(proxyConfig.agentPolicyFile);
  await agentPolicy.load();
  const capabilityPolicy = new ProxyCapabilityPolicy({
    policyEngine: agentPolicy,
    approvalTtlMs: proxyConfig.approvalTtlMs,
    requireExecApproval: proxyConfig.requireConfirmation,
  });
  const webBrowser = new WebBrowser({
    timeoutMs: proxyConfig.webFetchTimeoutMs,
    maxFetchBytes: proxyConfig.webFetchMaxBytes,
    maxTextChars: proxyConfig.webContentMaxChars,
    defaultSearchResults: proxyConfig.webSearchMaxResults,
  });
  const gmailAccount = createGmailAccountService();
  const activeAgentByChat = new Map<number, string>();
  const activeObjectiveControllers = new Map<number, ObjectiveRunController>();
  const latestArchivedImageByChat = new Map<number, string>();
  const latestWebResultsByChat = new Map<number, WebSearchResult[]>();
  const gmailContextByChat = new Map<number, GmailChatContext>();
  const scheduledTasks = new ScheduledTaskSqliteService({
    dbPath: path.join(process.cwd(), "runtime", "proxy-scheduled-tasks.sqlite"),
  });
  await scheduledTasks.load();
  const intentBiasStore = await IntentBiasStore.create({
    enabled: proxyConfig.intentBiasEnabled,
    filePath: proxyConfig.intentBiasFile,
  });
  const intentTelemetry = await IntentTelemetry.create({
    enabled: proxyConfig.intentTelemetryEnabled,
    filePath: proxyConfig.intentTelemetryFile,
    sloWindow: proxyConfig.intentSloWindow,
    sloMaxFailureRate: proxyConfig.intentSloMaxFailureRate,
    sloMinSamples: proxyConfig.intentSloMinSamples,
  });
  let scheduleDeliveryLoopRunning = false;

  const resolveActiveAgent = (chatId: number): AgentProfile => {
    const activeName = activeAgentByChat.get(chatId) || proxyConfig.defaultAgent;
    return registry.get(activeName) ?? registry.getDefault();
  };

  const startTypingHeartbeat = (chatId: number, reply?: (text: string) => Promise<unknown>): (() => void) => {
    let lastPhase: ObjectivePhase | null = null;
    let heartbeatCount = 0;
    let lastNoticeAtMs = Date.now();
    const sendTyping = async (): Promise<void> => {
      try {
        await bot.api.sendChatAction(chatId, "typing");
      } catch {
        // ignore transient sendChatAction failures
      }
    };
    void sendTyping();
    const handle = setInterval(() => {
      void sendTyping();
      if (!reply || !proxyConfig.agenticStatusEnabled) {
        return;
      }
      const current = objectiveState.getState(chatId);
      if (!current || current.status !== "active") {
        return;
      }
      if (!["planning", "executing", "verifying"].includes(current.phase)) {
        lastPhase = current.phase;
        heartbeatCount = 0;
        lastNoticeAtMs = Date.now();
        return;
      }
      if (current.phase !== lastPhase) {
        lastPhase = current.phase;
        heartbeatCount = 0;
        lastNoticeAtMs = Date.now();
        return;
      }
      if (Date.now() - lastNoticeAtMs < Math.max(10_000, proxyConfig.progressHeartbeatMs * 2)) {
        return;
      }
      heartbeatCount += 1;
      const message = pickHeartbeatMessage(current.phase, heartbeatCount);
      if (!message) {
        return;
      }
      lastNoticeAtMs = Date.now();
      void reply(message).catch(() => {
        // ignore transient heartbeat reply failures
      });
    }, Math.max(2_000, proxyConfig.progressHeartbeatMs));
    if (typeof handle.unref === "function") {
      handle.unref();
    }
    return () => clearInterval(handle);
  };

  const replyLong = async (reply: (text: string) => Promise<unknown>, text: string): Promise<void> => {
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      await reply("No encontre nada util para mostrarte.");
      return;
    }
    for (const chunk of chunks) {
      await reply(chunk);
    }
  };

  const replyProgress = async (params: {
    chatId: number;
    reply: (text: string) => Promise<unknown>;
    phase: ObjectivePhase | "status";
    text: string;
  }): Promise<void> => {
    if (!proxyConfig.agenticStatusEnabled) {
      try {
        await bot.api.sendChatAction(params.chatId, "typing");
      } catch {
        // ignore
      }
      return;
    }
    await params.reply(params.text);
  };

  const enqueueChatWork = async <T>(chatId: number, source: string, fn: () => Promise<T>): Promise<T> => {
    const queued = await chatQueue.enqueue(chatId, fn);
    if (queued.waitMs >= 200) {
      logInfo(`Telegram chat-queue chat=${chatId} source=${source} wait_ms=${queued.waitMs}`);
    }
    return queued.result;
  };

  const buildObjectiveStatusText = (chatId: number): string => {
    const current = objectiveState.getState(chatId);
    if (!current) {
      const semantic = objectiveState.getSemanticState(chatId);
      if (semantic?.pendingApproval) {
        return [
          "No tengo un objetivo activo ahora mismo.",
          `Confirmación pendiente: ${semantic.pendingApproval.summary}`,
          'Respondé "sí" para seguir o "no" para cancelarlo.',
        ].join("\n");
      }
      return "No tengo nada reciente para mostrarte en este chat.";
    }
    const base = buildFriendlyObjectiveStatusText({
      current,
      queueDepth: chatQueue.getDepth(chatId),
      events: objectiveState.listRecentEvents(chatId, 5),
    });
    const semantic = objectiveState.getSemanticState(chatId);
    if (!semantic?.pendingApproval) {
      return base;
    }
    return [
      base,
      "",
      `Confirmación pendiente: ${semantic.pendingApproval.summary}`,
      'Respondé "sí" para seguir o "no" para cancelarlo.',
    ].join("\n");
  };

  const requestObjectiveCancel = async (params: {
    chatId: number;
    reply: (text: string) => Promise<unknown>;
    reason: string;
  }): Promise<void> => {
    const current = objectiveState.getState(params.chatId);
    if (!current || current.status !== "active") {
      const pendingApproval = objectiveState.getSemanticState(params.chatId)?.pendingApproval;
      if (pendingApproval) {
        objectiveState.clearPendingApproval(params.chatId);
        await params.reply("Listo, descarte la confirmación pendiente.");
        return;
      }
      await params.reply("No tengo nada activo para frenar ahora.");
      return;
    }
    objectiveState.requestCancel({
      chatId: params.chatId,
      reason: params.reason,
    });
    const active = activeObjectiveControllers.get(params.chatId);
    if (active && active.runId === current.runId) {
      active.controller.abort(new Error(params.reason));
    }
    await params.reply(`Listo, ya pedi que se detenga. Estaba en ${humanizeObjectivePhase(current.phase)}.`);
  };

  const rememberAssistant = async (params: {
    chatId: number;
    userId?: number;
    text: string;
    source: string;
  }): Promise<void> => {
    if (!memory) {
      return;
    }
    await memory.rememberAssistantTurn({
      chatId: params.chatId,
      text: params.text,
      source: params.source,
      ...(typeof params.userId === "number" ? { userId: params.userId } : {}),
    });
  };

  const rememberUser = async (params: {
    chatId: number;
    userId?: number;
    text: string;
    source: string;
  }): Promise<void> => {
    if (!memory) {
      return;
    }
    await memory.rememberUserTurn({
      chatId: params.chatId,
      objective: params.text,
      source: params.source,
      ...(typeof params.userId === "number" ? { userId: params.userId } : {}),
    });
  };

  const resolveGmailMessageIdForIntent = async (params: {
    chatId: number;
    intent: IntentIr;
  }): Promise<string | undefined> => {
    const gmail = params.intent.entities.gmail;
    if (!gmail) {
      return undefined;
    }
    if (gmail.messageId?.trim()) {
      return gmail.messageId.trim();
    }

    const context = getGmailChatContext(gmailContextByChat, params.chatId);
    if (typeof gmail.messageIndex === "number") {
      if (gmail.messageIndex === -1) {
        return context.lastMessageId ?? context.listedMessageIds[0];
      }
      const index = Math.max(0, gmail.messageIndex - 1);
      if (index < context.listedMessageIds.length) {
        return context.listedMessageIds[index];
      }
    }

    if (context.lastMessageId) {
      return context.lastMessageId;
    }

    const latest = await gmailAccount.listMessages(gmail.query, 1);
    if (latest.length === 0 || !latest[0]?.id) {
      return undefined;
    }
    context.listedMessageIds = latest.map((item) => item.id).filter(Boolean);
    context.lastMessageId = latest[0].id;
    for (const item of latest) {
      if (!item.id) {
        continue;
      }
      updateMessageContext(context, item.id, {
        ...(item.threadId ? { threadId: item.threadId } : {}),
        ...(item.subject ? { subject: item.subject } : {}),
      });
    }
    return latest[0].id;
  };

  const handleDeterministicIntent = createDeterministicIntentHandler({
    objectiveState,
    replyLong,
    replyProgress,
    rememberAssistant,
    gmailAccount,
    getGmailContext: (chatId) => getGmailChatContext(gmailContextByChat, chatId),
    updateGmailMessageContext: updateMessageContext,
    resolveGmailMessageIdForIntent,
    buildScheduledGmailSendPayload,
    createWorkspaceFilesService,
    createDocumentReader,
    expandWorkspacePathForDirectUse,
    formatBytes,
    getLatestWebResults: (chatId) => latestWebResultsByChat.get(chatId) ?? [],
    setLatestWebResults: (chatId, hits) => {
      latestWebResultsByChat.set(chatId, hits);
    },
    webBrowser,
    listMaxResults: proxyConfig.webSearchMaxResults,
    webSearchMaxResults: proxyConfig.webSearchMaxResults,
    buildWebResultsListText,
  });

  const maybeHandleNaturalScheduleInstruction = createNaturalScheduleHandler({
    intentBiasStore,
    intentRoutingThreshold: proxyConfig.intentRoutingThreshold,
    logInfo,
    rememberUser,
    rememberAssistant,
    scheduledTasks,
    formatScheduleTaskLines,
    buildScheduledNaturalIntentPayload,
    formatScheduleDateTime,
  });

  const actionRegistry = createProxyActionRegistry({
    objectiveState,
    handleDeterministicIntent,
    maybeHandleNaturalScheduleInstruction,
    updateSemanticReferences,
  });

  const runObjectiveExecution = createObjectiveExecutionRunner({
    config: {
      intentShadowEnabled: proxyConfig.intentShadowEnabled,
      deterministicRoutingThreshold: proxyConfig.deterministicRoutingThreshold,
      objectiveMaxMs: proxyConfig.objectiveMaxMs,
      intentAbstainThreshold: proxyConfig.intentAbstainThreshold,
      recentConversationTurns: proxyConfig.recentConversationTurns,
      maxIterations: proxyConfig.maxIterations,
      plannerTimeoutMs: proxyConfig.plannerTimeoutMs,
      intentCriticEnabled: proxyConfig.intentCriticEnabled,
      maxCommandsTotal: proxyConfig.maxCommandsTotal,
      verifierTimeoutMs: proxyConfig.verifierTimeoutMs,
    },
    objectiveState,
    intentBiasStore,
    intentTelemetry,
    planner,
    executor,
    verifier,
    memory,
    webApi,
    policyGate: capabilityPolicy,
    actionRegistry,
    startTypingHeartbeat,
    replyProgress,
    rememberAssistant,
    rememberUser,
    registerActiveObjectiveController: (chatId, controller) => {
      activeObjectiveControllers.set(chatId, controller);
    },
    clearActiveObjectiveController: (chatId, runId) => {
      const current = activeObjectiveControllers.get(chatId);
      if (current?.runId === runId) {
        activeObjectiveControllers.delete(chatId);
      }
    },
    getGmailPlannerContextBlock: (chatId) => buildGmailPlannerContextBlock(getGmailChatContext(gmailContextByChat, chatId)),
    resolvePendingDraftSendFromHistory,
    rewritePlannerCommands: (chatId, commands) => {
      const gmailContext = getGmailChatContext(gmailContextByChat, chatId);
      const rewritten = commands.map((item) => rewriteGmailCommandWithContext(item, gmailContext));
      return {
        commands: rewritten,
        changed: rewritten.some((item, index) => item !== commands[index]),
      };
    },
    updateChatExecutionContext: (chatId, result) => {
      updateGmailContextFromExecution(getGmailChatContext(gmailContextByChat, chatId), result);
    },
    presentExecutionResultChunks: async (result, activeAgent) => {
      const presentable = await presentListingResultForWorkspace(result, activeAgent);
      return chunkText(buildExecutionReplyText(presentable) ?? "");
    },
    logInfo,
    logWarn,
    logError,
  });

  const handleTaskCommand = async (params: {
    chatId: number;
    userId?: number;
    input: string;
    reply: (text: string) => Promise<unknown>;
  }): Promise<void> => {
    const usage = [
      "Uso:",
      "/task",
      "/task list",
      "/task add <cuando> | <detalle|automatizacion>",
      "/task del <n|id|last>",
      "/task edit <n|id> | <nuevo cuando> | <nuevo detalle opcional>",
    ].join("\n");

    const listPendingTasks = async (): Promise<void> => {
      const pending = scheduledTasks.listPending(params.chatId);
      if (pending.length === 0) {
        await params.reply("No tenes tareas pendientes.");
        return;
      }
      await params.reply([`Tenes ${pending.length} tarea(s) pendiente(s):`, ...formatScheduleTaskLines(pending)].join("\n\n"));
    };

    const input = params.input.trim();
    if (!input || input.toLowerCase() === "list" || input.toLowerCase() === "status") {
      await listPendingTasks();
      return;
    }

    const [subRaw, ...restTokens] = input.split(/\s+/);
    const sub = (subRaw ?? "").trim().toLowerCase();
    const restRaw = restTokens.join(" ").trim();

    if (sub === "add") {
      const [whenRaw = "", detailRaw = ""] = restRaw.split("|", 2).map((part) => part.trim());
      const parseTarget = whenRaw || restRaw;
      const parsed = parseNaturalScheduleDateTime(parseTarget, new Date());
      const dueAt = parsed.dueAt;
      const detail = sanitizeScheduleTitle(detailRaw || extractTaskTitleForCreate(restRaw));
      const automation = detectScheduledAutomationIntent({
        text: restRaw,
        normalizeIntentText,
        stripScheduleTemporalPhrases,
        sanitizeTitle: sanitizeScheduleTitle,
      });
      const hasAutomationInstruction = Boolean(automation.instruction?.trim());

      if (!dueAt) {
        await params.reply(`No pude inferir fecha/hora.\n\n${usage}`);
        return;
      }
      if (dueAt.getTime() <= Date.now() + 10_000) {
        await params.reply("La fecha/hora debe ser futura.");
        return;
      }
      if (!detail && !hasAutomationInstruction) {
        await params.reply("Falta detalle de la tarea. Ejemplo: /task add mañana 10:30 | llamar a Juan");
        return;
      }

      const automationPayload = hasAutomationInstruction
        ? buildScheduledNaturalIntentPayload({
            rawText: restRaw,
            instruction: automation.instruction?.trim() ?? "",
            taskTitle: hasAutomationInstruction ? sanitizeScheduleTitle(`Automatizacion: ${automation.instruction}`) : detail,
            automationDomain: automation.domain,
            recurrenceDaily: automation.recurrenceDaily,
          })
        : null;
      if (hasAutomationInstruction && !automationPayload?.payload) {
        await params.reply(
          automationPayload?.errorText ??
            "No pude estructurar la automatización. Reescribe con destinatario y mensaje explícitos.",
        );
        return;
      }

      const created = await scheduledTasks.createTask({
        chatId: params.chatId,
        ...(typeof params.userId === "number" ? { userId: params.userId } : {}),
        title: hasAutomationInstruction ? sanitizeScheduleTitle(`Automatizacion: ${automation.instruction}`) : detail,
        dueAt,
        ...(hasAutomationInstruction ? { deliveryKind: "natural-intent" as const } : {}),
        ...(hasAutomationInstruction
          ? {
              deliveryPayload: JSON.stringify(automationPayload?.payload),
            }
          : {}),
      });
      await params.reply(
        [
          hasAutomationInstruction ? "Listo, deje la automatizacion programada." : "Listo, deje la tarea agendada.",
          `Para: ${formatScheduleDateTime(new Date(created.dueAt))}`,
          `Detalle: ${created.title}`,
          ...(hasAutomationInstruction ? [`Se va a ejecutar: ${automation.instruction}`] : []),
          ...(automationPayload?.responseHints ?? []),
          ...(automation.recurrenceDaily ? ["Se repite todos los dias."] : []),
        ].join("\n"),
      );
      return;
    }

    if (["del", "delete", "remove", "rm", "cancel"].includes(sub)) {
      const ref = restRaw.trim();
      if (!ref) {
        await params.reply(`Falta referencia de tarea.\n\n${usage}`);
        return;
      }
      const task = scheduledTasks.resolveTaskByRef(params.chatId, ref);
      if (!task) {
        await params.reply("No encontré esa tarea pendiente.");
        return;
      }
      const canceled = await scheduledTasks.cancelTask(task.id);
      await params.reply([`Listo, elimine esta tarea:`, canceled.title].join("\n"));
      return;
    }

    if (sub === "edit") {
      const ref = restTokens[0]?.trim() ?? "";
      if (!ref) {
        await params.reply(`Falta referencia de tarea.\n\n${usage}`);
        return;
      }

      const target = scheduledTasks.resolveTaskByRef(params.chatId, ref);
      if (!target) {
        await params.reply("No encontré esa tarea pendiente.");
        return;
      }

      const afterRef = restRaw.slice(ref.length).trim();
      const segments = afterRef
        .split("|")
        .map((part) => part.trim())
        .filter(Boolean);
      let dueAt: Date | undefined;
      let detail = "";

      if (segments.length > 0) {
        const parsed = parseNaturalScheduleDateTime(segments[0] ?? "", new Date());
        if (parsed.dueAt) {
          dueAt = parsed.dueAt;
        } else {
          detail = sanitizeScheduleTitle(segments[0] ?? "");
        }
        if (segments[1]) {
          detail = sanitizeScheduleTitle(segments[1]);
        }
      } else if (afterRef) {
        const parsed = parseNaturalScheduleDateTime(afterRef, new Date());
        if (parsed.dueAt) {
          dueAt = parsed.dueAt;
        }
        const extracted = sanitizeScheduleTitle(extractTaskTitleForEdit(afterRef));
        if (extracted) {
          detail = extracted;
        }
      }

      const changes: { dueAt?: Date; title?: string } = {};
      if (dueAt) {
        if (dueAt.getTime() <= Date.now() + 10_000) {
          await params.reply("La nueva fecha/hora debe ser futura.");
          return;
        }
        changes.dueAt = dueAt;
      }
      if (detail) {
        changes.title = detail;
      }

      if (!changes.dueAt && !changes.title) {
        await params.reply(`No detecté cambios.\n\n${usage}`);
        return;
      }

      const updated = await scheduledTasks.updateTask(target.id, changes);
      await params.reply(
        [
          "Listo, actualice la tarea.",
          `Para: ${formatScheduleDateTime(new Date(updated.dueAt))}`,
          `Detalle: ${updated.title}`,
        ].join("\n"),
      );
      return;
    }

    await params.reply(usage);
  };

  const processDueScheduledTasks = async (): Promise<void> => {
    if (scheduleDeliveryLoopRunning) {
      return;
    }
    scheduleDeliveryLoopRunning = true;
    try {
      const due = scheduledTasks.dueTasks(new Date());
      for (const task of due) {
        await enqueueChatWork(task.chatId, `scheduled-task:${task.id}`, async () => {
          try {
            if (task.deliveryKind === "natural-intent") {
              const payload = parseScheduledNaturalIntentPayload(task.deliveryPayload);
              const instruction = payload?.instruction?.trim();
              if (!instruction) {
                throw new Error("No hay instrucción para la automatización programada.");
              }
              const payloadSafe = payload;

              if (payloadSafe?.gmailSend) {
                const command = buildGmailSendCommandFromPayload(payloadSafe.gmailSend);
                const activeAgent = resolveActiveAgent(task.chatId);
                await bot.api.sendMessage(
                  task.chatId,
                  `Arranco la automatizacion programada para enviar un email a ${payloadSafe.gmailSend.to}.`,
                );
                logInfo(`Telegram schedule gmail-send start chat=${task.chatId} task=${task.id} command="${command}"`);
                const results = await executor.runSequence(activeAgent, [command]);
                const sendResult = results[0];
                if (!sendResult) {
                  throw new Error("No hubo resultado al ejecutar gmail-api send.");
                }
                const evidence = parseGmailSendExecutionEvidence(sendResult);
                if (!evidence.sent) {
                  throw new Error(
                    `No se confirmó envío real del email. ${evidence.reason ?? "Sin evidencia sent=true."}`.trim(),
                  );
                }
                logInfo(
                  `Telegram schedule gmail-send ok chat=${task.chatId} task=${task.id} message=${evidence.messageId ?? "-"} thread=${evidence.threadId ?? "-"}`,
                );
                await bot.api.sendMessage(
                  task.chatId,
                  buildFriendlyGmailSendText({
                    to: payloadSafe.gmailSend.to,
                    subject: payloadSafe.gmailSend.subject,
                  }),
                );
              } else {
                await bot.api.sendMessage(
                  task.chatId,
                  `Arranco la automatizacion programada: ${instruction}`,
                );

                const runOutcome = await runObjectiveExecution({
                  chatId: task.chatId,
                  ...(typeof task.userId === "number" ? { userId: task.userId } : {}),
                  activeAgent: resolveActiveAgent(task.chatId),
                  objectiveRaw: instruction,
                  reply: async (text: string) => bot.api.sendMessage(task.chatId, text),
                  rememberUserSource: undefined,
                });
                logInfo(
                  `Telegram schedule objective outcome chat=${task.chatId} task=${task.id} status=${runOutcome.status} summary="${runOutcome.summary.slice(0, 160)}"`,
                );
                if (runOutcome.status !== "success") {
                  throw new Error(`No se confirmó ejecución exitosa: ${runOutcome.summary}`);
                }
              }

              if (payloadSafe?.recurrence?.frequency === "daily") {
                const nextDueAt = buildNextDailyOccurrence(task.dueAt, new Date());
                const createdNext = await scheduledTasks.createTask({
                  chatId: task.chatId,
                  ...(typeof task.userId === "number" ? { userId: task.userId } : {}),
                  title: task.title,
                  dueAt: nextDueAt,
                  deliveryKind: "natural-intent",
                  deliveryPayload: task.deliveryPayload,
                });
                await bot.api.sendMessage(
                  task.chatId,
                  [
                    "Listo, la automatizacion diaria quedo reprogramada.",
                    `Proxima ejecucion: ${formatScheduleDateTime(new Date(createdNext.dueAt))}`,
                  ].join("\n"),
                );
              }

              await scheduledTasks.markDelivered(task.id, new Date());
              logInfo(`Telegram schedule delivered chat=${task.chatId} task=${task.id} kind=natural-intent`);
              return;
            }

            await bot.api.sendMessage(
              task.chatId,
              [
                "Recordatorio:",
                task.title,
                `Era para: ${formatScheduleDateTime(new Date(task.dueAt))}`,
              ].join("\n"),
            );
            await scheduledTasks.markDelivered(task.id, new Date());
            logInfo(`Telegram schedule delivered chat=${task.chatId} task=${task.id} kind=reminder`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            try {
              await scheduledTasks.markDeliveryFailure(task.id, message, new Date());
            } catch {
              // ignore secondary failures
            }
            logError(`Telegram schedule delivery error chat=${task.chatId} task=${task.id}: ${message}`);
            try {
              await bot.api.sendMessage(task.chatId, `Una tarea programada fallo: ${message}`);
            } catch {
              // ignore send failure
            }
          }
        });
      }
    } finally {
      scheduleDeliveryLoopRunning = false;
    }
  };

  try {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`No pude limpiar webhook antes de polling: ${message}`);
  }

  const schedulePollHandle = setInterval(() => {
    void processDueScheduledTasks();
  }, Math.max(1000, proxyConfig.schedulePollMs));
  if (typeof schedulePollHandle.unref === "function") {
    schedulePollHandle.unref();
  }
  void processDueScheduledTasks();

  const objectiveWatchdogHandle = setInterval(() => {
    const stale = objectiveState.listStaleActiveStates(proxyConfig.objectiveMaxMs);
    for (const state of stale) {
      const active = activeObjectiveControllers.get(state.chatId);
      if (active && active.runId === state.runId) {
        active.controller.abort(new Error(`timeout ${proxyConfig.objectiveMaxMs}ms`));
        continue;
      }
      objectiveState.finishRun({
        chatId: state.chatId,
        runId: state.runId,
        status: "cancelled",
        phase: "cancelled",
        summary: "Objetivo cancelado por estado obsoleto.",
        reason: "stale_objective_state",
      });
    }
  }, Math.max(5_000, proxyConfig.progressHeartbeatMs));
  if (typeof objectiveWatchdogHandle.unref === "function") {
    objectiveWatchdogHandle.unref();
  }

  bot.on("message:photo", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isAllowedUser(userId)) {
      return;
    }

    const chatId = ctx.chat.id;
    await enqueueChatWork(chatId, "message:photo", async () => {
      const activeAgent = resolveActiveAgent(chatId);
      const caption = (ctx.message.caption ?? "").trim();
      const photo = ctx.message.photo[ctx.message.photo.length - 1];

      if (!photo?.file_id) {
        await ctx.reply("No pude leer la imagen recibida.");
        return;
      }

      await rememberUser({
        chatId,
        userId,
        text: caption ? `[imagen] ${caption}` : "[imagen sin texto]",
        source: "proxy-telegram:image-user",
      });

      try {
        const telegramFile = await ctx.api.getFile(photo.file_id);
        const telegramFilePath = telegramFile.file_path;
        if (!telegramFilePath) {
          throw new Error("Telegram no devolvio file_path para la imagen.");
        }

        const bytes = await downloadTelegramFileBuffer({
          botToken: proxyConfig.telegramBotToken,
          filePath: telegramFilePath,
          maxBytes: proxyConfig.imageMaxFileBytes,
        });

        const archived = await archiveImageInWorkspace({
          agent: activeAgent,
          chatId,
          messageId: ctx.message.message_id,
          bytes,
          mimeType: "image/jpeg",
          originalName: undefined,
          telegramFilePath,
        });
        latestArchivedImageByChat.set(chatId, archived.relativePath);

        let analysis = "";
        try {
          analysis = await analyzeImageWithOpenAi({
            client: imageClient,
            bytes,
            mimeType: archived.mimeType,
            caption,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          analysis = `No pude analizar la imagen con el modelo. Detalle: ${message}`;
        }

        const replyText = [
          "Listo, ya procese la imagen.",
          `La guarde como ${archived.relativePath}.`,
          `Pesa ${formatBytes(archived.bytes)}.`,
          "",
          "Esto vi:",
          analysis,
          "",
          `Si despues queres reenviarla como adjunto: /adjuntar #${toHashtagToken(archived.relativePath)}`,
        ].join("\n");

        await ctx.reply(replyText);
        await rememberAssistant({
          chatId,
          userId,
          text: replyText,
          source: "proxy-telegram:image-analysis",
        });
        logInfo(
          `Telegram image chat=${chatId} user=${userId} archived=${archived.relativePath} bytes=${archived.bytes}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const replyText = `No pude procesar la imagen: ${message}`;
        await ctx.reply(replyText);
        await rememberAssistant({
          chatId,
          userId,
          text: replyText,
          source: "proxy-telegram:image-error",
        });
        logError(`Telegram image error chat=${chatId} user=${userId}: ${message}`);
      }
    });
  });

  bot.on("message:document", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isAllowedUser(userId)) {
      return;
    }

    const chatId = ctx.chat.id;
    await enqueueChatWork(chatId, "message:document", async () => {
      const activeAgent = resolveActiveAgent(chatId);
      const document = ctx.message.document;
      const mimeType = (document.mime_type ?? "").toLowerCase();
      const fileName = document.file_name ?? "";

      const isImageDocument = mimeType.startsWith("image/") || isImagePath(fileName);
      if (!isImageDocument) {
        await ctx.reply("Recibi un documento, pero en este flujo solo analizo imagenes.");
        return;
      }

      const caption = (ctx.message.caption ?? "").trim();
      await rememberUser({
        chatId,
        userId,
        text: caption ? `[imagen-documento] ${caption}` : `[imagen-documento] ${fileName || "sin nombre"}`,
        source: "proxy-telegram:image-user",
      });

      try {
        const telegramFile = await ctx.api.getFile(document.file_id);
        const telegramFilePath = telegramFile.file_path;
        if (!telegramFilePath) {
          throw new Error("Telegram no devolvio file_path para el documento.");
        }

        const bytes = await downloadTelegramFileBuffer({
          botToken: proxyConfig.telegramBotToken,
          filePath: telegramFilePath,
          maxBytes: proxyConfig.imageMaxFileBytes,
        });

        const normalizedMime = mimeType.startsWith("image/") ? mimeType : "image/jpeg";
        const archived = await archiveImageInWorkspace({
          agent: activeAgent,
          chatId,
          messageId: ctx.message.message_id,
          bytes,
          mimeType: normalizedMime,
          originalName: fileName || undefined,
          telegramFilePath,
        });
        latestArchivedImageByChat.set(chatId, archived.relativePath);

        let analysis = "";
        try {
          analysis = await analyzeImageWithOpenAi({
            client: imageClient,
            bytes,
            mimeType: archived.mimeType,
            caption,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          analysis = `No pude analizar la imagen con el modelo. Detalle: ${message}`;
        }

        const replyText = [
          "Listo, ya procese la imagen.",
          `La guarde como ${archived.relativePath}.`,
          `Pesa ${formatBytes(archived.bytes)}.`,
          "",
          "Esto vi:",
          analysis,
          "",
          `Si despues queres reenviarla como adjunto: /adjuntar #${toHashtagToken(archived.relativePath)}`,
        ].join("\n");

        await ctx.reply(replyText);
        await rememberAssistant({
          chatId,
          userId,
          text: replyText,
          source: "proxy-telegram:image-analysis",
        });
        logInfo(
          `Telegram image-document chat=${chatId} user=${userId} archived=${archived.relativePath} bytes=${archived.bytes}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const replyText = `No pude procesar la imagen: ${message}`;
        await ctx.reply(replyText);
        await rememberAssistant({
          chatId,
          userId,
          text: replyText,
          source: "proxy-telegram:image-error",
        });
        logError(`Telegram image-document error chat=${chatId} user=${userId}: ${message}`);
      }
    });
  });

  bot.on("message:voice", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isAllowedUser(userId)) {
      return;
    }

    const chatId = ctx.chat.id;
    await enqueueChatWork(chatId, "message:voice", async () => {
      const activeAgent = resolveActiveAgent(chatId);
      const voice = ctx.message.voice;
      const caption = "";

      await rememberUser({
        chatId,
        userId,
        text: "[audio-voz]",
        source: "proxy-telegram:audio-user",
      });

      try {
        const telegramFile = await ctx.api.getFile(voice.file_id);
        const telegramFilePath = telegramFile.file_path;
        if (!telegramFilePath) {
          throw new Error("Telegram no devolvió file_path para el audio.");
        }

        const mimeType = (voice.mime_type ?? "audio/ogg").toLowerCase();
        const bytes = await downloadTelegramFileBuffer({
          botToken: proxyConfig.telegramBotToken,
          filePath: telegramFilePath,
          maxBytes: proxyConfig.audioMaxFileBytes,
        });

        const fileName = `voice_${chatId}_${ctx.message.message_id}${extensionFromAudioMimeType(mimeType)}`;
        const transcript = await transcribeAudioWithOpenAi({
          client: imageClient,
          bytes,
          mimeType,
          fileName,
        });
        if (!transcript) {
          throw new Error("No pude transcribir el audio.");
        }

        logInfo(`Telegram audio-transcribed chat=${chatId} user=${userId} chars=${transcript.length}`);
        await ctx.reply(`Transcripción:\n${transcript}`);
        await rememberAssistant({
          chatId,
          userId,
          text: `Transcripción de audio: ${truncateInline(transcript, 2000)}`,
          source: "proxy-telegram:audio-transcript",
        });

        const objectiveRaw = caption ? `${transcript}\n\n${caption}` : transcript;
        await runObjectiveExecution({
          chatId,
          userId,
          activeAgent,
          objectiveRaw,
          rememberUserSource: "proxy-telegram:audio-transcript-user",
          reply: async (replyText: string) => ctx.reply(replyText),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const replyText = `No pude procesar/transcribir el audio: ${message}`;
        await ctx.reply(replyText);
        await rememberAssistant({
          chatId,
          userId,
          text: replyText,
          source: "proxy-telegram:audio-error",
        });
        logError(`Telegram audio error chat=${chatId} user=${userId}: ${message}`);
      }
    });
  });

  bot.on("message:audio", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isAllowedUser(userId)) {
      return;
    }

    const chatId = ctx.chat.id;
    await enqueueChatWork(chatId, "message:audio", async () => {
      const activeAgent = resolveActiveAgent(chatId);
      const audio = ctx.message.audio;
      const caption = (ctx.message.caption ?? "").trim();

      await rememberUser({
        chatId,
        userId,
        text: caption ? `[audio] ${caption}` : "[audio]",
        source: "proxy-telegram:audio-user",
      });

      try {
        const telegramFile = await ctx.api.getFile(audio.file_id);
        const telegramFilePath = telegramFile.file_path;
        if (!telegramFilePath) {
          throw new Error("Telegram no devolvió file_path para el audio.");
        }

        const mimeType = (audio.mime_type ?? "audio/mpeg").toLowerCase();
        const bytes = await downloadTelegramFileBuffer({
          botToken: proxyConfig.telegramBotToken,
          filePath: telegramFilePath,
          maxBytes: proxyConfig.audioMaxFileBytes,
        });

        const fileName =
          audio.file_name?.trim() || `audio_${chatId}_${ctx.message.message_id}${extensionFromAudioMimeType(mimeType)}`;
        const transcript = await transcribeAudioWithOpenAi({
          client: imageClient,
          bytes,
          mimeType,
          fileName,
        });
        if (!transcript) {
          throw new Error("No pude transcribir el audio.");
        }

        logInfo(`Telegram audio-transcribed chat=${chatId} user=${userId} chars=${transcript.length}`);
        await ctx.reply(`Transcripción:\n${transcript}`);
        await rememberAssistant({
          chatId,
          userId,
          text: `Transcripción de audio: ${truncateInline(transcript, 2000)}`,
          source: "proxy-telegram:audio-transcript",
        });

        const objectiveRaw = caption ? `${transcript}\n\n${caption}` : transcript;
        await runObjectiveExecution({
          chatId,
          userId,
          activeAgent,
          objectiveRaw,
          rememberUserSource: "proxy-telegram:audio-transcript-user",
          reply: async (replyText: string) => ctx.reply(replyText),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const replyText = `No pude procesar/transcribir el audio: ${message}`;
        await ctx.reply(replyText);
        await rememberAssistant({
          chatId,
          userId,
          text: replyText,
          source: "proxy-telegram:audio-error",
        });
        logError(`Telegram audio error chat=${chatId} user=${userId}: ${message}`);
      }
    });
  });

  bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isAllowedUser(userId)) {
      return;
    }

    const chatId = ctx.chat.id;
    const text = (ctx.message.text ?? "").trim();
    if (!text) {
      return;
    }
    const replyQuote = extractReplyTextFromTelegramEnvelope(ctx.message);
    const textWithReplyQuote = buildObjectiveFromUserTextAndReplyQuote(text, replyQuote);
    const preview = text.replace(/\s+/g, " ").slice(0, 140);
    logInfo(`Telegram inbound chat=${chatId} user=${userId} text="${preview}"`);
    if (replyQuote) {
      logInfo(`Telegram inbound-reply-quote chat=${chatId} user=${userId} chars=${replyQuote.length}`);
    }
    const normalizedText = normalizeTelegramCommand(text);

    if (normalizedText === "/status") {
      await replyLong(async (replyText: string) => ctx.reply(replyText), buildObjectiveStatusText(chatId));
      return;
    }

    if (normalizedText === "/cancel") {
      await requestObjectiveCancel({
        chatId,
        reply: async (replyText: string) => ctx.reply(replyText),
        reason: "cancelado por usuario via /cancel",
      });
      return;
    }

    await enqueueChatWork(chatId, "message:text", async () => {
      let activeAgent = resolveActiveAgent(chatId);

      if (normalizedText === "/start" || normalizedText === "/help") {
        await ctx.reply(formatHelp(activeAgent));
        return;
      }

      if (normalizedText === "/agents") {
        const lines = ["Agentes disponibles:"];
        for (const agent of registry.list()) {
          const marker = agent.name === activeAgent.name ? "*" : "-";
          lines.push(`${marker} ${agent.name} (cwd=${agent.cwd}, workspaceOnly=${String(agent.workspaceOnly)})`);
        }
        await ctx.reply(lines.join("\n"));
        return;
      }

      if (normalizedText.startsWith("/agent ")) {
        const target = normalizedText.replace(/^\/agent\s+/, "").trim();
        if (!target) {
          await ctx.reply("Uso: /agent <nombre>");
          return;
        }
        const candidate = registry.get(target);
        if (!candidate) {
          await ctx.reply(`Agente no encontrado: ${target}`);
          return;
        }
        activeAgentByChat.set(chatId, candidate.name);
        activeAgent = candidate;
        await ctx.reply(`Agente activo: ${candidate.name}`);
        return;
      }

      if (normalizedText === "/task" || normalizedText.startsWith("/task ")) {
        const input = normalizedText.replace(/^\/task\s*/, "").trim();
        await handleTaskCommand({
          chatId,
          userId,
          input,
          reply: async (replyText: string) => ctx.reply(replyText),
        });
        return;
      }

      const pendingApproval = objectiveState.getSemanticState(chatId)?.pendingApproval;
      if (pendingApproval) {
        const approvalDecision = parseApprovalReply(text);
        if (approvalDecision) {
          if (pendingApproval.expiresAtMs <= Date.now()) {
            objectiveState.clearPendingApproval(chatId);
            const replyText = "Esa confirmación ya venció. Si querés, pedímelo de nuevo.";
            await ctx.reply(replyText);
            await rememberAssistant({
              chatId,
              userId,
              text: replyText,
              source: "proxy-telegram:approval-expired",
            });
            return;
          }

          objectiveState.clearPendingApproval(chatId);
          if (approvalDecision === "deny") {
            const replyText = "Listo, no sigo con eso.";
            await ctx.reply(replyText);
            await rememberAssistant({
              chatId,
              userId,
              text: replyText,
              source: "proxy-telegram:approval-denied",
            });
            return;
          }

          const approvedAgent = registry.get(pendingApproval.activeAgent) ?? activeAgent;
          activeAgentByChat.set(chatId, approvedAgent.name);
          activeAgent = approvedAgent;
          await ctx.reply("Listo, sigo con eso.");
          await runObjectiveExecution({
            chatId,
            userId,
            activeAgent,
            objectiveRaw: pendingApproval.originalObjective,
            plannerAttachmentHint: pendingApproval.plannerAttachmentHint,
            approvedCapabilities: new Set([pendingApproval.capability]),
            reply: async (replyText: string) => ctx.reply(replyText),
            rememberUserSource: undefined,
          });
          return;
        }

        objectiveState.clearPendingApproval(chatId);
      }

      const attachmentIntent = parseAttachmentIntent(text, normalizedText);
      const explicitAttachmentCommand = isExplicitAttachmentCommand(normalizedText);
      const emailIntent = looksLikeEmailIntent(text);
      const shouldBypassAttachmentFlow =
        (attachmentIntent.kind === "send" || attachmentIntent.kind === "send_latest") &&
        emailIntent &&
        !explicitAttachmentCommand;

      let plannerAttachmentHint = "";
      if (shouldBypassAttachmentFlow) {
        let suggestedPath = "";
        if (attachmentIntent.kind === "send") {
          suggestedPath = attachmentIntent.target;
        } else {
          suggestedPath = latestArchivedImageByChat.get(chatId) ?? ((await findLatestWorkspaceImage(activeAgent)) || "");
        }
        if (suggestedPath) {
          plannerAttachmentHint = `Archivo sugerido en workspace: ${suggestedPath}`;
        }
        logInfo(
          `Telegram attach-flow-bypass chat=${chatId} reason=email-intent explicit=${String(explicitAttachmentCommand)} hint=${plannerAttachmentHint || "-"}`,
        );
      }

      if ((attachmentIntent.kind === "send" || attachmentIntent.kind === "send_latest") && !shouldBypassAttachmentFlow) {
        logInfo(
          `Telegram attach-flow-enter chat=${chatId} kind=${attachmentIntent.kind} explicit=${String(explicitAttachmentCommand)} emailIntent=${String(emailIntent)}`,
        );
        let resolvedTarget = "";
        let hashtagResolved = false;
        if (attachmentIntent.kind === "send") {
          resolvedTarget = attachmentIntent.target;
        } else {
          resolvedTarget = latestArchivedImageByChat.get(chatId) ?? "";
          if (!resolvedTarget) {
            resolvedTarget = (await findLatestWorkspaceImage(activeAgent)) ?? "";
          }
          if (!resolvedTarget) {
            await ctx.reply("No tengo una imagen reciente para adjuntar. Enviame una imagen primero.");
            return;
          }
        }
        try {
          const resolved = await resolveWorkspaceHashtagsInText(resolvedTarget, activeAgent);
          resolvedTarget = resolved.text;
          hashtagResolved = resolved.replacements.length > 0;
          if (resolved.replacements.length > 0) {
            const mapping = resolved.replacements.map((item) => `${item.tag}->${item.path}`).join(", ");
            logInfo(`Telegram attach hashtag-resolve chat=${chatId} map="${mapping}"`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logError(`No pude resolver hashtags para adjunto chat=${chatId}: ${message}`);
        }

        if (attachmentIntent.kind === "send" && attachmentIntent.target.trim().startsWith("#") && !hashtagResolved) {
          const fallbackLatest = latestArchivedImageByChat.get(chatId) ?? (await findLatestWorkspaceImage(activeAgent));
          if (fallbackLatest) {
            resolvedTarget = fallbackLatest;
          } else {
            const replyText = [
              `No pude resolver ${attachmentIntent.target} a un archivo actual del workspace.`,
              "Es probable que el workspace se haya reiniciado y el archivo ya no exista.",
              "Enviame la imagen de nuevo o usa /adjuntar sin hashtag.",
            ].join("\n");
            await ctx.reply(replyText);
            await rememberAssistant({
              chatId,
              userId,
              text: replyText,
              source: "proxy-telegram:attach-error",
            });
            return;
          }
        }

        try {
          const relativePath = await sendWorkspaceAttachment(ctx, activeAgent, resolvedTarget);
          const replyText = `Listo, te mande el adjunto ${relativePath}.`;
          await ctx.reply(replyText);
          logInfo(`Telegram attach-flow-sent chat=${chatId} path=${relativePath}`);
          await rememberUser({
            chatId,
            userId,
            text,
            source: "proxy-telegram:attach-user",
          });
          await rememberAssistant({
            chatId,
            userId,
            text: replyText,
            source: "proxy-telegram:attach-sent",
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const isMissingFile = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
          const friendlyMessage = isMissingFile
            ? "No encuentro ese archivo en workspace. Si reiniciaste el bot, reenviame la imagen o usa /adjuntar sin hashtag."
            : message;
          const replyText = `No pude enviar el adjunto: ${message}`;
          const replyTextUser = isMissingFile ? `No pude enviar el adjunto: ${friendlyMessage}` : replyText;
          await ctx.reply(replyTextUser);
          logError(`Telegram attach-flow-error chat=${chatId} detail=${message}`);
          await rememberAssistant({
            chatId,
            userId,
            text: replyTextUser,
            source: "proxy-telegram:attach-error",
          });
        }
        return;
      }

      await runObjectiveExecution({
        chatId,
        userId,
        activeAgent,
        objectiveRaw: textWithReplyQuote,
        plannerAttachmentHint,
        rememberUserSource: "proxy-telegram:user",
        reply: async (replyText: string) => ctx.reply(replyText),
      });
    });
  });

  bot.catch((error) => {
    const { ctx } = error;
    logError(`Telegram update ${ctx.update.update_id}: ${error.error}`);
    if (error.error instanceof GrammyError) {
      logError(`Telegram request error: ${error.error.description}`);
    } else if (error.error instanceof HttpError) {
      logError(`Telegram HTTP error: ${String(error.error)}`);
    }
  });

  logInfo("Iniciando Proxy Telegram en long polling...");
  await bot.start({
    drop_pending_updates: false,
    onStart: (botInfo) => {
      logInfo(`Proxy Telegram activo como @${botInfo.username}`);
    },
  });
}

export async function runProxyTelegramFromProcess(): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      await startTerminalProxyTelegramBot();
      logError("Proxy Telegram finalizó inesperadamente; reiniciando...");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`Proxy Telegram crash: ${message}`);
      process.stderr.write(`Error: ${message}\n`);
    }

    attempt += 1;
    const retryMs = Math.min(30_000, Math.max(2_000, attempt * 2_000));
    logInfo(`Reintentando inicio de Telegram en ${retryMs}ms (intento ${attempt}).`);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, retryMs);
    });
  }
}
