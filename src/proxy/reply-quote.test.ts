import assert from "node:assert/strict";
import test from "node:test";
import {
  buildObjectiveFromUserTextAndReplyQuote,
  extractReplyTextFromTelegramEnvelope,
  extractReplyTextFromTelegramMessage,
} from "./reply-quote.js";

test("extracts quoted text from telegram reply message", () => {
  const output = extractReplyTextFromTelegramMessage({
    text: "Resumen de noticias de Boca Juniors",
  });
  assert.equal(output, "Resumen de noticias de Boca Juniors");
});

test("extracts quoted text from telegram envelope quote fallback", () => {
  const output = extractReplyTextFromTelegramEnvelope({
    quote: { text: "Solo este párrafo citado" },
  });
  assert.equal(output, "Solo este párrafo citado");
});

test("builds email objective using quoted content as body hint", () => {
  const output = buildObjectiveFromUserTextAndReplyQuote(
    "Enviar resumen por email a nazareno.tomaselli@vrand.biz",
    "Boca ganó 2-0 y se clasificó a semifinales.",
  );
  assert.match(output, /Contenido citado/);
  assert.match(output, /Boca ganó 2-0/);
  assert.match(output, /usar el contenido citado como cuerpo/i);
});

test("builds generic objective with quoted context for non-email requests", () => {
  const output = buildObjectiveFromUserTextAndReplyQuote(
    "Guardar esto en archivo",
    "Texto de referencia para guardar.",
  );
  assert.match(output, /Contexto citado/);
  assert.match(output, /Texto de referencia/);
});

test("treats explicit recipient email as email-send directive", () => {
  const output = buildObjectiveFromUserTextAndReplyQuote(
    "Mandalo a equipo@vrand.biz",
    "Contenido citado listo para enviar.",
  );
  assert.match(output, /Contenido citado/);
  assert.match(output, /usar el contenido citado como cuerpo/i);
});
