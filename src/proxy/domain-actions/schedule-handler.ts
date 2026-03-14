import { detectScheduleNaturalIntent } from "../../domains/schedule/natural.js";
import { buildIntentIr, stripQuotedExecutionNoise } from "../intent-ir.js";
import type { NaturalScheduleHandler, NaturalScheduleHandlerDeps } from "./types.js";

export function createNaturalScheduleHandler(deps: NaturalScheduleHandlerDeps): NaturalScheduleHandler {
  return async (params) => {
    const routingBias = deps.intentBiasStore.getDomainBias(params.chatId);
    const routingIntent = buildIntentIr(stripQuotedExecutionNoise(params.text), {
      domainBias: routingBias,
    });
    const intent = detectScheduleNaturalIntent(params.text);
    if (!intent.shouldHandle || !intent.action) {
      return null;
    }
    if (
      routingIntent.domain === "gmail" &&
      routingIntent.confidence >= deps.intentRoutingThreshold &&
      !routingIntent.entities.hasTemporalCue
    ) {
      deps.logInfo(
        `Telegram schedule-bypass chat=${params.chatId} user=${params.userId ?? 0} routed=${routingIntent.domain} confidence=${routingIntent.confidence.toFixed(3)}`,
      );
      return null;
    }
    if (
      intent.action === "create" &&
      routingIntent.ambiguousDomains.includes("schedule") &&
      routingIntent.ambiguousDomains.includes("gmail") &&
      !routingIntent.entities.hasTemporalCue
    ) {
      const clarification =
        "Veo ambigüedad entre recordatorio y Gmail. ¿Querés crear una tarea programada o enviar un email ahora?";
      await params.reply(clarification);
      await deps.rememberAssistant({
        chatId: params.chatId,
        userId: params.userId,
        text: clarification,
        source: "proxy-telegram:schedule-clarify",
      });
      return {
        status: "incomplete",
        summary: clarification,
        reason: "schedule_vs_gmail_clarify",
      };
    }
    deps.logInfo(
      `Telegram schedule-intent chat=${params.chatId} user=${params.userId ?? 0} action=${intent.action} due=${intent.dueAt?.toISOString() ?? "-"} hasAutomation=${String(Boolean(intent.automationInstruction))} domain=${intent.automationDomain ?? "-"} route=${routingIntent.domain}:${routingIntent.confidence.toFixed(3)}`,
    );

    try {
      await deps.rememberUser({
        chatId: params.chatId,
        userId: params.userId,
        text: params.text,
        source: "proxy-telegram:schedule-user",
      });

      if (intent.action === "list") {
        const pending = deps.scheduledTasks.listPending(params.chatId);
        const responseText =
          pending.length === 0
            ? "No hay tareas programadas pendientes."
            : [`Tareas pendientes (${pending.length}):`, ...deps.formatScheduleTaskLines(pending)].join("\n\n");
        await params.reply(responseText);
        await deps.rememberAssistant({
          chatId: params.chatId,
          userId: params.userId,
          text: responseText,
          source: "proxy-telegram:schedule-list",
        });
        return {
          status: "success",
          summary: responseText,
          reason: "schedule_list",
        };
      }

      if (intent.action === "create") {
        if (!intent.dueAt || !Number.isFinite(intent.dueAt.getTime())) {
          const text =
            "No pude inferir fecha/hora. Ejemplos: 'recordame mañana a las 10 pagar expensas' o 'en 2 horas llamo a Juan'.";
          await params.reply(text);
          await deps.rememberAssistant({
            chatId: params.chatId,
            userId: params.userId,
            text,
            source: "proxy-telegram:schedule-error",
          });
          return {
            status: "incomplete",
            summary: text,
            reason: "schedule_missing_due_at",
          };
        }
        if (intent.dueAt.getTime() <= Date.now() + 10_000) {
          const text =
            "La fecha/hora quedó en pasado o demasiado cerca. Indícame una hora futura (ej: en 10 minutos).";
          await params.reply(text);
          await deps.rememberAssistant({
            chatId: params.chatId,
            userId: params.userId,
            text,
            source: "proxy-telegram:schedule-error",
          });
          return {
            status: "incomplete",
            summary: text,
            reason: "schedule_due_at_in_past",
          };
        }
        const title = intent.taskTitle?.trim() ?? "";
        if (!title) {
          const text = "No pude inferir la tarea. Ejemplo: 'recordame mañana a las 10 pagar expensas'.";
          await params.reply(text);
          await deps.rememberAssistant({
            chatId: params.chatId,
            userId: params.userId,
            text,
            source: "proxy-telegram:schedule-error",
          });
          return {
            status: "incomplete",
            summary: text,
            reason: "schedule_missing_title",
          };
        }

        const hasAutomationInstruction = Boolean(intent.automationInstruction?.trim());
        const automationPayload = hasAutomationInstruction
          ? deps.buildScheduledNaturalIntentPayload({
              rawText: params.text,
              instruction: intent.automationInstruction?.trim() ?? "",
              taskTitle: title,
              automationDomain: intent.automationDomain,
              recurrenceDaily: intent.automationRecurrenceDaily,
            })
          : null;
        if (hasAutomationInstruction && !automationPayload?.payload) {
          const text =
            automationPayload?.errorText ??
            "No pude estructurar la automatización. Reescribe con destinatario y mensaje explícitos.";
          await params.reply(text);
          await deps.rememberAssistant({
            chatId: params.chatId,
            userId: params.userId,
            text,
            source: "proxy-telegram:schedule-error",
          });
          return {
            status: "incomplete",
            summary: text,
            reason: "schedule_automation_invalid",
          };
        }

        const created = await deps.scheduledTasks.createTask({
          chatId: params.chatId,
          ...(typeof params.userId === "number" ? { userId: params.userId } : {}),
          title,
          dueAt: intent.dueAt,
          ...(hasAutomationInstruction ? { deliveryKind: "natural-intent" as const } : {}),
          ...(hasAutomationInstruction
            ? {
                deliveryPayload: JSON.stringify(automationPayload?.payload),
              }
            : {}),
        });
        const pending = deps.scheduledTasks.listPending(params.chatId);
        const index = Math.max(1, pending.findIndex((item) => item.id === created.id) + 1);
        const responseText = [
          hasAutomationInstruction ? "Listo, deje la automatizacion programada." : "Listo, deje la tarea agendada.",
          `Tarea ${index}: ${created.title}`,
          `Para: ${deps.formatScheduleDateTime(new Date(created.dueAt))}`,
          ...(hasAutomationInstruction ? [`Se va a ejecutar: ${intent.automationInstruction?.trim()}`] : []),
          ...(automationPayload?.responseHints ?? []),
          ...(intent.automationRecurrenceDaily ? ["Se repite todos los dias."] : []),
        ].join("\n");
        await params.reply(responseText);
        await deps.rememberAssistant({
          chatId: params.chatId,
          userId: params.userId,
          text: responseText,
          source: "proxy-telegram:schedule-create",
        });
        return {
          status: "success",
          summary: responseText,
          reason: "schedule_create",
        };
      }

      if (intent.action === "delete") {
        const ref = intent.taskRef?.trim() ?? "";
        if (!ref) {
          const text = "Indica qué tarea eliminar. Ejemplos: 'elimina tarea 2' o 'borra la última tarea'.";
          await params.reply(text);
          await deps.rememberAssistant({
            chatId: params.chatId,
            userId: params.userId,
            text,
            source: "proxy-telegram:schedule-error",
          });
          return {
            status: "incomplete",
            summary: text,
            reason: "schedule_delete_missing_ref",
          };
        }
        const target = deps.scheduledTasks.resolveTaskByRef(params.chatId, ref);
        if (!target) {
          const text = "No encontré esa tarea pendiente. Usa 'lista mis tareas' para ver índices.";
          await params.reply(text);
          await deps.rememberAssistant({
            chatId: params.chatId,
            userId: params.userId,
            text,
            source: "proxy-telegram:schedule-error",
          });
          return {
            status: "incomplete",
            summary: text,
            reason: "schedule_delete_not_found",
          };
        }
        const canceled = await deps.scheduledTasks.cancelTask(target.id);
        const responseText = ["Listo, elimine esta tarea:", canceled.title].join("\n");
        await params.reply(responseText);
        await deps.rememberAssistant({
          chatId: params.chatId,
          userId: params.userId,
          text: responseText,
          source: "proxy-telegram:schedule-delete",
        });
        return {
          status: "success",
          summary: responseText,
          reason: "schedule_delete",
        };
      }

      if (intent.action === "edit") {
        const ref = intent.taskRef?.trim() ?? "";
        if (!ref) {
          const text = "Indica qué tarea editar. Ejemplo: 'edita tarea 2 para mañana 18:30'.";
          await params.reply(text);
          await deps.rememberAssistant({
            chatId: params.chatId,
            userId: params.userId,
            text,
            source: "proxy-telegram:schedule-error",
          });
          return {
            status: "incomplete",
            summary: text,
            reason: "schedule_edit_missing_ref",
          };
        }
        const target = deps.scheduledTasks.resolveTaskByRef(params.chatId, ref);
        if (!target) {
          const text = "No encontré esa tarea pendiente. Usa 'lista mis tareas' para ver índices.";
          await params.reply(text);
          await deps.rememberAssistant({
            chatId: params.chatId,
            userId: params.userId,
            text,
            source: "proxy-telegram:schedule-error",
          });
          return {
            status: "incomplete",
            summary: text,
            reason: "schedule_edit_not_found",
          };
        }

        const changes: { title?: string; dueAt?: Date } = {};
        if (intent.taskTitle?.trim()) {
          changes.title = intent.taskTitle.trim();
        }
        if (intent.dueAt && Number.isFinite(intent.dueAt.getTime())) {
          if (intent.dueAt.getTime() <= Date.now() + 10_000) {
            const text = "La nueva fecha/hora debe ser futura.";
            await params.reply(text);
            await deps.rememberAssistant({
              chatId: params.chatId,
              userId: params.userId,
              text,
              source: "proxy-telegram:schedule-error",
            });
            return {
              status: "incomplete",
              summary: text,
              reason: "schedule_edit_due_at_in_past",
            };
          }
          changes.dueAt = intent.dueAt;
        }

        if (!changes.title && !changes.dueAt) {
          const text =
            "No detecté cambios. Ejemplos: 'edita tarea 2 para mañana 18' o 'edita tarea 2 texto: llamar a Juan'.";
          await params.reply(text);
          await deps.rememberAssistant({
            chatId: params.chatId,
            userId: params.userId,
            text,
            source: "proxy-telegram:schedule-error",
          });
          return {
            status: "incomplete",
            summary: text,
            reason: "schedule_edit_no_changes",
          };
        }

        const updated = await deps.scheduledTasks.updateTask(target.id, changes);
        const responseText = [
          "Listo, actualice la tarea.",
          `Para: ${deps.formatScheduleDateTime(new Date(updated.dueAt))}`,
          `Detalle: ${updated.title}`,
        ].join("\n");
        await params.reply(responseText);
        await deps.rememberAssistant({
          chatId: params.chatId,
          userId: params.userId,
          text: responseText,
          source: "proxy-telegram:schedule-edit",
        });
        return {
          status: "success",
          summary: responseText,
          reason: "schedule_edit",
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const responseText = `No pude gestionar la tarea programada: ${message}`;
      await params.reply(responseText);
      await deps.rememberAssistant({
        chatId: params.chatId,
        userId: params.userId,
        text: responseText,
        source: "proxy-telegram:schedule-error",
      });
      return {
        status: "blocked",
        summary: responseText,
        reason: "schedule_exception",
      };
    }

    return null;
  };
}
