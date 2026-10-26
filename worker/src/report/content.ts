import type { AuditFact, AuditResult, AuditSnapshot, FactStatus, Json } from "../audit/contracts.ts";
import type { AuditLibrary } from "../audit/library.ts";
import { coverPngBase64 } from "./cover-image.ts";
import { regularFont, boldFont } from "./fonts.ts";
import { ReportFailure } from "./pdf.ts";

export const TEMPLATE_VERSION = "1.2.0";
export type ReportContent = { title: string; templateVersion: string; html: string; generatedAt: number };
const states: Record<FactStatus, string> = {
  known: "сообщено посетителем", unknown: "неизвестно", not_measured: "не измерялось", not_applicable: "не применимо",
  declined: "ответ не предоставлен", ambiguous: "требует уточнения", other: "другой ответ", not_asked: "не выяснено", conflicting: "противоречивые сведения",
};
const labels: Record<string, string> = { high: "высокая", medium: "средняя", low: "низкая", unknown: "не определена", supported: "подтверждено предоставленными сведениями", hypothesis: "гипотеза", insufficient: "недостаточно сведений" };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
}
function textValue(value: Json): string {
  if (value === null) return "не указано";
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (Array.isArray(value)) return value.map(textValue).join("; ");
  if (typeof value === "object") {
    if (typeof value.state === "string" && "value" in value && Object.keys(value).every(key => key === "state" || key === "value")) {
      return value.state === "known" || value.state === "other" ? textValue(value.value) : states[value.state as FactStatus] ?? value.state;
    }
    return Object.entries(value).map(([key, val]) => `${key === "description" ? "Описание" : key}: ${textValue(val)}`).join("; ");
  }
  return String(value);
}
function list(values: string[]): string { return values.length ? `<ul>${values.map(value => `<li>${escapeHtml(value)}</li>`).join("")}</ul>` : ""; }
function section(title: string, body: string): string { return body ? `<section><h2>${escapeHtml(title)}</h2>${body}</section>` : ""; }
function object(value: Json | undefined): Record<string, Json> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null; }
function strings(value: Json | undefined): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function tariffPrice(details: Record<string, Json>): string {
  const price = object(details.price);
  if (!price) return "Стоимость уточняется";
  if (price.type === "individual") return "Стоимость рассчитывается индивидуально";
  const money = (value: Json | undefined) => typeof value === "number" && Number.isFinite(value) ? `${new Intl.NumberFormat("ru-RU").format(value)} ${price.currency === "RUB" ? "₽" : String(price.currency ?? "")}` : null;
  const amount = money(price.amount), minimum = money(price.min), maximum = money(price.max);
  const value = price.type === "fixed" ? amount : price.type === "from" && amount ? `от ${amount}` : price.type === "range" && minimum && maximum ? `${minimum}–${maximum}` : null;
  if (!value) return "Стоимость уточняется";
  const units: Record<string, string> = { project: "за проект", month: "в месяц", audit: "за аудит", hour: "за час", database: "за базу", slide: "за слайд", prepaid_package: "за пакет" };
  // An unstated period or unit is simply left out: the price itself is always shown.
  const periods: Record<string, string> = { one_time: "разово", monthly: "ежемесячно", monthly_in_arrears: "постоплата в конце месяца", not_monthly: "не ежемесячно" };
  const unit = units[String(price.unit)] ?? "";
  const period = price.billing_period === "monthly" && price.unit === "month" ? "" : periods[String(price.billing_period)] ?? "";
  return [value, unit, period].filter(Boolean).join(" · ");
}

/** Produces fixed, escaped HTML before any provider call. Subsequent attempts use this exact HTML. */
export function buildReportContent(result: AuditResult, snapshot: AuditSnapshot, library: AuditLibrary, maxBytes = 1_000_000): ReportContent {
  if (result.template_version !== TEMPLATE_VERSION || result.library_version !== snapshot.library_version || result.snapshot_id !== snapshot.id) {
    throw new ReportFailure("REPORT_VERSION_MISMATCH", false);
  }
  const factLabel = (id: string) => library.facts.find(fact => fact.id === id)?.label ?? id;
  const factValue = (id: string, value: Json) => library.facts.find(item => item.id === id)?.values?.find(option => option.id === value)?.label ?? textValue(value);
  const factText = (fact: AuditFact) => {
    const history = object(fact.value);
    const displayed = fact.fact_id.endsWith(".history") && history?.attempts_status === "not_tried" ? "ранее не предпринимались" : factValue(fact.fact_id, fact.value);
    return `${factLabel(fact.fact_id)}: ${displayed} (${states[fact.state]}${fact.confirmation === "disputed" ? "; оспаривается" : ""})`;
  };
  const approvedSourceUrls = new Set(library.sources.map(source => source.url));
  const body = [
    section("Исходная задача", `<p>${escapeHtml(textValue(result.goal))}</p>`),
    section("Профиль и существенные сведения", `<p>Сведения получены в ходе опроса посетителя. Независимая проверка сайта, рекламных кабинетов и CRM не выполнялась.</p>${list(Object.entries(result.profile).map(([key, value]) => `${factLabel(key)}: ${textValue(value)}`))}${list(result.facts.filter(fact => !fact.fact_id.startsWith("context.")).map(factText))}`),
    section("Значимые ситуации", `<p>${escapeHtml(result.summary)}</p>` + result.situations.map(situation => {
      const evidence = snapshot.answers.filter(answer => situation.evidence_answer_ids.includes(answer.id)).map(answer => `${factLabel(answer.fact_id)}: ${factValue(answer.fact_id, answer.value)}`);
      return `<article><h3>${escapeHtml(situation.title)}</h3><p>${escapeHtml(labels[situation.evidence_status] ?? situation.evidence_status)}. Значимость: ${escapeHtml(labels[situation.significance.level] ?? situation.significance.level)}.</p><p>${escapeHtml(situation.significance.reason)}</p>${list(evidence)}${list(situation.limitations)}</article>`;
    }).join("")),
    section("Ранее выполненные работы", list(result.previous_work.map(factText))),
    section("Решения и необходимые проверки", result.solutions.map(solution => `<article><h3>${escapeHtml(solution.title)}</h3><p>${escapeHtml(solution.text)}</p>${list(solution.limitations)}</article>`).join("")),
    section("Порядок действий", result.actions.length ? `<ol>${result.actions.map(action => `<li>${escapeHtml(action.text)}${action.deferred_reason ? `<p>Отложено: ${escapeHtml(action.deferred_reason)}</p>` : ""}${action.after.length ? `<p>После: ${escapeHtml(action.after.map(id => result.actions.find(item => item.id === id)?.text ?? id).join("; "))}</p>` : ""}${action.parallel_with.length ? `<p>Можно параллельно: ${escapeHtml(action.parallel_with.map(id => result.actions.find(item => item.id === id)?.text ?? id).join("; "))}</p>` : ""}</li>`).join("")}</ol>` : ""),
    section("Предварительные тарифные варианты", result.tariffs.length ? `<p>Варианты относятся к выявленным направлениям работ. Конкретный пакет, объём и итоговая стоимость требуют уточнения; это не индивидуальная смета.</p>` + result.tariffs.map(tariff => {
      for (const url of tariff.source_urls) if (!approvedSourceUrls.has(url) || new URL(url).protocol !== "https:") throw new ReportFailure("REPORT_UNVERIFIED_SOURCE", false);
      const details = tariff.details;
      const service = library.services.find(item => item.id === details.service_id);
      const tax = object(details.tax);
      const checked = typeof details.source_checked_on === "string" ? details.source_checked_on : "не указана";
      const group = (name: string, values: string[]) => values.length ? `<h4>${escapeHtml(name)}</h4>${list(values)}` : "";
      return `<article class="tariff-option"><h3>${escapeHtml(tariff.title)}</h3><p class="tariff-price">${escapeHtml(tariffPrice(details))}</p><p>${escapeHtml(service?.name ?? String(details.service_id ?? "Услуга"))}. Подходящий объём и пакет уточняются перед предложением.</p>${group("Что входит", strings(details.included))}${group("Условия", strings(details.conditions))}${group("Что не входит", strings(details.excluded))}${group("Что требует уточнения", strings(details.not_stated))}${typeof tax?.source_text === "string" ? `<p>${escapeHtml(tax.source_text)}${tax.status === "source_says_excluded" ? " (по источнику)" : ""}.</p>` : ""}<p>Источник проверен: ${escapeHtml(checked)}. ${tariff.source_urls.map(url => `<a href="${escapeHtml(url)}">${escapeHtml(library.sources.find(source => source.url === url)?.title ?? url)}</a>`).join("; ")}</p></article>`;
    }).join("") : ""),
    section("Недостающие сведения и ограничения", list([...new Set([...result.gaps.map(factLabel), ...result.contradictions.map(item => `${factLabel(item.fact_id)}: ${item.reason}`), ...result.limitations, ...snapshot.limitations])])),
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
