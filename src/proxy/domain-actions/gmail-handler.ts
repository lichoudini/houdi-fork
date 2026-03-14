import type { GmailDeterministicDeps, DeterministicDomainHandler } from "./types.js";
import {
  buildFriendlyGmailListText,
  buildFriendlyGmailModifyText,
  buildFriendlyGmailProfileText,
  buildFriendlyGmailReadText,
  buildFriendlyGmailSendText,
  buildFriendlyGmailStatusText,
} from "../user-facing.js";
import { throwIfAborted } from "../abort-utils.js";

export function createGmailDeterministicHandler(deps: GmailDeterministicDeps): DeterministicDomainHandler {
  return async (params) => {
    if (params.intent.domain !== "gmail") {
      return null;
    }

    const gmailIntent = params.intent.entities.gmail;
    const status = deps.gmailAccount.getStatus();
    const statusText = buildFriendlyGmailStatusText(status);

    if (gmailIntent?.action === "status") {
      await params.replyAndRemember(statusText, "proxy-telegram:gmail-status");
      return {
        status: "success",
        summary: statusText,
        reason: "deterministic_gmail_status",
      };
    }

    if (!status.configured) {
      await params.replyAndRemember(statusText, "proxy-telegram:gmail-status");
      return {
        status: "blocked",
        summary: statusText,
        reason: "gmail_not_configured",
      };
    }

    if (gmailIntent?.action === "profile") {
      throwIfAborted(params.objectiveSignal);
      const profile = await deps.gmailAccount.getProfile();
      const text = buildFriendlyGmailProfileText(profile);
      await params.replyAndRemember(text, "proxy-telegram:gmail-profile");
      return {
        status: "success",
        summary: text,
        reason: "deterministic_gmail_profile",
      };
    }

    if (params.intent.action === "list") {
      throwIfAborted(params.objectiveSignal);
      const messages = await deps.gmailAccount.listMessages(gmailIntent?.query, deps.listMaxResults);
      const gmailContext = deps.getGmailContext(params.chatId);
      gmailContext.listedMessageIds = messages.map((item) => item.id).filter(Boolean);
      gmailContext.lastMessageId = messages[0]?.id || gmailContext.lastMessageId;
      for (const item of messages) {
        if (!item.id) {
          continue;
        }
        deps.updateGmailMessageContext(gmailContext, item.id, {
          ...(item.threadId ? { threadId: item.threadId } : {}),
          ...(item.subject ? { subject: item.subject } : {}),
        });
      }
      const text = buildFriendlyGmailListText(messages);
      await params.replyAndRemember(text, "proxy-telegram:gmail-list");
      return {
        status: "success",
        summary: text,
        reason: "deterministic_gmail_list",
      };
    }

    if (params.intent.action === "read") {
      throwIfAborted(params.objectiveSignal);
      const messageId = await deps.resolveGmailMessageIdForIntent({
        chatId: params.chatId,
        intent: params.intent,
      });
      if (!messageId) {
        const text = "No pude resolver qué email leer. Pedime primero 'lista mis emails' o indica el mensaje.";
        await params.replyAndRemember(text, "proxy-telegram:gmail-read-missing");
        return {
          status: "incomplete",
          summary: text,
          reason: "gmail_read_missing_message_id",
        };
      }
      const detail = await deps.gmailAccount.readMessage(messageId);
      const gmailContext = deps.getGmailContext(params.chatId);
      deps.updateGmailMessageContext(gmailContext, detail.id, {
        ...(detail.threadId ? { threadId: detail.threadId } : {}),
        ...(detail.subject ? { subject: detail.subject } : {}),
        attachments: (detail.attachments ?? []).map((item, index) => ({
          index: index + 1,
          filename: item.filename || `adjunto-${index + 1}`,
        })),
      });
      params.objectiveState.mergeSlots(params.chatId, params.runId, {
        ...(detail.subject ? { gmailSubject: detail.subject } : {}),
      });
      const text = buildFriendlyGmailReadText(detail);
      await params.replyAndRemember(text, "proxy-telegram:gmail-read");
      return {
        status: "success",
        summary: `Leido: ${detail.subject || "email sin asunto"}`,
        reason: "deterministic_gmail_read",
      };
    }

    if (params.intent.action === "send") {
      throwIfAborted(params.objectiveSignal);
      const payloadResult = deps.buildScheduledGmailSendPayload({
        rawText: params.objectiveRaw,
        instruction: params.objectiveRaw,
        taskTitle: gmailIntent?.subject?.trim() || "Mensaje",
      });
      if (!payloadResult.payload) {
        const text = payloadResult.errorText ?? "No pude estructurar el email a enviar.";
        await params.replyAndRemember(text, "proxy-telegram:gmail-send-missing");
        return {
          status: "incomplete",
          summary: text,
          reason: "gmail_send_missing_fields",
        };
      }
      params.objectiveState.mergeSlots(params.chatId, params.runId, {
        currentRecipient: payloadResult.payload.to,
        gmailTo: payloadResult.payload.to,
        gmailSubject: payloadResult.payload.subject,
      });
      const sent = await deps.gmailAccount.sendMessage({
        to: payloadResult.payload.to,
        subject: payloadResult.payload.subject,
        body: payloadResult.payload.body,
        ...(payloadResult.payload.cc ? { cc: payloadResult.payload.cc } : {}),
        ...(payloadResult.payload.bcc ? { bcc: payloadResult.payload.bcc } : {}),
      });
      if (sent.id) {
        deps.updateGmailMessageContext(deps.getGmailContext(params.chatId), sent.id, {
          ...(sent.threadId ? { threadId: sent.threadId } : {}),
          ...(payloadResult.payload.subject ? { subject: payloadResult.payload.subject } : {}),
        });
      }
      const text = buildFriendlyGmailSendText({
        to: payloadResult.payload.to,
        subject: payloadResult.payload.subject,
      });
      await params.replyAndRemember(text, "proxy-telegram:gmail-send");
      return {
        status: "success",
        summary: text,
        reason: "deterministic_gmail_send",
      };
    }

    if (["markread", "markunread", "trash", "untrash", "star", "unstar"].includes(gmailIntent?.action ?? "")) {
      throwIfAborted(params.objectiveSignal);
      const messageId = await deps.resolveGmailMessageIdForIntent({
        chatId: params.chatId,
        intent: params.intent,
      });
      if (!messageId) {
        const text = "No pude resolver qué email modificar. Indica el mensaje o lista primero los emails.";
        await params.replyAndRemember(text, "proxy-telegram:gmail-modify-missing");
        return {
          status: "incomplete",
          summary: text,
          reason: "gmail_modify_missing_message_id",
        };
      }
      switch (gmailIntent?.action) {
        case "markread":
          await deps.gmailAccount.markRead(messageId);
          break;
        case "markunread":
          await deps.gmailAccount.markUnread(messageId);
          break;
        case "trash":
          await deps.gmailAccount.trashMessage(messageId);
          break;
        case "untrash":
          await deps.gmailAccount.untrashMessage(messageId);
          break;
        case "star":
          await deps.gmailAccount.star(messageId);
          break;
        case "unstar":
          await deps.gmailAccount.unstar(messageId);
          break;
        default:
          break;
      }
      const text = buildFriendlyGmailModifyText(gmailIntent?.action ?? "");
      await params.replyAndRemember(text, "proxy-telegram:gmail-modify");
      return {
        status: "success",
        summary: text,
        reason: `deterministic_gmail_${gmailIntent?.action ?? "modify"}`,
      };
    }

    return null;
  };
}
