import type { AgentProfile } from "../../agents.js";
import type { DocumentReader } from "../../document-reader.js";
import type { GmailAccountService } from "../../gmail-account.js";
import type { ScheduledAutomationDomain } from "../../domains/schedule/automation-intent.js";
import type { WorkspaceFilesService } from "../../domains/workspace/workspace-files-service.js";
import type { ScheduledTaskSqliteService } from "../../scheduled-tasks-sqlite.js";
import type { WebBrowser, WebSearchResult } from "../../web-browser.js";
import type { ActionOutcome } from "../action-registry.js";
import type { IntentIr } from "../intent-ir.js";
import type { InterpretationBundle } from "../interpretation-bundle.js";
import type { ObjectivePhase, ProxyObjectiveStateStore, SemanticReferenceState } from "../objective-state.js";

export type ReplyFn = (text: string) => Promise<unknown>;

export type GmailMessagePatch = {
  threadId?: string;
  subject?: string;
  attachments?: Array<{
    index: number;
    filename: string;
    attachmentId?: string;
  }>;
};

export type ObjectiveStateLike = {
  updatePhase: (params: {
    chatId: number;
    runId: string;
    phase: ObjectivePhase;
    message: string;
    details?: Record<string, unknown>;
  }) => void;
  mergeSlots: (chatId: number, runId: string, slots: Record<string, string>) => void;
};

export type DeterministicIntentParams = {
  chatId: number;
  userId?: number;
  activeAgent: AgentProfile;
  objectiveRaw: string;
  intent: IntentIr;
  runId: string;
  reply: ReplyFn;
  objectiveSignal?: AbortSignal;
};

export type DeterministicDomainParams = DeterministicIntentParams & {
  objectiveState: ObjectiveStateLike;
  replyAndRemember: (text: string, source: string) => Promise<void>;
};

export type DeterministicIntentHandler = (params: DeterministicIntentParams) => Promise<ActionOutcome | null>;
export type DeterministicDomainHandler = (params: DeterministicDomainParams) => Promise<ActionOutcome | null>;

export type NaturalScheduleHandler = (params: {
  chatId: number;
  userId?: number;
  text: string;
  reply: ReplyFn;
}) => Promise<ActionOutcome | null>;

export type ProxyActionRegistryContext = {
  bundle: InterpretationBundle;
  chatId: number;
  userId?: number;
  activeAgent: AgentProfile;
  objectiveRaw: string;
  runId: string;
  reply: ReplyFn;
  objectiveSignal?: AbortSignal;
};

export type DeterministicHandlerBaseDeps = {
  objectiveState: ObjectiveStateLike;
  replyLong: (reply: ReplyFn, text: string) => Promise<void>;
  replyProgress: (params: {
    chatId: number;
    reply: ReplyFn;
    phase: ObjectivePhase | "status";
    text: string;
  }) => Promise<void>;
  rememberAssistant: (params: { chatId: number; userId?: number; text: string; source: string }) => Promise<void>;
};

export type GmailDeterministicDeps = {
  gmailAccount: GmailAccountService;
  getGmailContext: (chatId: number) => {
    listedMessageIds: string[];
    lastMessageId?: string;
  } & Record<string, unknown>;
  updateGmailMessageContext: (context: any, messageId: string, patch: GmailMessagePatch) => void;
  resolveGmailMessageIdForIntent: (params: { chatId: number; intent: IntentIr }) => Promise<string | undefined>;
  buildScheduledGmailSendPayload: (params: {
    rawText: string;
    instruction: string;
    taskTitle: string;
  }) => { payload?: { to: string; subject: string; body: string; cc?: string; bcc?: string }; errorText?: string };
  listMaxResults: number;
};

export type WorkspaceDeterministicDeps = {
  createWorkspaceFilesService: (agent: AgentProfile) => WorkspaceFilesService;
  createDocumentReader: (agent: AgentProfile) => DocumentReader;
  expandWorkspacePathForDirectUse: (
    service: WorkspaceFilesService,
    rawPath: string | undefined,
    options?: { allowFuzzy?: boolean; extensionFilters?: string[] },
  ) => Promise<string>;
  formatBytes: (bytes: number) => string;
};

export type WebDeterministicDeps = {
  getLatestWebResults: (chatId: number) => WebSearchResult[];
  setLatestWebResults: (chatId: number, hits: WebSearchResult[]) => void;
  webBrowser: WebBrowser;
  webSearchMaxResults: number;
  buildWebResultsListText: (query: string, hits: WebSearchResult[]) => string;
};

export type DeterministicIntentHandlerDeps = DeterministicHandlerBaseDeps &
  GmailDeterministicDeps &
  WorkspaceDeterministicDeps &
  WebDeterministicDeps;

export type NaturalScheduleHandlerDeps = {
  intentBiasStore: {
    getDomainBias: (chatId: number) => Record<string, number>;
  };
  intentRoutingThreshold: number;
  logInfo: (message: string) => void;
  rememberUser: (params: { chatId: number; userId?: number; text: string; source: string }) => Promise<void>;
  rememberAssistant: (params: { chatId: number; userId?: number; text: string; source: string }) => Promise<void>;
  scheduledTasks: ScheduledTaskSqliteService;
  formatScheduleTaskLines: (tasks: Awaited<ReturnType<ScheduledTaskSqliteService["listPending"]>>) => string[];
  buildScheduledNaturalIntentPayload: (params: {
    rawText: string;
    instruction: string;
    taskTitle: string;
    automationDomain?: ScheduledAutomationDomain;
    recurrenceDaily?: boolean;
  }) => { payload?: unknown; responseHints: string[]; errorText?: string };
  formatScheduleDateTime: (date: Date) => string;
};

export type ProxyActionRegistryDeps = {
  objectiveState: ProxyObjectiveStateStore;
  handleDeterministicIntent: DeterministicIntentHandler;
  maybeHandleNaturalScheduleInstruction: NaturalScheduleHandler;
  updateSemanticReferences: (params: {
    store: ProxyObjectiveStateStore;
    chatId: number;
    references: SemanticReferenceState;
  }) => void;
};
