import type { AuditFact, AuditResult, AuditSnapshot } from "../audit/contracts.ts";
import { deriveFacts } from "../audit/engine.ts";
import type { AuditLibrary } from "../audit/library.ts";
import { executionOrder, importanceOrder, levelCap, orderPairs, PRIORITY_RANK, problemFacts, codePriorities, type PriorityLevel } from "../audit/priority.ts";
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
  /** The complaint whose other possible cause this problem is. */
  found_while_checking?: string;
  /** What the code prints under «Что рекомендуется сделать» and «Решение Pixel Plus»: for context, not for retelling. */
  steps: string[]; result_of_work: string; services: string[];
}
export interface WriterInput {
  company: Record<string, string>; contact: Record<string, string>; goal: Record<string, string>;
  named_directions: string[]; funnel?: string; problem_count: number; problems: WriterProblem[];
  /** Map rows that need a short conclusion: directions with problems of this report, or where the visitor said work is not affected. */
  map_directions: { id: string; title: string; problem_ids: string[]; visitor_said?: string }[];
  /** Directions the visitor discussed and said they are not a problem. */
  not_problems: { id: string; title: string; visitor_said: string }[];
  plan_stages: { stage: number; problem_ids: string[] }[];
  solutions: { id: string; options: string[] }[];
}
export interface WriterProblemText {
  id: string; priority: PriorityLevel; why: string; impact: string; action: string;
  found: string; why_problem: string; cause: string; consequence: string; expected: string; measure: string;
}
export interface WriterOutput {
  intro: string; problems: WriterProblemText[];
  map: { id: string; conclusion: string }[]; map_conclusion: string;
  not_problems: { id: string; conclusion: string }[];
  top_tasks: { title: string; text: string }[];
  stages: { stage: number; title: string }[]; principle: string;
  effect: { rows: { metric: string; now: string; target: string; horizon: string; means: string }[]; measure: string[] };
  solutions: { id: string; task: string; why: string }[];
  final: { constraint: string; first: string; why: string; next: string };
}

// Answers saved as codes (audience in 0.1.4, sales model, stage) are shown in words.
const CODE_LABELS: Record<string, Record<string, string>> = {
  "context.audience": { b2b: "компании", b2c: "частные лица", mixed: "компании и частные лица" },
  "context.model": { online_order: "онлайн-покупка", manager_request: "заявка и общение с сотрудником", appointment: "запись на встречу или услугу", offline: "офлайн",
    marketplace: "через маркетплейсы", digital_product: "цифровой продукт", mixed: "сочетание способов" },
  "context.stage": { launch: "запуск", operating: "работает", expanding: "расширяется", changing: "меняет модель" },
};
/** A told fact as text; empty when the visitor did not say it. */
export function toldText(facts: Record<string, AuditFact>, id: string): string {
  const fact = facts[id];
  const text = fact && ["known", "other"].includes(fact.state) && fact.confirmation !== "disputed" ? textValue(fact.value) : "";
  return CODE_LABELS[id]?.[text] ?? text;
}
const filled = (entries: [string, string][]) => Object.fromEntries(entries.filter(([, value]) => value));
const explicit = (fact: AuditFact | undefined) => fact?.state === "known" && fact.confirmation === "explicit";

/** The report's directions, problems and plan, shared by the writer's input and the renderer so both see the same rows. */
export function reportOutline(snapshot: AuditSnapshot, result: AuditResult, lib: AuditLibrary, levels?: ReadonlyMap<string, PriorityLevel>) {
  const { facts } = deriveFacts(snapshot.answers, lib);
  const ids = result.solutions.map(solution => solution.id), problems = problemFacts(ids, facts, lib), pairs = orderPairs(ids, lib);
  const code = codePriorities(problems, pairs, lib);
  const level = new Map<string, PriorityLevel>(ids.map(id => [id, levels?.get(id) ?? code.get(id)!.level]));
  // Of two problems with the same level, the one the other depends on comes first (the other cause found for a complaint is solved before it).
  const order = executionOrder(importanceOrder(problems, level), pairs.filter(([before, after]) => level.get(before) === level.get(after))), execution = executionOrder(order, pairs);
  const blockDomain = (id: string) => lib.solutions.find(block => block.id === id)?.domain;
  const impactLevel = (domain: string) => { const fact = facts[`${domain}.impact`]; const value = explicit(fact) ? object(fact!.value) : null; return value ? String(value.level ?? "") : ""; };
  const applicable = (domain: string) => { const fact = facts[`${domain}.applicable`]; return explicit(fact) ? fact!.value : undefined; };
  // Covered: every direction the conversation went through — answered its scope question, has a problem here, or one of its blocks was checked as another cause.
  const crossDomains = new Set((snapshot.state.cross_checked ?? []).map(blockDomain).filter(Boolean));
  const checked = lib.domains.filter(domain => applicable(domain.id) !== undefined || problems.some(problem => problem.domain === domain.id) || crossDomains.has(domain.id));
  const withProblems = (domain: string) => order.filter(id => problems.find(problem => problem.id === id)!.domain === domain);
  const notAffected = (domain: string) => applicable(domain) !== false && !withProblems(domain).length && impactLevel(domain) === "no_effect";
  const map = checked.filter(domain => withProblems(domain.id).length || notAffected(domain.id)).map(domain => ({ id: domain.id, title: domain.title, problem_ids: withProblems(domain.id),
    ...(notAffected(domain.id) ? { visitor_said: "на работу не влияет" } : {}) }));
  const notProblems = checked.filter(domain => applicable(domain.id) === false || notAffected(domain.id)).map(domain => ({ id: domain.id, title: domain.title,
    visitor_said: applicable(domain.id) === false ? "направление не относится к задаче" : "на работу не влияет" }));
  // Plan stages: dependency depth first, then the code level group (critical and high, medium, low), so the writer and the renderer see the same stages;
  // inside a stage, the execution order.
  const depth = new Map<string, number>();
  const depthOf = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const before = pairs.filter(([, after]) => after === id).map(([first]) => first);
    const value = before.length ? 1 + Math.max(...before.map(item => depthOf(item, seen))) : 0;
    depth.set(id, value); return value;
  };
  const group = (id: string) => ({ critical: 0, high: 0, medium: 1, low: 2 })[code.get(id)!.level];
  const keys = [...new Set(execution.map(id => `${depthOf(id)}:${group(id)}`))].sort((a, b) => { const [da, ga] = a.split(":").map(Number); const [db, gb] = b.split(":").map(Number); return da - db || ga - gb; });
  const stages = keys.map((key, index) => ({ stage: index + 1, problem_ids: execution.filter(id => `${depthOf(id)}:${group(id)}` === key) }));
  return { facts, ids, problems, pairs, code, level, order, execution, checked, map, notProblems, stages };
}

/** What the writer sees: told facts only, so it has nothing «unknown» to repeat; steps, results and services for context; no prices. */
export function buildWriterInput(snapshot: AuditSnapshot, result: AuditResult, lib: AuditLibrary): WriterInput {
  const outline = reportOutline(snapshot, result, lib), { facts, problems, pairs } = outline;
  const told = (id: string) => toldText(facts, id);
  const website = facts["context.website"]?.state === "not_applicable" ? lib.report.texts.no_website : told("context.website");
  const funnelFact = facts["context.funnel"], funnelValue = explicit(funnelFact) ? String(funnelFact!.value) : "";
  const funnel = funnelValue && funnelValue !== "unclear" ? lib.facts.find(fact => fact.id === "context.funnel")?.values?.find(value => typeof value === "object" && value.id === funnelValue) : undefined;
  const actionText = (id: string) => result.actions.find(action => action.id === id)?.text ?? "";
  const serviceName = (id: string) => lib.services.find(service => service.id === id)?.name ?? id;
  const tariffsOf = (id: string) => result.tariffs.filter(tariff => result.solutions.find(solution => solution.id === id)!.service_ids.includes(String(tariff.details.service_id)));
  return {
    company: filled([["name", told("context.company_name")], ["website", website], ["business", told("context.business")], ["products_and_services", told("context.products")],
      ["audience", told("context.audience")], ["employees", told("context.company_size")], ["geography", told("context.geography")], ["sales_model", told("context.model")],
      ["channels", told("context.channels")], ["revenue_last_year", told("context.revenue_year")], ["revenue_last_3_years", told("context.revenue_3y")],
      ["average_check", told("context.average_check")], ["deal_cycle", told("context.deal_cycle")], ["platforms_and_systems", told("context.assets")], ["stage", told("context.stage")],
      ["main_problem_in_visitor_words", told("context.main_problem")]]),
    contact: filled([["name", told("context.name")], ["position", told("context.position")]]),
    goal: filled([["result", told("context.goal")], ["period", told("context.goal_period")], ["resources", told("context.resources")], ["constraints", told("context.constraints")], ["budget", told("context.budget")]]),
    named_directions: problems.filter(problem => problem.named >= 0).sort((a, b) => a.named - b.named).map(problem => problem.domainTitle).filter((title, index, all) => all.indexOf(title) === index),
    ...(funnel && typeof funnel === "object" && typeof funnel.label === "string" ? { funnel: funnel.label } : {}),
    problem_count: problems.length,
    problems: problems.map(problem => {
      const impact = object(facts[`${problem.domain}.impact`]?.value ?? null), history = object(facts[`${problem.domain}.history`]?.value ?? null);
      const consequences = problem.consequence ? { level: problem.consequence, ...filled([["description", textValue(impact?.description ?? null)], ["period", textValue(impact?.period ?? null)]]) } : undefined;
      const earlier = history && toldText(facts, `${problem.domain}.history`) !== "" ? historyText(history) : "";
      const solution = result.solutions.find(item => item.id === problem.id)!;
      const complaint = (snapshot.state.cross_checked ?? []).includes(problem.id) ? lib.relationships.find(relation => relation.relation === "alternative_cause" && relation.b === problem.id && outline.ids.includes(relation.a)) : undefined;
      return { id: problem.id, title: problem.title, direction: problem.domainTitle, visitor_example: told(`${problem.id}.details`),
        ...(consequences ? { consequences } : {}), named_by_visitor: problem.named >= 0, already_happening: problem.reported,
        must_be_solved_before: pairs.filter(([before]) => before === problem.id).map(([, after]) => after), highest_allowed_priority: levelCap(problem), ...(earlier ? { earlier_work: earlier } : {}),
        ...(complaint ? { found_while_checking: problems.find(item => item.id === complaint.a)!.title } : {}),
        steps: solution.action_ids.map(actionText).filter(Boolean), result_of_work: solution.text, services: solution.service_ids.map(serviceName) };
    }),
    map_directions: outline.map, not_problems: outline.notProblems, plan_stages: outline.stages,
    solutions: outline.order.filter(id => tariffsOf(id).length).map(id => ({ id, options: tariffsOf(id).map(tariff => tariff.title) })),
  };
}

// No markup, links, promises, foreign scripts or lines about missing answers in the writer's texts.
const FORBIDDEN = /https?:|www\.|[*_#`<>[\]{}|]|гарант|обещаем|[぀-ヿ㐀-鿿가-힯豈-﫿]/iu;
// Prices are not the writer's business: these words and signs pass only where a problem's name or the visitor's own words use them.
// «Стоимость» is a price only next to work, services or a tariff: the cost of a lead or of acquiring a customer is a business metric of the kit.
const PRICE_WORDS = [/тариф/iu, /стоимост\S*\s+(?:\S+\s+)?(?:работ|услуг|аудит|внедрени|разработк|продвижени|проект|пакет|ведени|настройк|решени)/iu, /(?<!\p{L})цен(?:а|ы|у|е|ой)?(?!\p{L})/iu, /(?<!\p{L})руб/iu, /₽/u, /\$/u, /€/u];
export const NO_INFO = /(?<!\p{L})неизвестно(?!\p{L})|(?<!\p{L})не указан[оаы]?(?!\p{L})|нет сведений|сведений нет|не измерялось|требу\S* уточнения|недостаточно сведений|не выяснено|ответ не предоставлен|противоречивые сведения|(?:нет|недостаточно) данных(?!\s+(?:о|об|по|из|в|с|за|на)(?!\p{L}))|(?<!\p{L})N\/A(?!\p{L})|определить после аудита|информация не предоставлена/iu;
// Pixel Plus measured nothing in the conversation: no samples, own data or analyses. The visitor is «Вы», never «посетитель».
const NOT_MEASURED = /выборк|по нашим данным|мы проанализировали|по результатам проверки|мы проверили/iu;
const THIRD_PERSON = /(?:по словам|со слов|мнению) посетител|посетител\S* (?:сказал|назвал|сообщил|отметил|указал|считает|говорит|ответил)/iu;
// Russian only: Latin words pass when they are the abbreviations of the report or come from the data (the visitor's words, services, tariffs).
const LATIN_ALLOWED = new Set(["SEO", "CRM", "AI", "GEO", "AEO", "UX", "UI", "UTM", "CJM", "SLA", "CAC", "ROMI", "CR", "CPL", "LTV", "KPI", "A", "B", "B2B", "B2C", "API", "SMM", "SERM", "ORM", "IT", "Pixel", "Plus", "Ozon", "Wildberries", "Avito"]);
const latinWords = (text: string) => text.match(/[A-Za-z][A-Za-z0-9]*/g) ?? [];
const numbers = (text: string) => (text.match(/\d[\d\s]*(?:[.,]\d+)?/g) ?? []).map(number => number.replace(/\s/g, "").replace(",", "."));
const clean = (text: unknown) => typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
// The code prints each field's name: a text that repeats it before a dash or a colon («Следующий шаг — …») keeps only what follows.
const unnamed = (text: string, name: string) => {
  const match = new RegExp(`^[«"]?${name}[»"]?(?:\\s+сейчас)?\\s*[—–:-]\\s*(?:это\\s+)?`, "iu").exec(text);
  if (!match || match[0].length >= text.length) return text;
  const rest = text.slice(match[0].length);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
};
const keysAre = (value: unknown, keys: string) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys;
const within = (text: string, min: number, max: number) => text.length >= min && text.length <= max;
const LEVELS: PriorityLevel[] = ["critical", "high", "medium", "low"];

/** Code checks on the writer's reply; null sends the report to the template texts and the code priority. */
export function checkWriter(content: string, input: WriterInput): WriterOutput | null {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { return null; }
  if (!keysAre(raw, "effect,final,intro,map,map_conclusion,not_problems,principle,problems,solutions,stages,top_tasks")) return null;
  const value = raw as Record<string, unknown>;
  const list = (key: string, length: number) => Array.isArray(value[key]) && (value[key] as unknown[]).length === length ? value[key] as Record<string, unknown>[] : null;
  // One entry per requested row, each id once, in any order.
  const rows = <T>(key: string, wanted: { id: string }[], fields: string, map: (entry: Record<string, unknown>) => T): T[] | null => {
    const entries = list(key, wanted.length);
    if (!entries || entries.some(entry => !keysAre(entry, fields) || !wanted.some(item => item.id === entry.id)) || new Set(entries.map(entry => entry.id)).size !== entries.length) return null;
    return entries.map(map);
  };
  const problems = rows("problems", input.problems, "action,cause,consequence,expected,found,id,impact,measure,priority,why,why_problem", entry => ({
    id: String(entry.id), priority: entry.priority as PriorityLevel, why: clean(entry.why), impact: clean(entry.impact), action: clean(entry.action), found: unnamed(clean(entry.found), "что обнаружено"),
    why_problem: unnamed(clean(entry.why_problem), "почему это проблема"), cause: clean(entry.cause), consequence: unnamed(clean(entry.consequence), "последствие для бизнеса"),
    expected: unnamed(clean(entry.expected), "ожидаемый результат"), measure: unnamed(clean(entry.measure), "что измерять") }));
  const map = rows("map", input.map_directions, "conclusion,id", entry => ({ id: String(entry.id), conclusion: clean(entry.conclusion) }));
  const notProblems = rows("not_problems", input.not_problems, "conclusion,id", entry => ({ id: String(entry.id), conclusion: clean(entry.conclusion) }));
  const solutions = rows("solutions", input.solutions, "id,task,why", entry => ({ id: String(entry.id), task: clean(entry.task), why: clean(entry.why) }));
  const stageEntries = list("stages", input.plan_stages.length);
  const topEntries = Array.isArray(value.top_tasks) ? value.top_tasks as unknown[] : null;
  const effect = value.effect as Record<string, unknown>, final = value.final as Record<string, unknown>;
  if (!problems || !map || !notProblems || !solutions || !stageEntries || !topEntries || !keysAre(effect, "measure,rows") || !keysAre(final, "constraint,first,next,why") ||
      !Array.isArray(effect.rows) || !Array.isArray(effect.measure)) return null;
  if (problems.some(problem => !LEVELS.includes(problem.priority))) return null;
  if (stageEntries.some((entry, index) => !keysAre(entry, "stage,title") || entry.stage !== index + 1)) return null;
  if (!topEntries.length || topEntries.length > Math.min(3, input.problems.length) || topEntries.some(entry => !keysAre(entry, "text,title"))) return null;
  if (effect.rows.length > 8 || effect.measure.length > 8 || effect.rows.some(row => !keysAre(row, "horizon,means,metric,now,target")) || effect.measure.some(item => typeof item !== "string")) return null;
  const output: WriterOutput = {
    intro: clean(value.intro), problems, map, map_conclusion: unnamed(clean(value.map_conclusion), "главный вывод(?: карты)?"), not_problems: notProblems,
    top_tasks: topEntries.map(entry => ({ title: clean((entry as Record<string, unknown>).title), text: clean((entry as Record<string, unknown>).text) })),
    stages: stageEntries.map(entry => ({ stage: Number(entry.stage), title: clean(entry.title) })), principle: unnamed(clean(value.principle), "контрольный принцип"),
    effect: { rows: (effect.rows as Record<string, unknown>[]).map(row => ({ metric: clean(row.metric), now: clean(row.now), target: clean(row.target), horizon: clean(row.horizon), means: clean(row.means) })),
      measure: (effect.measure as unknown[]).map(clean) },
    solutions, final: { constraint: unnamed(clean(final.constraint), "главное ограничение(?: роста)?"), first: unnamed(clean(final.first), "что делать первым"), why: unnamed(clean(final.why), "почему"),
      next: unnamed(clean(final.next), "следующий шаг") },
  };
  // Lengths: the kit's fields are short phrases or one to three sentences.
  const sized = within(output.intro, 60, 700) && within(output.map_conclusion, 30, 500) && within(output.principle, 30, 400) &&
    problems.every(problem => within(problem.why, 10, 300) && within(problem.impact, 10, 200) && within(problem.action, 10, 200) && within(problem.found, 20, 700) &&
      within(problem.why_problem, 20, 500) && within(problem.cause, 20, 500) && within(problem.consequence, 20, 500) && within(problem.expected, 10, 400) && within(problem.measure, 5, 300)) &&
    map.every(row => within(row.conclusion, 10, 220)) && notProblems.every(row => within(row.conclusion, 10, 300)) &&
    output.top_tasks.every(task => within(task.title, 3, 80) && within(task.text, 20, 400)) && output.stages.every(stage => within(stage.title, 3, 80)) &&
    output.effect.rows.every(row => within(row.metric, 2, 80) && within(row.now, 1, 40) && within(row.target, 1, 40) && within(row.horizon, 0, 40) && within(row.means, 3, 120) && /\d/.test(row.now) && /\d/.test(row.target)) &&
    output.effect.measure.every(item => within(item, 3, 120)) && (output.effect.rows.length === 0 || output.effect.measure.length === 0) &&
    solutions.every(row => within(row.task, 5, 150) && within(row.why, 10, 300)) &&
    within(output.final.constraint, 30, 500) && within(output.final.first, 30, 500) && within(output.final.why, 30, 500) && within(output.final.next, 20, 400);
  if (!sized) return null;
  const texts = [output.intro, output.map_conclusion, output.principle, ...problems.flatMap(problem => [problem.why, problem.impact, problem.action, problem.found, problem.why_problem, problem.cause, problem.consequence, problem.expected, problem.measure]),
    ...map.map(row => row.conclusion), ...notProblems.map(row => row.conclusion), ...output.top_tasks.flatMap(task => [task.title, task.text]), ...output.stages.map(stage => stage.title),
    ...output.effect.rows.flatMap(row => [row.metric, row.now, row.target, row.horizon, row.means]), ...output.effect.measure, ...solutions.flatMap(row => [row.task, row.why]), ...Object.values(output.final)];
  const told = JSON.stringify(input), priced = (text: string) => PRICE_WORDS.some(word => word.test(text) && !word.test(told));
  if (texts.some(text => FORBIDDEN.test(text) || priced(text) || NO_INFO.test(text) || NOT_MEASURED.test(text) || THIRD_PERSON.test(text))) return null;
  const dataLatin = new Set(latinWords(told).map(word => word.toLowerCase()));
  if (texts.some(text => latinWords(text).some(word => !LATIN_ALLOWED.has(word) && !dataLatin.has(word.toLowerCase())))) return null;
  // Every number in the texts must come from the data; the count of problems is the number of cards.
  const known = new Set(numbers(told));
  if (texts.some(text => numbers(text).some(number => !known.has(number)))) return null;
  const counted = /[Вв]ыявлен\S*\s+(\d+)/u.exec(output.intro);
  if (counted && Number(counted[1]) !== input.problems.length) return null;
  // The approved limits: critical and high only with severe named consequences; critical only when work stops or for the bottleneck of a critical problem;
  // a bottleneck not below its dependent.
  const level = new Map(problems.map(problem => [problem.id, problem.priority]));
  for (const problem of input.problems) {
    const own = level.get(problem.id)!;
    if (PRIORITY_RANK[own] > PRIORITY_RANK[problem.highest_allowed_priority]) return null;
    if (own === "critical" && problem.consequences?.level !== "stops_operation" && !problem.must_be_solved_before.some(after => level.get(after) === "critical")) return null;
    for (const after of problem.must_be_solved_before) {
      if (PRIORITY_RANK[own] < Math.min(PRIORITY_RANK[level.get(after)!], PRIORITY_RANK[problem.highest_allowed_priority])) return null;
    }
  }
  return output;
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
