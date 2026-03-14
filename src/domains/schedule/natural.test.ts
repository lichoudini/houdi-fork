import assert from "node:assert/strict";
import test from "node:test";
import { detectScheduleNaturalIntent, parseNaturalScheduleDateTime } from "./natural.js";

test("schedule natural parser detects create reminders with due date", () => {
  const intent = detectScheduleNaturalIntent("recordame mañana a las 10 pagar expensas");
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "create");
  assert.equal(intent.taskTitle, "pagar expensas");
  assert.ok(intent.dueAt instanceof Date);
});

test("schedule natural parser detects edit with task ref and new due date", () => {
  const intent = detectScheduleNaturalIntent("reprograma la tarea 3 para mañana a las 9");
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "edit");
  assert.equal(intent.taskRef, "3");
  assert.ok(intent.dueAt instanceof Date);
});

test("schedule natural parser detects scheduled gmail automation", () => {
  const intent = detectScheduleNaturalIntent("programa mañana a las 08:30 enviar correo con novedades");
  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.action, "create");
  assert.equal(intent.automationDomain, "gmail");
  assert.ok(intent.automationInstruction);
});

test("schedule parser recognizes relative temporal signals", () => {
  const parsed = parseNaturalScheduleDateTime("en un rato recordame revisar correo");
  assert.equal(parsed.hasTemporalSignal, true);
  assert.ok(parsed.dueAt instanceof Date);
});
