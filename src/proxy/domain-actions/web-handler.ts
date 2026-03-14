import { extractFirstHttpUrl } from "../agentic-helpers.js";
import { throwIfAborted } from "../abort-utils.js";
import { normalizeIntentText } from "../intent-text.js";
import type { DeterministicDomainHandler, WebDeterministicDeps } from "./types.js";

function buildWebOpenText(page: {
  title: string;
  finalUrl: string;
  contentType?: string | null;
  truncated?: boolean;
  text?: string | null;
}): string {
  return [
    `Web abierta: ${page.title}`,
    `url: ${page.finalUrl}`,
    `content_type: ${page.contentType || "-"}`,
    ...(page.truncated ? ["truncated: true"] : []),
    "",
    page.text || "(sin contenido legible)",
  ].join("\n");
}

export function createWebDeterministicHandler(deps: WebDeterministicDeps): DeterministicDomainHandler {
  return async (params) => {
    if (params.intent.domain !== "web") {
      return null;
    }

    throwIfAborted(params.objectiveSignal);
    const normalized = normalizeIntentText(params.objectiveRaw);
    const directUrl = extractFirstHttpUrl(params.objectiveRaw);
    const recentResults = deps.getLatestWebResults(params.chatId);
    const indexedRef = normalized.match(/\b(\d{1,2}|primero|primera|segundo|segunda|tercero|tercera|ultimo|último|ultima|última)\b/);
    let selectedUrl = directUrl;
    if (!selectedUrl && /\b(abrir|abre|open|leer|ver)\b/.test(normalized) && indexedRef && recentResults.length > 0) {
      const token = indexedRef[1] ?? "";
      const index =
        /^prim/.test(token)
          ? 0
          : /^seg/.test(token)
            ? 1
            : /^ter/.test(token)
              ? 2
              : /^ult/.test(token)
                ? recentResults.length - 1
                : Math.max(0, Number.parseInt(token, 10) - 1);
      if (Number.isFinite(index) && index >= 0 && index < recentResults.length) {
        selectedUrl = recentResults[index]?.url;
      }
    }

    if (selectedUrl) {
      const page = await deps.webBrowser.open(selectedUrl);
      params.objectiveState.mergeSlots(params.chatId, params.runId, {
        lastWebQuery: selectedUrl,
      });
      const text = buildWebOpenText(page);
      await params.replyAndRemember(text, "proxy-telegram:web-open");
      return {
        status: "success",
        summary: `Web abierta: ${page.title}`,
        reason: "deterministic_web_open",
      };
    }

    const query = params.objectiveRaw
      .replace(/^\s*(?:busca(?:r)?|buscame|googlea|googleame|consulta(?:r)?|averigua|revisa|mira)\b[\s:,-]*/i, "")
      .trim();
    const hits = await deps.webBrowser.search(query || params.objectiveRaw, deps.webSearchMaxResults);
    deps.setLatestWebResults(params.chatId, hits);
    params.objectiveState.mergeSlots(params.chatId, params.runId, {
      lastWebQuery: query || params.objectiveRaw,
    });
    const text =
      hits.length === 0 ? "No encontré resultados web." : deps.buildWebResultsListText(query || params.objectiveRaw, hits);
    await params.replyAndRemember(text, "proxy-telegram:web-search");
    return {
      status: "success",
      summary: text,
      reason: "deterministic_web_search",
    };
  };
}
