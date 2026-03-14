import type { ScheduledAutomationDomain } from "../domains/schedule/automation-intent.js";
import type { ScheduleNaturalAction } from "../domains/schedule/natural.js";
import type { SelfMaintenanceIntent } from "../domains/selfskill/intents.js";
import type { GmailNaturalIntent, GmailRecipientNaturalIntent } from "../domains/gmail/intents.js";
import type { WorkspaceNaturalIntent } from "../domains/workspace/intents.js";

export type IntentDomain = "self-maintenance" | "schedule" | "gmail" | "workspace" | "web" | "memory" | "general";

export type IntentAction = "create" | "list" | "delete" | "edit" | "send" | "read" | "search" | "chat";

export type IntentEntities = {
  emails: string[];
  hasTemporalCue: boolean;
  hasTaskCue: boolean;
  hasMailCue: boolean;
  hasWorkspaceCue: boolean;
  hasWebCue: boolean;
  taskRef?: string;
  gmail?: {
    kind: "message" | "recipients";
    action?: GmailNaturalIntent["action"] | GmailRecipientNaturalIntent["action"];
    to?: string;
    subject?: string;
    body?: string;
    cc?: string;
    bcc?: string;
    query?: string;
    recipientName?: string;
    messageId?: string;
    messageIndex?: number;
    draftRequested?: boolean;
    autoContentKind?: GmailNaturalIntent["autoContentKind"];
  };
  workspace?: {
    action?: WorkspaceNaturalIntent["action"];
    path?: string;
    sourcePath?: string;
    targetPath?: string;
    selector?: WorkspaceNaturalIntent["selector"];
    deleteExtensions?: string[];
    deleteContentsOfPath?: string;
    append?: boolean;
    fileIndex?: number;
    formatHint?: string;
    hasContent?: boolean;
    content?: string;
  };
  schedule?: {
    action?: ScheduleNaturalAction;
    taskTitle?: string;
    dueAt?: Date;
    automationInstruction?: string;
    automationDomain?: ScheduledAutomationDomain;
    automationRecurrenceDaily?: boolean;
  };
  selfMaintenance?: {
    action?: SelfMaintenanceIntent["action"];
    instruction?: string;
    skillIndex?: number;
    skillRef?: string;
  };
};

export type IntentIr = {
  domain: IntentDomain;
  action: IntentAction;
  confidence: number;
  reasons: string[];
  ambiguousDomains: IntentDomain[];
  entities: IntentEntities;
};

export type IntentAbstention = {
  abstain: boolean;
  reason?: string;
  clarification?: string;
};
