import fs from "node:fs/promises";
import { throwIfAborted } from "../abort-utils.js";
import {
  buildFriendlyWorkspaceDeleteText,
  buildFriendlyWorkspaceListText,
  buildFriendlyWorkspaceMoveText,
  buildFriendlyWorkspaceReadText,
  buildFriendlyWorkspaceWriteText,
} from "../user-facing.js";
import type { DeterministicDomainHandler, WorkspaceDeterministicDeps } from "./types.js";

export function createWorkspaceDeterministicHandler(deps: WorkspaceDeterministicDeps): DeterministicDomainHandler {
  return async (params) => {
    if (params.intent.domain !== "workspace") {
      return null;
    }

    const workspaceIntent = params.intent.entities.workspace;
    const service = deps.createWorkspaceFilesService(params.activeAgent);
    const reader = deps.createDocumentReader(params.activeAgent);

    if (workspaceIntent?.action === "list" || params.intent.action === "list") {
      throwIfAborted(params.objectiveSignal);
      const relativePath = await deps.expandWorkspacePathForDirectUse(service, workspaceIntent?.path, { allowFuzzy: true });
      const listed = await service.listWorkspaceDirectory(relativePath);
      params.objectiveState.mergeSlots(params.chatId, params.runId, {
        workspacePath: listed.relPath,
      });
      const text = buildFriendlyWorkspaceListText({
        relPath: listed.relPath,
        entries: listed.entries,
        truncated: listed.truncated,
        formatBytes: deps.formatBytes,
      });
      await params.replyAndRemember(text, "proxy-telegram:workspace-list");
      return {
        status: "success",
        summary: text,
        reason: "deterministic_workspace_list",
      };
    }

    if (workspaceIntent?.action === "mkdir") {
      throwIfAborted(params.objectiveSignal);
      const relativePath = await deps.expandWorkspacePathForDirectUse(service, workspaceIntent.path);
      const created = await service.createWorkspaceDirectory(relativePath);
      params.objectiveState.mergeSlots(params.chatId, params.runId, {
        workspacePath: created.relPath,
      });
      const text = `Listo, cree la carpeta ${created.relPath}.`;
      await params.replyAndRemember(text, "proxy-telegram:workspace-mkdir");
      return {
        status: "success",
        summary: text,
        reason: "deterministic_workspace_mkdir",
      };
    }

    if (workspaceIntent?.action === "move" || workspaceIntent?.action === "rename") {
      throwIfAborted(params.objectiveSignal);
      const sourceInput = workspaceIntent.sourcePath || workspaceIntent.path || "";
      const targetInput = workspaceIntent.targetPath || "";
      if (!sourceInput || !targetInput) {
        return null;
      }
      const sourcePath = await deps.expandWorkspacePathForDirectUse(service, sourceInput, { allowFuzzy: true });
      const targetPath = await deps.expandWorkspacePathForDirectUse(service, targetInput);
      const moved = await service.moveWorkspacePath(sourcePath, targetPath);
      params.objectiveState.mergeSlots(params.chatId, params.runId, {
        workspacePath: moved.from,
        workspaceTarget: moved.to,
      });
      const text = buildFriendlyWorkspaceMoveText(moved.from, moved.to);
      await params.replyAndRemember(text, "proxy-telegram:workspace-move");
      return {
        status: "success",
        summary: text,
        reason: "deterministic_workspace_move",
      };
    }

    if (workspaceIntent?.action === "write" || params.intent.action === "create" || params.intent.action === "edit") {
      throwIfAborted(params.objectiveSignal);
      const relativePath = await deps.expandWorkspacePathForDirectUse(service, workspaceIntent?.path);
      const content = workspaceIntent?.content ?? "";
      const writeResult = await service.writeWorkspaceTextFile({
        relativePath,
        content,
        overwrite: params.intent.action === "edit" && !workspaceIntent?.append,
        append: workspaceIntent?.append,
      });
      params.objectiveState.mergeSlots(params.chatId, params.runId, {
        workspacePath: writeResult.relPath,
      });
      const text = buildFriendlyWorkspaceWriteText({
        relPath: writeResult.relPath,
        size: writeResult.size,
        created: writeResult.created,
        appended: workspaceIntent?.append,
        formatBytes: deps.formatBytes,
      });
      await params.replyAndRemember(text, "proxy-telegram:workspace-write");
      return {
        status: "success",
        summary: text,
        reason: "deterministic_workspace_write",
      };
    }

    if (workspaceIntent?.action === "read" || params.intent.action === "read") {
      throwIfAborted(params.objectiveSignal);
      const relativePath = await deps.expandWorkspacePathForDirectUse(service, workspaceIntent?.path, { allowFuzzy: true });
      const resolved = service.resolveWorkspacePath(relativePath);
      const stat = await fs.stat(resolved.fullPath);
      if (stat.isDirectory()) {
        const listed = await service.listWorkspaceDirectory(relativePath);
        const text = buildFriendlyWorkspaceListText({
          relPath: listed.relPath,
          entries: listed.entries,
          truncated: listed.truncated,
          formatBytes: deps.formatBytes,
        });
        await params.replyAndRemember(text, "proxy-telegram:workspace-read-dir");
        return {
          status: "success",
          summary: text,
          reason: "deterministic_workspace_read_dir",
        };
      }
      const document = await reader.readDocument(relativePath);
      const relPath = `workspace/${document.path}`;
      params.objectiveState.mergeSlots(params.chatId, params.runId, {
        workspacePath: relPath,
      });
      const text = buildFriendlyWorkspaceReadText({
        relPath,
        text: document.text || "(No encontre texto extraible)",
        truncated: document.truncated,
      });
      await params.replyAndRemember(text, "proxy-telegram:workspace-read");
      return {
        status: "success",
        summary: `Leído ${relPath}`,
        reason: "deterministic_workspace_read",
      };
    }

    if (workspaceIntent?.action === "delete" || params.intent.action === "delete") {
      if (!workspaceIntent?.path) {
        return null;
      }
      throwIfAborted(params.objectiveSignal);
      const relativePath = await deps.expandWorkspacePathForDirectUse(service, workspaceIntent.path, {
        allowFuzzy: true,
        extensionFilters: workspaceIntent.deleteExtensions,
      });
      const deleted = await service.deleteWorkspacePath(relativePath);
      params.objectiveState.mergeSlots(params.chatId, params.runId, {
        workspacePath: deleted.relPath,
      });
      const text = buildFriendlyWorkspaceDeleteText(deleted.relPath, deleted.kind);
      await params.replyAndRemember(text, "proxy-telegram:workspace-delete");
      return {
        status: "success",
        summary: text,
        reason: "deterministic_workspace_delete",
      };
    }

    return null;
  };
}
