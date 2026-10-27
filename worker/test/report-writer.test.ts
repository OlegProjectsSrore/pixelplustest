import test from "node:test";
import assert from "node:assert/strict";
import { initialAuditState, type AuditAnswer, type AuditSnapshot, type Json } from "../src/audit/contracts.ts";
import { analyzeAudit } from "../src/audit/engine.ts";
import { library } from "../src/audit/library.ts";
import { codePriorities, executionOrder, importanceOrder, orderPairs, problemFacts, type PriorityLevel, type ProblemFacts } from "../src/audit/priority.ts";
import { buildReportContent } from "../src/report/content.ts";
import { buildWriterInput, checkWriter, type WriterOutput } from "../src/report/report-writer.ts";
import { REPORT_WRITER_PROMPT } from "../src/report/report-writer-prompt.ts";

const date = Date.parse("2026-10-27T10:00:00Z");
const answer = (id: string, fact: string, value: Json, state: AuditAnswer["state"] = "known"): AuditAnswer => ({ id, question_id: library.questions.find(question => question.fact_ids.includes(fact))!.id,
  fact_id: fact, state, value: state === "known" ? value : null, event_ids: ["visitor-1"], channel: "chat", method: "classification", confirmation: "explicit", library_version: library.version, created_at: date });
const details = (blockId: string, text: string) => Object.fromEntries(library.facts.find(fact => fact.id === `${blockId}.details`)!.required_fields!.map(field => [field, { state: "known", value: text }]));
// Two analytics problems where measurement must come first, plus an SEO problem; the visitor named analytics as the main difficulty.
const pair = library.relationships.find(relation => relation.relation === "measurement_before_optimization")!;
const blocks = [pair.a, pair.b].map(id => library.solutions.find(block => block.id === id)!);
function snapshotOf(extra: AuditAnswer[] = []): AuditSnapshot {
  const answers: AuditAnswer[] = [answer("n", "context.name", "Олег"), answer("p", "context.position", "Директор"), answer("c", "context.company_name", "Мебельная фабрика «Дуб»"),
    answer("w", "context.website", "mebel-dub.ru"), answer("b", "context.business", "Кухни на заказ для частных покупателей"), answer("g", "context.goal", "Больше заказов с сайта"),
    answer("u", "context.goal_period", null, "unknown"), answer("pr", "context.priority", [blocks[1]!.domain]),
    ...blocks.flatMap((block, index) => [answer(`a${index}`, `${block.domain}.applicable`, true), answer(`s${index}`, `${block.id}.signal`, "target"), answer(`d${index}`, `${block.id}.details`, details(block.id, `Пример ${index + 1}: в сентябре 60 заявок без источника`)),
      answer(`h${index}`, `${block.domain}.history`, { attempts_status: "not_tried", attempts: [] })]), ...extra];
  return { id: "writer-snapshot", session_id: "session", library_version: library.version, created_at: date, through_seq: 1, answers, state: initialAuditState(library.version, "chat", date), limitations: [] };
}
const facts = (overrides: Partial<ProblemFacts>): ProblemFacts => ({ id: "x", title: "X", domain: "d", domainTitle: "D", consequence: null, named: -1, reported: false, libraryIndex: 0, ...overrides });

test("the approved code priority: consequences and the named topic decide the level; high never without severe consequences", () => {
  const cases: [Partial<ProblemFacts>, PriorityLevel, string[]][] = [
    [{ consequence: "stops_operation" }, "high", ["останавливает работу"]],
    [{ consequence: "loss_or_delay", named: 0 }, "high", ["вызывает потери или задержки", "Вы назвали это направление главным"]],
    [{ consequence: "loss_or_delay" }, "medium", ["вызывает потери или задержки"]],
    [{ consequence: "limited", named: 1 }, "medium", ["влияние ограниченное", "Вы назвали это направление главным"]],
    [{ named: 0 }, "medium", ["Вы назвали это направление главным"]],
    [{ consequence: "no_effect", named: 0 }, "low", ["на работу не влияет", "Вы назвали это направление главным"]],
    [{ consequence: "limited" }, "low", ["влияние ограниченное"]],
    [{}, "low", ["проблема подтверждена Вашими ответами"]],
  ];
  for (const [given, level, reasons] of cases) assert.deepEqual(codePriorities([facts(given)], [], library).get("x"), { level, reasons }, JSON.stringify(given));
  // A bottleneck rises to its dependent's level, but not to high without severe consequences of its own.
  const lifted = codePriorities([facts({ id: "a", title: "Измерение" }), facts({ id: "b", title: "Реклама", consequence: "stops_operation" })], [["a", "b"]], library);
  assert.deepEqual(lifted.get("a"), { level: "medium", reasons: ["от неё зависит решение проблемы «Реклама»"] });
});

test("importance order follows level, the named order, problems already happening and the library; execution puts bottlenecks first", () => {
  const problems = [facts({ id: "lib0", libraryIndex: 0 }), facts({ id: "named1", named: 1, libraryIndex: 1 }), facts({ id: "named0", named: 0, libraryIndex: 2 }), facts({ id: "reported", reported: true, libraryIndex: 3 }), facts({ id: "high", libraryIndex: 4 })];
  const levels = new Map<string, PriorityLevel>([["lib0", "low"], ["named1", "low"], ["named0", "low"], ["reported", "low"], ["high", "high"]]);
  const order = importanceOrder(problems, levels);
  assert.deepEqual(order, ["high", "named0", "named1", "reported", "lib0"]);
  assert.deepEqual(executionOrder(order, [["lib0", "high"]]), ["lib0", "high", "named0", "named1", "reported"]);
});

test("the writer sees only told facts with the approved limits, never library rules, steps or prices", () => {
  const snapshot = snapshotOf([answer("i", `${blocks[0]!.domain}.impact`, { level: "loss_or_delay", description: "Тратим бюджет вслепую" })]);
  const input = buildWriterInput(snapshot, analyzeAudit(snapshot, library), library);
  assert.deepEqual(input.company, { name: "Мебельная фабрика «Дуб»", website: "mebel-dub.ru", business: "Кухни на заказ для частных покупателей" });
  assert.deepEqual(input.goal, { result: "Больше заказов с сайта" }, "an unknown period is left out, not passed as «unknown»");
  assert.deepEqual(input.contact, { name: "Олег", position: "Директор" });
  const [first, second] = blocks.map(block => input.problems.find(problem => problem.id === block.id)!);
  assert.deepEqual(first!.must_be_solved_before, [second!.id]);
  assert.equal(first!.highest_allowed_priority, "high"); assert.equal(first!.consequences?.description, "Тратим бюджет вслепую");
  assert.doesNotMatch(JSON.stringify(input), /₽|tariff|steps|unknown|not_tried/);
  assert.match(REPORT_WRITER_PROMPT, /1\. Узкое место[\s\S]*2\. Последствия[\s\S]*3\. Связь с целью[\s\S]*4\. Выбор посетителя[\s\S]*5\. Срочность/);
  assert.match(REPORT_WRITER_PROMPT, /high только при consequences stops_operation или loss_or_delay/);
});

test("the writer's reply passes only with every problem, no invented numbers, prices or missing-data lines, and within the limits", () => {
  const snapshot = snapshotOf();
  const input = buildWriterInput(snapshot, analyzeAudit(snapshot, library), library);
  const [a, b] = input.problems.map(problem => problem.id);
  const reply = (patch: Partial<WriterOutput> = {}, problems?: WriterOutput["problems"]) => JSON.stringify({ summary: "Главное — связать заявки с источниками: в сентябре 60 заявок пришли без источника. Начать стоит с этого.",
    problems: problems ?? [{ id: a, situation: "Заявки приходят, но источник неизвестен для 60 заявок за сентябрь, поэтому оценить рекламу сложно.", priority: "medium", why: "Вы назвали это направление главным." },
      { id: b, situation: "Пример 2 показывает, что в сентябре 60 заявок остались без источника.", priority: "medium", why: "Вы назвали это направление главным." }],
    plan_intro: "Сначала наладим измерение, затем остальное.", ...patch });
  // «неизвестен» about a source is a finding, not a line about a missing answer.
  assert.ok(checkWriter(reply(), input));
  const ok = (problems: WriterOutput["problems"]) => reply({}, problems);
  const good: WriterOutput["problems"] = [{ id: a!, situation: "Заявки приходят, но у 60 заявок за сентябрь нет источника, поэтому оценить рекламу сложно.", priority: "medium", why: "Вы назвали это направление главным." },
    { id: b!, situation: "Пример 2: в сентябре 60 заявок остались без источника, это мешает понять отдачу.", priority: "medium", why: "Вы назвали это направление главным." }];
  assert.ok(checkWriter(ok(good), input));
  for (const [name, broken] of [
    ["missing problem", ok(good.slice(1))],
    ["invented number", ok([{ ...good[0]!, situation: "За год потеряли 300 заявок, источник не определить." }, good[1]!])],
    ["price", ok([{ ...good[0]!, why: "Работы стоят от 10 000 ₽." }, good[1]!])],
    ["missing-data line", ok([{ ...good[0]!, situation: "Срок цели неизвестно какой, поэтому 60 заявок без источника." }, good[1]!])],
    ["high without consequences", ok([{ ...good[0]!, priority: "high" }, good[1]!])],
    ["bottleneck below its dependent", ok([{ ...good[0]!, priority: "low" }, good[1]!])],
    ["foreign script", ok([{ ...good[0]!, why: "Вы назвали это направление главным 上." }, good[1]!])],
    ["extra field", JSON.stringify({ ...JSON.parse(ok(good)), extra: 1 })],
  ] as const) assert.equal(checkWriter(broken, input), null, name);
  // A price word passes only where the problem's name or the visitor's own words use it.
  const prices = ok([{ ...good[0]!, why: "Цены и фото Вы не меняли, а заявки идут без источника." }, good[1]!]);
  assert.equal(checkWriter(prices, input), null, "price word the visitor did not use");
  const told = { ...input, problems: input.problems.map((problem, index) => index ? problem : { ...problem, visitor_example: `${problem.visitor_example} Цены и фото не меняли.` }) };
  assert.ok(checkWriter(prices, told), "the visitor's own word");
  const titled = { ...input, problems: input.problems.map((problem, index) => index ? problem : { ...problem, title: "Стоимость подходящего обращения превышает согласованный ориентир" }) };
  const cost = ok([{ ...good[0]!, why: "Стоимость обращения выше ориентира." }, good[1]!]);
  assert.equal(checkWriter(cost, input), null); assert.ok(checkWriter(cost, titled), "a word of the problem's name");
  assert.equal(checkWriter(ok([{ ...good[0]!, why: "Тариф выбирайте сами." }, good[1]!]), titled), null, "other price words stay forbidden");
});

test("the PDF has the eleven approved sections in order, the header, and uses the writer's texts", () => {
  const snapshot = snapshotOf(), result = analyzeAudit(snapshot, library);
  const input = buildWriterInput(snapshot, result, library);
  const written: WriterOutput = { summary: "Главное — связать заявки с источниками, начать стоит с измерения.", plan_intro: "Сначала измерение, затем реклама.",
    problems: input.problems.map(problem => ({ id: problem.id, situation: `Ситуация «${problem.title}» по Вашему примеру.`, priority: "medium", why: "Вы назвали это направление главным." })) };
  const html = buildReportContent(result, snapshot, library, 1_000_000, written).html;
  const titles = library.report.sections.slice(1).map(section => section.title);
  const positions = titles.map(title => html.indexOf(`<h2>${title}</h2>`));
  assert.ok(positions.every(position => position > 0), JSON.stringify(titles.filter((_, index) => positions[index]! < 0)));
  assert.deepEqual([...positions].sort((x, y) => x - y), positions, "sections keep the approved order");
  assert.ok(html.indexOf('class="report-cover"') < html.indexOf("<header>"), "the cover stays the first page");
  assert.match(html, /<p class="company">Мебельная фабрика «Дуб» · сайт: mebel-dub\.ru<\/p><p>Подготовлено для: Олег, Директор<\/p>/);
  assert.ok(html.includes(written.summary) && html.includes(written.plan_intro) && html.includes("Вы назвали это направление главным."));
  assert.match(html, /Контактное лицо: Олег, Директор/);
  assert.ok(html.includes('<a href="https://pixelplus.ru/contact/zakaz/">'));
  // The bottleneck is the first stage, and the dependent stage names it.
  const [first, second] = blocks.map(block => library.solutions.find(item => item.id === block.id)!.pdf.heading as string);
  assert.ok(html.indexOf(`<li><strong>${first}</strong>`, html.indexOf("<h2>Общий план работ</h2>")) < html.indexOf(`<li><strong>${second}</strong> — после: «${first}»`));
  // Levels above the limits from a tampered reply are not trusted: the code priority is used.
  const tampered = { ...written, problems: written.problems.map(problem => ({ ...problem, priority: "high" as const })) };
  assert.doesNotMatch(buildReportContent(result, snapshot, library, 1_000_000, tampered).html, /— Высокий/);
});

test("without the writer the PDF uses the template texts and the code priority; «no website» is said plainly", () => {
  const snapshot = snapshotOf([answer("w2", "context.website", null, "not_applicable")]);
  snapshot.answers = snapshot.answers.filter(item => item.id !== "w");
  const html = buildReportContent(analyzeAudit(snapshot, library), snapshot, library).html;
  assert.ok(html.includes(library.report.texts.summary_fallback) && html.includes(library.report.texts.plan_fallback));
  assert.match(html, /Сайт: пока нет/);
  assert.match(html, /— Средний\. Вы назвали это направление главным\./);
  assert.match(html, /<strong>С чего начать:<\/strong>/);
});
