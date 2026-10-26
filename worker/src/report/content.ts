import type { AuditFact, AuditResult, AuditSnapshot, Json } from "../audit/contracts.ts";
import type { AuditLibrary } from "../audit/library.ts";
import { coverPngBase64 } from "./cover-image.ts";
import { regularFont, boldFont } from "./fonts.ts";
import { ReportFailure } from "./pdf.ts";

export const TEMPLATE_VERSION = "1.2.0";
export type ReportContent = { title: string; templateVersion: string; html: string; generatedAt: number };
// The report states only what the visitor told: no «unknown», «not stated» or «needs clarification» lines.
const fieldLabels: Record<string, string> = { description: "описание", object: "объект", observation: "что происходит", period: "период", context: "обстоятельства",
  task: "задача", current_way: "как сейчас", constraint: "ограничение", level: "насколько важно" };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
}
/** What the visitor said, as text; an empty string when nothing usable was said. */
function textValue(value: Json): string {
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
function list(values: string[]): string { return values.length ? `<ul>${values.map(value => `<li>${escapeHtml(value)}</li>`).join("")}</ul>` : ""; }
function section(title: string, body: string): string { return body ? `<section><h2>${escapeHtml(title)}</h2>${body}</section>` : ""; }
function object(value: Json | undefined): Record<string, Json> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null; }
function strings(value: Json | undefined): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function tariffPrice(details: Record<string, Json>): string {
  const price = object(details.price);
  if (!price || price.type === "individual") return "";
  const money = (value: Json | undefined) => typeof value === "number" && Number.isFinite(value) ? `${new Intl.NumberFormat("ru-RU").format(value)} ${price.currency === "RUB" ? "₽" : String(price.currency ?? "")}` : null;
  const amount = money(price.amount), minimum = money(price.min), maximum = money(price.max);
  const value = price.type === "fixed" ? amount : price.type === "from" && amount ? `от ${amount}` : price.type === "range" && minimum && maximum ? `${minimum}–${maximum}` : null;
  if (!value) return "";
  const units: Record<string, string> = { project: "за проект", month: "в месяц", audit: "за аудит", hour: "за час", database: "за базу", slide: "за слайд", prepaid_package: "за пакет" };
  // An unstated period or unit is simply left out: the price itself is always shown.
  const periods: Record<string, string> = { one_time: "разово", monthly: "ежемесячно", monthly_in_arrears: "постоплата в конце месяца", not_monthly: "не ежемесячно" };
  const unit = units[String(price.unit)] ?? "";
  const period = price.billing_period === "monthly" && price.unit === "month" ? "" : periods[String(price.billing_period)] ?? "";
  return [value, unit, period].filter(Boolean).join(" · ");
}

const historyFields: [string, string][] = [["work", "что делали"], ["period_and_duration", "когда и как долго"], ["goal", "какого результата ждали"], ["executor_and_resources", "исполнитель и ресурсы"],
  ["outcome", "что получилось"], ["measurement", "как оценивали"], ["current_status", "сейчас"], ["stop_reason", "причина остановки"]];
/** A short account of earlier work in the visitor's words: reported fields only, no bookkeeping IDs. */
function historyText(history: Record<string, Json>): string {
  if (history.attempts_status === "not_tried") return "ранее не предпринимались";
  const attempts = Array.isArray(history.attempts) ? history.attempts.map(object).filter(item => item !== null) : [];
  return attempts.map(attempt => historyFields.map(([key, label]) => [label, textValue(attempt[key] ?? null)] as const).filter(([, text]) => text).map(([label, text]) => `${label} — ${text}`).join("; ")).filter(Boolean).join(" / ");
}

/** Produces fixed, escaped HTML before any provider call. Subsequent attempts use this exact HTML. */
export function buildReportContent(result: AuditResult, snapshot: AuditSnapshot, library: AuditLibrary, maxBytes = 1_000_000): ReportContent {
  if (result.template_version !== TEMPLATE_VERSION || result.library_version !== snapshot.library_version || result.snapshot_id !== snapshot.id) {
    throw new ReportFailure("REPORT_VERSION_MISMATCH", false);
  }
  const factLabel = (id: string) => library.facts.find(fact => fact.id === id)?.label ?? id;
  const factValue = (id: string, value: Json) => library.facts.find(item => item.id === id)?.values?.find(option => option.id === value)?.label ?? textValue(value);
  // Only told facts are listed; an empty value drops the line.
  const told = (fact: AuditFact) => ["known", "other"].includes(fact.state) && fact.confirmation !== "disputed";
  const factText = (fact: AuditFact) => {
    const displayed = fact.fact_id.endsWith(".history") && object(fact.value) ? historyText(object(fact.value)!) : factValue(fact.fact_id, fact.value);
    return displayed ? `${factLabel(fact.fact_id)}: ${displayed}` : "";
  };
  const supported = result.situations.filter(situation => situation.evidence_status === "supported");
  const actionText = (id: string) => result.actions.find(item => item.id === id)?.text ?? id;
  const approvedSourceUrls = new Set(library.sources.map(source => source.url));
  const body = [
    section("Исходная задача", textValue(result.goal) ? `<p>${escapeHtml(textValue(result.goal))}</p>` : ""),
    section("Профиль и существенные сведения", `<p>Сведения получены в ходе опроса посетителя. Независимая проверка сайта, рекламных кабинетов и CRM не выполнялась.</p>${list(Object.entries(result.profile).map(([key, value]) => textValue(value) ? `${factLabel(key)}: ${textValue(value)}` : "").filter(Boolean))}${list(result.facts.filter(fact => !fact.fact_id.startsWith("context.") && !fact.fact_id.endsWith(".history") && told(fact)).map(factText).filter(Boolean))}`),
    // Only confirmed situations: a topic without enough information stays out of the report.
    section("Значимые ситуации", supported.length ? `<p>${escapeHtml(result.summary)}</p>` + supported.map(situation => {
      const evidence = snapshot.answers.filter(answer => situation.evidence_answer_ids.includes(answer.id) && ["known", "other"].includes(answer.state)).map(answer => {
        const text = factValue(answer.fact_id, answer.value);
        return text ? `${factLabel(answer.fact_id)}: ${text}` : "";
      }).filter(Boolean);
      return `<article><h3>${escapeHtml(situation.title)}</h3>${list(evidence)}${list(situation.limitations)}</article>`;
    }).join("") : ""),
    section("Ранее выполненные работы", list(result.previous_work.filter(told).map(factText).filter(Boolean))),
    section("Решения и необходимые проверки", result.solutions.map(solution => `<article><h3>${escapeHtml(solution.title)}</h3>${solution.prior_attempts ? `<p>${escapeHtml(solution.prior_attempts.intro)}</p>` : ""}<p>${escapeHtml(solution.text)}</p>${list(solution.limitations)}</article>`).join("")),
    section("Порядок действий", result.actions.length ? `<ol>${result.actions.map(action => `<li>${escapeHtml(action.text)}${action.after.length ? `<p>После: ${escapeHtml(action.after.map(actionText).join("; "))}</p>` : ""}${action.parallel_with.length ? `<p>Можно параллельно: ${escapeHtml(action.parallel_with.map(actionText).join("; "))}</p>` : ""}</li>`).join("")}</ol>` : ""),
    section("Предварительные тарифные варианты", result.tariffs.length ? `<p>Варианты относятся к выявленным направлениям работ. Это не индивидуальная смета: пакет, объём и итоговая стоимость определяются при подготовке коммерческого предложения.</p>` + result.tariffs.map(tariff => {
      for (const url of tariff.source_urls) if (!approvedSourceUrls.has(url) || new URL(url).protocol !== "https:") throw new ReportFailure("REPORT_UNVERIFIED_SOURCE", false);
      const details = tariff.details;
      const service = library.services.find(item => item.id === details.service_id);
      const tax = object(details.tax);
      const checked = typeof details.source_checked_on === "string" ? `Источник проверен: ${escapeHtml(details.source_checked_on)}. ` : "";
      const group = (name: string, values: string[]) => values.length ? `<h4>${escapeHtml(name)}</h4>${list(values)}` : "";
      const price = tariffPrice(details);
      // VAT is mentioned only where the page states it.
      return `<article class="tariff-option"><h3>${escapeHtml(tariff.title)}</h3>${price ? `<p class="tariff-price">${escapeHtml(price)}</p>` : ""}<p>${escapeHtml(service?.name ?? String(details.service_id ?? "Услуга"))}. Подходящий пакет и объём подбираются при подготовке предложения.</p>${group("Что входит", strings(details.included))}${group("Условия", strings(details.conditions))}${group("Что не входит", strings(details.excluded))}${typeof tax?.source_text === "string" && tax.status === "source_says_excluded" ? `<p>${escapeHtml(tax.source_text)}.</p>` : ""}<p>${checked}${tariff.source_urls.map(url => `<a href="${escapeHtml(url)}">${escapeHtml(library.sources.find(source => source.url === url)?.title ?? url)}</a>`).join("; ")}</p></article>`;
    }).join("") : ""),
  ].join("");
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'"><title>ПРЕДВАРИТЕЛЬНЫЙ АУДИТ</title><style>
@font-face{font-family:AuditUbuntu;src:url(data:font/woff2;base64,${regularFont}) format('woff2');font-weight:400;font-style:normal;font-display:block}
@font-face{font-family:AuditUbuntu;src:url(data:font/woff2;base64,${boldFont}) format('woff2');font-weight:700;font-style:normal;font-display:block}
@page{size:A4;margin:18mm 17mm}@page:first{margin:0}*{box-sizing:border-box}body{font-family:AuditUbuntu,sans-serif;color:#222;font-size:10.5pt;line-height:1.5;margin:0}.report-cover{width:210mm;height:297mm;overflow:hidden;break-after:page;page-break-after:always}.report-cover img{display:block;width:100%;height:100%}header{border-bottom:3px solid #d92735;padding-bottom:16pt;margin-bottom:20pt}h1{font-size:23pt;line-height:1.15;margin:0 0 12pt}h2{font-size:15pt;margin:22pt 0 8pt;break-after:avoid}h3{font-size:12pt;margin:14pt 0 5pt;break-after:avoid}h4{font-size:10.5pt;margin:9pt 0 3pt;break-after:avoid}p,li{orphans:3;widows:3;overflow-wrap:anywhere}ul,ol{padding-left:18pt}li{margin:5pt 0}a{color:#ad1c29;text-decoration:underline;overflow-wrap:anywhere}.tariff-option{border-top:1px solid #ddd;margin-top:14pt;padding-top:8pt;break-inside:avoid;page-break-inside:avoid}.tariff-price{font-weight:700;color:#a61420}footer{border-top:1px solid #ccc;margin-top:22pt;padding-top:8pt;color:#555;font-size:8pt}</style></head><body><div class="report-cover"><img src="data:image/png;base64,${coverPngBase64}" alt=""></div><main><header><h1>ПРЕДВАРИТЕЛЬНЫЙ АУДИТ</h1><p>Pixel Plus · ${escapeHtml(new Date(snapshot.created_at).toISOString().slice(0, 10))}</p></header>${body}<footer>Предварительное заключение по предоставленным сведениям. Библиотека ${escapeHtml(result.library_version)}; правила ${escapeHtml(result.rules_version)}; тарифы ${escapeHtml(result.tariffs_version)}; шаблон ${escapeHtml(result.template_version)}.</footer></main></body></html>`;
  const content = { title: "ПРЕДВАРИТЕЛЬНЫЙ АУДИТ", templateVersion: TEMPLATE_VERSION, html, generatedAt: snapshot.created_at };
  if (new TextEncoder().encode(JSON.stringify(content)).byteLength > maxBytes) throw new ReportFailure("REPORT_CONTENT_TOO_LARGE", false);
  return content;
}

export function readReportContent(value: Json | null): ReportContent {
  if (!value || Array.isArray(value) || typeof value !== "object" || typeof value.html !== "string" || typeof value.title !== "string" || typeof value.templateVersion !== "string" || typeof value.generatedAt !== "number") throw new ReportFailure("REPORT_CONTENT_MISSING", false);
  return value as ReportContent;
}
