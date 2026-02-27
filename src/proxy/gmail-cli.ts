#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { GmailAccountService } from "../gmail-account.js";
import {
  parseAttachmentPaths,
  parseGmailForwardArgs,
  parseGmailListArgs,
  parseGmailReplyArgs,
  parseGmailSendArgs,
  type ParsedKeyValueOptions,
} from "../domains/gmail/command-parser.js";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const projectRootDir = path.resolve(currentDir, "../..");
dotenv.config({ path: path.join(projectRootDir, ".env") });
dotenv.config();

type SendInput = {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  attachments: string[];
};

type ReplyInput = {
  messageId: string;
  body: string;
  cc?: string;
  bcc?: string;
  replyAll: boolean;
  attachments: string[];
};

type ForwardInput = {
  messageId: string;
  to: string;
  body: string;
  cc?: string;
  bcc?: string;
  attachments: string[];
};

type DraftCreateInput = SendInput;

type DraftUpdateInput = SendInput & {
  draftId: string;
};

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (typeof value === "undefined") {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "si", "sí", "s"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "n"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parseIntegerEnv(value: string | undefined, defaultValue: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function parseKeyValueOptions(tokens: string[]): ParsedKeyValueOptions {
  const args: string[] = [];
  const options: Record<string, string> = {};

  for (const tokenRaw of tokens) {
    const token = tokenRaw.trim();
    if (!token) {
      continue;
    }
    const normalized = token.startsWith("--") ? token.slice(2) : token;
    const eq = normalized.indexOf("=");
    if (eq <= 0) {
      args.push(tokenRaw);
      continue;
    }
    const key = normalized.slice(0, eq).trim().toLowerCase();
    const value = normalized.slice(eq + 1).trim();
    if (!/^[a-z][a-z0-9_-]*$/.test(key)) {
      args.push(tokenRaw);
      continue;
    }
    options[key] = value;
  }

  return { args, options };
}

function getOption(options: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = options[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function optionalField(value: string | undefined): string | undefined {
  const normalized = value?.trim() ?? "";
  return normalized || undefined;
}

function toAttachmentInputs(paths: string[]): Array<{ path: string }> {
  const unique = Array.from(new Set(paths.map((item) => item.trim()).filter(Boolean)));
  return unique.map((item) => ({ path: item }));
}

function sanitizeFileName(fileName: string): string {
  const normalized = fileName
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || "attachment.bin";
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureUniquePath(rawPath: string): Promise<string> {
  let nextPath = rawPath;
  let suffix = 2;
  const extension = path.extname(rawPath);
  const base = extension ? rawPath.slice(0, -extension.length) : rawPath;

  while (await pathExists(nextPath)) {
    nextPath = `${base}_${suffix}${extension}`;
    suffix += 1;
  }

  return nextPath;
}

function splitTextChunks(input: string, maxChars = 3200): string[] {
  const text = input.trim();
  if (!text) {
    return [];
  }
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    chunks.push(text.slice(cursor, cursor + maxChars));
    cursor += maxChars;
  }
  return chunks;
}

function printUsage(): void {
  const lines = [
    "gmail-api (proxy directo Gmail API)",
    "",
    "Uso general:",
    "  gmail-api status",
    "  gmail-api profile",
    "  gmail-api inbox [limit=10]",
    "  gmail-api list [query libre] [limit=10]",
    "  gmail-api read <messageId>",
    "  gmail-api send to=<mail> subject=\"...\" body=\"...\" [cc=a@x.com,b@y.com] [bcc=c@z.com|cco=c@z.com] [attach=img.png,doc.pdf]",
    "  gmail-api reply <messageId> body=\"...\" [all=true] [cc=...] [bcc=...] [attach=...]",
    "  gmail-api forward <messageId> to=<mail> body=\"...\" [cc=...] [bcc=...] [attach=...]",
    "  gmail-api delete <messageId>",
    "  gmail-api modify <markread|markunread|trash|untrash|star|unstar> <messageId>",
    "  gmail-api thread list <threadId>",
    "  gmail-api thread read <threadId> [limit=20]",
    "  gmail-api draft list [limit=20]",
    "  gmail-api draft read <draftId>",
    "  gmail-api draft create to=<mail> subject=\"...\" body=\"...\" [cc=...] [bcc=...] [attach=...]",
    "  gmail-api draft update <draftId> to=<mail> subject=\"...\" body=\"...\" [cc=...] [bcc=...] [attach=...]",
    "  gmail-api draft send <draftId>",
    "  gmail-api draft delete <draftId>",
    "  gmail-api attachment list <messageId>",
    "  gmail-api attachment download <messageId> <selector> [out=./archivo.bin]",
    "",
    "Selector de adjunto en download:",
    "  - #1 / 1 (por indice)",
    "  - nombre exacto o parcial (por filename)",
    "  - id:<attachmentId> (por attachmentId)",
    "",
    "Requisitos de entorno:",
    "  ENABLE_GMAIL_ACCOUNT=true",
    "  GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function createService(): GmailAccountService {
  return new GmailAccountService({
    enabled: parseBooleanEnv(process.env.ENABLE_GMAIL_ACCOUNT, Boolean(process.env.GMAIL_REFRESH_TOKEN)),
    clientId: process.env.GMAIL_CLIENT_ID?.trim(),
    clientSecret: process.env.GMAIL_CLIENT_SECRET?.trim(),
    refreshToken: process.env.GMAIL_REFRESH_TOKEN?.trim(),
    accountEmail: process.env.GMAIL_ACCOUNT_EMAIL?.trim(),
    maxResults: parseIntegerEnv(process.env.GMAIL_MAX_RESULTS, 10),
  });
}

function parseSendInput(tokens: string[]): SendInput {
  const parsed = parseKeyValueOptions(tokens);
  const cc = optionalField(getOption(parsed.options, ["cc", "copia"]));
  const bcc = optionalField(getOption(parsed.options, ["bcc", "cco"]));
  const attachments = parseAttachmentPaths(getOption(parsed.options, ["attach", "attachments", "files", "adjuntos"]));

  const toOpt = getOption(parsed.options, ["to", "para"]);
  const subjectOpt = getOption(parsed.options, ["subject", "asunto"]);
  const bodyOpt = getOption(parsed.options, ["body", "cuerpo", "mensaje"]);

  if (toOpt && subjectOpt && bodyOpt) {
    return {
      to: toOpt,
      subject: subjectOpt,
      body: bodyOpt,
      attachments,
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
    };
  }

  const fallback = parseGmailSendArgs(parsed);
  if (!fallback.ok) {
    throw new Error(fallback.error);
  }
  return {
    to: fallback.to,
    subject: fallback.subject,
    body: fallback.body,
    attachments: fallback.attachments,
    ...(cc || fallback.cc ? { cc: cc ?? fallback.cc } : {}),
    ...(bcc || fallback.bcc ? { bcc: bcc ?? fallback.bcc } : {}),
  };
}

function parseReplyInput(tokens: string[]): ReplyInput {
  const parsed = parseKeyValueOptions(tokens);
  const cc = optionalField(getOption(parsed.options, ["cc", "copia"]));
  const bcc = optionalField(getOption(parsed.options, ["bcc", "cco"]));
  const attachments = parseAttachmentPaths(getOption(parsed.options, ["attach", "attachments", "files", "adjuntos"]));
  const bodyOpt = getOption(parsed.options, ["body", "cuerpo", "mensaje"]);
  const messageOpt = getOption(parsed.options, ["id", "messageid", "message", "msg"]);
  const allOpt = getOption(parsed.options, ["all", "replyall"]);
  const replyAll = ["1", "true", "yes", "si", "sí", "on"].includes((allOpt ?? "").toLowerCase());

  if (messageOpt && bodyOpt) {
    return {
      messageId: messageOpt,
      body: bodyOpt,
      replyAll,
      attachments,
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
    };
  }

  const fallback = parseGmailReplyArgs(parsed);
  if (!fallback.ok) {
    throw new Error(fallback.error);
  }
  return {
    messageId: fallback.messageId,
    body: fallback.body,
    replyAll: replyAll || fallback.replyAll,
    attachments: fallback.attachments,
    ...(cc || fallback.cc ? { cc: cc ?? fallback.cc } : {}),
    ...(bcc || fallback.bcc ? { bcc: bcc ?? fallback.bcc } : {}),
  };
}

function parseForwardInput(tokens: string[]): ForwardInput {
  const parsed = parseKeyValueOptions(tokens);
  const cc = optionalField(getOption(parsed.options, ["cc", "copia"]));
  const bcc = optionalField(getOption(parsed.options, ["bcc", "cco"]));
  const attachments = parseAttachmentPaths(getOption(parsed.options, ["attach", "attachments", "files", "adjuntos"]));

  const messageOpt = getOption(parsed.options, ["id", "messageid", "message", "msg"]);
  const toOpt = getOption(parsed.options, ["to", "para"]);
  const bodyOpt = getOption(parsed.options, ["body", "cuerpo", "mensaje"]);
  if (messageOpt && toOpt && bodyOpt) {
    return {
      messageId: messageOpt,
      to: toOpt,
      body: bodyOpt,
      attachments,
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
    };
  }

  const fallback = parseGmailForwardArgs(parsed);
  if (!fallback.ok) {
    throw new Error(fallback.error);
  }
  return {
    messageId: fallback.messageId,
    to: fallback.to,
    body: fallback.body,
    attachments: fallback.attachments,
    ...(cc || fallback.cc ? { cc: cc ?? fallback.cc } : {}),
    ...(bcc || fallback.bcc ? { bcc: bcc ?? fallback.bcc } : {}),
  };
}

function parseDraftCreateInput(tokens: string[]): DraftCreateInput {
  return parseSendInput(tokens);
}

function parseDraftUpdateInput(tokens: string[]): DraftUpdateInput {
  const parsed = parseKeyValueOptions(tokens);
  const draftIdOption = getOption(parsed.options, ["id", "draft", "draftid"]);
  const draftIdArg = parsed.args[0]?.trim();
  const draftId = draftIdOption || draftIdArg || "";
  if (!draftId) {
    throw new Error("Falta draftId para draft update.");
  }

  const restTokens = draftIdOption ? [...tokens] : parsed.args.slice(1);
  const send = parseSendInput(restTokens);
  return {
    draftId,
    ...send,
  };
}

function formatAttachments(attachments: Array<{ filename: string; mimeType: string; size: number }>): string {
  if (attachments.length === 0) {
    return "Adjuntos: -";
  }
  return `Adjuntos: ${attachments.map((item) => `${item.filename} (${item.size} bytes)`).join(", ")}`;
}

async function resolveDownloadPath(outputRaw: string | undefined, fileName: string): Promise<string> {
  const safeFileName = sanitizeFileName(fileName);

  if (!outputRaw) {
    const defaultDir = path.resolve(process.cwd(), "gmail-attachments");
    await fs.mkdir(defaultDir, { recursive: true });
    return await ensureUniquePath(path.join(defaultDir, safeFileName));
  }

  const resolved = path.resolve(outputRaw);
  const outputEndsWithSeparator = outputRaw.endsWith("/") || outputRaw.endsWith(path.sep);
  if (outputEndsWithSeparator) {
    await fs.mkdir(resolved, { recursive: true });
    return await ensureUniquePath(path.join(resolved, safeFileName));
  }

  if (await pathExists(resolved)) {
    const stats = await fs.stat(resolved);
    if (stats.isDirectory()) {
      return await ensureUniquePath(path.join(resolved, safeFileName));
    }
  }

  await fs.mkdir(path.dirname(resolved), { recursive: true });
  return await ensureUniquePath(resolved);
}

function parseAttachmentSelector(raw: string | undefined): { filename?: string; attachmentId?: string; index?: number } {
  const selector = raw?.trim() ?? "";
  if (!selector) {
    return {};
  }
  if (/^id:/i.test(selector)) {
    return { attachmentId: selector.replace(/^id:/i, "").trim() };
  }
  const withoutHash = selector.startsWith("#") ? selector.slice(1) : selector;
  if (/^\d+$/.test(withoutHash)) {
    return { index: Number.parseInt(withoutHash, 10) };
  }
  return { filename: selector };
}

function isMetadataScopeQueryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /metadata scope/i.test(message) && /does not support 'q' parameter/i.test(message);
}

async function main(): Promise<void> {
  const service = createService();
  const argv = process.argv.slice(2);
  const command = (argv.shift() ?? "").trim().toLowerCase();

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "status") {
    const status = service.getStatus();
    process.stdout.write(
      [
        `enabled=${status.enabled ? "true" : "false"}`,
        `configured=${status.configured ? "true" : "false"}`,
        `account=${status.accountEmail || "-"}`,
        `max_results=${status.maxResults}`,
        `missing=${status.missing.join(",") || "-"}`,
      ].join("\n") + "\n",
    );
    return;
  }

  if (command === "profile") {
    const profile = await service.getProfile();
    process.stdout.write(
      [
        `email=${profile.emailAddress || "-"}`,
        `messages_total=${profile.messagesTotal}`,
        `threads_total=${profile.threadsTotal}`,
        `history_id=${profile.historyId || "-"}`,
      ].join("\n") + "\n",
    );
    return;
  }

  if (command === "inbox") {
    const parsed = parseKeyValueOptions(argv);
    const limit = parsePositiveInteger(parsed.options.limit);
    const extraQuery = parsed.args.join(" ").trim();
    let rows;
    if (!extraQuery) {
      rows = await service.listMessagesByLabelIds(["INBOX"], limit);
    } else {
      const query = `in:inbox ${extraQuery}`;
      try {
        rows = await service.listMessages(query, limit);
      } catch (error) {
        if (!isMetadataScopeQueryError(error)) {
          throw error;
        }
        rows = await service.listMessagesByLabelIds(["INBOX"], limit);
        process.stderr.write("WARN: Scope metadata no permite filtros q=. Devuelvo inbox sin filtro extra.\n");
      }
    }
    if (rows.length === 0) {
      process.stdout.write("Sin correos en inbox para ese filtro.\n");
      return;
    }
    const lines = rows.map((item, index) =>
      [
        `${index + 1}. ${item.subject || "(sin asunto)"}`,
        `id=${item.id}`,
        `thread=${item.threadId || "-"}`,
        `from=${item.from || "-"}`,
        `to=${item.to || "-"}`,
        `date=${item.date || "-"}`,
        item.snippet ? `snippet=${item.snippet}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    process.stdout.write(`${lines.join("\n\n")}\n`);
    return;
  }

  if (command === "list") {
    const parsed = parseKeyValueOptions(argv);
    const queryOption = getOption(parsed.options, ["q", "query", "filtro"]);
    const mergedArgs = queryOption ? [queryOption] : parsed.args;
    const listParsed = parseGmailListArgs({
      args: mergedArgs,
      options: parsed.options,
    });
    if (!listParsed.ok) {
      throw new Error(listParsed.error);
    }
    let rows;
    try {
      rows = await service.listMessages(listParsed.query, listParsed.limit);
    } catch (error) {
      if (!listParsed.query || !isMetadataScopeQueryError(error)) {
        throw error;
      }
      throw new Error(
        "El scope OAuth actual no permite búsquedas con q=. Usa `gmail-api inbox` o reautoriza con scope gmail.readonly/gmail.modify.",
      );
    }
    if (rows.length === 0) {
      process.stdout.write("Sin correos para ese filtro.\n");
      return;
    }
    const lines = rows.map((item, index) =>
      [
        `${index + 1}. ${item.subject || "(sin asunto)"}`,
        `id=${item.id}`,
        `thread=${item.threadId || "-"}`,
        `from=${item.from || "-"}`,
        `to=${item.to || "-"}`,
        `date=${item.date || "-"}`,
        item.snippet ? `snippet=${item.snippet}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    process.stdout.write(`${lines.join("\n\n")}\n`);
    return;
  }

  if (command === "read") {
    const messageId = argv[0]?.trim() ?? "";
    if (!messageId) {
      throw new Error("Falta messageId para read.");
    }
    const detail = await service.readMessage(messageId);
    const bodyChunks = splitTextChunks(detail.bodyText || detail.snippet || "", 6000);
    const lines = [
      `id=${detail.id}`,
      `thread=${detail.threadId || "-"}`,
      `from=${detail.from || "-"}`,
      `to=${detail.to || "-"}`,
      `subject=${detail.subject || "(sin asunto)"}`,
      `date=${detail.date || "-"}`,
      `labels=${detail.labelIds.join(",") || "-"}`,
      formatAttachments(detail.attachments ?? []),
      "",
      "body:",
      bodyChunks.length > 0 ? bodyChunks[0] : "(sin cuerpo)",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  if (command === "send") {
    const parsed = parseSendInput(argv);
    const sent = await service.sendMessage({
      to: parsed.to,
      subject: parsed.subject,
      body: parsed.body,
      ...(parsed.cc ? { cc: parsed.cc } : {}),
      ...(parsed.bcc ? { bcc: parsed.bcc } : {}),
      attachments: toAttachmentInputs(parsed.attachments),
    });
    process.stdout.write(`sent=true\nmessage_id=${sent.id}\nthread_id=${sent.threadId}\n`);
    return;
  }

  if (command === "reply") {
    const parsed = parseReplyInput(argv);
    const sent = await service.replyMessage({
      messageId: parsed.messageId,
      body: parsed.body,
      ...(parsed.cc ? { cc: parsed.cc } : {}),
      ...(parsed.bcc ? { bcc: parsed.bcc } : {}),
      ...(parsed.replyAll ? { replyAll: true } : {}),
      attachments: toAttachmentInputs(parsed.attachments),
    });
    process.stdout.write(`sent=true\nmessage_id=${sent.id}\nthread_id=${sent.threadId}\n`);
    return;
  }

  if (command === "forward") {
    const parsed = parseForwardInput(argv);
    const sent = await service.forwardMessage({
      messageId: parsed.messageId,
      to: parsed.to,
      body: parsed.body,
      ...(parsed.cc ? { cc: parsed.cc } : {}),
      ...(parsed.bcc ? { bcc: parsed.bcc } : {}),
      attachments: toAttachmentInputs(parsed.attachments),
    });
    process.stdout.write(`sent=true\nmessage_id=${sent.id}\nthread_id=${sent.threadId}\n`);
    return;
  }

  if (command === "delete" || command === "trash") {
    const messageId = argv[0]?.trim() ?? "";
    if (!messageId) {
      throw new Error("Falta messageId para delete/trash.");
    }
    await service.trashMessage(messageId);
    process.stdout.write(`ok=true\naction=trash\nmessage_id=${messageId}\n`);
    return;
  }

  if (command === "modify") {
    const action = (argv[0] ?? "").trim().toLowerCase();
    const messageId = (argv[1] ?? "").trim();
    if (!action || !messageId) {
      throw new Error("Uso: gmail-api modify <markread|markunread|trash|untrash|star|unstar> <messageId>");
    }
    if (action === "markread") {
      await service.markRead(messageId);
    } else if (action === "markunread") {
      await service.markUnread(messageId);
    } else if (action === "trash") {
      await service.trashMessage(messageId);
    } else if (action === "untrash") {
      await service.untrashMessage(messageId);
    } else if (action === "star") {
      await service.star(messageId);
    } else if (action === "unstar") {
      await service.unstar(messageId);
    } else {
      throw new Error(`Acción modify no soportada: ${action}`);
    }
    process.stdout.write(`ok=true\naction=${action}\nmessage_id=${messageId}\n`);
    return;
  }

  if (["markread", "markunread", "untrash", "star", "unstar"].includes(command)) {
    const messageId = argv[0]?.trim() ?? "";
    if (!messageId) {
      throw new Error(`Falta messageId para ${command}.`);
    }
    if (command === "markread") {
      await service.markRead(messageId);
    } else if (command === "markunread") {
      await service.markUnread(messageId);
    } else if (command === "untrash") {
      await service.untrashMessage(messageId);
    } else if (command === "star") {
      await service.star(messageId);
    } else if (command === "unstar") {
      await service.unstar(messageId);
    }
    process.stdout.write(`ok=true\naction=${command}\nmessage_id=${messageId}\n`);
    return;
  }

  if (command === "thread") {
    const subcommand = (argv.shift() ?? "").trim().toLowerCase();
    const threadId = (argv.shift() ?? "").trim();
    if (!subcommand || !threadId) {
      throw new Error("Uso: gmail-api thread <list|read> <threadId> [limit=20]");
    }
    const parsed = parseKeyValueOptions(argv);
    const limit = parsePositiveInteger(parsed.options.limit);
    if (subcommand === "list") {
      const rows = await service.listThread(threadId);
      if (rows.length === 0) {
        process.stdout.write("Thread vacío.\n");
        return;
      }
      const lines = rows.map((item, index) =>
        [
          `${index + 1}. ${item.subject || "(sin asunto)"}`,
          `id=${item.id}`,
          `from=${item.from || "-"}`,
          `to=${item.to || "-"}`,
          `date=${item.date || "-"}`,
          item.snippet ? `snippet=${item.snippet}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      process.stdout.write(`${lines.join("\n\n")}\n`);
      return;
    }
    if (subcommand === "read") {
      const rows = await service.readThread(threadId, limit);
      if (rows.length === 0) {
        process.stdout.write("Thread vacío.\n");
        return;
      }
      const lines = rows.map((item, index) =>
        [
          `${index + 1}. ${item.subject || "(sin asunto)"}`,
          `id=${item.id}`,
          `from=${item.from || "-"}`,
          `to=${item.to || "-"}`,
          `date=${item.date || "-"}`,
          formatAttachments(item.attachments ?? []),
          `body=${(item.bodyText || item.snippet || "").slice(0, 900)}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      process.stdout.write(`${lines.join("\n\n")}\n`);
      return;
    }
    throw new Error(`Subcomando thread no soportado: ${subcommand}`);
  }

  if (command === "draft") {
    const subcommand = (argv.shift() ?? "").trim().toLowerCase();
    if (!subcommand) {
      throw new Error("Uso: gmail-api draft <list|read|create|update|send|delete> ...");
    }

    if (subcommand === "list") {
      const parsed = parseKeyValueOptions(argv);
      const limit = parsePositiveInteger(parsed.options.limit);
      const rows = await service.listDrafts(limit);
      if (rows.length === 0) {
        process.stdout.write("Sin drafts.\n");
        return;
      }
      const lines = rows.map((item, index) =>
        [
          `${index + 1}. ${item.subject || "(sin asunto)"}`,
          `draft_id=${item.id}`,
          `message_id=${item.messageId || "-"}`,
          `thread=${item.threadId || "-"}`,
          `to=${item.to || "-"}`,
          `from=${item.from || "-"}`,
          `date=${item.date || "-"}`,
          item.snippet ? `snippet=${item.snippet}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      process.stdout.write(`${lines.join("\n\n")}\n`);
      return;
    }

    if (subcommand === "read") {
      const draftId = (argv[0] ?? "").trim();
      if (!draftId) {
        throw new Error("Falta draftId para draft read.");
      }
      const draft = await service.readDraft(draftId);
      const lines = [
        `draft_id=${draft.id}`,
        `message_id=${draft.messageId || "-"}`,
        `thread=${draft.threadId || "-"}`,
        `to=${draft.to || "-"}`,
        `from=${draft.from || "-"}`,
        `subject=${draft.subject || "(sin asunto)"}`,
        `date=${draft.date || "-"}`,
        formatAttachments(draft.attachments ?? []),
        "",
        "body:",
        splitTextChunks(draft.bodyText || draft.snippet || "", 6000)[0] || "(sin cuerpo)",
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
      return;
    }

    if (subcommand === "send") {
      const draftId = (argv[0] ?? "").trim();
      if (!draftId) {
        throw new Error("Falta draftId para draft send.");
      }
      const sent = await service.sendDraft(draftId);
      process.stdout.write(`sent=true\nmessage_id=${sent.id}\nthread_id=${sent.threadId}\n`);
      return;
    }

    if (subcommand === "delete") {
      const draftId = (argv[0] ?? "").trim();
      if (!draftId) {
        throw new Error("Falta draftId para draft delete.");
      }
      await service.deleteDraft(draftId);
      process.stdout.write(`ok=true\naction=draft-delete\ndraft_id=${draftId}\n`);
      return;
    }

    if (subcommand === "create") {
      const parsed = parseDraftCreateInput(argv);
      const created = await service.createDraft({
        to: parsed.to,
        subject: parsed.subject,
        body: parsed.body,
        ...(parsed.cc ? { cc: parsed.cc } : {}),
        ...(parsed.bcc ? { bcc: parsed.bcc } : {}),
        attachments: toAttachmentInputs(parsed.attachments),
      });
      process.stdout.write(
        `ok=true\naction=draft-create\ndraft_id=${created.draftId}\nmessage_id=${created.messageId}\nthread_id=${created.threadId}\n`,
      );
      return;
    }

    if (subcommand === "update") {
      const parsed = parseDraftUpdateInput(argv);
      const updated = await service.updateDraft({
        draftId: parsed.draftId,
        to: parsed.to,
        subject: parsed.subject,
        body: parsed.body,
        ...(parsed.cc ? { cc: parsed.cc } : {}),
        ...(parsed.bcc ? { bcc: parsed.bcc } : {}),
        attachments: toAttachmentInputs(parsed.attachments),
      });
      process.stdout.write(
        `ok=true\naction=draft-update\ndraft_id=${updated.draftId}\nmessage_id=${updated.messageId}\nthread_id=${updated.threadId}\n`,
      );
      return;
    }

    throw new Error(`Subcomando draft no soportado: ${subcommand}`);
  }

  if (command === "attachment") {
    const subcommand = (argv.shift() ?? "").trim().toLowerCase();
    if (!subcommand) {
      throw new Error("Uso: gmail-api attachment <list|download> ...");
    }
    if (subcommand === "list") {
      const messageId = (argv[0] ?? "").trim();
      if (!messageId) {
        throw new Error("Falta messageId para attachment list.");
      }
      const attachments = await service.listAttachments(messageId);
      if (attachments.length === 0) {
        process.stdout.write("Sin adjuntos.\n");
        return;
      }
      const lines = attachments.map((item, index) =>
        `${index + 1}. ${item.filename} | id=${item.attachmentId || "inline-data"} | mime=${item.mimeType} | size=${item.size}`,
      );
      process.stdout.write(`${lines.join("\n")}\n`);
      return;
    }

    if (subcommand === "download") {
      const messageId = (argv.shift() ?? "").trim();
      if (!messageId) {
        throw new Error("Falta messageId para attachment download.");
      }
      const selectorRaw = argv.shift();
      const parsed = parseKeyValueOptions(argv);
      const outOption = getOption(parsed.options, ["out", "output", "destino"]);
      const selector = parseAttachmentSelector(selectorRaw);
      const downloaded = await service.downloadAttachment({
        messageId,
        ...(selector.filename ? { filename: selector.filename } : {}),
        ...(selector.attachmentId ? { attachmentId: selector.attachmentId } : {}),
        ...(selector.index ? { index: selector.index } : {}),
      });
      const outputPath = await resolveDownloadPath(outOption, downloaded.filename);
      await fs.writeFile(outputPath, downloaded.data);
      process.stdout.write(
        [
          "ok=true",
          "action=attachment-download",
          `message_id=${messageId}`,
          `attachment_id=${downloaded.attachmentId}`,
          `filename=${downloaded.filename}`,
          `mime_type=${downloaded.mimeType}`,
          `bytes=${downloaded.data.length}`,
          `saved_path=${outputPath}`,
        ].join("\n") + "\n",
      );
      return;
    }

    throw new Error(`Subcomando attachment no soportado: ${subcommand}`);
  }

  throw new Error(`Comando no soportado: ${command}. Usa "gmail-api help".`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ERROR: ${message}\n`);
  process.exitCode = 1;
});
