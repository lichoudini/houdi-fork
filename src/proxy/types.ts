import { z } from "zod";

const PlannerCommandItemSchema = z.union([
  z.string().trim().min(1),
  z.object({
    command: z.string().trim().min(1),
    reason: z.string().trim().optional(),
  }),
]);

const RawPlannerResponseSchema = z.object({
  action: z.enum(["reply", "commands", "done"]),
  explanation: z.string().trim().optional(),
  reply: z.string().trim().optional(),
  commands: z.array(PlannerCommandItemSchema).optional(),
});

export type PlannerAction = "reply" | "commands" | "done";

export type PlannerResponse = {
  action: PlannerAction;
  explanation?: string;
  reply?: string;
  commands?: string[];
};

export type ExecutedCommand = {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  startedAt: number;
  finishedAt: number;
};

const ObjectiveVerificationSchema = z.object({
  status: z.enum(["success", "continue", "blocked"]),
  summary: z.string().trim().optional(),
});

export type ObjectiveVerification = {
  status: "success" | "continue" | "blocked";
  summary: string;
};

export function stripJsonCodeFence(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith("```")) {
    return text;
  }
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export function parsePlannerResponse(raw: string, maxCommandsPerTurn: number): PlannerResponse {
  const normalizedRaw = stripJsonCodeFence(raw);
  const parsed = RawPlannerResponseSchema.parse(JSON.parse(normalizedRaw));

  const commands = (parsed.commands ?? [])
    .map((item) => (typeof item === "string" ? item : item.command))
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !item.includes("\n"))
    .slice(0, Math.max(1, Math.floor(maxCommandsPerTurn)));

  if (parsed.action === "commands") {
    if (!parsed.explanation?.trim()) {
      throw new Error("La respuesta del modelo no incluyó 'explanation' para la secuencia de comandos.");
    }
    if (commands.length === 0) {
      throw new Error("La respuesta del modelo pidió ejecutar comandos, pero no incluyó comandos válidos.");
    }
    return {
      action: "commands",
      explanation: parsed.explanation.trim(),
      commands,
      ...(parsed.reply?.trim() ? { reply: parsed.reply.trim() } : {}),
    };
  }

  if (parsed.action === "done") {
    return {
      action: "done",
      reply: parsed.reply?.trim() || "Objetivo completado.",
    };
  }

  return {
    action: "reply",
    reply: parsed.reply?.trim() || "No necesito ejecutar comandos para responder eso.",
  };
}

export function parseObjectiveVerification(raw: string): ObjectiveVerification {
  const normalizedRaw = stripJsonCodeFence(raw);
  const parsed = ObjectiveVerificationSchema.parse(JSON.parse(normalizedRaw));
  if (parsed.status === "success") {
    return {
      status: "success",
      summary: parsed.summary?.trim() || "Objetivo completado.",
    };
  }
  if (parsed.status === "blocked") {
    return {
      status: "blocked",
      summary: parsed.summary?.trim() || "No puedo continuar por bloqueo operativo.",
    };
  }
  return {
    status: "continue",
    summary: parsed.summary?.trim() || "Aún falta para completar el objetivo.",
  };
}
