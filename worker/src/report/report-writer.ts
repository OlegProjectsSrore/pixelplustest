import type { AuditFact, AuditResult, AuditSnapshot } from "../audit/contracts.ts";
import { deriveFacts } from "../audit/engine.ts";
import type { AuditLibrary } from "../audit/library.ts";
import { levelCap, orderPairs, PRIORITY_RANK, problemFacts, type PriorityLevel } from "../audit/priority.ts";
import { requestDeepseek } from "../chat/classifier.ts";
import type { ClassifierRuntime } from "../chat/types.ts";
import { REPORT_WRITER_PROMPT } from "./report-writer-prompt.ts";
import { historyText, object, textValue } from "./told.ts";

export const WRITER_MODEL = "deepseek-v4-pro";
export const WRITER_REASONING = "high";
export interface WriterProblem {
  id: string; title: string; direction: string; visitor_example: string;
  consequences?: { level: string; description?: string; period?: string };
  named_by_visitor: boolean; already_happening: boolean; must_be_solved_before: string[];
  highest_allowed_priority: PriorityLevel; earlier_work?: string;
}
export interface WriterInput { company: Record<string, string>; contact: Record<string, string>; goal: Record<string, string>; named_directions: string[]; problems: WriterProblem[] }
export interface WriterOutput { summary: string; problems: { id: string; situation: string; priority: PriorityLevel; why: string }[]; plan_intro: string }

/** A told fact as text; empty when the visitor did not say it. */
export function toldText(facts: Record<string, AuditFact>, id: string): string {
  const fact = facts[id];
  return fact && ["known", "other"].includes(fact.state) && fact.confirmation !== "disputed" ? textValue(fact.value) : "";
}
const filled = (entries: [string, string][]) => Object.fromEntries(entries.filter(([, value]) => value));

/** What the writer sees: told facts only, so it has nothing «unknown» to repeat; no library rules, steps or prices. */
export function buildWriterInput(snapshot: AuditSnapshot, result: AuditResult, lib: AuditLibrary): WriterInput {
  const { facts } = deriveFacts(snapshot.answers, lib);
  const told = (id: string) => toldText(facts, id);
  const website = facts["context.website"]?.state === "not_applicable" ? lib.report.texts.no_website : told("context.website");
  const ids = result.solutions.map(solution => solution.id), problems = problemFacts(ids, facts, lib), pairs = orderPairs(ids, lib);
  return {
    company: filled([["name", told("context.company_name")], ["website", website], ["business", told("context.business")], ["audience", told("context.audience")],
      ["size", told("context.company_size")], ["geography", told("context.geography")], ["sales_model", told("context.model")], ["channels", told("context.channels")],
      ["platforms_and_systems", told("context.assets")], ["stage", told("context.stage")]]),
    contact: filled([["name", told("context.name")], ["position", told("context.position")]]),
    goal: filled([["result", told("context.goal")], ["period", told("context.goal_period")], ["resources", told("context.resources")], ["constraints", told("context.constraints")], ["budget", told("context.budget")]]),
    named_directions: problems.filter(problem => problem.named >= 0).sort((a, b) => a.named - b.named).map(problem => problem.domainTitle).filter((title, index, all) => all.indexOf(title) === index),
    problems: problems.map(problem => {
      const impact = object(facts[`${problem.domain}.impact`]?.value ?? null), history = object(facts[`${problem.domain}.history`]?.value ?? null);
      const consequences = problem.consequence ? { level: problem.consequence, ...filled([["description", textValue(impact?.description ?? null)], ["period", textValue(impact?.period ?? null)]]) } : undefined;
      const earlier = history && toldText(facts, `${problem.domain}.history`) !== "" ? historyText(history) : "";
      return { id: problem.id, title: problem.title, direction: problem.domainTitle, visitor_example: told(`${problem.id}.details`),
        ...(consequences ? { consequences } : {}), named_by_visitor: problem.named >= 0, already_happening: problem.reported,
        must_be_solved_before: pairs.filter(([before]) => before === problem.id).map(([, after]) => after), highest_allowed_priority: levelCap(problem), ...(earlier ? { earlier_work: earlier } : {}) };
    }),
  };
}

// No markup, links, prices, promises, foreign scripts or lines about missing answers in the writer's texts.
const FORBIDDEN = /https?:|www\.|[*_#`<>[\]{}|]|[₽$€]|тариф|стоимост|(?<!\p{L})цен(?:а|ы|у|е|ой)?(?!\p{L})|(?<!\p{L})руб|гарант|обещаем|[぀-ヿ㐀-鿿가-힯豈-﫿]/iu;
export const NO_INFO = /(?<!\p{L})неизвестно(?!\p{L})|(?<!\p{L})не указан[оаы]?(?!\p{L})|нет сведений|сведений нет|не измерялось|требу\S* уточнения|недостаточно сведений|не выяснено|ответ не предоставлен|противоречивые сведения/iu;
const numbers = (text: string) => (text.match(/\d[\d\s]*(?:[.,]\d+)?/g) ?? []).map(number => number.replace(/\s/g, "").replace(",", "."));
const clean = (text: unknown) => typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";

/** Code checks on the writer's reply; null sends the report to the template texts and the code priority. */
export function checkWriter(content: string, input: WriterInput): WriterOutput | null {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "plan_intro,problems,summary" || !Array.isArray(value.problems) || value.problems.length !== input.problems.length) return null;
  const summary = clean(value.summary), planIntro = clean(value.plan_intro);
  const problems: WriterOutput["problems"] = [];
  for (const item of value.problems) {
    if (!item || typeof item !== "object" || Object.keys(item).sort().join(",") !== "id,priority,situation,why") return null;
    const entry = item as Record<string, unknown>;
    if (!input.problems.some(problem => problem.id === entry.id) || problems.some(problem => problem.id === entry.id) || !["high", "medium", "low"].includes(String(entry.priority))) return null;
    problems.push({ id: String(entry.id), situation: clean(entry.situation), priority: entry.priority as PriorityLevel, why: clean(entry.why) });
  }
  const texts = [summary, planIntro, ...problems.flatMap(problem => [problem.situation, problem.why])];
  if (summary.length < 60 || summary.length > 900 || planIntro.length < 20 || planIntro.length > 500 || problems.some(problem => problem.situation.length < 30 || problem.situation.length > 700 || problem.why.length < 10 || problem.why.length > 300)) return null;
  if (texts.some(text => FORBIDDEN.test(text) || NO_INFO.test(text))) return null;
  // Every number in the texts must come from the visitor's answers.
  const known = new Set(numbers(JSON.stringify(input)));
  if (texts.some(text => numbers(text).some(number => !known.has(number)))) return null;
  // The approved limits: high only with severe named consequences; a bottleneck not below its dependent.
  const level = new Map(problems.map(problem => [problem.id, problem.priority]));
  for (const problem of input.problems) {
    if (PRIORITY_RANK[level.get(problem.id)!] > PRIORITY_RANK[problem.highest_allowed_priority]) return null;
    for (const after of problem.must_be_solved_before) {
      if (PRIORITY_RANK[level.get(problem.id)!] < Math.min(PRIORITY_RANK[level.get(after)!], PRIORITY_RANK[problem.highest_allowed_priority])) return null;
    }
  }
  return { summary, problems, plan_intro: planIntro };
}

/** One metered DeepSeek V4 Pro call with reasoning high. Null on any provider or check failure. */
export async function writeReport(input: WriterInput, runtime: ClassifierRuntime): Promise<WriterOutput | null> {
  const exchange = await requestDeepseek([{ role: "system", content: REPORT_WRITER_PROMPT }, { role: "user", content: JSON.stringify(input) }], runtime, 0, WRITER_MODEL, WRITER_REASONING);
  const body = exchange.body as { choices?: { finish_reason?: unknown; message?: { content?: unknown } }[] } | null;
  if (exchange.outcome !== "completed" || !Array.isArray(body?.choices) || body.choices.length !== 1) return null;
  const choice = body.choices[0];
  if (choice?.finish_reason !== "stop" || typeof choice.message?.content !== "string") return null;
  return checkWriter(choice.message.content, input);
}

