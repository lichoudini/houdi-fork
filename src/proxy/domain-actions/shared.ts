import type { InterpretationBundle } from "../interpretation-bundle.js";
import type { SemanticReferenceState } from "../objective-state.js";

export function buildSemanticReferencesFromBundle(bundle: InterpretationBundle): SemanticReferenceState {
  return {
    ...(bundle.slotValues.gmail_subject ? { lastEmailSubject: bundle.slotValues.gmail_subject } : {}),
    ...(bundle.slotValues.workspace_path ? { lastWorkspacePath: bundle.slotValues.workspace_path } : {}),
    ...(bundle.slotValues.workspace_target ? { lastWorkspaceTarget: bundle.slotValues.workspace_target } : {}),
    ...(bundle.slotValues.schedule_task_ref ? { lastTaskRef: bundle.slotValues.schedule_task_ref } : {}),
    ...(bundle.slotValues.schedule_title ? { lastTaskTitle: bundle.slotValues.schedule_title } : {}),
    ...(bundle.slotValues.web_query ? { lastWebQuery: bundle.slotValues.web_query } : {}),
  };
}
