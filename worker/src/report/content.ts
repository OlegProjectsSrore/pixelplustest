import type { AuditFact, AuditResult, AuditSnapshot, Json } from "../audit/contracts.ts";
import { deriveFacts } from "../audit/engine.ts";
import type { AuditLibrary } from "../audit/library.ts";
import { codePriorities, executionOrder, importanceOrder, levelCap, orderPairs, PRIORITY_RANK, problemFacts, type PriorityLevel } from "../audit/priority.ts";
import { coverPngBase64 } from "./cover-image.ts";
import { regularFont, boldFont } from "./fonts.ts";
import { ReportFailure } from "./pdf.ts";
import type { WriterOutput } from "./report-writer.ts";
import { historyText, object, strings, textValue } from "./told.ts";

export const TEMPLATE_VERSION = "1.3.0";
export type ReportContent = { title: string; templateVersion: string; html: string; generatedAt: number };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
}
function list(values: string[]): string { return values.length ? `<ul>${values.map(value => `<li>${escapeHtml(value)}</li>`).join("")}</ul>` : ""; }
function section(title: string, body: string): string { return body ? `<section><h2>${escapeHtml(title)}</h2>${body}</section>` : ""; }
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
// Client-facing names of the told facts in «О компании» and «Ваша задача и цель».
const COMPANY: [string, string][] = [["context.company_name", "Компания"], ["context.website", "Сайт"], ["context.business", "Чем занимается и кому продаёт"], ["context.audience", "Кто покупает"],
  ["context.company_size", "Размер компании"], ["context.geography", "Регионы"], ["context.model", "Модель продаж"], ["context.channels", "Откуда приходят клиенты"],
  ["context.assets", "Площадки и системы"], ["context.stage", "Стадия проекта"], ["context.scale", "Масштаб"]];
const GOAL: [string, string][] = [["context.goal", "Желаемый результат"], ["context.goal_period", "Срок"], ["context.resources", "Ресурсы на внедрение"], ["context.constraints", "Ограничения"], ["context.budget", "Бюджет"]];
const sentence = (text: string) => text ? text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? "" : ".") : "";

/** Produces fixed, escaped HTML of the eleven approved sections. written: the report writer's checked texts; null keeps the template texts and the code priority. */
export function buildReportContent(result: AuditResult, snapshot: AuditSnapshot, library: AuditLibrary, maxBytes = 1_000_000, written: WriterOutput | null = null): ReportContent {
  if (result.template_version !== TEMPLATE_VERSION || result.library_version !== snapshot.library_version || result.snapshot_id !== snapshot.id) {
    throw new ReportFailure("REPORT_VERSION_MISMATCH", false);
  }
  const titles = Object.fromEntries(library.report.sections.map(item => [item.id, item.title]));
  const texts = library.report.texts, levelNames = library.report.priority.levels;
  const { facts } = deriveFacts(snapshot.answers, library);
  const told = (id: string) => { const fact: AuditFact | undefined = facts[id]; return fact && ["known", "other"].includes(fact.state) && fact.confirmation !== "disputed" ? textValue(fact.value) : ""; };
  const website = facts["context.website"]?.state === "not_applicable" ? texts.no_website : told("context.website");
  const value = (id: string) => id === "context.website" ? website : told(id);
  const lines = (fields: [string, string][]) => fields.map(([id, label]) => value(id) ? `${label}: ${value(id)}` : "").filter(Boolean);

  // Priority: the writer's levels when they keep the approved limits, otherwise the code rule.
  const ids = result.solutions.map(solution => solution.id);
  const problems = problemFacts(ids, facts, library), pairs = orderPairs(ids, library), code = codePriorities(problems, pairs, library);
  const writerLevels = written ? new Map(written.problems.map(problem => [problem.id, problem.priority])) : null;
  const writerValid = writerLevels !== null && problems.every(problem => writerLevels.has(problem.id) && PRIORITY_RANK[writerLevels.get(problem.id)!] <= PRIORITY_RANK[levelCap(problem)]) &&
    pairs.every(([before, after]) => PRIORITY_RANK[writerLevels.get(before)!] >= Math.min(PRIORITY_RANK[writerLevels.get(after)!], PRIORITY_RANK[levelCap(problems.find(problem => problem.id === before)!)]));
  const writer = writerValid ? written : null;
  const levels = new Map<string, PriorityLevel>(ids.map(id => [id, writer ? writerLevels!.get(id)! : code.get(id)!.level]));
  const why = (id: string) => writer ? writer.problems.find(problem => problem.id === id)!.why : sentence(code.get(id)!.reasons.join("; "));
  const order = importanceOrder(problems, levels), stages = executionOrder(order, pairs);
  const title = (id: string) => problems.find(problem => problem.id === id)!.title;
  const solution = (id: string) => result.solutions.find(item => item.id === id)!;
  const actionText = (actionId: string) => result.actions.find(item => item.id === actionId)?.text ?? actionId;
  // Shared prior-attempt steps of a topic are listed once, under its first problem.
  const shownPrior = new Set<string>();
  const stepsOf = (id: string) => solution(id).action_ids.filter(actionId => {
    if (actionId.startsWith(`${id}:`)) return true;
    if (shownPrior.has(actionId)) return false;
    shownPrior.add(actionId); return true;
  });
  const firstStage = stages[0];

  const today = new Date(snapshot.created_at).toISOString().slice(0, 10);
  const company = [value("context.company_name"), value("context.website") && `сайт: ${value("context.website")}`].filter(Boolean).join(" · ");
  const preparedFor = [told("context.name"), told("context.position")].filter(Boolean).join(", ");
  const header = `<header><h1>ПРЕДВАРИТЕЛЬНЫЙ АУДИТ</h1>${company ? `<p class="company">${escapeHtml(company)}</p>` : ""}${preparedFor ? `<p>Подготовлено для: ${escapeHtml(preparedFor)}</p>` : ""}<p>Pixel Plus · ${escapeHtml(today)}</p></header>`;
  const approvedSourceUrls = new Set(library.sources.map(source => source.url));
  const shownTariffs = new Set<string>();
  const tariffCard = (tariff: AuditResult["tariffs"][number]) => {
    for (const url of tariff.source_urls) if (!approvedSourceUrls.has(url) || new URL(url).protocol !== "https:") throw new ReportFailure("REPORT_UNVERIFIED_SOURCE", false);
    const details = tariff.details;
    const service = library.services.find(item => item.id === details.service_id);
    const tax = object(details.tax);
    const checked = typeof details.source_checked_on === "string" ? `Источник проверен: ${escapeHtml(details.source_checked_on)}. ` : "";
    const group = (name: string, values: string[]) => values.length ? `<h5>${escapeHtml(name)}</h5>${list(values)}` : "";
    const price = tariffPrice(details);
    // VAT is mentioned only where the page states it.
    return `<article class="tariff-option"><h4>${escapeHtml(tariff.title)}</h4>${price ? `<p class="tariff-price">${escapeHtml(price)}</p>` : ""}<p>${escapeHtml(service?.name ?? String(details.service_id ?? "Услуга"))}. Подходящий пакет и объём подбираются при подготовке предложения.</p>${group("Что входит", strings(details.included))}${group("Условия", strings(details.conditions))}${group("Что не входит", strings(details.excluded))}${typeof tax?.source_text === "string" && tax.status === "source_says_excluded" ? `<p>${escapeHtml(tax.source_text)}.</p>` : ""}<p>${checked}${tariff.source_urls.map(url => `<a href="${escapeHtml(url)}">${escapeHtml(library.sources.find(source => source.url === url)?.title ?? url)}</a>`).join("; ")}</p></article>`;
  };
  // Earlier work only for the topics of the problems in this report.
  const histories = library.domains.filter(domain => problems.some(problem => problem.domain === domain.id)).map(domain => {
    const fact = facts[`${domain.id}.history`], history = fact && ["known", "other"].includes(fact.state) && fact.confirmation !== "disputed" ? object(fact.value) : null;
    const text = history ? historyText(history) : "";
    return text ? `${domain.title}: ${text}` : "";
  }).filter(Boolean);
  // A cause outside digital services the visitor named is mentioned once and never becomes a recommendation.
  const externalCause = told("context.external_cause").replace(/[.!?]+$/, "");
  const external = texts.external_cause && externalCause ? texts.external_cause.replace("{{external_cause}}", externalCause) : "";
  // A problem found while checking another possible cause of a complaint in this report says so.
  const crossFound = (id: string) => {
    if (!texts.cross_found || !(snapshot.state.cross_checked ?? []).includes(id)) return "";
    const complaint = library.relationships.find(relation => relation.relation === "alternative_cause" && relation.b === id && ids.includes(relation.a));
    return complaint ? texts.cross_found.replace("{{complaint}}", title(complaint.a)) : "";
  };
  const nextStep = escapeHtml(texts.next_step).replace(escapeHtml(texts.contact_url), `<a href="${escapeHtml(texts.contact_url)}">${escapeHtml(texts.contact_url)}</a>`);

  const body = [
    section(titles.summary!, ids.length ? `<p>${escapeHtml(writer?.summary ?? texts.summary_fallback)}</p>${list(order.slice(0, 3).map(id => `${title(id)} — ${levelNames[levels.get(id)!]}`))}${firstStage ? `<p><strong>С чего начать:</strong> ${escapeHtml(`«${title(firstStage)}»: ${actionText(solution(firstStage).action_ids[0] ?? "")}`)}</p>` : ""}` : ""),
    section(titles.company!, list([...lines(COMPANY), ...(preparedFor ? [`Контактное лицо: ${preparedFor}`] : [])])),
    section(titles.goal!, list(lines(GOAL)) + (external ? `<p>${escapeHtml(external)}</p>` : "")),
    section(titles.problems!, order.map(id => {
      const domain = problems.find(problem => problem.id === id)!.domain, impact = object(facts[`${domain}.impact`]?.value ?? null);
      const fallback = [told(`${id}.details`) && `Что происходит: ${told(`${id}.details`)}.`, told(`${domain}.impact`) && impact && textValue(impact.description ?? null) ? `Последствия: ${textValue(impact.description ?? null)}.` : ""].filter(Boolean).join(" ");
      const situation = writer?.problems.find(problem => problem.id === id)?.situation ?? fallback;
      const found = crossFound(id);
      return `<article><h3>${escapeHtml(title(id))}</h3>${situation ? `<p>${escapeHtml(situation)}</p>` : ""}${found ? `<p>${escapeHtml(found)}</p>` : ""}</article>`;
    }).join("")),
    section(titles.priorities!, order.length ? `<ol>${order.map(id => `<li><strong>${escapeHtml(title(id))}</strong> — ${escapeHtml(levelNames[levels.get(id)!])}. ${escapeHtml(why(id))}</li>`).join("")}</ol>` : ""),
    section(titles.history!, list(histories)),
    section(titles.recommendations!, order.map(id => {
      const item = solution(id);
      return `<article><h3>${escapeHtml(title(id))}</h3>${item.prior_attempts ? `<p>${escapeHtml(item.prior_attempts.intro)}</p>` : ""}<p><strong>Результат работ:</strong> ${escapeHtml(item.text)}</p><ol>${stepsOf(id).map(actionId => `<li>${escapeHtml(actionText(actionId))}</li>`).join("")}</ol></article>`;
    }).join("")),
    section(titles.plan!, stages.length ? `<p>${escapeHtml(writer?.plan_intro ?? texts.plan_fallback)}</p><ol>${stages.map(id => {
      const after = pairs.filter(([, dependent]) => dependent === id).map(([before]) => `«${title(before)}»`);
      return `<li><strong>${escapeHtml(title(id))}</strong>${after.length ? escapeHtml(` — после: ${after.join(", ")}`) : ""}</li>`;
    }).join("")}</ol>` : ""),
    section(titles.cost!, result.tariffs.length ? `<p>Варианты относятся к выявленным направлениям работ. Это не индивидуальная смета: пакет, объём и итоговая стоимость определяются при подготовке коммерческого предложения.</p>` + order.map(id => {
      const cards = result.tariffs.filter(tariff => solution(id).service_ids.includes(String(tariff.details.service_id)) && !shownTariffs.has(tariff.id)).map(tariff => { shownTariffs.add(tariff.id); return tariffCard(tariff); });
      return cards.length ? `<article><h3>${escapeHtml(`Для проблемы «${title(id)}»`)}</h3>${cards.join("")}</article>` : "";
    }).join("") : ""),
    section(titles.next_step!, `<p>${nextStep}</p>`),
  ].join("");
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'"><title>ПРЕДВАРИТЕЛЬНЫЙ АУДИТ</title><style>
@font-face{font-family:AuditUbuntu;src:url(data:font/woff2;base64,${regularFont}) format('woff2');font-weight:400;font-style:normal;font-display:block}
@font-face{font-family:AuditUbuntu;src:url(data:font/woff2;base64,${boldFont}) format('woff2');font-weight:700;font-style:normal;font-display:block}
@page{size:A4;margin:18mm 17mm}@page:first{margin:0}*{box-sizing:border-box}body{font-family:AuditUbuntu,sans-serif;color:#222;font-size:10.5pt;line-height:1.5;margin:0}.report-cover{width:210mm;height:297mm;overflow:hidden;break-after:page;page-break-after:always}.report-cover img{display:block;width:100%;height:100%}header{border-bottom:3px solid #d92735;padding-bottom:16pt;margin-bottom:20pt}header p{margin:3pt 0}header .company{font-size:13pt;font-weight:700}h1{font-size:23pt;line-height:1.15;margin:0 0 12pt}h2{font-size:15pt;margin:22pt 0 8pt;break-after:avoid}h3{font-size:12pt;margin:14pt 0 5pt;break-after:avoid}h4{font-size:11pt;margin:10pt 0 3pt;break-after:avoid}h5{font-size:10.5pt;margin:8pt 0 3pt;break-after:avoid}p,li{orphans:3;widows:3;overflow-wrap:anywhere}ul,ol{padding-left:18pt}li{margin:5pt 0}a{color:#ad1c29;text-decoration:underline;overflow-wrap:anywhere}.tariff-option{border-top:1px solid #ddd;margin-top:12pt;padding-top:8pt;break-inside:avoid;page-break-inside:avoid}.tariff-price{font-weight:700;color:#a61420}footer{border-top:1px solid #ccc;margin-top:22pt;padding-top:8pt;color:#555;font-size:8pt}</style></head><body><div class="report-cover"><img src="data:image/png;base64,${coverPngBase64}" alt=""></div><main>${header}${body}<footer>Библиотека ${escapeHtml(result.library_version)}; правила ${escapeHtml(result.rules_version)}; тарифы ${escapeHtml(result.tariffs_version)}; шаблон ${escapeHtml(result.template_version)}.</footer></main></body></html>`;
  const content = { title: "ПРЕДВАРИТЕЛЬНЫЙ АУДИТ", templateVersion: TEMPLATE_VERSION, html, generatedAt: snapshot.created_at };
  if (new TextEncoder().encode(JSON.stringify(content)).byteLength > maxBytes) throw new ReportFailure("REPORT_CONTENT_TOO_LARGE", false);
  return content;
}

export function readReportContent(value: Json | null): ReportContent {
  if (!value || Array.isArray(value) || typeof value !== "object" || typeof value.html !== "string" || typeof value.title !== "string" || typeof value.templateVersion !== "string" || typeof value.generatedAt !== "number") throw new ReportFailure("REPORT_CONTENT_MISSING", false);
  return value as ReportContent;
}
