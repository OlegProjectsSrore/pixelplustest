import test from "node:test";
import assert from "node:assert/strict";
import { initialAuditState, type AuditAnswer, type AuditSnapshot, type Json } from "../src/audit/contracts.ts";
import { analyzeAudit } from "../src/audit/engine.ts";
import { library } from "../src/audit/library.ts";
import { codePriorities, complexityScore, CONFIDENCE, executionOrder, importanceOrder, influenceScore, levelsAllowed, urgencyScore, type PriorityLevel, type ProblemFacts } from "../src/audit/priority.ts";
import { buildReportContent } from "../src/report/content.ts";
import { buildWriterInput, checkWriter, type WriterInput, type WriterOutput } from "../src/report/report-writer.ts";
import { REPORT_WRITER_PROMPT } from "../src/report/report-writer-prompt.ts";
import { REPORT_KIT_SAMPLE } from "../src/report/report-kit-sample.ts";

const date = Date.parse("2026-10-27T10:00:00Z");
const answer = (id: string, fact: string, value: Json, state: AuditAnswer["state"] = "known"): AuditAnswer => ({ id, question_id: library.questions.find(question => question.fact_ids.includes(fact))!.id,
  fact_id: fact, state, value: state === "known" ? value : null, event_ids: ["visitor-1"], channel: "chat", method: "classification", confirmation: "explicit", library_version: library.version, created_at: date });
const details = (blockId: string, text: string) => Object.fromEntries(library.facts.find(fact => fact.id === `${blockId}.details`)!.required_fields!.map(field => [field, { state: "known", value: text }]));
// Two analytics problems where measurement must come first; the visitor named analytics as the main difficulty; SEO does not apply.
const pair = library.relationships.find(relation => relation.relation === "measurement_before_optimization")!;
const blocks = [pair.a, pair.b].map(id => library.solutions.find(block => block.id === id)!);
function snapshotOf(extra: AuditAnswer[] = []): AuditSnapshot {
  const answers: AuditAnswer[] = [answer("n", "context.name", "Олег"), answer("p", "context.position", "Директор"), answer("c", "context.company_name", "Мебельная фабрика «Дуб»"),
    answer("w", "context.website", "mebel-dub.ru"), answer("b", "context.business", "Кухни на заказ для частных покупателей"), answer("g", "context.goal", "Больше заказов с сайта"),
    answer("u", "context.goal_period", null, "unknown"), answer("pr", "context.priority", [blocks[1]!.domain]), answer("seo", "seo.applicable", false),
    ...blocks.flatMap((block, index) => [answer(`a${index}`, `${block.domain}.applicable`, true), answer(`s${index}`, `${block.id}.signal`, "target"), answer(`d${index}`, `${block.id}.details`, details(block.id, `Пример ${index + 1}: в сентябре 60 заявок без источника`)),
      answer(`h${index}`, `${block.domain}.history`, { attempts_status: "not_tried", attempts: [] })]), ...extra];
  return { id: "writer-snapshot", session_id: "session", library_version: library.version, created_at: date, through_seq: 1, answers, state: initialAuditState(library.version, "chat", date), limitations: [] };
}
const facts = (overrides: Partial<ProblemFacts>): ProblemFacts => ({ id: "x", title: "X", domain: "d", domainTitle: "D", consequence: null, named: -1, reported: false, type: "reported_issue", libraryIndex: 0, ...overrides });
/** A reply that passes every check for the given input. */
function goodReply(input: WriterInput): WriterOutput {
  return {
    intro: `Выявлено ${input.problem_count} проблемы. Главная — связать заявки с источниками: в сентябре 60 заявок пришли без источника.`,
    problems: input.problems.map(problem => ({ id: problem.id, priority: "medium", why: "Вы назвали это направление главным.", impact: "Нельзя понять, какая реклама работает.",
      action: "Настроить учёт заявок и источников.", found: "В сентябре 60 заявок пришли без источника.", why_problem: "Без источника заявок нельзя оценить отдачу рекламы.",
      cause: "Вероятно, цели и метки настроены не для всех форм; это нужно проверить.", consequence: "Решения о бюджете принимаются без опоры на данные.",
      expected: "Понятная картина источников заявок для решений о бюджете.", measure: "доля заявок с источником; число заявок по каналам" })),
    map: input.map_directions.map(direction => ({ id: direction.id, conclusion: "Есть подтверждённая проблема с учётом заявок." })),
    map_conclusion: "Сначала стоит наладить измерение, затем менять рекламу и сайт.",
    not_problems: input.not_problems.map(direction => ({ id: direction.id, conclusion: "По Вашим словам, направление не относится к задаче." })),
    top_tasks: [{ title: "Наладить измерение", text: "Связать заявки с источниками, чтобы видеть отдачу каналов." }],
    stages: input.plan_stages.map(stage => ({ stage: stage.stage, title: "сначала измерение" })),
    principle: "Каждый следующий этап опирается на данные предыдущего.",
    effect: { rows: [], measure: ["доля заявок с источником", "число заявок по каналам", "число звонков с сайта"] },
    solutions: input.solutions.map(row => ({ id: row.id, task: "Понять отдачу рекламы", why: "Даст надёжную связь между расходом и заявкой." })),
    final: { constraint: "Главное ограничение — заявки без источника: в сентябре их было 60.", first: "Сначала наладить учёт заявок и источников по этапу 1 плана.",
      why: "От измерения зависят все решения о бюджете и рекламе.", next: "Собрать данные о текущих системах учёта обращений." },
  };
}

test("the kit priority: four levels from consequences, the named topic and bottlenecks; critical only when work stops", () => {
  const cases: [Partial<ProblemFacts>, PriorityLevel, string[]][] = [
    [{ consequence: "stops_operation" }, "critical", ["останавливает работу"]],
    [{ consequence: "loss_or_delay", named: 0 }, "high", ["вызывает потери или задержки", "Вы назвали это направление главным"]],
    [{ consequence: "loss_or_delay" }, "medium", ["вызывает потери или задержки"]],
    [{ consequence: "limited", named: 1 }, "medium", ["влияние ограниченное", "Вы назвали это направление главным"]],
    [{ named: 0 }, "medium", ["Вы назвали это направление главным"]],
    [{ consequence: "no_effect", named: 0 }, "low", ["на работу не влияет", "Вы назвали это направление главным"]],
    [{ consequence: "limited" }, "low", ["влияние ограниченное"]],
    [{}, "low", ["проблема подтверждена Вашими ответами"]],
  ];
  for (const [given, level, reasons] of cases) assert.deepEqual(codePriorities([facts(given)], [], library).get("x"), { level, reasons }, JSON.stringify(given));
  // A bottleneck rises to its dependent's level within its own cap: without severe consequences no higher than medium, with losses up to critical.
  const lifted = codePriorities([facts({ id: "a", title: "Измерение" }), facts({ id: "b", title: "Реклама", consequence: "stops_operation" })], [["a", "b"]], library);
  assert.deepEqual(lifted.get("a"), { level: "medium", reasons: ["от неё зависит решение проблемы «Реклама»"] });
  const severe = codePriorities([facts({ id: "a", title: "Измерение", consequence: "loss_or_delay" }), facts({ id: "b", title: "Реклама", consequence: "stops_operation" })], [["a", "b"]], library);
  assert.equal(severe.get("a")!.level, "critical");
  // The writer's levels: critical only when work stops or for the bottleneck of a critical problem.
  const problems = [facts({ id: "a", consequence: "loss_or_delay" }), facts({ id: "b", consequence: "stops_operation" })];
  assert.ok(levelsAllowed(problems, [["a", "b"]], new Map([["a", "critical"], ["b", "critical"]])));
  assert.ok(!levelsAllowed(problems, [], new Map([["a", "critical"], ["b", "critical"]])));
  assert.ok(!levelsAllowed([facts({ id: "a" })], [], new Map([["a", "high"]])));
});

test("the kit scores follow the visitor's answers", () => {
  assert.deepEqual([influenceScore(facts({ consequence: "stops_operation" })), influenceScore(facts({ consequence: "loss_or_delay" })), influenceScore(facts({ consequence: "limited" })),
    influenceScore(facts({ consequence: "no_effect" })), influenceScore(facts({}))], [10, 8, 5, 2, 5]);
  assert.equal(urgencyScore(facts({ consequence: "stops_operation" }), []), 10);
  assert.equal(urgencyScore(facts({ named: 0 }), []), 9);
  assert.equal(urgencyScore(facts({ named: 2 }), []), 8);
  assert.equal(urgencyScore(facts({ id: "a" }), [["a", "b"]]), 8);
  assert.equal(urgencyScore(facts({ consequence: "loss_or_delay" }), []), 7);
  assert.equal(urgencyScore(facts({}), []), 5);
  assert.equal(urgencyScore(facts({ consequence: "no_effect" }), []), 3);
  assert.deepEqual([complexityScore(3), complexityScore(12)], [5, 10]);
  assert.deepEqual(Object.values(CONFIDENCE).map(item => item.percent), [90, 85, 70, 60]);
});

test("importance order follows level, the named order, problems already happening and the library; execution puts bottlenecks first", () => {
  const problems = [facts({ id: "lib0", libraryIndex: 0 }), facts({ id: "named1", named: 1, libraryIndex: 1 }), facts({ id: "named0", named: 0, libraryIndex: 2 }), facts({ id: "reported", reported: true, libraryIndex: 3 }), facts({ id: "high", libraryIndex: 4 })];
  const levels = new Map<string, PriorityLevel>([["lib0", "low"], ["named1", "low"], ["named0", "low"], ["reported", "low"], ["high", "critical"]]);
  const order = importanceOrder(problems, levels);
  assert.deepEqual(order, ["high", "named0", "named1", "reported", "lib0"]);
  assert.deepEqual(executionOrder(order, [["lib0", "high"]]), ["lib0", "high", "named0", "named1", "reported"]);
});

test("the writer sees told facts, the approved limits and the report's rows, never prices; its instructions carry the approved sample", () => {
  const snapshot = snapshotOf([answer("i", `${blocks[0]!.domain}.impact`, { level: "loss_or_delay", description: "Тратим бюджет вслепую" })]);
  const result = analyzeAudit(snapshot, library), input = buildWriterInput(snapshot, result, library);
  assert.deepEqual(input.company, { name: "Мебельная фабрика «Дуб»", website: "mebel-dub.ru", business: "Кухни на заказ для частных покупателей" });
  assert.deepEqual(input.goal, { result: "Больше заказов с сайта" }, "an unknown period is left out, not passed as «unknown»");
  assert.deepEqual(input.contact, { name: "Олег", position: "Директор" });
  const [first, second] = blocks.map(block => input.problems.find(problem => problem.id === block.id)!);
  assert.deepEqual(first!.must_be_solved_before, [second!.id]);
  assert.equal(first!.highest_allowed_priority, "critical"); assert.equal(first!.consequences?.description, "Тратим бюджет вслепую");
  assert.deepEqual(first!.steps, result.solutions.find(solution => solution.id === first!.id)!.action_ids.map(id => result.actions.find(action => action.id === id)!.text));
  assert.equal(input.problem_count, 2);
  assert.deepEqual(input.not_problems, [{ id: "seo", title: library.domains.find(domain => domain.id === "seo")!.title, visitor_said: "направление не относится к задаче" }]);
  assert.deepEqual(input.plan_stages.map(stage => stage.problem_ids), [[first!.id], [second!.id]], "the bottleneck is the first stage");
  assert.ok(input.solutions.length > 0 && input.solutions.every(row => row.options.length > 0));
  assert.doesNotMatch(JSON.stringify(input), /₽|unknown|not_tried|price/);
  assert.ok(REPORT_WRITER_PROMPT.includes(REPORT_KIT_SAMPLE) && REPORT_KIT_SAMPLE.includes("[КОММЕНТАРИЙ ДЛЯ LLM] Кто что пишет."));
  assert.match(REPORT_WRITER_PROMPT, /critical — посетитель сказал, что проблема останавливает работу/);
  assert.match(REPORT_WRITER_PROMPT, /critical и high только при consequences stops_operation или loss_or_delay/);
});

test("the writer's reply passes only with every row, no invented numbers, prices, missing-data lines or English words, and within the limits", () => {
  const snapshot = snapshotOf();
  const input = buildWriterInput(snapshot, analyzeAudit(snapshot, library), library);
  const good = goodReply(input);
  assert.ok(checkWriter(JSON.stringify(good), input));
  const problem = (patch: Partial<WriterOutput["problems"][number]>) => ({ ...good, problems: [{ ...good.problems[0]!, ...patch }, ...good.problems.slice(1)] });
  for (const [name, broken] of [
    ["missing problem", { ...good, problems: good.problems.slice(1) }],
    ["missing map row", { ...good, map: [] }],
    ["missing stage", { ...good, stages: [] }],
    ["invented number", problem({ found: "За год потеряли 300 заявок, источник не определить." })],
    ["price", problem({ why: "Работы стоят от 10 000 ₽." })],
    ["missing-data line", problem({ found: "Срок цели неизвестно какой, поэтому 60 заявок без источника." })],
    ["no data placeholder", { ...good, map_conclusion: "По рекламе нет данных, поэтому начинать стоит с измерения." }],
    ["a sample that was never taken", { ...good, map_conclusion: "В нашей выборке заявок компания видна слабо, начинать стоит с измерения." }],
    ["English word", { ...good, map_conclusion: "Главный bottleneck — измерение, начинать стоит с него." }],
    ["wrong count", { ...good, intro: "Выявлено 5 проблем. Главная — связать заявки с источниками, это стоит сделать первым." }],
    ["effect row without the visitor's numbers", { ...good, effect: { rows: [{ metric: "Заявки", now: "мало", target: "больше", horizon: "", means: "аналитика" }], measure: [] } }],
    ["high without consequences", problem({ priority: "high" })],
    ["critical without a stop", problem({ priority: "critical" })],
    ["bottleneck below its dependent", problem({ priority: "low" })],
    ["foreign script", problem({ why: "Вы назвали это направление главным 上." })],
    ["extra field", { ...good, extra: 1 }],
  ] as const) assert.equal(checkWriter(JSON.stringify(broken), input), null, name);
  // A price word passes only where the problem's name or the visitor's own words use it.
  const prices = JSON.stringify(problem({ why: "Цены и фото Вы не меняли, а заявки идут без источника." }));
  assert.equal(checkWriter(prices, input), null, "price word the visitor did not use");
  const told = { ...input, problems: input.problems.map((item, index) => index ? item : { ...item, visitor_example: `${item.visitor_example} Цены и фото не меняли.` }) };
  assert.ok(checkWriter(prices, told), "the visitor's own word");
  // A text that repeats its field's name keeps only what follows; the third person is not accepted.
  const named = checkWriter(JSON.stringify({ ...good, final: { ...good.final, constraint: "Главное ограничение роста сейчас — это заявки без источника: в сентябре их было 60.", next: "Следующий шаг: собрать данные о текущих системах учёта." } }), input)!;
  assert.deepEqual([named.final.constraint, named.final.next], ["Заявки без источника: в сентябре их было 60.", "Собрать данные о текущих системах учёта."]);
  assert.equal(checkWriter(JSON.stringify({ ...good, map_conclusion: "Направление на работу не влияет, по словам посетителя, начинать стоит с измерения." }), input), null);
  // «Стоимость» of a lead or of acquiring a customer is a metric, of work a price; «нет данных о …» is a finding, a bare «нет данных» a placeholder.
  assert.ok(checkWriter(JSON.stringify(problem({ consequence: "Растёт стоимость привлечения клиента (CAC) и стоимость обращения." })), input));
  assert.equal(checkWriter(JSON.stringify(problem({ consequence: "Стоимость работ по настройке окупится быстро." })), input), null);
  assert.ok(checkWriter(JSON.stringify(problem({ impact: "Нет данных о том, где теряются заявки." })), input));
  assert.equal(checkWriter(JSON.stringify(problem({ impact: "По рекламе пока нет данных." })), input), null);
  // The visitor's own numbers make an effect row.
  const goal = { ...input, goal: { result: "Увеличить заказы с 25 до 35 в месяц" } };
  assert.ok(checkWriter(JSON.stringify({ ...good, effect: { rows: [{ metric: "Заказы в месяц", now: "25", target: "35", horizon: "", means: "аналитика и реклама" }], measure: [] } }), goal));
});

test("the PDF follows the kit: the cover, ten sections in order, the header block and the writer's texts", () => {
  const snapshot = snapshotOf(), result = analyzeAudit(snapshot, library);
  const input = buildWriterInput(snapshot, result, library), written = goodReply(input);
  const html = buildReportContent(result, snapshot, library, 1_000_000, written).html;
  const titles = library.report.sections.filter(section => !["cover", "problems"].includes(section.id)).map(section => section.title);
  const positions = titles.map(title => html.indexOf(`<h1>${title}</h1>`));
  assert.ok(positions.every(position => position > 0), JSON.stringify(titles.filter((_, index) => positions[index]! < 0)));
  assert.deepEqual([...positions].sort((x, y) => x - y), positions, "sections keep the approved order");
  const problems = html.indexOf("05 / ВЫЯВЛЕННЫЕ ПРОБЛЕМЫ / 01");
  assert.ok(problems > html.indexOf(`<h1>${library.report.sections.find(section => section.id === "map")!.title}</h1>`) && problems < html.indexOf("<h1>Приоритизация</h1>"));
  assert.match(html, /<p class="label">01 \/ ГЛАВНЫЕ ПРИОРИТЕТЫ<\/p>/);
  assert.ok(html.indexOf('class="report-cover"') < html.indexOf("<main>"), "the cover stays the first page");
  assert.match(html, /<div class="who"><p>Мебельная фабрика «Дуб» · сайт: mebel-dub\.ru<\/p><\/div><p class="meta">Подготовлено для: Олег, Директор<\/p><p class="meta">Pixel Plus · 27\.10\.2026<\/p>/);
  for (const text of [written.intro, written.map_conclusion, written.principle, written.final.constraint, written.problems[0]!.cause, written.effect.measure[0]!]) assert.ok(html.includes(text), text);
  assert.match(html, /Что не признано проблемой по итогам экспресс-аудита/);
  assert.match(html, /@bottom-center\{content:"Мебельная фабрика «Дуб»"/);
  assert.match(html, /counter\(page,decimal-leading-zero\) " \/ " counter\(pages,decimal-leading-zero\)/);
  assert.ok(html.includes('<a href="https://pixelplus.ru/contact/zakaz/">'));
  // The bottleneck is stage 1, its dependent stage 2 names it.
  const [first, second] = blocks.map(block => library.solutions.find(item => item.id === block.id)!.pdf.heading as string);
  assert.ok(html.indexOf(`<li>${first}:`) < html.indexOf(`<li>${second}:`) && html.includes(`После: «${first}».`));
  // Levels above the limits from a tampered reply are not trusted: the code priority is used.
  const tampered = { ...written, problems: written.problems.map(problem => ({ ...problem, priority: "critical" as const })) };
  assert.doesNotMatch(buildReportContent(result, snapshot, library, 1_000_000, tampered).html, /Критический/);
});

test("without the writer the PDF uses the template texts and the code priority; «no website» is said plainly; no effect section", () => {
  const snapshot = snapshotOf([answer("w2", "context.website", null, "not_applicable")]);
  snapshot.answers = snapshot.answers.filter(item => item.id !== "w");
  const html = buildReportContent(analyzeAudit(snapshot, library), snapshot, library).html;
  assert.ok(html.includes(library.report.texts.summary_fallback) && html.includes(library.report.texts.plan_fallback));
  assert.match(html, /<td><strong>Сайт<\/strong><\/td><td>пока нет<\/td>/);
  assert.match(html, /<strong>Приоритет:<\/strong> Средний\./);
  assert.doesNotMatch(html, /Ожидаемый бизнес-эффект/);
  assert.match(html, /Выявлено 2 проблемы\./);
});
