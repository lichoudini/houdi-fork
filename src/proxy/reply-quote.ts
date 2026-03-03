function normalizeIntentText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function truncateInline(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  const trimmed = input.slice(0, Math.max(0, maxChars - 3)).trimEnd();
  return `${trimmed}...`;
}

function isEmailSendDirective(text: string): boolean {
  const normalized = normalizeIntentText(text);
  const hasSendVerb = /\b(envi\w*|mand\w*|send|reenvi\w*|pas\w*)\b/.test(normalized);
  const hasMailCue = /\b(correo|mail|email|gmail|resumen|destinatari\w*|asunto)\b/.test(normalized);
  const hasEmailAddress = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text);
  return hasSendVerb && (hasMailCue || hasEmailAddress);
}

export function extractReplyTextFromTelegramMessage(replyMessage: unknown, maxChars = 4000): string {
  if (!replyMessage || typeof replyMessage !== "object") {
    return "";
  }
  const payload = replyMessage as { text?: unknown; caption?: unknown };
  const blocks: string[] = [];
  if (typeof payload.text === "string" && payload.text.trim()) {
    blocks.push(payload.text.trim());
  }
  if (typeof payload.caption === "string" && payload.caption.trim()) {
    blocks.push(payload.caption.trim());
  }
  const joined = blocks.join("\n").trim();
  if (!joined) {
    return "";
  }
  return truncateInline(joined, maxChars);
}

export function extractReplyTextFromTelegramEnvelope(message: unknown, maxChars = 4000): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const payload = message as {
    reply_to_message?: unknown;
    quote?: { text?: unknown };
  };
  const fromReply = extractReplyTextFromTelegramMessage(payload.reply_to_message, maxChars);
  if (fromReply) {
    return fromReply;
  }
  const quoteText = typeof payload.quote?.text === "string" ? payload.quote.text.trim() : "";
  if (!quoteText) {
    return "";
  }
  return truncateInline(quoteText, maxChars);
}

export function buildObjectiveFromUserTextAndReplyQuote(userText: string, replyQuote: string): string {
  const objective = userText.trim();
  const quoted = replyQuote.trim();
  if (!quoted) {
    return objective;
  }
  if (!objective) {
    return quoted;
  }
  if (isEmailSendDirective(objective)) {
    return [
      objective,
      "",
      "Contenido citado (mensaje respondido):",
      quoted,
      "",
      "Si se envia por email, usar el contenido citado como cuerpo del correo.",
    ].join("\n");
  }
  return [objective, "", "Contexto citado:", quoted].join("\n");
}
