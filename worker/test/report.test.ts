import test from "node:test";
import assert from "node:assert/strict";
import { renderPdf, sha256, randomReadToken, ReportFailure } from "../src/report/pdf.ts";
import { buildMime, SmtpTransport } from "../src/report/smtp.ts";
import type { SmtpSocket } from "../src/report/smtp.ts";
import { buildReportContent } from "../src/report/content.ts";
import { getReportResponse } from "../src/report/download.ts";
import type { ReportRecord } from "../src/storage/types.ts";
import { initialAuditState } from "../src/audit/contracts.ts";
import type { AuditAnswer, AuditSnapshot } from "../src/audit/contracts.ts";
import { analyzeAudit } from "../src/audit/engine.ts";
import { library } from "../src/audit/library.ts";

const pdfBytes = new TextEncoder().encode("%PDF-1.7\nfixture").buffer as ArrayBuffer;
const date = Date.parse("2026-10-22T12:00:00Z");
const smtpConfig = { hostname: "smtp.example.com", username: "audit@example.com", password: "secret", from: "audit@example.com", clientHostname: "audit.example.com", timeoutMs: 1000 };
const mail = { to: "person@example.com", reportId: "report", pdf: pdfBytes, downloadUrl: `https://audit.example.com/api/report/${"a".repeat(64)}`, now: date };

test("PDF rendering rejects provider errors, incorrect MIME, invalid PDF and oversized streams", async () => {
  assert.deepEqual(await renderPdf({ quickAction: async () => new Response(pdfBytes, { headers: { "Content-Type": "application/pdf" } }) }, "<html></html>"), pdfBytes);
  for (const [response, code] of [
    [new Response("busy", { status: 429 }), "PDF_PROVIDER_BUSY"],
    [new Response("html", { headers: { "Content-Type": "text/html" } }), "PDF_INVALID_CONTENT_TYPE"],
    [new Response("invalid", { headers: { "Content-Type": "application/pdf" } }), "PDF_INVALID_SIGNATURE"],
    [new Response(pdfBytes, { headers: { "Content-Type": "application/pdf" } }), "PDF_TOO_LARGE"],
  ] as const) await assert.rejects(renderPdf({ quickAction: async () => response }, "<html></html>", code === "PDF_TOO_LARGE" ? 8 : 1024), (error: unknown) => error instanceof ReportFailure && error.code === code);
});

test("saved report HTML is reproducible, escaped and includes its fixed font resources", () => {
  const snapshot: AuditSnapshot = { id: "snap", session_id: "session", library_version: library.version, created_at: date, through_seq: 0, answers: [], state: initialAuditState(library.version, "chat", date), limitations: [] };
  const result = analyzeAudit(snapshot, library, { allowDraft: true });
  result.goal = '<img src="https://attacker.example/" onerror="alert(1)">';
  const first = buildReportContent(result, snapshot, library);
  assert.equal(first.html, buildReportContent(result, snapshot, library).html);
  assert.ok(first.html.includes("&lt;img"));
  assert.ok(!first.html.includes('<img src="https://attacker'));
  assert.ok(first.html.includes("data:font/woff2;base64,"));
  assert.equal(result.solutions.length, 0);
  assert.throws(() => buildReportContent(result, snapshot, library, 1024), /REPORT_CONTENT_TOO_LARGE/);
});

test("PDF content shows evidence-matched tariff alternatives with prices, scope caveat and dated sources", () => {
  const answer = (id: string, fact: string, value: AuditAnswer['value']): AuditAnswer => ({
    id, question_id: library.questions.find(question => question.fact_ids.includes(fact))!.id, fact_id: fact,
    state: 'known', value, event_ids: ['visitor-1'], channel: 'chat', method: 'selection', confirmation: 'explicit',
    library_version: library.version, created_at: date,
  });
  const snapshot: AuditSnapshot = { id: 'tariff-snapshot', session_id: 'session', library_version: library.version, created_at: date, through_seq: 1,
    answers: [answer('a1', 'analytics.applicable', true), answer('a2', 'analytics_sales.signal', 'target'),
      answer('a3', 'analytics_sales.details', { description: { state: 'known', value: 'Продажи не связаны с источниками' } }),
      answer('a4', 'analytics.history', { attempts_status: 'not_tried', attempts: [] })],
    state: initialAuditState(library.version, 'chat', date), limitations: [] };
  const html = buildReportContent(analyzeAudit(snapshot, library), snapshot, library).html;
  assert.match(html, /Предварительные тарифные варианты/);
  assert.match(html, /Конкретный пакет, объём и итоговая стоимость требуют уточнения/);
  assert.match(html, /Арифметика — разовая настройка/);
  assert.match(html, /14[\u00a0\u202f ]000 ₽/);
  assert.match(html, /от 60[\u00a0\u202f ]000 ₽/);
  assert.match(html, /Источник проверен: 2026-10-22/);
  assert.match(html, /Что входит/);
  assert.ok(html.indexOf('class="report-cover"') < html.indexOf('Предварительные тарифные варианты'));
});

test("KV cache misses only return waiting and never invoke rendering; expired report returns 410", async () => {
  let reads = 0;
  const report = { status: "ready", kvKey: "pdf/key", reportExpiresAt: date + 10_000 } as ReportRecord;
  const store = { findReportByTokenHash: async () => report, lookupReportToken: async () => report };
  const kv = { get: async () => { reads++; return null; }, put: async () => { throw new Error("download must not write"); } };
  const token = randomReadToken();
  assert.equal(token.length, 64); assert.equal((await sha256(token)).length, 64);
  const waiting = await getReportResponse(store, kv, token, date);
  assert.equal(waiting.status, 202); assert.equal(waiting.headers.get("Retry-After"), "60"); assert.equal(reads, 1);
  assert.equal((await getReportResponse(store, kv, token, date + 10_000)).status, 410); assert.equal(reads, 1);
  assert.equal((await getReportResponse({ ...store, findReportByTokenHash: async () => null }, kv, token, date)).status, 410);
  assert.equal((await getReportResponse(store, kv, "bad-token", date)).status, 404);
});

function smtpFixture(mode: "success" | "lost-data-reply" | "rejected" | "quit-disconnect", greeting = true) {
  const commands: string[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const reply = (value: string) => controller.enqueue(new TextEncoder().encode(value));
  const readable = new ReadableStream<Uint8Array>({ start(value) { controller = value; if (greeting) reply("220 smtp.example.com ready\r\n"); } });
  const socket: SmtpSocket = {
    readable, opened: Promise.resolve(), closed: Promise.resolve(), close: async () => undefined,
    writable: new WritableStream<Uint8Array>({ write(chunk) {
      const command = new TextDecoder().decode(chunk); commands.push(command);
      if (command.startsWith("EHLO")) reply("250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 10000000\r\n");
      else if (command.startsWith("AUTH")) reply("235 Authenticated\r\n");
      else if (command.startsWith("MAIL FROM")) reply("250 Sender ok\r\n");
      else if (command.startsWith("RCPT TO")) reply(mode === "rejected" ? "550 Recipient rejected\r\n" : "250 Recipient ok\r\n");
      else if (command === "DATA\r\n") reply("354 End with dot\r\n");
      else if (command === "QUIT\r\n") { if (mode === "quit-disconnect") controller.close(); else reply("221 Goodbye\r\n"); }
      else { if (mode === "lost-data-reply") controller.close(); else reply("250 Queued\r\n"); }
    } }),
  };
  return { socket, commands };
}

test("SMTP authenticates over TLS465 and treats lost DATA acknowledgement as unknown", async () => {
  for (const [mode, expected] of [["success", "sent"], ["lost-data-reply", "unknown"], ["rejected", "failed"], ["quit-disconnect", "sent"]] as const) {
    const fixture = smtpFixture(mode);
    const transport = new SmtpTransport(smtpConfig, (address, options) => { assert.equal(address.port, 465); assert.equal(options.secureTransport, "on"); return fixture.socket; });
    const result = await transport.send(mail);
    assert.equal(result.status, expected);
    assert.ok(fixture.commands.some(command => command.startsWith("AUTH PLAIN ")));
  }
});

test("SMTP587 upgrades with STARTTLS before authentication", async () => {
  const clearCommands: string[] = [];
  const secure = smtpFixture("success", false);
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let upgraded = false;
  const clear: SmtpSocket = {
    readable: new ReadableStream<Uint8Array>({ start(value) { controller = value; value.enqueue(new TextEncoder().encode("220 Ready\r\n")); } }),
    opened: Promise.resolve(), closed: Promise.resolve(), close: async () => undefined,
    startTls() { upgraded = true; return secure.socket; },
    writable: new WritableStream<Uint8Array>({ write(chunk) {
      const command = new TextDecoder().decode(chunk); clearCommands.push(command);
      if (command.startsWith("EHLO")) controller.enqueue(new TextEncoder().encode("250-hello\r\n250 STARTTLS\r\n"));
      else if (command === "STARTTLS\r\n") controller.enqueue(new TextEncoder().encode("220 Go ahead\r\n"));
      else throw new Error("authentication attempted before TLS");
    } }),
  };
  const transport = new SmtpTransport({ ...smtpConfig, port: 587 }, (address, options) => {
    assert.equal(address.port, 587); assert.equal(options.secureTransport, "starttls"); return clear;
  });
  assert.equal((await transport.send(mail)).status, "sent");
  assert.equal(upgraded, true);
  assert.deepEqual(clearCommands.map(command => command.split(" ")[0]), ["EHLO", "STARTTLS\r\n"]);
  assert.ok(secure.commands.some(command => command.startsWith("AUTH PLAIN ")));
});

test("MIME attaches PDF, includes separate report URL and rejects header injection", () => {
  const mime = buildMime(smtpConfig, mail);
  assert.ok(mime.includes('Content-Disposition: attachment; filename="preliminary-audit.pdf"'));
  assert.ok(mime.includes("Content-Type: application/pdf"));
  assert.ok(mime.split("\r\n").every(line => line.length < 998));
  assert.throws(() => buildMime(smtpConfig, { ...mail, to: "a@example.com\r\nBcc: other@example.com" }), /SMTP_INVALID_ADDRESS/);
  assert.throws(() => buildMime(smtpConfig, { ...mail, downloadUrl: "http://audit.example.com/report" }), /SMTP_INVALID_REPORT_URL/);
});
