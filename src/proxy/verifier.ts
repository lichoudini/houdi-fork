import OpenAI from "openai";
import type { AgentProfile } from "../agents.js";
import { proxyConfig } from "./config.js";
import type { ExecutedCommand, ObjectiveVerification } from "./types.js";
import { parseObjectiveVerification } from "./types.js";

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

function buildVerifierSystemPrompt(): string {
  return [
    "Eres un verificador de cumplimiento de objetivos.",
    "Debes decidir si el objetivo del usuario ya fue cumplido con los resultados reales de terminal.",
    "",
    "Responde SOLO JSON válido sin texto extra.",
    'Schema exacto: {"status":"success"|"continue"|"blocked","summary":"string"}.',
    "",
    "Reglas:",
    "1) Usa solo evidencia de commands/stdout/stderr/exitCode/timedOut.",
    "2) Si el objetivo ya fue satisfecho, status=success.",
    "3) Si no está satisfecho pero se puede seguir, status=continue.",
    "4) Si hay bloqueo real (errores persistentes/permisos/imposible), status=blocked.",
    "5) summary debe ser corto y accionable.",
    "6) Si el objetivo era listar/ver directorio y hubo comando de listado con exitCode=0, es success aunque el directorio esté vacío.",
  ].join("\n");
}

function summarizeHistory(history: ExecutedCommand[], maxItems: number): string {
  const recent = history.slice(-Math.max(1, maxItems));
  if (recent.length === 0) {
    return "(sin historial)";
  }
  const payload = recent.map((item) => ({
    command: item.command,
    exitCode: item.exitCode,
    timedOut: item.timedOut,
    stdout: item.stdout.slice(0, 1800),
    stderr: item.stderr.slice(0, 1200),
  }));
  return JSON.stringify(payload, null, 2);
}

function normalizeText(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function parseSavedPath(stdout: string): string | undefined {
  const match = stdout.match(/^saved_path=([^\r\n]+)$/m);
  return match?.[1]?.trim();
}

function parseAttachmentDownloadEvidence(history: ExecutedCommand[]): {
  successPaths: string[];
  hasDownloadAttempt: boolean;
  hasAttachmentListSuccess: boolean;
  hasPlaceholderFailure: boolean;
} {
  const out = {
    successPaths: [] as string[],
    hasDownloadAttempt: false,
    hasAttachmentListSuccess: false,
    hasPlaceholderFailure: false,
  };

  for (const item of history) {
    const command = item.command.trim().toLowerCase();
    if (!command.startsWith("gmail-api ")) {
      continue;
    }

    if (command.startsWith("gmail-api attachment list ") && item.exitCode === 0) {
      out.hasAttachmentListSuccess = true;
      continue;
    }

    if (!command.startsWith("gmail-api attachment download ")) {
      continue;
    }
    out.hasDownloadAttempt = true;

    if (item.exitCode === 0) {
      const savedPath = parseSavedPath(item.stdout);
      if (savedPath) {
        out.successPaths.push(savedPath);
      }
      continue;
    }

    if (/<\s*messageid\s*>|<\s*attachmentid\s*>/i.test(item.command)) {
      out.hasPlaceholderFailure = true;
      continue;
    }
  }

  return out;
}

function applyDeterministicRules(params: {
  objective: string;
  history: ExecutedCommand[];
  llmVerdict: ObjectiveVerification;
}): ObjectiveVerification {
  const normalizedObjective = normalizeText(params.objective);
  const wantsAttachmentDownload =
    (normalizedObjective.includes("adjunto") || normalizedObjective.includes("attachment")) &&
    (normalizedObjective.includes("descarg") || normalizedObjective.includes("download"));

  if (!wantsAttachmentDownload) {
    return params.llmVerdict;
  }

  const evidence = parseAttachmentDownloadEvidence(params.history);
  if (evidence.successPaths.length > 0) {
    const latestPath = evidence.successPaths[evidence.successPaths.length - 1];
    return {
      status: "success",
      summary: `Adjunto descargado correctamente. Guardado en: ${latestPath}`,
    };
  }

  if (params.llmVerdict.status === "success") {
    return {
      status: "continue",
      summary:
        "Todavía no hay evidencia de descarga completa: falta `gmail-api attachment download ...` con `saved_path=` en la salida.",
    };
  }

  if (evidence.hasPlaceholderFailure) {
    return {
      status: "continue",
      summary:
        "La descarga falló por placeholders sin resolver (<messageId>/<attachmentId>). Reemplaza por IDs reales o usa #1 sobre la lista actual.",
    };
  }

  if (evidence.hasAttachmentListSuccess || evidence.hasDownloadAttempt) {
    return {
      status: "continue",
      summary:
        "Aún no se descargó el adjunto. Ejecuta `gmail-api attachment download <messageId> <selector> ...` y verifica `saved_path=`.",
    };
  }

  return {
    status: "continue",
    summary:
      "Falta ejecutar la descarga del adjunto (`gmail-api attachment download ...`). Listar adjuntos no completa el objetivo.",
  };
}

export class ObjectiveVerifier {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async verify(params: {
    objective: string;
    agent: AgentProfile;
    iteration: number;
    latestCommands: string[];
    latestResults: ExecutedCommand[];
    history: ExecutedCommand[];
  }): Promise<ObjectiveVerification> {
    const userPrompt = [
      `Objetivo del usuario: ${params.objective}`,
      `Iteración evaluada: ${params.iteration}`,
      `Agente: ${params.agent.name}`,
      `CWD: ${params.agent.cwd}`,
      `Comandos ejecutados en esta iteración: ${JSON.stringify(params.latestCommands)}`,
      "Resultados de esta iteración:",
      JSON.stringify(
        params.latestResults.map((item) => ({
          command: item.command,
          exitCode: item.exitCode,
          signal: item.signal,
          timedOut: item.timedOut,
          stdout: item.stdout.slice(0, 2000),
          stderr: item.stderr.slice(0, 1200),
        })),
        null,
        2,
      ),
      "Historial reciente:",
      summarizeHistory(params.history, proxyConfig.maxHistoryItems),
      "Devuelve el veredicto con el schema.",
    ].join("\n\n");

    const response = await this.client.responses.create({
      model: proxyConfig.openAiModel,
      max_output_tokens: 260,
      input: [
        {
          role: "system",
          content: buildVerifierSystemPrompt(),
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
    });

    const raw = extractTextOutput(response).trim();
    if (!raw) {
      return applyDeterministicRules({
        objective: params.objective,
        history: params.history,
        llmVerdict: {
          status: "continue",
          summary: "Verificador sin salida. Continúo con siguiente iteración.",
        },
      });
    }

    try {
      const llmVerdict = parseObjectiveVerification(raw);
      return applyDeterministicRules({
        objective: params.objective,
        history: params.history,
        llmVerdict,
      });
    } catch {
      return applyDeterministicRules({
        objective: params.objective,
        history: params.history,
        llmVerdict: {
          status: "continue",
          summary: "No pude parsear veredicto del verificador. Continúo con siguiente iteración.",
        },
      });
    }
  }
}
