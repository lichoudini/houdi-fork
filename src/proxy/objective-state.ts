import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentCapability } from '../agent-policy.js';
import type { IntentAction, IntentDomain } from './intent-types.js';

export type ObjectivePhase =
  | 'queued'
  | 'intent'
  | 'clarify'
  | 'planning'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'blocked'
  | 'cancelled';

export type ObjectiveStatus = 'active' | 'success' | 'blocked' | 'incomplete' | 'cancelled' | 'error';

export type ObjectiveSlots = {
  currentRecipient?: string;
  currentAttachment?: string;
  pendingDraftId?: string;
  lastWebQuery?: string;
  activeTaskId?: string;
  activeTaskRef?: string;
  workspacePath?: string;
  workspaceTarget?: string;
  gmailSubject?: string;
  gmailTo?: string;
  domain?: string;
  action?: string;
};

export type ObjectiveStateRecord = {
  chatId: number;
  runId: string;
  userId?: number;
  objectiveRaw: string;
  activeAgent: string;
  domain: string;
  action: string;
  source: string;
  phase: ObjectivePhase;
  status: ObjectiveStatus;
  slots: ObjectiveSlots;
  cancelRequested: boolean;
  cancelReason?: string;
  summary?: string;
  reason?: string;
  startedAtMs: number;
  updatedAtMs: number;
  finishedAtMs?: number;
};

export type SemanticSlotKey =
  | 'gmail_to'
  | 'gmail_subject'
  | 'gmail_body'
  | 'workspace_path'
  | 'workspace_target'
  | 'workspace_content'
  | 'schedule_due_at'
  | 'schedule_title'
  | 'schedule_task_ref'
  | 'web_query'
  | 'self_instruction';

export type InterpretationCandidateRecord = {
  domain: IntentDomain;
  action: IntentAction;
  confidence: number;
  source?: string;
};

export type SemanticReferenceState = {
  lastEmailId?: string;
  lastEmailSubject?: string;
  lastWorkspacePath?: string;
  lastWorkspaceTarget?: string;
  lastTaskRef?: string;
  lastTaskTitle?: string;
  lastWebQuery?: string;
  lastAttachmentPath?: string;
};

export type SemanticConversationState = {
  chatId: number;
  activeDomain?: IntentDomain;
  activeAction?: IntentAction;
  baseObjective?: string;
  awaitingClarification: boolean;
  clarificationQuestion?: string;
  pendingSlots: SemanticSlotKey[];
  candidateInterpretations: InterpretationCandidateRecord[];
  slotValues: Record<string, string>;
  references: SemanticReferenceState;
  pendingApproval?: PendingApprovalState;
  lastExecutor?: 'clarify' | 'deterministic' | 'planner';
  updatedAtMs: number;
};

export type PendingApprovalState = {
  capability: AgentCapability;
  summary: string;
  originalObjective: string;
  activeAgent: string;
  executor: 'deterministic' | 'planner';
  plannerAttachmentHint?: string;
  createdAtMs: number;
  expiresAtMs: number;
};

export type ObjectiveEventRecord = {
  id: number;
  chatId: number;
  runId: string;
  phase: ObjectivePhase;
  status: ObjectiveStatus;
  message: string;
  detailsJson?: string;
  createdAtMs: number;
};

function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function parseSlots(raw: unknown): ObjectiveSlots {
  if (typeof raw !== 'string' || !raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as ObjectiveSlots;
  } catch {
    return {};
  }
}

function serializeSlots(slots: ObjectiveSlots): string {
  return JSON.stringify(slots);
}

function parseStringRecord(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || !raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        continue;
      }
      const cleanKey = key.trim();
      const cleanValue = value.trim();
      if (!cleanKey || !cleanValue) {
        continue;
      }
      out[cleanKey] = cleanValue;
    }
    return out;
  } catch {
    return {};
  }
}

function serializeStringRecord(values: Record<string, string>): string {
  return JSON.stringify(values);
}

function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseCandidates(raw: unknown): InterpretationCandidateRecord[] {
  if (typeof raw !== 'string' || !raw.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const candidates: Array<InterpretationCandidateRecord | null> = parsed.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return null;
        }
        const value = item as Record<string, unknown>;
        const domain = typeof value.domain === 'string' ? value.domain.trim() : '';
        const action = typeof value.action === 'string' ? value.action.trim() : '';
        const confidence = typeof value.confidence === 'number' ? value.confidence : Number(value.confidence ?? 0);
        if (!domain || !action || !Number.isFinite(confidence)) {
          return null;
        }
        return {
          domain: domain as IntentDomain,
          action: action as IntentAction,
          confidence,
          source: typeof value.source === 'string' ? value.source.trim() || undefined : undefined,
        };
      });
    return candidates.filter((item): item is InterpretationCandidateRecord => item !== null);
  } catch {
    return [];
  }
}

function serializeCandidates(values: InterpretationCandidateRecord[]): string {
  return JSON.stringify(values);
}

function parseReferences(raw: unknown): SemanticReferenceState {
  return parseStringRecord(raw) as SemanticReferenceState;
}

function serializeReferences(values: SemanticReferenceState): string {
  return JSON.stringify(values);
}

function parsePendingApproval(raw: unknown): PendingApprovalState | undefined {
  if (typeof raw !== 'string' || !raw.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const capability = typeof parsed.capability === 'string' ? parsed.capability.trim() : '';
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    const originalObjective = typeof parsed.originalObjective === 'string' ? parsed.originalObjective.trim() : '';
    const activeAgent = typeof parsed.activeAgent === 'string' ? parsed.activeAgent.trim() : '';
    const executor = typeof parsed.executor === 'string' ? parsed.executor.trim() : '';
    const createdAtMs = toNumber(parsed.createdAtMs);
    const expiresAtMs = toNumber(parsed.expiresAtMs);
    if (!capability || !summary || !originalObjective || !activeAgent || !executor || !Number.isFinite(createdAtMs) || !Number.isFinite(expiresAtMs)) {
      return undefined;
    }
    return {
      capability: capability as AgentCapability,
      summary,
      originalObjective,
      activeAgent,
      executor: executor as 'deterministic' | 'planner',
      plannerAttachmentHint:
        typeof parsed.plannerAttachmentHint === 'string' && parsed.plannerAttachmentHint.trim()
          ? parsed.plannerAttachmentHint.trim()
          : undefined,
      createdAtMs,
      expiresAtMs,
    };
  } catch {
    return undefined;
  }
}

function serializePendingApproval(value: PendingApprovalState | undefined): string | null {
  if (!value) {
    return null;
  }
  return JSON.stringify(value);
}

function nowMs(): number {
  return Date.now();
}

export class ProxyObjectiveStateStore {
  private db: DatabaseSync | null = null;

  constructor(private readonly dbPathInput: string) {}

  get dbPath(): string {
    return path.resolve(this.dbPathInput);
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_objective_state (
        chat_id INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL,
        user_id INTEGER,
        objective_raw TEXT NOT NULL,
        active_agent TEXT NOT NULL,
        domain TEXT NOT NULL,
        action TEXT NOT NULL,
        source TEXT NOT NULL,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        slots_json TEXT NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        cancel_reason TEXT,
        summary TEXT,
        reason TEXT,
        started_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        finished_at_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_chat_objective_state_status ON chat_objective_state(status, updated_at_ms DESC);

      CREATE TABLE IF NOT EXISTS objective_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        run_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_objective_events_chat ON objective_events(chat_id, created_at_ms DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_objective_events_run ON objective_events(run_id, created_at_ms DESC, id DESC);

      CREATE TABLE IF NOT EXISTS chat_semantic_state (
        chat_id INTEGER PRIMARY KEY,
        active_domain TEXT,
        active_action TEXT,
        base_objective TEXT,
        awaiting_clarification INTEGER NOT NULL DEFAULT 0,
        clarification_question TEXT,
        pending_slots_json TEXT NOT NULL,
        candidate_interpretations_json TEXT NOT NULL,
        slot_values_json TEXT NOT NULL,
        references_json TEXT NOT NULL,
        pending_approval_json TEXT,
        last_executor TEXT,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_semantic_state_updated ON chat_semantic_state(updated_at_ms DESC);
    `);
    const semanticColumns = this.db
      .prepare(`PRAGMA table_info(chat_semantic_state)`)
      .all() as Array<Record<string, unknown>>;
    const columnNames = new Set(
      semanticColumns
        .map((row) => (typeof row.name === 'string' ? row.name.trim() : ''))
        .filter(Boolean),
    );
    if (!columnNames.has('pending_approval_json')) {
      this.db.exec(`ALTER TABLE chat_semantic_state ADD COLUMN pending_approval_json TEXT;`);
    }
  }

  private ensureDb(): DatabaseSync {
    if (!this.db) {
      throw new Error('ProxyObjectiveStateStore no inicializado. Llama init() primero.');
    }
    return this.db;
  }

  startRun(params: {
    chatId: number;
    runId: string;
    userId?: number;
    objectiveRaw: string;
    activeAgent: string;
    domain: string;
    action: string;
    source: string;
    phase?: ObjectivePhase;
    slots?: ObjectiveSlots;
  }): ObjectiveStateRecord {
    const db = this.ensureDb();
    const startedAtMs = nowMs();
    const phase = params.phase ?? 'queued';
    const slots = params.slots ?? {};
    db.prepare(
      `
      INSERT INTO chat_objective_state (
        chat_id, run_id, user_id, objective_raw, active_agent, domain, action, source,
        phase, status, slots_json, cancel_requested, cancel_reason, summary, reason,
        started_at_ms, updated_at_ms, finished_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 0, NULL, NULL, NULL, ?, ?, NULL)
      ON CONFLICT(chat_id) DO UPDATE SET
        run_id = excluded.run_id,
        user_id = excluded.user_id,
        objective_raw = excluded.objective_raw,
        active_agent = excluded.active_agent,
        domain = excluded.domain,
        action = excluded.action,
        source = excluded.source,
        phase = excluded.phase,
        status = 'active',
        slots_json = excluded.slots_json,
        cancel_requested = 0,
        cancel_reason = NULL,
        summary = NULL,
        reason = NULL,
        started_at_ms = excluded.started_at_ms,
        updated_at_ms = excluded.updated_at_ms,
        finished_at_ms = NULL
    `,
    ).run(
      params.chatId,
      params.runId,
      params.userId ?? null,
      params.objectiveRaw,
      params.activeAgent,
      params.domain,
      params.action,
      params.source,
      phase,
      serializeSlots(slots),
      startedAtMs,
      startedAtMs,
    );
    this.appendEvent({
      chatId: params.chatId,
      runId: params.runId,
      phase,
      status: 'active',
      message: 'objective_started',
      details: {
        domain: params.domain,
        action: params.action,
        activeAgent: params.activeAgent,
        source: params.source,
      },
    });
    return this.getState(params.chatId)!;
  }

  getState(chatId: number): ObjectiveStateRecord | null {
    const db = this.ensureDb();
    const row = db
      .prepare(
        `
        SELECT chat_id, run_id, user_id, objective_raw, active_agent, domain, action, source,
               phase, status, slots_json, cancel_requested, cancel_reason, summary, reason,
               started_at_ms, updated_at_ms, finished_at_ms
        FROM chat_objective_state
        WHERE chat_id = ?
      `,
      )
      .get(chatId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      chatId: toNumber(row.chat_id),
      runId: String(row.run_id ?? ''),
      userId: typeof row.user_id === 'number' ? row.user_id : undefined,
      objectiveRaw: String(row.objective_raw ?? ''),
      activeAgent: String(row.active_agent ?? ''),
      domain: String(row.domain ?? ''),
      action: String(row.action ?? ''),
      source: String(row.source ?? ''),
      phase: String(row.phase ?? 'queued') as ObjectivePhase,
      status: String(row.status ?? 'active') as ObjectiveStatus,
      slots: parseSlots(row.slots_json),
      cancelRequested: Boolean(row.cancel_requested),
      cancelReason: typeof row.cancel_reason === 'string' ? row.cancel_reason : undefined,
      summary: typeof row.summary === 'string' ? row.summary : undefined,
      reason: typeof row.reason === 'string' ? row.reason : undefined,
      startedAtMs: toNumber(row.started_at_ms),
      updatedAtMs: toNumber(row.updated_at_ms),
      finishedAtMs: typeof row.finished_at_ms === 'number' ? row.finished_at_ms : undefined,
    };
  }

  mergeSlots(chatId: number, runId: string, patch: ObjectiveSlots): ObjectiveStateRecord | null {
    const current = this.getState(chatId);
    if (!current || current.runId !== runId) {
      return current;
    }
    const nextSlots: ObjectiveSlots = {
      ...current.slots,
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => typeof value !== 'undefined')),
    };
    const db = this.ensureDb();
    db.prepare(
      `UPDATE chat_objective_state SET slots_json = ?, updated_at_ms = ? WHERE chat_id = ? AND run_id = ?`,
    ).run(serializeSlots(nextSlots), nowMs(), chatId, runId);
    return this.getState(chatId);
  }

  updatePhase(params: {
    chatId: number;
    runId: string;
    phase: ObjectivePhase;
    message?: string;
    details?: Record<string, unknown>;
  }): ObjectiveStateRecord | null {
    const db = this.ensureDb();
    db.prepare(
      `UPDATE chat_objective_state SET phase = ?, updated_at_ms = ? WHERE chat_id = ? AND run_id = ?`,
    ).run(params.phase, nowMs(), params.chatId, params.runId);
    this.appendEvent({
      chatId: params.chatId,
      runId: params.runId,
      phase: params.phase,
      status: 'active',
      message: params.message ?? `phase:${params.phase}`,
      details: params.details,
    });
    return this.getState(params.chatId);
  }

  requestCancel(params: { chatId: number; reason: string }): ObjectiveStateRecord | null {
    const db = this.ensureDb();
    db.prepare(
      `UPDATE chat_objective_state SET cancel_requested = 1, cancel_reason = ?, updated_at_ms = ? WHERE chat_id = ? AND status = 'active'`,
    ).run(params.reason, nowMs(), params.chatId);
    const state = this.getState(params.chatId);
    if (state && state.status === 'active') {
      this.appendEvent({
        chatId: params.chatId,
        runId: state.runId,
        phase: state.phase,
        status: 'active',
        message: 'cancel_requested',
        details: { reason: params.reason },
      });
    }
    return state;
  }

  clearCancel(chatId: number): ObjectiveStateRecord | null {
    const db = this.ensureDb();
    db.prepare(
      `UPDATE chat_objective_state SET cancel_requested = 0, cancel_reason = NULL, updated_at_ms = ? WHERE chat_id = ?`,
    ).run(nowMs(), chatId);
    return this.getState(chatId);
  }

  finishRun(params: {
    chatId: number;
    runId: string;
    status: ObjectiveStatus;
    phase?: ObjectivePhase;
    summary?: string;
    reason?: string;
    details?: Record<string, unknown>;
  }): ObjectiveStateRecord | null {
    const db = this.ensureDb();
    const finishedAtMs = nowMs();
    const current = this.getState(params.chatId);
    if (!current || current.runId !== params.runId) {
      return current;
    }
    const phase =
      params.phase ??
      (params.status === 'success'
        ? 'completed'
        : params.status === 'cancelled'
          ? 'cancelled'
          : 'blocked');
    db.prepare(
      `
      UPDATE chat_objective_state
      SET status = ?,
          phase = ?,
          summary = ?,
          reason = ?,
          updated_at_ms = ?,
          finished_at_ms = ?
      WHERE chat_id = ? AND run_id = ?
    `,
    ).run(params.status, phase, params.summary ?? null, params.reason ?? null, finishedAtMs, finishedAtMs, params.chatId, params.runId);
    this.appendEvent({
      chatId: params.chatId,
      runId: params.runId,
      phase,
      status: params.status,
      message: params.summary?.trim() || `objective_${params.status}`,
      details: params.details,
    });
    return this.getState(params.chatId);
  }

  appendEvent(params: {
    chatId: number;
    runId: string;
    phase: ObjectivePhase;
    status: ObjectiveStatus;
    message: string;
    details?: Record<string, unknown>;
    createdAtMs?: number;
  }): number {
    const db = this.ensureDb();
    const result = db
      .prepare(
        `
        INSERT INTO objective_events (chat_id, run_id, phase, status, message, details_json, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        params.chatId,
        params.runId,
        params.phase,
        params.status,
        params.message,
        params.details ? JSON.stringify(params.details) : null,
        params.createdAtMs ?? nowMs(),
      ) as { lastInsertRowid?: number | bigint };
    return Number(result.lastInsertRowid ?? 0);
  }

  listRecentEvents(chatId: number, limit = 12): ObjectiveEventRecord[] {
    const db = this.ensureDb();
    const capped = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = db
      .prepare(
        `
        SELECT id, chat_id, run_id, phase, status, message, details_json, created_at_ms
        FROM objective_events
        WHERE chat_id = ?
        ORDER BY created_at_ms DESC, id DESC
        LIMIT ?
      `,
      )
      .all(chatId, capped) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: toNumber(row.id),
      chatId: toNumber(row.chat_id),
      runId: String(row.run_id ?? ''),
      phase: String(row.phase ?? 'queued') as ObjectivePhase,
      status: String(row.status ?? 'active') as ObjectiveStatus,
      message: String(row.message ?? ''),
      detailsJson: typeof row.details_json === 'string' ? row.details_json : undefined,
      createdAtMs: toNumber(row.created_at_ms),
    }));
  }

  listStaleActiveStates(maxAgeMs: number): ObjectiveStateRecord[] {
    const db = this.ensureDb();
    const cutoff = nowMs() - Math.max(1_000, Math.floor(maxAgeMs));
    const rows = db
      .prepare(
        `
        SELECT chat_id
        FROM chat_objective_state
        WHERE status = 'active' AND updated_at_ms <= ?
        ORDER BY updated_at_ms ASC
      `,
      )
      .all(cutoff) as Array<Record<string, unknown>>;
    return rows
      .map((row) => this.getState(toNumber(row.chat_id)))
      .filter((item): item is ObjectiveStateRecord => Boolean(item));
  }

  pruneEvents(beforeEpochMs: number): number {
    const db = this.ensureDb();
    const result = db.prepare(`DELETE FROM objective_events WHERE created_at_ms < ?`).run(beforeEpochMs) as { changes?: number };
    return Number(result.changes ?? 0);
  }

  getSemanticState(chatId: number): SemanticConversationState | null {
    const db = this.ensureDb();
    const row = db
      .prepare(
        `
        SELECT chat_id, active_domain, active_action, base_objective, awaiting_clarification,
               clarification_question, pending_slots_json, candidate_interpretations_json,
               slot_values_json, references_json, pending_approval_json, last_executor, updated_at_ms
        FROM chat_semantic_state
        WHERE chat_id = ?
      `,
      )
      .get(chatId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      chatId: toNumber(row.chat_id),
      activeDomain: typeof row.active_domain === 'string' && row.active_domain.trim() ? (row.active_domain as IntentDomain) : undefined,
      activeAction: typeof row.active_action === 'string' && row.active_action.trim() ? (row.active_action as IntentAction) : undefined,
      baseObjective: typeof row.base_objective === 'string' ? row.base_objective : undefined,
      awaitingClarification: Boolean(row.awaiting_clarification),
      clarificationQuestion: typeof row.clarification_question === 'string' ? row.clarification_question : undefined,
      pendingSlots: parseStringArray(row.pending_slots_json) as SemanticSlotKey[],
      candidateInterpretations: parseCandidates(row.candidate_interpretations_json),
      slotValues: parseStringRecord(row.slot_values_json),
      references: parseReferences(row.references_json),
      pendingApproval: parsePendingApproval(row.pending_approval_json),
      lastExecutor:
        typeof row.last_executor === 'string' && row.last_executor.trim()
          ? (row.last_executor as 'clarify' | 'deterministic' | 'planner')
          : undefined,
      updatedAtMs: toNumber(row.updated_at_ms),
    };
  }

  upsertSemanticState(params: {
    chatId: number;
    activeDomain?: IntentDomain;
    activeAction?: IntentAction;
    baseObjective?: string;
    awaitingClarification?: boolean;
    clarificationQuestion?: string;
    pendingSlots?: SemanticSlotKey[];
    candidateInterpretations?: InterpretationCandidateRecord[];
    slotValues?: Record<string, string>;
    references?: SemanticReferenceState;
    pendingApproval?: PendingApprovalState | null;
    lastExecutor?: 'clarify' | 'deterministic' | 'planner';
  }): SemanticConversationState {
    const current = this.getSemanticState(params.chatId);
    const next: SemanticConversationState = {
      chatId: params.chatId,
      activeDomain: params.activeDomain ?? current?.activeDomain,
      activeAction: params.activeAction ?? current?.activeAction,
      baseObjective: typeof params.baseObjective === 'string' ? params.baseObjective : current?.baseObjective,
      awaitingClarification:
        typeof params.awaitingClarification === 'boolean' ? params.awaitingClarification : (current?.awaitingClarification ?? false),
      clarificationQuestion:
        typeof params.clarificationQuestion === 'string'
          ? params.clarificationQuestion
          : params.clarificationQuestion === undefined
            ? current?.clarificationQuestion
            : undefined,
      pendingSlots: params.pendingSlots ?? current?.pendingSlots ?? [],
      candidateInterpretations: params.candidateInterpretations ?? current?.candidateInterpretations ?? [],
      slotValues: {
        ...(current?.slotValues ?? {}),
        ...Object.fromEntries(Object.entries(params.slotValues ?? {}).filter(([, value]) => typeof value === 'string' && value.trim())),
      },
      references: {
        ...(current?.references ?? {}),
        ...Object.fromEntries(Object.entries(params.references ?? {}).filter(([, value]) => typeof value === 'string' && value.trim())),
      },
      pendingApproval:
        params.pendingApproval === undefined
          ? current?.pendingApproval
          : params.pendingApproval ?? undefined,
      lastExecutor: params.lastExecutor ?? current?.lastExecutor,
      updatedAtMs: nowMs(),
    };
    const db = this.ensureDb();
    db.prepare(
      `
      INSERT INTO chat_semantic_state (
        chat_id, active_domain, active_action, base_objective, awaiting_clarification,
        clarification_question, pending_slots_json, candidate_interpretations_json,
        slot_values_json, references_json, pending_approval_json, last_executor, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        active_domain = excluded.active_domain,
        active_action = excluded.active_action,
        base_objective = excluded.base_objective,
        awaiting_clarification = excluded.awaiting_clarification,
        clarification_question = excluded.clarification_question,
        pending_slots_json = excluded.pending_slots_json,
        candidate_interpretations_json = excluded.candidate_interpretations_json,
        slot_values_json = excluded.slot_values_json,
        references_json = excluded.references_json,
        pending_approval_json = excluded.pending_approval_json,
        last_executor = excluded.last_executor,
        updated_at_ms = excluded.updated_at_ms
    `,
    ).run(
      next.chatId,
      next.activeDomain ?? null,
      next.activeAction ?? null,
      next.baseObjective ?? null,
      next.awaitingClarification ? 1 : 0,
      next.clarificationQuestion ?? null,
      JSON.stringify(next.pendingSlots),
      serializeCandidates(next.candidateInterpretations),
      serializeStringRecord(next.slotValues),
      serializeReferences(next.references),
      serializePendingApproval(next.pendingApproval),
      next.lastExecutor ?? null,
      next.updatedAtMs,
    );
    return this.getSemanticState(params.chatId)!;
  }

  clearSemanticClarification(chatId: number): SemanticConversationState | null {
    const current = this.getSemanticState(chatId);
    if (!current) {
      return null;
    }
    return this.upsertSemanticState({
      chatId,
      awaitingClarification: false,
      clarificationQuestion: '',
      pendingSlots: [],
      baseObjective: current.baseObjective,
    });
  }

  clearPendingApproval(chatId: number): SemanticConversationState | null {
    const current = this.getSemanticState(chatId);
    if (!current) {
      return null;
    }
    return this.upsertSemanticState({
      chatId,
      pendingApproval: null,
    });
  }

  clearSemanticState(chatId: number): void {
    const db = this.ensureDb();
    db.prepare(`DELETE FROM chat_semantic_state WHERE chat_id = ?`).run(chatId);
  }
}
