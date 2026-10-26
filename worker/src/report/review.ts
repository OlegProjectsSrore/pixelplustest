import type { AuditResult, AuditSnapshot, Json } from "../audit/contracts.ts";
import type { AuditLibrary } from "../audit/library.ts";
import { requestDeepseek } from "../chat/classifier.ts";
import type { ClassifierRuntime } from "../chat/types.ts";
import { REVIEW_PROMPT } from "./review-prompt.ts";

/** Shown on the site and sent by e-mail instead of the report when the visitor gave too little information. */
export const INSUFFICIENT_NOTICE = "К сожалению, для полноценного анализа было предоставлено недостаточно информации. Пожалуйста, обратитесь к сотрудникам компании по указанным на сайте телефонам либо заполните онлайн-заявку.";
export const REVIEW_MODEL = "deepseek-v4-pro";
export interface ReviewVerdict { verdict: "sufficient" | "insufficient"; reasons: string[] }

/** The code minimum before any model call: at least one confirmed problem with its order of work and a priced option. */
export function meetsMinimum(result: AuditResult): boolean {
  return result.solutions.some(solution => solution.action_ids.length > 0) && result.tariffs.length > 0;
}

/** What the check sees: the visitor's answers to each question, the profile and the draft report — no library rules or prompts. */
export function buildReviewInput(snapshot: AuditSnapshot, result: AuditResult, library: AuditLibrary): Json {
  const label = (id: string) => library.facts.find(fact => fact.id === id)?.label ?? id;
  const superseded = new Set(snapshot.answers.flatMap(answer => answer.replaces_answer_id ? [answer.replaces_answer_id] : []));
  const answers = snapshot.answers.filter(answer => !superseded.has(answer.id)).map(answer => {
    const question = library.questions.find(item => item.id === answer.question_id);
    return { question: question?.chat ?? answer.question_id, topic: label(answer.fact_id), key_for_report: Boolean(question?.required_for_report), state: answer.state, value: answer.value };
  });
  const actionText = (id: string) => result.actions.find(action => action.id === id)?.text ?? id;
  return {
    profile: Object.entries(result.profile).map(([id, value]) => ({ topic: label(id), value })), goal: result.goal, answers,
    draft: {
      problems: result.solutions.map(solution => ({ title: solution.title, result_of_work: solution.text, earlier_work: solution.prior_attempts?.result ?? "not_tried", steps: solution.action_ids.map(actionText) })),
      price_options: result.tariffs.map(tariff => ({ title: tariff.title, price: tariff.details.price ?? null })),
      contradictions: result.contradictions.map(item => label(item.fact_id)),
    },
  };
}

/** Code checks on the model reply; null means the check did not happen and will be retried. */
export function checkReview(content: string): ReviewVerdict | null {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "reasons,verdict" || !["sufficient", "insufficient"].includes(String(value.verdict)) || !Array.isArray(value.reasons)) return null;
  const reasons = value.reasons.map(reason => typeof reason === "string" ? reason.replace(/\s+/g, " ").trim() : "");
  if (!reasons.length || reasons.length > 5 || reasons.some(reason => !reason || reason.length > 400)) return null;
  return { verdict: value.verdict as ReviewVerdict["verdict"], reasons };
}

/** One metered DeepSeek V4 Pro call. Null on any provider or check failure. */
export async function reviewReport(input: Json, runtime: ClassifierRuntime): Promise<ReviewVerdict | null> {
  const exchange = await requestDeepseek([{ role: "system", content: REVIEW_PROMPT }, { role: "user", content: JSON.stringify(input) }], runtime, 0, REVIEW_MODEL);
  const body = exchange.body as { choices?: { finish_reason?: unknown; message?: { content?: unknown } }[] } | null;
  if (exchange.outcome !== "completed" || !Array.isArray(body?.choices) || body.choices.length !== 1) return null;
  const choice = body.choices[0];
  if (choice?.finish_reason !== "stop" || typeof choice.message?.content !== "string") return null;
  return checkReview(choice.message.content);
}
