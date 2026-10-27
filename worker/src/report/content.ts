import type { AuditResult, AuditSnapshot, Json } from "../audit/contracts.ts";
import type { AuditLibrary } from "../audit/library.ts";
import { complexityScore, CONFIDENCE, influenceScore, levelsAllowed, MAP_SCORE, PRIORITY_RANK, urgencyScore, type PriorityLevel } from "../audit/priority.ts";
import { coverPngBase64 } from "./cover-image.ts";
import { regularFont, boldFont } from "./fonts.ts";
import { ReportFailure } from "./pdf.ts";
import { reportOutline, toldText, type WriterOutput } from "./report-writer.ts";
import { object, strings, textValue } from "./told.ts";

export const TEMPLATE_VERSION = "2.0.0";
// A result analysed with the previous template has the same shape: a report in flight at a release still renders.
const RENDERABLE = new Set(["1.3.0", TEMPLATE_VERSION]);
export type ReportContent = { title: string; templateVersion: string; html: string; generatedAt: number };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
}
const esc = escapeHtml;
// A CSS string for the page footer: every character that could end the string or the style element is escaped.
const cssString = (value: string) => `"${value.replace(/[\\"'<>&\n\r]/g, character => `\\${character.charCodeAt(0).toString(16)} `)}"`;
function tariffPrice(details: Record<string, Json>): string {
  const price = object(details.price);
  if (!price || price.type === "individual") return "";
  const money = (value: Json | undefined) => typeof value === "number" && Number.isFinite(value) ? `${new Intl.NumberFormat("ru-RU").format(value)} ${price.currency === "RUB" ? "₽" : String(price.currency ?? "")}` : null;
  const amount = money(price.amount), minimum = money(price.min), maximum = money(price.max);
  // A fixed price of zero is a free offer: no unit or period.
  if (price.type === "fixed" && price.amount === 0) return "бесплатно";
  const value = price.type === "fixed" ? amount : price.type === "from" && amount ? `от ${amount}` : price.type === "range" && minimum && maximum ? `${minimum}–${maximum}` : null;
  if (!value) return "";
  const units: Record<string, string> = { project: "за проект", month: "в месяц", audit: "за аудит", hour: "за час", database: "за базу", slide: "за слайд", prepaid_package: "за пакет" };
  // An unstated period or unit is simply left out: the price itself is always shown.
  const periods: Record<string, string> = { one_time: "разово", monthly: "ежемесячно", monthly_in_arrears: "постоплата в конце месяца", not_monthly: "не ежемесячно" };
  const unit = units[String(price.unit)] ?? "";
  const period = price.billing_period === "monthly" && price.unit === "month" ? "" : periods[String(price.billing_period)] ?? "";
  return [value, unit, period].filter(Boolean).join(" · ");
}
const sentence = (text: string) => text ? text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?…]$/.test(text) ? "" : ".") : "";
const lowerFirst = (text: string) => text && !/^\p{Lu}{2}/u.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
const plural = (count: number, one: string, few: string, many: string) => {
  const last = count % 10, tens = count % 100;
  return last === 1 && tens !== 11 ? one : last >= 2 && last <= 4 && (tens < 10 || tens >= 20) ? few : many;
};
const two = (value: number) => String(value).padStart(2, "0");
const ruDate = (time: number) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(time));
// Approximate heights of the kit's typography in points: a problem card that would not fit its page continues on the next one under a «continued» heading.
const CARD_ROOM = 700;
const lineCount = (text: string, perLine: number) => Math.max(1, Math.ceil(text.length / perLine));
const textHeight = (text: string, perLine = 88) => lineCount(text, perLine) * 14.4;
const table = (headers: string[], rows: string[][], className = "") => rows.length
  ? `<table${className ? ` class="${className}"` : ""}><thead><tr>${headers.map(header => `<th>${esc(header)}</th>`).join("")}</tr></thead><tbody>${rows.map(cells => `<tr>${cells.map(cell => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>`
  : "";

/** Produces fixed, escaped HTML of the report kit: the approved cover and ten sections. written: the report writer's checked texts; null keeps the template texts and the code priority. */
export function buildReportContent(result: AuditResult, snapshot: AuditSnapshot, library: AuditLibrary, maxBytes = 1_000_000, written: WriterOutput | null = null): ReportContent {
  if (!RENDERABLE.has(result.template_version) || result.library_version !== snapshot.library_version || result.snapshot_id !== snapshot.id) {
    throw new ReportFailure("REPORT_VERSION_MISMATCH", false);
  }
  const titles = Object.fromEntries(library.report.sections.map(item => [item.id, item.title]));
  const texts = library.report.texts, levelNames = library.report.priority.levels, reasons = library.report.priority.reasons;
  // Priority: the writer's levels when they keep the approved limits, otherwise the code rule.
  const base = reportOutline(snapshot, result, library);
  const writerLevels = written ? new Map(written.problems.map(problem => [problem.id, problem.priority])) : null;
  const writer = writerLevels && levelsAllowed(base.problems, base.pairs, writerLevels) ? written : null;
  const outline = writer ? reportOutline(snapshot, result, library, writerLevels!) : base;
  const { facts, problems, pairs, code, level, order, execution } = outline;
  const told = (id: string) => toldText(facts, id);
  const website = facts["context.website"]?.state === "not_applicable" ? texts.no_website : told("context.website");

  const problem = (id: string) => problems.find(item => item.id === id)!;
  const title = (id: string) => problem(id).title;
  const solution = (id: string) => result.solutions.find(item => item.id === id)!;
  const textOf = (id: string) => writer?.problems.find(item => item.id === id);
  const why = (id: string) => textOf(id)?.why ?? sentence(code.get(id)!.reasons.join("; "));
  const actionText = (actionId: string) => result.actions.find(item => item.id === actionId)?.text ?? actionId;
  const serviceName = (id: string) => library.services.find(item => item.id === id)?.name ?? id;
  const services = (id: string) => solution(id).service_ids.map(serviceName).join(" / ");
  const impact = (id: string) => { const domain = problem(id).domain; return told(`${domain}.impact`) ? textValue(object(facts[`${domain}.impact`]?.value ?? null)?.description ?? null) : ""; };
  const consequence = (id: string) => sentence(impact(id)) || (problem(id).consequence ? sentence(reasons[problem(id).consequence!]) : "");
  // Shared prior-attempt steps of a topic are listed once, under its first problem.
  const shownPrior = new Set<string>();
  const stepsOf = (id: string) => solution(id).action_ids.filter(actionId => {
    if (actionId.startsWith(`${id}:`)) return true;
    if (shownPrior.has(actionId)) return false;
    shownPrior.add(actionId); return true;
  });
  // A problem found while checking another possible cause of a complaint in this report says so.
  const crossFound = (id: string) => {
    if (!texts.cross_found || !(snapshot.state.cross_checked ?? []).includes(id)) return "";
    const complaint = library.relationships.find(relation => relation.relation === "alternative_cause" && relation.b === id && outline.ids.includes(relation.a));
    return complaint ? texts.cross_found.replace("{{complaint}}", title(complaint.a)) : "";
  };
  const levelLabel = (id: string) => `<span class="level ${level.get(id)}">${esc(levelNames[level.get(id)!])}</span>`;

  // Sections are numbered in order; one without content is left out and the next takes its number.
  let number = 0;
  const pages: string[] = [];
  const section = (label: string | null, heading: string, body: string, options: { problem?: boolean } = {}) =>
    `<section class="page"><p class="label">${esc(label ?? "")}</p><h1${options.problem ? ' class="problem-title"' : ""}>${esc(heading)}</h1>${body}</section>`;
  const next = () => two(++number);

  // 1. What holds growth back: the company, the recipient and the date, then up to three main problems.
  const company = [told("context.company_name"), website && `сайт: ${website}`].filter(Boolean).join(" · ");
  const preparedFor = [told("context.name"), told("context.position")].filter(Boolean).join(", ");
  const count = problems.length;
  const intro = writer?.intro ?? `Выявлено ${count} ${plural(count, "проблема", "проблемы", "проблем")}. ${texts.summary_fallback}`;
  const badge = (index: number, id: string) => `<div class="badge ${level.get(id)}">${two(index + 1)}</div><div class="badge-label ${level.get(id)}">${esc(levelNames[level.get(id)!])}</div>`;
  pages.push(section(`${next()} / ГЛАВНЫЕ ПРИОРИТЕТЫ`, titles.growth!,
    `${company ? `<div class="who"><p>${esc(company)}</p></div>` : ""}${preparedFor ? `<p class="meta">Подготовлено для: ${esc(preparedFor)}</p>` : ""}<p class="meta">Pixel Plus · ${esc(ruDate(snapshot.created_at))}</p>` +
    `<p class="lead">${esc(intro)}</p>` +
    table(["Приоритет", "Проблема", "Влияние на бизнес", "Что делать"], order.slice(0, 3).map((id, index) => [badge(index, id), `<strong>${esc(title(id))}</strong>`,
      esc(textOf(id)?.impact ?? (consequence(id) || sentence(reasons.confirmed))), esc(textOf(id)?.action ?? services(id))]), "top")));

  // 2. About the company: only what the visitor said; a cause outside digital services is named once below the table.
  const goalText = [sentence(told("context.goal")), told("context.goal_period") && `Срок: ${lowerFirst(told("context.goal_period")).replace(/[.!?]+$/, "")}.`].filter(Boolean).join(" ");
  const priorityFact = facts["context.priority"];
  const named = priorityFact?.state === "known" && priorityFact.confirmation === "explicit" && Array.isArray(priorityFact.value) ? priorityFact.value.filter((value): value is string => typeof value === "string")
    .map(value => library.domains.find(domain => domain.id === value || domain.title === value)?.title ?? "").filter(Boolean) : [];
  const funnelFact = facts["context.funnel"], funnelValue = funnelFact?.state === "known" && funnelFact.confirmation === "explicit" ? String(funnelFact.value) : "";
  const funnelOption = funnelValue && funnelValue !== "unclear" ? library.facts.find(fact => fact.id === "context.funnel")?.values?.find(value => typeof value === "object" && value.id === funnelValue) : undefined;
  const funnel = funnelOption && typeof funnelOption === "object" && typeof funnelOption.label === "string" ? funnelOption.label : "";
  const complaint = [named.length === 1 ? `Главным Вы назвали направление «${named[0]}».` : named.length ? `Главными Вы назвали направления ${named.map(item => `«${item}»`).join(", ")}.` : "", funnel ? `Больше всего клиентов теряется так: ${lowerFirst(funnel)}.` : ""].filter(Boolean).join(" ");
  const businessText = [sentence(told("context.business")), told("context.model") && `Модель продаж: ${lowerFirst(told("context.model")).replace(/[.!?]+$/, "")}.`].filter(Boolean).join(" ");
  const companyRows: [string, string][] = [["Компания", told("context.company_name")], ["Сайт", website], ["Чем занимается компания", businessText], ["Целевая аудитория", sentence(told("context.audience"))],
    ["Основные каналы продаж", sentence(told("context.channels"))], ["География / регионы", sentence(told("context.geography"))], ["Количество сотрудников", sentence(told("context.company_size"))],
    ["Площадки и системы", sentence(told("context.assets"))], ["Целевой бизнес-результат", goalText], ["Главная проблема, озвученная клиентом", complaint]];
  const externalCause = told("context.external_cause").replace(/[.!?]+$/, "");
  const external = texts.external_cause && externalCause ? texts.external_cause.replace("{{external_cause}}", externalCause) : "";
  const shownCompany = companyRows.filter(([, value]) => value);
  if (shownCompany.length || external) pages.push(section(`${next()} / РЕЗУЛЬТАТ АУДИТА`, titles.company!,
    table(["Поле", "Сведения"], shownCompany.map(([label, value]) => [`<strong>${esc(label)}</strong>`, esc(value)]), "facts") + (external ? `<p class="note-box">${esc(external)}</p>` : "")));

  // 3. What was checked: the directions the conversation went through.
  const checkedCount = `${outline.checked.length} ${plural(outline.checked.length, "направление", "направления", "направлений")}`;
  pages.push(section(`${next()} / РЕЗУЛЬТАТ АУДИТА`, titles.checked!, `<p>${esc(texts.checked_intro.replace("{{count}}", checkedCount))}</p>` +
    table(["№", "Направление", "Что проверялось"], outline.checked.map((domain, index) => [String(index + 1), esc(domain.title), esc(sentence(domain.scope ?? ""))]), "checked")));

  // 4. The business map: scores follow the highest problem level of each direction.
  const mapRows = outline.map.map(row => {
    const top = row.problem_ids.reduce<PriorityLevel | "none">((best, id) => best === "none" || PRIORITY_RANK[level.get(id)!] > PRIORITY_RANK[best] ? level.get(id)! : best, "none");
    const { score, potential } = MAP_SCORE[top];
    const conclusion = writer?.map.find(item => item.id === row.id)?.conclusion ?? (row.problem_ids.length ? sentence(row.problem_ids.map(title).join("; ")) : "По Вашим словам, на работу не влияет.");
    return [`<strong>${esc(row.title)}</strong>`, `<span class="score">${score}/10</span><span class="bar"><i class="s${score}"></i></span>`, esc(potential), esc(conclusion)];
  });
  pages.push(section(`${next()} / РЕЗУЛЬТАТ АУДИТА`, titles.map!, `<p>${esc(texts.map_intro)}</p>` + table(["Направление", "Оценка", "Потенциал", "Короткий вывод"], mapRows, "map") +
    (writer ? `<div class="callout"><p><strong>Главный вывод карты:</strong> ${esc(writer.map_conclusion)}</p></div>` : "")));

  // 5. One page per problem in the order of importance, then what was not found to be a problem.
  const problemsNumber = next();
  order.forEach((id, index) => {
    const text = textOf(id), confidence = CONFIDENCE[problem(id).type];
    const item = solution(id), found = crossFound(id);
    const stepTexts = stepsOf(id).map(actionText), intro = item.prior_attempts?.intro ?? "";
    const steps = `${intro ? `<p>${esc(intro)}</p>` : ""}<ol>${stepTexts.map(step => `<li>${esc(step)}</li>`).join("")}</ol>`;
    // Each field with its HTML and its estimated height.
    const plain = (label: string, value: string): [string, string, number] => [label, value ? `<p>${esc(value)}</p>` : "", 25 + textHeight(value)];
    const fields: [string, string, number][] = [
      plain("Что обнаружено", text?.found ?? sentence(told(`${id}.details`))),
      plain("Почему это проблема", text?.why_problem ?? ""),
      plain("Вероятная причина", text?.cause ?? ""),
      plain("Последствие для бизнеса", text?.consequence ?? consequence(id)),
      ["Что рекомендуется сделать", steps, 25 + (intro ? textHeight(intro) + 2 : 0) + stepTexts.reduce((sum, step) => sum + textHeight(step, 80) + 3, 0)],
      plain("Ожидаемый результат", text?.expected ?? sentence(item.text)),
      plain("Что измерять", text?.measure ?? ""),
      plain("Решение Pixel Plus", services(id)),
      plain("Статус / уверенность", `${confidence.status}; ${confidence.percent}%.`),
    ];
    const heading = `Проблема №${index + 1}. ${title(id)}`, label = `${problemsNumber} / ${titles.problems!.toUpperCase()} / ${two(index + 1)}`;
    const parts: string[][] = [[]];
    let used = 10 + 40 + lineCount(heading, 38) * 26 + 14 + 22 + textHeight("Приоритет") + (found ? 5 + textHeight(found) : 0);
    for (const [name, body, height] of fields.filter(([, body]) => body)) {
      if (used + height > CARD_ROOM && parts[parts.length - 1]!.length) { parts.push([]); used = 10 + 40 + lineCount(`${heading} (продолжение)`, 38) * 26; }
      parts[parts.length - 1]!.push(`<div class="field"><h3>${esc(name)}:</h3>${body}</div>`); used += height;
    }
    parts.forEach((part, partIndex) => pages.push(partIndex === 0
      ? section(label, heading, `<div class="priority-box"><p><strong>Приоритет:</strong> ${esc(levelNames[level.get(id)!])}.</p>${found ? `<p>${esc(found)}</p>` : ""}</div>` + part.join(""), { problem: true })
      : section(`${label} · ПРОДОЛЖЕНИЕ`, `${heading} (продолжение)`, part.join(""), { problem: true })));
  });
  if (outline.notProblems.length) pages.push(section(`${problemsNumber} / ${titles.problems!.toUpperCase()}`, "Что не признано проблемой по итогам экспресс-аудита",
    table(["Направление", "Вывод"], outline.notProblems.map(row => [`<strong>${esc(row.title)}</strong>`,
      esc(writer?.not_problems.find(item => item.id === row.id)?.conclusion ?? sentence(`по Вашим словам, ${row.visitor_said}`))]), "facts")));

  // 6. Prioritisation: the code scores, the levels and the three tasks to start with.
  const ownStep = (id: string) => actionText(solution(id).action_ids.find(actionId => actionId.startsWith(`${id}:`)) ?? solution(id).action_ids[0] ?? "");
  const tasks = writer?.top_tasks ?? execution.slice(0, 3).map(id => ({ title: title(id), text: sentence(ownStep(id)) }));
  pages.push(section(`${next()} / РЕЗУЛЬТАТ АУДИТА`, titles.priorities!, `<p>${esc(texts.priorities_intro)}</p>` +
    table(["№", "Проблема", "Влияние", "Срочность", "Сложность", "Уверенность", "Приоритет"], order.map((id, index) => [String(index + 1), esc(title(id)),
      String(influenceScore(problem(id))), String(urgencyScore(problem(id), pairs)), String(complexityScore(solution(id).action_ids.length)), `${CONFIDENCE[problem(id).type].percent}%`, levelLabel(id)]), "scores") +
    `<h2>Три задачи, которые стоит решить в первую очередь</h2>${tasks.map((task, index) => `<p class="task">${index + 1}. <strong>${esc(task.title.replace(/[.!?]+$/, ""))}.</strong> ${esc(task.text)}</p>`).join("")}`));

  // 7. The plan: stages in the order of dependencies; each item is a problem and its result of work.
  const stageHtml = outline.stages.map(stage => {
    const named = writer?.stages.find(item => item.stage === stage.stage)?.title;
    return `<div class="stage"><p>Этап ${stage.stage}${named ? ` — ${esc(lowerFirst(named).replace(/[.!?]+$/, ""))}` : ""}</p></div><ul class="dash">${stage.problem_ids.map(id => {
      const after = pairs.filter(([, dependent]) => dependent === id).map(([before]) => `«${title(before)}»`);
      return `<li>${esc(sentence(`${title(id)}: ${lowerFirst(solution(id).text)}`))}${after.length ? esc(` После: ${after.join(", ")}.`) : ""}</li>`;
    }).join("")}</ul>`;
  }).join("");
  pages.push(section(`${next()} / РЕЗУЛЬТАТ АУДИТА`, titles.plan!, stageHtml + `<div class="principle"><p><strong>Контрольный принцип:</strong> ${esc(writer?.principle ?? texts.plan_fallback)}</p></div>`));

  // 8. Expected business effect: rows with the visitor's own numbers; otherwise what to measure; nothing without the writer.
  const effect = writer?.effect;
  if (effect && (effect.rows.length || effect.measure.length)) {
    const horizon = effect.rows.some(row => row.horizon);
    pages.push(section(`${next()} / РЕЗУЛЬТАТ АУДИТА`, titles.effect!, effect.rows.length
      ? `<p>${esc(texts.effect_intro)}</p>` + table(["Метрика", "Сейчас", "Цель", ...(horizon ? ["Горизонт"] : []), "За счёт чего"],
        effect.rows.map(row => [`<strong>${esc(row.metric)}</strong>`, esc(row.now), `<strong class="target">${esc(row.target)}</strong>`, ...(horizon ? [esc(row.horizon)] : []), esc(row.means)]), "effect")
      : `<p>${esc(texts.effect_measure_intro)}</p><ul class="dash">${effect.measure.map(item => `<li>${esc(sentence(item))}</li>`).join("")}</ul>`));
  }

  // 9. Recommended solutions: the tariffs the analysis selected, each once, with the price, unit, period and conditions of the source.
  const approvedSourceUrls = new Set(library.sources.map(source => source.url));
  const shownTariffs = new Set<string>(), sources = new Map<string, string>(), taxes = new Set<string>();
  const solutionRows: string[] = [];
  // One row per tariff without merged cells, so a problem with many tariffs continues on the next page row by row.
  let group = 0;
  for (const id of order) {
    const tariffs = result.tariffs.filter(tariff => solution(id).service_ids.includes(String(tariff.details.service_id)) && !shownTariffs.has(tariff.id));
    tariffs.forEach(tariff => shownTariffs.add(tariff.id));
    const alt = tariffs.length && group++ % 2 ? "alt" : "";
    tariffs.forEach((tariff, index) => {
      for (const url of tariff.source_urls) {
        if (!approvedSourceUrls.has(url) || new URL(url).protocol !== "https:") throw new ReportFailure("REPORT_UNVERIFIED_SOURCE", false);
        const checked = typeof tariff.details.source_checked_on === "string" ? ` (проверено ${tariff.details.source_checked_on.split("-").reverse().join(".")})` : "";
        sources.set(url, `<a href="${esc(url)}">${esc(library.sources.find(source => source.url === url)?.title ?? url)}</a>${esc(checked)}`);
      }
      // VAT is mentioned only where the page states it.
      const tax = object(tariff.details.tax);
      if (typeof tax?.source_text === "string" && tax.status === "source_says_excluded") taxes.add(sentence(tax.source_text));
      const conditions = strings(tariff.details.conditions);
      const row = `<td><strong>${esc(tariff.title)}</strong><br><span class="muted">${esc(serviceName(String(tariff.details.service_id)))}</span></td><td><strong>${esc(tariffPrice(tariff.details))}</strong>${conditions.length ? `<br><span class="muted">${esc(conditions.join("; "))}</span>` : ""}</td>`;
      const task = writer?.solutions.find(item => item.id === id);
      // Rows inside one problem's group keep the task and «why» columns free of separators.
      const rowClass = [alt, index < tariffs.length - 1 ? "in" : ""].filter(Boolean).join(" "), tr = rowClass ? `<tr class="${rowClass}">` : "<tr>";
      solutionRows.push(index === 0
        ? `${tr}<td><strong>${esc(task?.task ?? title(id))}</strong></td>${row}<td>${esc(task?.why ?? sentence(solution(id).text))}</td></tr>`
        : `${tr}<td></td>${row}<td></td></tr>`);
    });
  }
  if (solutionRows.length) pages.push(section(`${next()} / РЕЗУЛЬТАТ АУДИТА`, titles.solutions!,
    `<table class="solutions"><thead><tr><th>Задача бизнеса</th><th>Рекомендуемое решение</th><th>Ориентировочная стоимость</th><th>Почему</th></tr></thead><tbody>${solutionRows.join("")}</tbody></table>` +
    `<p class="footnote">${esc([texts.solutions_note, ...taxes].join(" "))} Источники: ${[...sources.values()].join("; ")}.</p>`));

  // 10. The final recommendation, the report logic and the approved caveat with the studio's contacts.
  const first = execution[0];
  const final = writer?.final ?? { constraint: order.length ? sentence(`главная проблема по Вашим ответам — «${title(order[0]!)}»`) : "", first: first ? sentence(`начать с проблемы «${title(first)}»: ${lowerFirst(ownStep(first))}`) : "",
    why: first ? why(first) : "", next: "" };
  const nextStep = esc(texts.next_step).replace(esc(texts.contact_url), `<a href="${esc(texts.contact_url)}">${esc(texts.contact_url)}</a>`);
  pages.push(section(`${next()} / РЕЗУЛЬТАТ АУДИТА`, titles.final!,
    (final.constraint ? `<div class="callout"><p><strong>Главное ограничение роста сейчас:</strong> ${esc(final.constraint)}</p></div>` : "") +
    (final.first ? `<p class="lead-in"><strong>Что делать первым:</strong> ${esc(final.first)}</p>` : "") +
    (final.why ? `<p class="lead-in"><strong>Почему:</strong> ${esc(final.why)}</p>` : "") +
    (final.next ? `<div class="callout"><p><strong>Следующий шаг:</strong> ${esc(final.next)}</p></div>` : "") +
    `<p class="lead-in"><strong>Логика отчёта:</strong> ${esc(texts.report_logic)}</p><div class="caveat"><p>${nextStep}</p></div>`));

  const footerCompany = cssString(told("context.company_name") || website || "Предварительный аудит");
  const decor = "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="110" height="64" viewBox="0 0 110 64"><path d="M14 0h34L34 64H0z M62 0h34L82 64H48z" fill="#FCF0F1"/></svg>');
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'"><title>Результат аудита. Предварительные рекомендации</title><style>
@font-face{font-family:AuditUbuntu;src:url(data:font/woff2;base64,${regularFont}) format('woff2');font-weight:400;font-style:normal;font-display:block}
@font-face{font-family:AuditUbuntu;src:url(data:font/woff2;base64,${boldFont}) format('woff2');font-weight:700;font-style:normal;font-display:block}
@page{size:594.96pt 841.92pt;margin:72pt 44pt 65pt 44pt;
@top-left{content:"Pixel Plus";width:50%;font:700 10pt AuditUbuntu,sans-serif;color:#BF0711;vertical-align:bottom;text-align:left;padding-bottom:9pt;margin-bottom:14pt;border-bottom:.75pt solid #E3E3E7}
@top-right{content:"Предварительные рекомендации";width:50%;font:400 7.5pt AuditUbuntu,sans-serif;color:#686870;vertical-align:bottom;text-align:right;padding-bottom:10pt;margin-bottom:14pt;border-bottom:.75pt solid #E3E3E7}
@bottom-left{content:"pixelplus.ru";width:30%;font:400 7.5pt AuditUbuntu,sans-serif;color:#686870;vertical-align:top;text-align:left;padding-top:10pt;margin-top:20pt;border-top:.75pt solid #E3E3E7}
@bottom-center{content:${footerCompany};width:40%;font:400 7.5pt AuditUbuntu,sans-serif;color:#686870;vertical-align:top;text-align:center;padding-top:10pt;margin-top:20pt;border-top:.75pt solid #E3E3E7}
@bottom-right{content:counter(page,decimal-leading-zero) " / " counter(pages,decimal-leading-zero);width:30%;font:700 7.5pt AuditUbuntu,sans-serif;color:#686870;vertical-align:top;text-align:right;padding-top:10pt;margin-top:20pt;border-top:.75pt solid #E3E3E7;background:url("${decor}") no-repeat right 18pt bottom 0/110pt 64pt}}
@page :right{@right-top{content:"";background:linear-gradient(#BF0711,#BF0711) no-repeat right 0 top 39pt/5pt 64pt}}
@page:first{margin:0;@top-left{content:none;border:0}@top-right{content:none;border:0}@bottom-left{content:none;border:0}@bottom-center{content:none;border:0}@bottom-right{content:none;border:0;background:none}}
*{box-sizing:border-box}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}body{font-family:AuditUbuntu,sans-serif;color:#25252B;font-size:10pt;line-height:14.4pt;margin:0}
.report-cover{width:594.96pt;height:841.92pt;overflow:hidden;break-after:page}.report-cover img{display:block;width:100%;height:100%}
.page{break-before:page}
.label{margin:0 0 0;break-after:avoid;font-size:8pt;line-height:10pt;font-weight:700;color:#BF0711;text-transform:uppercase;letter-spacing:.02em}
h1{font-size:24pt;line-height:29pt;margin:22pt 0 18pt;break-after:avoid}h1.problem-title{font-size:21pt;line-height:26pt}
h2{font-size:14pt;line-height:18pt;margin:22pt 0 10pt;break-after:avoid}h3{font-size:10pt;line-height:14pt;margin:0;color:#BF0711;break-after:avoid}
p{margin:0 0 9pt;orphans:3;widows:3;overflow-wrap:anywhere}ol,ul{margin:0 0 9pt;padding-left:16pt}li{margin:0 0 3pt;overflow-wrap:anywhere}a{color:#BF0711;text-decoration:underline;overflow-wrap:anywhere}
.who{background:#F5F5F7;padding:11pt 12pt;margin:0 0 9pt}.who p{margin:0;font-weight:700;font-size:9.5pt}.meta{color:#686870;font-size:9pt;line-height:12pt;margin:0 0 4pt}.lead{margin-top:14pt}
table{width:100%;border-collapse:collapse;margin:12pt 0 14pt;font-size:9pt;line-height:12.6pt}thead{display:table-header-group}
th{background:#BF0711;color:#fff;font-weight:700;font-size:8.6pt;text-align:left;vertical-align:middle;padding:10pt 8pt}td{padding:8pt;vertical-align:top;border-bottom:.75pt solid #E3E3E7;overflow-wrap:anywhere}
tbody tr:nth-child(even) td{background:#F5F5F7}tr{break-inside:avoid}table.solutions tbody tr td{background:#fff}table.solutions tbody tr.alt td{background:#F5F5F7}table.solutions tr.in td:first-child,table.solutions tr.in td:last-child{border-bottom-color:transparent}
.top td{padding:12pt 8pt}.top td:first-child{width:78pt}.badge{width:36pt;height:36pt;border-radius:5pt;font-size:20pt;line-height:34pt;font-weight:700;text-align:center;background:#fff;border:1pt solid #E3E3E7;color:#25252B}.badge.low{color:#686870}
.badge.critical{background:#BF0711;border-color:#BF0711;color:#fff}.badge.high{background:#FCF0F1;border-color:#FCF0F1;color:#BF0711}.badge-label{margin-top:6pt;font-size:8.3pt;line-height:10pt;font-weight:700;color:#25252B}.badge-label.critical{color:#BF0711}.badge-label.low{color:#686870}
.facts td:first-child{width:150pt}.checked td:first-child{width:24pt;font-weight:700}.map td:nth-child(2){width:62pt}.map td:nth-child(3){width:70pt}
.score{display:block;font-weight:700}.bar{display:block;width:38pt;height:3pt;margin-top:4pt;border-radius:2pt;background:#E3E3E7;overflow:hidden}.bar i{display:block;height:100%;background:#BF0711}
${Array.from({ length: 10 }, (_, index) => `.bar i.s${index + 1}{width:${(index + 1) * 10}%}`).join("")}
.callout{background:#FCF0F1;border-left:3pt solid #BF0711;padding:12pt 14pt;margin:12pt 0 14pt;break-inside:avoid}.callout p{margin:0}
.note-box{background:#FCF0F1;padding:11pt 12pt;margin-top:12pt}
.priority-box{background:#FCF0F1;border-radius:3pt;padding:11pt 12pt;margin:0 0 14pt;break-inside:avoid}.priority-box p{margin:0}.priority-box p+p{margin-top:5pt}
.field{margin:0 0 9pt}.field p,.field ol{margin:2pt 0 0}
.scores td:nth-child(n+3){white-space:nowrap}.level{font-weight:700}.level.critical{color:#BF0711}
.task{margin:0 0 9pt}
.stage{background:#FCF0F1;padding:9pt 12pt;margin:12pt 0 8pt;break-after:avoid}.stage p{margin:0;font-weight:700;font-size:9pt}
ul.dash{list-style:none;padding-left:0}ul.dash li{margin:0 0 6pt}ul.dash li::before{content:"- "}
.principle{background:#F5F5F7;padding:12pt 14pt;margin-top:14pt;break-inside:avoid}.principle p{margin:0;font-size:9pt;line-height:13pt}
.target{color:#BF0711}.muted{color:#686870;font-size:8.5pt;line-height:11.5pt}.footnote{font-style:italic;font-size:9pt;line-height:13pt;color:#25252B}
.lead-in{margin:12pt 0}.caveat{background:#F5F5F7;padding:12pt 14pt;margin-top:18pt;break-inside:avoid}.caveat p{margin:0;font-size:8.5pt;line-height:12pt;font-weight:700;color:#686870}
</style></head><body><div class="report-cover"><img src="data:image/png;base64,${coverPngBase64}" alt=""></div><main>${pages.join("")}</main></body></html>`;
  const content = { title: "Результат аудита. Предварительные рекомендации", templateVersion: TEMPLATE_VERSION, html, generatedAt: snapshot.created_at };
  if (new TextEncoder().encode(JSON.stringify(content)).byteLength > maxBytes) throw new ReportFailure("REPORT_CONTENT_TOO_LARGE", false);
  return content;
}

export function readReportContent(value: Json | null): ReportContent {
  if (!value || Array.isArray(value) || typeof value !== "object" || typeof value.html !== "string" || typeof value.title !== "string" || typeof value.templateVersion !== "string" || typeof value.generatedAt !== "number") throw new ReportFailure("REPORT_CONTENT_MISSING", false);
  return value as ReportContent;
}
