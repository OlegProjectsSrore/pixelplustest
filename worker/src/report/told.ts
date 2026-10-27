import type { Json } from "../audit/contracts.ts";

// The report states only what the visitor told: no «unknown», «not stated» or «needs clarification» lines.
export const fieldLabels: Record<string, string> = { description: "описание", object: "объект", observation: "что происходит", period: "период", context: "обстоятельства",
  task: "задача", current_way: "как сейчас", constraint: "ограничение", level: "насколько важно",
  frequency: "как часто", effort: "время и люди", data_location: "где данные", human_decision: "решение человека", error_cost: "цена ошибки" };

export function object(value: Json | undefined): Record<string, Json> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null; }
export function strings(value: Json | undefined): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }

/** What the visitor said, as text; an empty string when nothing usable was said. */
export function textValue(value: Json): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join("; ");
  if (typeof value === "object") {
    if (typeof value.state === "string" && "value" in value && Object.keys(value).every(key => key === "state" || key === "value")) {
      return value.state === "known" || value.state === "other" ? textValue(value.value) : "";
    }
    if (typeof value.unit === "string" && (typeof value.value === "number" || (typeof value.min === "number" && typeof value.max === "number"))) {
      const amount = typeof value.value === "number" ? String(value.value) : `${value.min}–${value.max}`;
      return [value.approximate === true ? "около" : "", amount, value.unit, typeof value.currency === "string" ? value.currency : "", typeof value.period === "string" ? `за ${value.period}` : ""].filter(Boolean).join(" ");
    }
    return Object.entries(value).map(([key, val]) => [fieldLabels[key] ?? key, textValue(val)] as const).filter(([, text]) => text).map(([label, text]) => `${label}: ${text}`).join("; ");
  }
  return String(value);
}

const historyFields: [string, string][] = [["work", "что делали"], ["period_and_duration", "когда и как долго"], ["goal", "какого результата ждали"], ["executor_and_resources", "исполнитель и ресурсы"],
  ["outcome", "что получилось"], ["measurement", "как оценивали"], ["current_status", "сейчас"], ["stop_reason", "причина остановки"]];
/** A short account of earlier work in the visitor's words: reported fields only, no bookkeeping IDs. */
export function historyText(history: Record<string, Json>): string {
  if (history.attempts_status === "not_tried") return "ранее не предпринимались";
  const attempts = Array.isArray(history.attempts) ? history.attempts.map(object).filter(item => item !== null) : [];
  return attempts.map(attempt => historyFields.map(([key, label]) => [label, textValue(attempt[key] ?? null)] as const).filter(([, text]) => text).map(([label, text]) => `${label} — ${text}`).join("; ")).filter(Boolean).join(" / ");
}
