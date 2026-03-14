import { shouldUseDeterministicHandler } from "./agentic-helpers.js";
import type {
  InterpretationCandidateRecord,
  SemanticConversationState,
  SemanticSlotKey,
} from "./objective-state.js";
import type { IntentAction, IntentDomain, IntentIr } from "./intent-types.js";

export type SuggestedExecutor = "clarify" | "deterministic" | "planner";

export type InterpretationBundle = {
  rawText: string;
  objectiveText: string;
  intent: IntentIr;
  domain: IntentDomain;
  action: IntentAction;
  confidence: number;
  candidates: InterpretationCandidateRecord[];
  slotValues: Record<string, string>;
  missingSlots: SemanticSlotKey[];
  clarificationQuestion?: string;
  suggestedExecutor: SuggestedExecutor;
  semanticStateUsed: boolean;
  mergedFromClarification: boolean;
};

function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function looksLikeReferenceFollowUp(text: string): boolean {
  const normalized = normalizeText(text);
  return /\b(eso|ese|esa|ultimo|ultima|último|última|mismo|mandalo|mandala|abrilo|abrila|borralo|borrala|editalo|editala|movelo|movela)\b/.test(
    normalized,
  );
}

function deriveSlotValues(params: {
  rawText: string;
  intent: IntentIr;
  semanticState?: SemanticConversationState | null;
}): Record<string, string> {
  const { intent, semanticState, rawText } = params;
  const slotValues: Record<string, string> = {
    ...(semanticState?.slotValues ?? {}),
  };
  if (intent.entities.gmail?.to) {
    slotValues.gmail_to = intent.entities.gmail.to;
  }
  if (intent.entities.gmail?.subject) {
    slotValues.gmail_subject = intent.entities.gmail.subject;
  }
  if (intent.entities.gmail?.body) {
    slotValues.gmail_body = intent.entities.gmail.body;
  }
  if (intent.entities.workspace?.path) {
    slotValues.workspace_path = intent.entities.workspace.path;
  }
  if (intent.entities.workspace?.targetPath) {
    slotValues.workspace_target = intent.entities.workspace.targetPath;
  }
  if (intent.entities.workspace?.content) {
    slotValues.workspace_content = intent.entities.workspace.content;
  }
  if (intent.entities.schedule?.dueAt) {
    slotValues.schedule_due_at = intent.entities.schedule.dueAt.toISOString();
  }
  if (intent.entities.schedule?.taskTitle) {
    slotValues.schedule_title = intent.entities.schedule.taskTitle;
  }
  if (intent.entities.schedule?.automationInstruction) {
    slotValues.self_instruction = intent.entities.schedule.automationInstruction;
  }
  if (intent.entities.taskRef) {
    slotValues.schedule_task_ref = intent.entities.taskRef;
  }
  if (intent.domain === "web" && intent.action === "search" && params.rawText.trim()) {
    slotValues.web_query = params.rawText.trim();
  }
  if (intent.domain === "self-maintenance" && params.rawText.trim()) {
    slotValues.self_instruction = params.rawText.trim();
  }

  if (!looksLikeReferenceFollowUp(rawText) || !semanticState) {
    return slotValues;
  }

  if (!slotValues.workspace_path && semanticState.references.lastWorkspacePath && intent.domain === "workspace") {
    slotValues.workspace_path = semanticState.references.lastWorkspacePath;
  }
  if (!slotValues.workspace_target && semanticState.references.lastWorkspaceTarget && intent.domain === "workspace") {
    slotValues.workspace_target = semanticState.references.lastWorkspaceTarget;
  }
  if (!slotValues.schedule_task_ref && semanticState.references.lastTaskRef && intent.domain === "schedule") {
    slotValues.schedule_task_ref = semanticState.references.lastTaskRef;
  }
  if (!slotValues.schedule_title && semanticState.references.lastTaskTitle && intent.domain === "schedule") {
    slotValues.schedule_title = semanticState.references.lastTaskTitle;
  }
  if (!slotValues.gmail_subject && semanticState.references.lastEmailSubject && intent.domain === "gmail") {
    slotValues.gmail_subject = semanticState.references.lastEmailSubject;
  }
  if (!slotValues.web_query && semanticState.references.lastWebQuery && intent.domain === "web") {
    slotValues.web_query = semanticState.references.lastWebQuery;
  }
  return slotValues;
}

function patchIntentWithSlots(intent: IntentIr, slotValues: Record<string, string>): IntentIr {
  return {
    ...intent,
    entities: {
      ...intent.entities,
      ...(slotValues.schedule_task_ref ? { taskRef: slotValues.schedule_task_ref } : {}),
      gmail: intent.entities.gmail
        ? {
            ...intent.entities.gmail,
            ...(slotValues.gmail_to ? { to: slotValues.gmail_to } : {}),
            ...(slotValues.gmail_subject ? { subject: slotValues.gmail_subject } : {}),
            ...(slotValues.gmail_body ? { body: slotValues.gmail_body } : {}),
          }
        : slotValues.gmail_to || slotValues.gmail_subject || slotValues.gmail_body
          ? {
              kind: "message",
              action: intent.action === "send" ? "send" : undefined,
              ...(slotValues.gmail_to ? { to: slotValues.gmail_to } : {}),
              ...(slotValues.gmail_subject ? { subject: slotValues.gmail_subject } : {}),
              ...(slotValues.gmail_body ? { body: slotValues.gmail_body } : {}),
            }
          : undefined,
      workspace: intent.entities.workspace
        ? {
            ...intent.entities.workspace,
            ...(slotValues.workspace_path ? { path: slotValues.workspace_path } : {}),
            ...(slotValues.workspace_target ? { targetPath: slotValues.workspace_target } : {}),
            ...(slotValues.workspace_content ? { content: slotValues.workspace_content, hasContent: true } : {}),
          }
        : slotValues.workspace_path || slotValues.workspace_target || slotValues.workspace_content
          ? {
              ...(slotValues.workspace_path ? { path: slotValues.workspace_path } : {}),
              ...(slotValues.workspace_target ? { targetPath: slotValues.workspace_target } : {}),
              ...(slotValues.workspace_content ? { content: slotValues.workspace_content, hasContent: true } : {}),
            }
          : undefined,
      schedule: intent.entities.schedule
        ? {
            ...intent.entities.schedule,
            ...(slotValues.schedule_due_at ? { dueAt: new Date(slotValues.schedule_due_at) } : {}),
            ...(slotValues.schedule_title ? { taskTitle: slotValues.schedule_title } : {}),
          }
        : slotValues.schedule_due_at || slotValues.schedule_title
          ? {
              ...(slotValues.schedule_due_at ? { dueAt: new Date(slotValues.schedule_due_at) } : {}),
              ...(slotValues.schedule_title ? { taskTitle: slotValues.schedule_title } : {}),
            }
          : undefined,
      selfMaintenance: intent.entities.selfMaintenance
        ? {
            ...intent.entities.selfMaintenance,
            ...(slotValues.self_instruction ? { instruction: slotValues.self_instruction } : {}),
          }
        : slotValues.self_instruction
          ? {
              instruction: slotValues.self_instruction,
            }
          : undefined,
    },
  };
}

function buildCandidates(intent: IntentIr): InterpretationCandidateRecord[] {
  const out: InterpretationCandidateRecord[] = [
    {
      domain: intent.domain,
      action: intent.action,
      confidence: intent.confidence,
      source: "primary",
    },
  ];
  let nextConfidence = intent.confidence;
  for (const domain of intent.ambiguousDomains) {
    if (domain === intent.domain) {
      continue;
    }
    nextConfidence = clamp(nextConfidence - 0.08, 0.18, 0.92);
    out.push({
      domain,
      action: intent.action,
      confidence: nextConfidence,
      source: "ambiguous",
    });
  }
  return out;
}

function computeMissingSlots(intent: IntentIr): SemanticSlotKey[] {
  if (intent.domain === "gmail" && intent.action === "send") {
    const missing: SemanticSlotKey[] = [];
    if (!intent.entities.gmail?.to) {
      missing.push("gmail_to");
    }
    if (!intent.entities.gmail?.subject && !intent.entities.gmail?.autoContentKind) {
      missing.push("gmail_subject");
    }
    return missing;
  }

  if (intent.domain === "workspace") {
    if ((intent.action === "create" || intent.action === "edit") && intent.entities.workspace?.action === "write") {
      const missing: SemanticSlotKey[] = [];
      if (!intent.entities.workspace?.path) {
        missing.push("workspace_path");
      }
      if (!intent.entities.workspace?.content) {
        missing.push("workspace_content");
      }
      return missing;
    }
    if ((intent.action === "read" || intent.action === "delete") && !intent.entities.workspace?.path) {
      return ["workspace_path"];
    }
  }

  if (intent.domain === "schedule") {
    if (intent.action === "create") {
      const missing: SemanticSlotKey[] = [];
      if (!intent.entities.schedule?.dueAt) {
        missing.push("schedule_due_at");
      }
      if (!intent.entities.schedule?.taskTitle) {
        missing.push("schedule_title");
      }
      return missing;
    }
    if ((intent.action === "edit" || intent.action === "delete") && !intent.entities.taskRef) {
      return ["schedule_task_ref"];
    }
  }

  if (intent.domain === "web" && intent.action === "search" && !intent.entities.hasWebCue) {
    return ["web_query"];
  }

  if (intent.domain === "self-maintenance" && !intent.entities.selfMaintenance?.instruction) {
    return ["self_instruction"];
  }

  return [];
}

function buildClarificationQuestion(missingSlots: SemanticSlotKey[], intent: IntentIr): string | undefined {
  const next = missingSlots[0];
  if (!next) {
    return undefined;
  }
  switch (next) {
    case "gmail_to":
      return "¿A qué direccion queres mandarlo?";
    case "gmail_subject":
      return "¿Que asunto queres que tenga ese email?";
    case "gmail_body":
      return "¿Que texto queres poner en el cuerpo del email?";
    case "workspace_path":
      return intent.action === "read"
        ? "¿Que archivo o carpeta queres abrir?"
        : intent.action === "delete"
          ? "¿Que archivo o carpeta queres borrar?"
          : "¿En que archivo queres trabajar?";
    case "workspace_target":
      return "¿A donde lo queres mover o renombrar?";
    case "workspace_content":
      return "¿Que contenido queres que escriba?";
    case "schedule_due_at":
      return "¿Para cuando queres que lo agende?";
    case "schedule_title":
      return "¿Que queres que recuerde o ejecute?";
    case "schedule_task_ref":
      return "¿Cual tarea queres tocar?";
    case "web_query":
      return "¿Que queres que busque exactamente en la web?";
    case "self_instruction":
      return "¿Que queres que haga exactamente?";
    default:
      return undefined;
  }
}

export function buildInterpretationBundle(params: {
  rawText: string;
  objectiveText: string;
  intent: IntentIr;
  deterministicThreshold: number;
  semanticState?: SemanticConversationState | null;
}): InterpretationBundle {
  const semanticState = params.semanticState;
  const slotValues = deriveSlotValues({
    rawText: params.rawText,
    intent: params.intent,
    semanticState,
  });
  const intent = patchIntentWithSlots(params.intent, slotValues);
  const missingSlots = computeMissingSlots(intent);
  const clarificationQuestion = buildClarificationQuestion(missingSlots, intent);
  const threshold = semanticState?.awaitingClarification
    ? Math.max(0.52, params.deterministicThreshold - 0.16)
    : params.deterministicThreshold;
  const suggestedExecutor: SuggestedExecutor = missingSlots.length > 0
    ? "clarify"
    : shouldUseDeterministicHandler(intent, threshold)
      ? "deterministic"
      : "planner";

  return {
    rawText: params.rawText,
    objectiveText: params.objectiveText,
    intent,
    domain: intent.domain,
    action: intent.action,
    confidence: intent.confidence,
    candidates: buildCandidates(intent),
    slotValues,
    missingSlots,
    clarificationQuestion,
    suggestedExecutor,
    semanticStateUsed: Boolean(semanticState),
    mergedFromClarification: Boolean(semanticState?.awaitingClarification),
  };
}
