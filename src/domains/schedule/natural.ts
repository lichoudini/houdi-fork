import { detectScheduledAutomationIntent, type ScheduledAutomationDomain } from "./automation-intent.js";

export type ScheduleNaturalAction = "create" | "list" | "delete" | "edit";

export type ScheduleNaturalIntent = {
  shouldHandle: boolean;
  action?: ScheduleNaturalAction;
  taskRef?: string;
  taskTitle?: string;
  dueAt?: Date;
  automationInstruction?: string;
  automationDomain?: ScheduledAutomationDomain;
  automationRecurrenceDaily?: boolean;
};

const SCHEDULE_WEEKDAY_TO_INDEX: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
};

const SCHEDULE_MONTH_TO_INDEX: Record<string, number> = {
  enero: 0,
  febrero: 1,
  marzo: 2,
  abril: 3,
  mayo: 4,
  junio: 5,
  julio: 6,
  agosto: 7,
  septiembre: 8,
  setiembre: 8,
  octubre: 9,
  noviembre: 10,
  diciembre: 11,
};

const SCHEDULE_SPOKEN_HOUR_TO_NUMBER: Record<string, number> = {
  un: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
};

function normalizeIntentText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function truncateInline(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  const trimmed = input.slice(0, Math.max(0, maxChars - 3)).trimEnd();
  return `${trimmed}...`;
}

function extractQuotedSegments(text: string): string[] {
  const pattern = /"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`/g;
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const value = (match[1] || match[2] || match[3] || "").trim();
    if (value) {
      values.push(value);
    }
  }
  return values;
}

function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60 * 1000);
}

function parseScheduleRelativeDateTime(normalized: string, now: Date): Date | null {
  const inPattern =
    normalized.match(
      /\b(?:en|dentro\s+de)\s+(\d{1,3}|un|una|media)\s*(minuto|minutos|min|mins|hora|horas|h|hs|dia|dias|semana|semanas)\b/,
    ) ?? normalized.match(/\b(\d{1,3})\s*(minuto|minutos|hora|horas|dia|dias|semana|semanas)\b/);
  if (inPattern) {
    const rawAmount = (inPattern[1] ?? "").trim();
    const unit = (inPattern[2] ?? "").trim();
    let amount = 0;
    if (rawAmount === "un" || rawAmount === "una") {
      amount = 1;
    } else if (rawAmount === "media") {
      amount = 0.5;
    } else {
      const parsed = Number.parseFloat(rawAmount);
      amount = Number.isFinite(parsed) ? parsed : 0;
    }
    if (amount > 0) {
      const minuteUnits = ["minuto", "minutos", "min", "mins"];
      const hourUnits = ["hora", "horas", "h", "hs"];
      const dayUnits = ["dia", "dias"];
      const weekUnits = ["semana", "semanas"];
      let minutesToAdd = 0;
      if (minuteUnits.includes(unit)) {
        minutesToAdd = Math.round(amount);
      } else if (hourUnits.includes(unit)) {
        minutesToAdd = Math.round(amount * 60);
      } else if (dayUnits.includes(unit)) {
        minutesToAdd = Math.round(amount * 24 * 60);
      } else if (weekUnits.includes(unit)) {
        minutesToAdd = Math.round(amount * 7 * 24 * 60);
      }
      if (minutesToAdd > 0) {
        return addMinutes(now, minutesToAdd);
      }
    }
  }

  if (/\ben un rato\b/.test(normalized)) {
    return addMinutes(now, 30);
  }
  if (/\bahora\b/.test(normalized) && /\b(recorda|recuerda|tarea|recordatorio|agenda|programa)\b/.test(normalized)) {
    return addMinutes(now, 1);
  }

  return null;
}

function parseScheduleTime(normalized: string): { hour: number; minute: number } | null {
  const applyDayPeriod = (hourInput: number, periodRaw?: string): number | null => {
    if (!Number.isFinite(hourInput) || hourInput < 0 || hourInput > 23) {
      return null;
    }
    const period = (periodRaw ?? "").toLowerCase();
    if (!period) {
      return hourInput;
    }
    if (period === "tarde" || period === "noche") {
      return hourInput < 12 ? hourInput + 12 : hourInput;
    }
    if (period === "manana" || period === "madrugada") {
      if (hourInput === 12) {
        return 0;
      }
      return hourInput;
    }
    return hourInput;
  };

  if (/\bmediodia\b/.test(normalized)) {
    return { hour: 12, minute: 0 };
  }
  if (/\bmedianoche\b/.test(normalized)) {
    return { hour: 0, minute: 0 };
  }

  const spokenHalf = normalized.match(
    /\ba\s+las\s+(un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\s+y\s+media(?:\s+de\s+la\s+(manana|tarde|noche|madrugada))?\b/,
  );
  if (spokenHalf) {
    const rawHour = SCHEDULE_SPOKEN_HOUR_TO_NUMBER[spokenHalf[1] ?? ""];
    const hour = applyDayPeriod(rawHour, spokenHalf[2] ?? "");
    if (typeof hour === "number") {
      return { hour, minute: 30 };
    }
    return null;
  }

  const hhmm = normalized.match(/\b(?:a\s+las\s+)?(\d{1,2})(?::|\.)(\d{2})\s*(am|pm)?\s*(?:h|hs)?\b/);
  if (hhmm) {
    let hour = Number.parseInt(hhmm[1] ?? "", 10);
    const minute = Number.parseInt(hhmm[2] ?? "", 10);
    const ampm = (hhmm[3] ?? "").toLowerCase();
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) {
      return null;
    }
    if (ampm) {
      if (hour < 1 || hour > 12) {
        return null;
      }
      if (ampm === "pm" && hour < 12) {
        hour += 12;
      }
      if (ampm === "am" && hour === 12) {
        hour = 0;
      }
    }
    if (hour < 0 || hour > 23) {
      return null;
    }
    const dayPeriod = normalized.match(
      /\b(?:a\s+las\s+)?\d{1,2}(?::|\.)\d{2}\s*(?:am|pm)?\s*(?:de\s+la\s+(manana|tarde|noche|madrugada))\b/,
    )?.[1];
    if (!ampm && dayPeriod) {
      const adjusted = applyDayPeriod(hour, dayPeriod);
      if (typeof adjusted !== "number") {
        return null;
      }
      hour = adjusted;
    }
    return { hour, minute };
  }

  const ampmOnly = normalized.match(/\b(?:a\s+las\s+)?(\d{1,2})\s*(am|pm)\b/);
  if (ampmOnly) {
    let hour = Number.parseInt(ampmOnly[1] ?? "", 10);
    const ampm = (ampmOnly[2] ?? "").toLowerCase();
    if (!Number.isFinite(hour) || hour < 1 || hour > 12) {
      return null;
    }
    if (ampm === "pm" && hour < 12) {
      hour += 12;
    }
    if (ampm === "am" && hour === 12) {
      hour = 0;
    }
    return { hour, minute: 0 };
  }

  const simple = normalized.match(/\ba\s+las\s+(\d{1,2})(?:\s+de\s+la\s+(manana|tarde|noche|madrugada))?\b/);
  if (simple) {
    const hourRaw = Number.parseInt(simple[1] ?? "", 10);
    if (!Number.isFinite(hourRaw) || hourRaw < 0 || hourRaw > 23) {
      return null;
    }
    const hour = applyDayPeriod(hourRaw, simple[2] ?? "");
    if (typeof hour !== "number") {
      return null;
    }
    return { hour, minute: 0 };
  }

  const compactHour = normalized.match(/(?<![:.])\b(?:a\s+las\s+)?(\d{1,2})\s*(h|hs)\b/);
  if (compactHour) {
    const hour = Number.parseInt(compactHour[1] ?? "", 10);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
      return null;
    }
    return { hour, minute: 0 };
  }

  return null;
}

function parseScheduleExplicitDate(
  normalized: string,
  now: Date,
): { year: number; month: number; day: number; fromKeywordToday: boolean } | null {
  const yearNow = now.getFullYear();
  const monthNow = now.getMonth();
  const dayNow = now.getDate();

  if (/\bpasado manana\b/.test(normalized)) {
    const date = new Date(yearNow, monthNow, dayNow + 2, 0, 0, 0, 0);
    return {
      year: date.getFullYear(),
      month: date.getMonth(),
      day: date.getDate(),
      fromKeywordToday: false,
    };
  }
  if (/\bmanana\b/.test(normalized)) {
    const date = new Date(yearNow, monthNow, dayNow + 1, 0, 0, 0, 0);
    return {
      year: date.getFullYear(),
      month: date.getMonth(),
      day: date.getDate(),
      fromKeywordToday: false,
    };
  }
  if (/\bhoy\b/.test(normalized)) {
    return {
      year: yearNow,
      month: monthNow,
      day: dayNow,
      fromKeywordToday: true,
    };
  }

  const isoDate = normalized.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (isoDate) {
    const year = Number.parseInt(isoDate[1] ?? "", 10);
    const month = Number.parseInt(isoDate[2] ?? "", 10) - 1;
    const day = Number.parseInt(isoDate[3] ?? "", 10);
    const candidate = new Date(year, month, day, 0, 0, 0, 0);
    if (candidate.getFullYear() === year && candidate.getMonth() === month && candidate.getDate() === day) {
      return { year, month, day, fromKeywordToday: false };
    }
  }

  const slashDate = normalized.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slashDate) {
    const day = Number.parseInt(slashDate[1] ?? "", 10);
    const month = Number.parseInt(slashDate[2] ?? "", 10) - 1;
    let year = yearNow;
    if (slashDate[3]) {
      const rawYear = Number.parseInt(slashDate[3] ?? "", 10);
      year = rawYear < 100 ? 2000 + rawYear : rawYear;
    }
    const candidate = new Date(year, month, day, 0, 0, 0, 0);
    if (candidate.getFullYear() === year && candidate.getMonth() === month && candidate.getDate() === day) {
      return { year, month, day, fromKeywordToday: false };
    }
  }

  const longDate = normalized.match(
    /\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de\s+(\d{2,4}))?\b/,
  );
  if (longDate) {
    const day = Number.parseInt(longDate[1] ?? "", 10);
    const month = SCHEDULE_MONTH_TO_INDEX[longDate[2] ?? ""];
    let year = yearNow;
    if (longDate[3]) {
      const rawYear = Number.parseInt(longDate[3] ?? "", 10);
      year = rawYear < 100 ? 2000 + rawYear : rawYear;
    }
    if (typeof month === "number") {
      const candidate = new Date(year, month, day, 0, 0, 0, 0);
      if (candidate.getFullYear() === year && candidate.getMonth() === month && candidate.getDate() === day) {
        return { year, month, day, fromKeywordToday: false };
      }
    }
  }

  const weekday = normalized.match(/\b(?:(proximo)\s+)?(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/);
  if (weekday) {
    const targetDow = SCHEDULE_WEEKDAY_TO_INDEX[weekday[2] ?? ""];
    if (typeof targetDow === "number") {
      const currentDow = now.getDay();
      let delta = (targetDow - currentDow + 7) % 7;
      if (delta === 0 && weekday[1]) {
        delta = 7;
      }
      const candidate = new Date(yearNow, monthNow, dayNow + delta, 0, 0, 0, 0);
      return {
        year: candidate.getFullYear(),
        month: candidate.getMonth(),
        day: candidate.getDate(),
        fromKeywordToday: delta === 0,
      };
    }
  }

  return null;
}

export function parseNaturalScheduleDateTime(text: string, nowInput?: Date): { dueAt?: Date; hasTemporalSignal: boolean } {
  const now = nowInput ? new Date(nowInput.getTime()) : new Date();
  const normalized = normalizeIntentText(text);

  const relative = parseScheduleRelativeDateTime(normalized, now);
  if (relative) {
    return { dueAt: relative, hasTemporalSignal: true };
  }

  const datePart = parseScheduleExplicitDate(normalized, now);
  const timePart = parseScheduleTime(normalized);
  const hasTemporalSignal = Boolean(datePart || timePart);
  if (!hasTemporalSignal) {
    return { hasTemporalSignal: false };
  }

  const base = datePart
    ? new Date(datePart.year, datePart.month, datePart.day, 0, 0, 0, 0)
    : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

  if (timePart) {
    base.setHours(timePart.hour, timePart.minute, 0, 0);
  } else if (datePart?.fromKeywordToday) {
    const soon = addMinutes(now, 10);
    base.setHours(soon.getHours(), soon.getMinutes(), 0, 0);
  } else {
    base.setHours(9, 0, 0, 0);
  }

  if (!datePart && timePart && base.getTime() <= now.getTime()) {
    base.setDate(base.getDate() + 1);
  }

  return { dueAt: base, hasTemporalSignal: true };
}

export function stripScheduleTemporalPhrases(text: string): string {
  return text
    .replace(
      /\b(?:en|dentro\s+de)\s+(\d{1,3}|un|una|media)\s*(?:minuto|minutos|min|mins|hora|horas|h|hs|d[ií]a|d[ií]as|semana|semanas)\b/gi,
      " ",
    )
    .replace(/\bpasado\s+ma(?:ñ|n)ana\b/gi, " ")
    .replace(/\bma(?:ñ|n)ana\b/gi, " ")
    .replace(/\bhoy\b/gi, " ")
    .replace(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g, " ")
    .replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, " ")
    .replace(
      /\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de\s+(\d{2,4}))?\b/gi,
      " ",
    )
    .replace(/\b(?:(proximo)\s+)?(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/gi, " ")
    .replace(/\bmediod[ií]a\b/gi, " ")
    .replace(/\bmedianoche\b/gi, " ")
    .replace(/\b(?:a\s+las\s+)?(\d{1,2})(?::|\.)(\d{2})\s*(?:am|pm)?\s*(?:h|hs)?\b/gi, " ")
    .replace(
      /\ba\s+las\s+(?:un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\s+y\s+media(?:\s+de\s+la\s+(?:manana|mañana|tarde|noche|madrugada))?\b/gi,
      " ",
    )
    .replace(/\ba\s+las\s+(\d{1,2})\s+de\s+la\s+(?:manana|mañana|tarde|noche|madrugada)\b/gi, " ")
    .replace(/(?<![:.])\b(?:a\s+las\s+)?(\d{1,2})\s*(?:h|hs)\b/gi, " ")
    .replace(/\b(?:a\s+las\s+)?(\d{1,2})\s*(?:am|pm)\b/gi, " ")
    .replace(/\ba\s+las\s+(\d{1,2})\b/gi, " ")
    .replace(/\ben un rato\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeScheduleTitle(raw: string): string {
  const cleaned = raw
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^(de|para|que|sobre|acerca de)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncateInline(cleaned, 400);
}

function extractTaskTitleForCreate(text: string): string {
  const quoted = extractQuotedSegments(text);
  if (quoted.length > 0) {
    return sanitizeScheduleTitle(quoted.join(" "));
  }

  const cleaned = stripScheduleTemporalPhrases(normalizeIntentText(text))
    .replace(
      /\b(record(?:a|á)(?:me|rme|r)?|recuerd(?:a|á)(?:me|r)?|agend(?:a|á)(?:me|r)?|program(?:a|á)(?:r)?|cre(?:a|á)(?:r)?|gener(?:a|á)(?:r)?|tareas?|recordatorios?|por\s+favor|porfa)\b/gi,
      " ",
    )
    .replace(/\b(hac(?:e|é)(?:r)?me)\s+acordar\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitizeScheduleTitle(cleaned);
}

function extractTaskTitleForEdit(text: string): string {
  const quoted = extractQuotedSegments(text);
  if (quoted.length > 0) {
    return sanitizeScheduleTitle(quoted.join(" "));
  }

  const explicit =
    text.match(/\b(?:texto|descripcion|descripción|detalle|mensaje)\s*[:=-]\s*(.+)$/i)?.[1]?.trim() ??
    text.match(/\b(?:que diga|que sea)\s+(.+)$/i)?.[1]?.trim() ??
    "";
  if (explicit) {
    return sanitizeScheduleTitle(explicit);
  }

  const cleaned = stripScheduleTemporalPhrases(normalizeIntentText(text))
    .replace(
      /\b(edit(?:a|á|ar)|cambi(?:a|á|ar)|modific(?:a|á|ar)|reprogram(?:a|á|ar)|muev(?:e|é|er)|actualiz(?:a|á|ar)|pospon(?:e|é|er)|tarea|recordatorio|numero|nro|#)\b/gi,
      " ",
    )
    .replace(/\btsk[-_][a-z0-9._-]*\.{0,}\b/gi, " ")
    .replace(/\b\d{1,3}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitizeScheduleTitle(cleaned);
}

export function extractScheduleTaskRef(text: string): string | null {
  const normalized = normalizeIntentText(text);
  if (/\b(ultima|ultimo|last)\b/.test(normalized)) {
    return "last";
  }

  const taskPrefixWithDots =
    text.match(/(?:^|[\s"'`(])((?:tsk[-_][a-z0-9_-]*\.{2,}))/i)?.[1] ??
    text.match(/(?:^|[\s"'`(])[a-z0-9]+_((?:tsk[-_][a-z0-9_-]*\.{2,}))/i)?.[1];
  if (taskPrefixWithDots) {
    return taskPrefixWithDots;
  }

  const taskId =
    text.match(/\btsk[-_][a-z0-9-]+\b/i)?.[0] ??
    text.match(/\b[a-z0-9]+_(tsk[-_][a-z0-9-]+)\b/i)?.[1];
  if (taskId) {
    return taskId;
  }

  const numeric =
    normalized.match(/\b(?:tarea|recordatorio)\s*(?:numero|nro|#)?\s*(\d{1,3})\b/)?.[1] ??
    normalized.match(/\b(?:numero|nro|#)\s*(\d{1,3})\b/)?.[1];
  if (numeric) {
    return numeric;
  }
  return null;
}

export function detectScheduleNaturalIntent(text: string): ScheduleNaturalIntent {
  const original = text.trim();
  if (!original) {
    return { shouldHandle: false };
  }

  const normalized = normalizeIntentText(original);
  const hasTaskRefCue = /\btsk(?:[-_][a-z0-9._-]*)?\b/i.test(original);
  const scheduleNouns =
    /\b(recordatorio|recordatorios|recordarorio|recordarorios|tarea|tareas|tareaa|tareaas|agenda)\b/.test(normalized) ||
    hasTaskRefCue;
  const parsedSchedule = parseNaturalScheduleDateTime(original, new Date());
  const automation = detectScheduledAutomationIntent({
    text: original,
    normalizeIntentText,
    stripScheduleTemporalPhrases,
    sanitizeTitle: sanitizeScheduleTitle,
  });
  const hasReminderVerb =
    /\b(recordar|recorda|recordame|recordarme|recuerda|recuerdame|agenda|agendame|agendar|programa|programar|fijar|fijame|fija)\b/.test(
      normalized,
    ) ||
    /\b(haceme|hacerme|hace(?:r)?me)\s+acordar\b/.test(normalized) ||
    (/\b(enviame|enviarme|mandame|mandarme|me\s+mandas|me\s+envias|me\s+envías)\b/.test(normalized) &&
      /\b(correo|mail|email|gmail)\b/.test(normalized));
  const hasExplicitScheduleCue =
    scheduleNouns ||
    hasReminderVerb ||
    /\b(pon(?:e|eme)?|deja(?:me)?|anota(?:me)?)\b.*\b(recordatorio|tarea|agenda)\b/.test(normalized);

  const listRequested =
    /\b(lista|listar|mostra|mostrar|ver|cuales|cuantas|pendientes)\b/.test(normalized) && scheduleNouns;
  if (
    listRequested ||
    (/\b(?:mis\s+)?(?:tareas|recordatorios|recordarorios|tareaa)\b/.test(normalized) &&
      /\b(que|cuales|ver|mostrar)\b/.test(normalized))
  ) {
    return { shouldHandle: true, action: "list" };
  }

  const deleteRequested =
    /\b(elimina|eliminar|borra|borrar|quita|quitar|cancela|cancelar|remove|delete)\b/.test(normalized) && scheduleNouns;
  if (deleteRequested) {
    return {
      shouldHandle: true,
      action: "delete",
      taskRef: extractScheduleTaskRef(original) ?? undefined,
    };
  }

  const editRequested =
    /\b(edita|editar|cambia|cambiar|modifica|modificar|reprograma|reprogramar|mueve|mover|actualiza|actualizar|pospone|posponer)\b/.test(
      normalized,
    ) && scheduleNouns;
  if (editRequested) {
    const taskRef = extractScheduleTaskRef(original) ?? undefined;
    const taskTitle = extractTaskTitleForEdit(original);
    return {
      shouldHandle: true,
      action: "edit",
      taskRef,
      ...(taskTitle ? { taskTitle } : {}),
      ...(parsedSchedule.dueAt ? { dueAt: parsedSchedule.dueAt } : {}),
    };
  }

  const createRequested = hasReminderVerb && (scheduleNouns || parsedSchedule.hasTemporalSignal);
  const scheduledAutomationRequested =
    parsedSchedule.hasTemporalSignal && hasExplicitScheduleCue && Boolean(automation.instruction);
  if (scheduledAutomationRequested) {
    const taskTitle = sanitizeScheduleTitle(`Automatizacion: ${automation.instruction ?? "accion"}`);
    return {
      shouldHandle: true,
      action: "create",
      ...(taskTitle ? { taskTitle } : {}),
      ...(automation.instruction ? { automationInstruction: automation.instruction } : {}),
      ...(automation.domain ? { automationDomain: automation.domain } : {}),
      ...(automation.recurrenceDaily ? { automationRecurrenceDaily: true } : {}),
      ...(parsedSchedule.dueAt ? { dueAt: parsedSchedule.dueAt } : {}),
    };
  }

  if (createRequested || (scheduleNouns && parsedSchedule.hasTemporalSignal)) {
    const taskTitle = extractTaskTitleForCreate(original);
    return {
      shouldHandle: true,
      action: "create",
      ...(taskTitle ? { taskTitle } : {}),
      ...(parsedSchedule.dueAt ? { dueAt: parsedSchedule.dueAt } : {}),
    };
  }

  return { shouldHandle: false };
}
