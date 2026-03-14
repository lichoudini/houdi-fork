import type { IntentIr } from './intent-types.js';
import type { ObjectivePhase, ObjectiveSlots } from './objective-state.js';

function hasStrongDeterministicScheduleSignal(intent: IntentIr): boolean {
  if (intent.domain !== 'schedule' || intent.action !== 'create') {
    return false;
  }
  const dueAt = intent.entities.schedule?.dueAt;
  const taskTitle = intent.entities.schedule?.taskTitle?.trim() ?? '';
  if (!(dueAt instanceof Date) || !Number.isFinite(dueAt.getTime()) || !taskTitle) {
    return false;
  }
  if (intent.entities.hasMailCue && !intent.entities.hasTemporalCue) {
    return false;
  }
  return true;
}

export function shouldUseDeterministicHandler(intent: IntentIr, threshold: number): boolean {
  if (intent.domain === 'general' || intent.domain === 'memory') {
    return false;
  }
  if (hasStrongDeterministicScheduleSignal(intent)) {
    return true;
  }
  if (intent.confidence < threshold) {
    return false;
  }
  return ['gmail', 'workspace', 'web', 'schedule'].includes(intent.domain);
}

export function deriveObjectiveSlots(intent: IntentIr): ObjectiveSlots {
  return {
    ...(intent.domain ? { domain: intent.domain } : {}),
    ...(intent.action ? { action: intent.action } : {}),
    ...(intent.entities.gmail?.to ? { currentRecipient: intent.entities.gmail.to, gmailTo: intent.entities.gmail.to } : {}),
    ...(intent.entities.gmail?.subject ? { gmailSubject: intent.entities.gmail.subject } : {}),
    ...(intent.entities.workspace?.path ? { workspacePath: intent.entities.workspace.path } : {}),
    ...(intent.entities.workspace?.targetPath ? { workspaceTarget: intent.entities.workspace.targetPath } : {}),
    ...(intent.entities.taskRef ? { activeTaskRef: intent.entities.taskRef } : {}),
  };
}

export function extractFirstHttpUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s)"']+/i);
  return match?.[0]?.trim();
}

export function humanizeObjectivePhase(phase: ObjectivePhase | 'status'): string {
  switch (phase) {
    case 'queued':
      return 'cola';
    case 'intent':
      return 'intencion';
    case 'clarify':
      return 'aclaracion';
    case 'planning':
      return 'planificacion';
    case 'executing':
      return 'ejecucion';
    case 'verifying':
      return 'verificacion';
    case 'completed':
      return 'completado';
    case 'blocked':
      return 'bloqueado';
    case 'cancelled':
      return 'cancelado';
    case 'status':
      return 'estado';
    default:
      return String(phase);
  }
}

export function buildPlanningProgressText(iteration: number): string {
  return iteration > 1 ? 'ajustando plan' : 'preparando plan';
}

export function buildVisiblePlanHeader(iteration: number): string {
  return iteration > 1 ? 'Plan ajustado:' : 'Plan:';
}

export function buildVerificationProgressText(): string {
  return 'verificando resultado';
}

export function buildDeterministicClarification(intent: IntentIr): string | undefined {
  if (intent.domain === 'gmail' && intent.entities.gmail?.action === 'send') {
    if (!intent.entities.gmail.to) {
      return 'Necesito el destinatario del email. Ejemplo: envia email a usuario@dominio.com asunto: ... mensaje: ...';
    }
    if (!intent.entities.gmail.subject && !intent.entities.gmail.autoContentKind) {
      return 'Necesito el asunto del email. Ejemplo: asunto: Seguimiento comercial';
    }
  }

  if (intent.domain === 'workspace') {
    if (intent.entities.workspace?.action === 'write') {
      if (!intent.entities.workspace.path) {
        return 'Necesito el archivo de destino. Ejemplo: crea resumen.md con contenido ...';
      }
      if (!intent.entities.workspace.content) {
        return 'Necesito el contenido a escribir. Ejemplo: crea resumen.md con contenido hola mundo';
      }
    }
    if (intent.action === 'read' && !intent.entities.workspace?.path) {
      return 'Necesito el archivo o carpeta a abrir. Ejemplo: lee docs/reporte.txt';
    }
    if (intent.action === 'delete' && !intent.entities.workspace?.path && !intent.entities.workspace?.deleteExtensions?.length) {
      return 'Necesito la ruta o el patrón a borrar. Ejemplo: elimina docs/reporte.txt';
    }
  }

  if (intent.domain === 'web' && intent.action === 'search') {
    if (!intent.entities.hasWebCue && intent.confidence < 0.9) {
      return 'Decime qué querés buscar en web con más precisión.';
    }
  }

  if (intent.domain === 'schedule' && intent.action === 'create' && !intent.entities.schedule?.dueAt) {
    return 'Necesito fecha u hora para programarlo. Ejemplo: recordame mañana a las 9 llamar a Juan';
  }

  return undefined;
}
