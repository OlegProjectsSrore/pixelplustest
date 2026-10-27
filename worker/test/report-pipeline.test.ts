import test from "node:test";
import assert from "node:assert/strict";
import { SqliteD1 } from "./helpers/d1.ts";
import { D1Store } from "../src/storage/d1-store.ts";
import { initialAuditState, REPORT_RETENTION_MS } from "../src/audit/contracts.ts";
import { library } from "../src/audit/library.ts";
import { requestEmail, runOneJob } from "../src/report/pipeline.ts";
import type { PipelineDependencies } from "../src/report/pipeline.ts";
import { sha256 } from "../src/report/pdf.ts";
import { getReportResponse } from "../src/report/download.ts";
import { INSUFFICIENT_NOTICE } from "../src/report/review.ts";
import { buildMime } from "../src/report/smtp.ts";

const start = Date.parse("2026-10-22T12:00:00Z");
const pdf = new TextEncoder().encode("%PDF-1.7\nfixture").buffer as ArrayBuffer;

// One confirmed problem with a price: the analytics answers that pass the code minimum of the information check.
const confirmedAnswers: [string, unknown][] = [["analytics.applicable", true], ["analytics_sales.signal", "target"],
  ["analytics_sales.details", { description: { state: "known", value: "Продажи из CRM не связаны с рекламными источниками" } }], ["analytics.history", { attempts_status: "not_tried", attempts: [] }]];
async function fixture(channel: "chat" | "voice" = "chat", answers = confirmedAnswers) {
  const db = new SqliteD1(); const store = new D1Store(db.binding());
  let now = start;
  let renders = 0;
  const files = new Map<string, ArrayBuffer>();
  const expirations: number[] = [];
  const state = initialAuditState(library.version, channel, now);
  await store.createSession({ id: "session", reportId: "report", tokenHash: "management-hash", reportTokenHash: await sha256("a".repeat(64)), state, now });
  for (const [index, [factId, value]] of answers.entries()) {
    const answer = { id: `answer-${index}`, question_id: library.questions.find(question => question.fact_ids.includes(factId))!.id, fact_id: factId, state: "known", value,
      event_ids: ["visitor-1"], channel, method: "classification", confirmation: "explicit", library_version: library.version, created_at: now };
    db.sqlite.prepare("INSERT INTO audit_answers(id,session_id,question_id,status,answer_json,library_version,event_seq,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(answer.id, "session", answer.question_id, "accepted", JSON.stringify(answer), library.version, index, now);
  }
  const result = await store.finish({ sessionId: "session", expectedRevision: 0, channelRevision: 0, operationId: "finish", now,
    reason: "user_requested", state, event: { id: "finish-event", source: "system", source_key: "finish", source_revision: 1,
      local_order: 0, role: "system", kind: "finish", occurred_at: now, received_at: now, data: { last_event_seq: 0 } } });
  assert.equal(result.kind, "accepted");
  const dependencies: PipelineDependencies = { store, allowDraft: true,
    browser: { quickAction: async () => { renders++; return new Response(pdf, { headers: { "Content-Type": "application/pdf" } }); } },
    kv: { get: async key => files.get(key) ?? null, put: async (key, value, options) => { files.set(key, value); expirations.push(options.expiration); } },
    budgets: { pdf_renders: 10, browser_seconds: 180, email_attempts: 10 },
    publicWorkerUrl: "https://audit.example.com", now: () => now };
  return { db, store, dependencies, files, expirations, get renders() { return renders; }, setNow(value: number) { now = value; } };
}

test("finish persists one job; stages snapshot and content before rendering; repeated execution is idle", async () => {
  const f = await fixture();
  try {
    await runOneJob(f.dependencies);
    const snapReport = (await f.store.getReport("report"))!;
    assert.ok(snapReport.snapshotId); assert.equal(snapReport.content, null); assert.equal(f.renders, 0);
    await runOneJob(f.dependencies);
    const beforePdf = (await f.store.getReport("report"))!;
    assert.ok(beforePdf.content); assert.ok(beforePdf.result); assert.equal(f.renders, 0);
    await runOneJob(f.dependencies);
    const ready = (await f.store.getReport("report"))!;
    assert.equal(ready.status, "ready"); assert.equal(f.renders, 1);
    assert.equal(ready.reportExpiresAt, start + REPORT_RETENTION_MS);
    assert.equal(f.expirations[0], Math.floor((start + REPORT_RETENTION_MS) / 1000));
    assert.equal(ready.contentHash, beforePdf.contentHash);
    assert.equal((await runOneJob(f.dependencies)).kind, "idle");
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM audit_jobs").get()!.n, 1);
  } finally { f.db.close(); }
});

test("voice without reconciler waits 90 seconds then preserves incomplete-history limitation", async () => {
  const f = await fixture("voice");
  try {
    await runOneJob(f.dependencies);
    assert.equal((await f.store.getReport("report"))!.snapshotId, null);
    f.setNow(start + 90_000); await runOneJob(f.dependencies);
    const snapshot = await f.store.getSnapshot((await f.store.getReport("report"))!.snapshotId!);
    assert.equal(snapshot!.state.history_status, "incomplete"); assert.ok(snapshot!.limitations.some(item => item.includes("не полностью")));
  } finally { f.db.close(); }
});

async function seedActiveCall(f: Awaited<ReturnType<typeof fixture>>) {
  await f.store.updateVoiceSlot({ id: "1", availableMs: 1_500_000, maxConcurrency: 1, now: start });
  f.db.sqlite.prepare("INSERT INTO ultravox_calls(id,session_id,slot_id,provider_call_id,channel_revision,status,reserved_ms,started_at,operation_id,created_at) VALUES('call','session','1','provider-call',0,'active',900000,?,'start-call',?)").run(start, start);
  f.db.sqlite.prepare("UPDATE audit_sessions SET active_call_id='call' WHERE id='session'").run();
}

test("reconciliation rereads stopped calls before recording history limitations", async () => {
  const f = await fixture("voice");
  try {
    await seedActiveCall(f); f.setNow(start + 95_000);
    f.dependencies.reconcile = async () => {
      assert.equal(await f.store.confirmCallStopped("call", start + 95_000, "complete"), true);
      return { complete: true, limitations: [] };
    };
    await runOneJob(f.dependencies);
    const snapshot = await f.store.getSnapshot((await f.store.getReport("report"))!.snapshotId!);
    assert.equal(snapshot!.state.history_status, "complete"); assert.deepEqual(snapshot!.limitations, []);
  } finally { f.db.close(); }
});

test("a failed reconciliation still rereads its confirmed stop and waits from the new end time", async () => {
  const f = await fixture("voice");
  try {
    await seedActiveCall(f); f.setNow(start + 95_000);
    f.dependencies.reconcile = async () => {
      await f.store.confirmCallStopped("call", start + 95_000);
      throw new Error("history temporarily unavailable after stop");
    };
    await runOneJob(f.dependencies);
    assert.equal((await f.store.getReport("report"))!.snapshotId, null);
    assert.equal((await f.store.getJob("audit:report:1"))!.state, "retry_wait");
    f.setNow(start + 185_000); await runOneJob(f.dependencies);
    const snapshot = await f.store.getSnapshot((await f.store.getReport("report"))!.snapshotId!);
    assert.equal(snapshot!.state.history_status, "incomplete");
    assert.ok(snapshot!.limitations.every(value => !value.includes("соединения не подтверждено")));
  } finally { f.db.close(); }
});

test("provider and classifier reconciliation may exceed ten seconds within its lease", async context => {
  const f = await fixture("voice"); context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let entered!: () => void; const began = new Promise<void>(resolve => { entered = resolve; });
    f.dependencies.reconcile = async () => {
      entered(); await new Promise<void>(resolve => setTimeout(resolve, 25_000));
      return { complete: true, limitations: [] };
    };
    const running = runOneJob(f.dependencies); await began;
    f.setNow(start + 25_000); context.mock.timers.tick(25_000); await running;
    assert.ok((await f.store.getReport("report"))!.snapshotId);
    assert.equal((await f.store.getJob("audit:report:1"))!.stage, "analyze");
  } finally { context.mock.timers.reset(); f.db.close(); }
});

test("a timed-out still-running reconciler cannot freeze a snapshot; the next job uses saved progress", async context => {
  const f = await fixture("voice"); context.mock.timers.enable({ apis: ["setTimeout"] });
  let finish!: () => void;
  try {
    f.setNow(start + 100_000);
    let entered!: () => void; const began = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let unfinished: Promise<{ complete: boolean; limitations: string[] }>;
    f.dependencies.reconcile = () => unfinished = (async () => {
      entered(); await gate;
      const session = await f.store.requireSession("session");
      await f.store.appendLateEvent({ sessionId: "session", expectedRevision: session.state.revision, channelRevision: 0, operationId: "late-history", now: start + 141_000,
        event: { id: "late-history", source: "webhook", source_key: "late-history", source_revision: 0, local_order: 0,
          role: "user", kind: "utterance", text: "Поздняя сохранённая реплика", occurred_at: start, received_at: start + 141_000 } });
      return { complete: true, limitations: [] };
    })();
    const running = runOneJob(f.dependencies); await began;
    f.setNow(start + 141_000); context.mock.timers.tick(41_000); await running;
    assert.equal((await f.store.getReport("report"))!.snapshotId, null);
    assert.equal((await f.store.requireSession("session")).state.status, "closing");
    assert.equal((await f.store.getJob("audit:report:1"))!.errorCode, "HISTORY_TIMEOUT");
    finish(); await unfinished!;
    f.dependencies.reconcile = async () => ({ complete: true, limitations: [] });
    f.setNow(start + 156_000); await runOneJob(f.dependencies);
    const snapshot = await f.store.getSnapshot((await f.store.getReport("report"))!.snapshotId!);
    assert.equal(snapshot!.through_seq, 2); assert.equal(snapshot!.state.history_status, "complete");
  } finally { finish?.(); context.mock.timers.reset(); f.db.close(); }
});

test("quota wait does not spend render attempts; interrupted KV publication retries same content and expiry", async () => {
  const f = await fixture();
  try {
    await runOneJob(f.dependencies); await runOneJob(f.dependencies);
    f.dependencies.budgets.pdf_renders = 0;
    await runOneJob(f.dependencies);
    const id = "audit:report:1";
    assert.equal((await f.store.getJob(id))!.attempts.render, 0); assert.equal(f.renders, 0);
    f.dependencies.budgets.pdf_renders = 10; f.setNow(start + 60_000);
    const put = f.dependencies.kv.put;
    f.dependencies.kv.put = async () => { throw new Error("injected KV failure"); };
    await runOneJob(f.dependencies);
    const failedAttempt = (await f.store.getReport("report"))!;
    assert.equal((await f.store.getJob(id))!.attempts.render, 1);
    const expiry = failedAttempt.reportExpiresAt;
    f.dependencies.kv.put = put; f.setNow(start + 120_000);
    await runOneJob(f.dependencies);
    const ready = (await f.store.getReport("report"))!;
    assert.equal(ready.status, "ready"); assert.equal(ready.reportExpiresAt, expiry); assert.equal(ready.contentHash, failedAttempt.contentHash);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM audit_snapshots").get()!.n, 1);
  } finally { f.db.close(); }
});

test("render stops after three actual provider attempts", async () => {
  const f = await fixture();
  try {
    await runOneJob(f.dependencies); await runOneJob(f.dependencies);
    let calls = 0;
    f.dependencies.browser = { quickAction: async () => { calls++; return new Response("busy", { status: 503 }); } };
    for (let index = 0; index < 4; index++) { f.setNow(start + index * 60_000); await runOneJob(f.dependencies); }
    assert.equal(calls, 3); assert.equal((await f.store.getReport("report"))!.status, "failed");
  } finally { f.db.close(); }
});

test("a former render owner cannot publish after another worker takes the lease", async () => {
  const f = await fixture();
  try {
    await runOneJob(f.dependencies); await runOneJob(f.dependencies);
    const put = f.dependencies.kv.put;
    f.dependencies.kv.put = async (key, value, options) => {
      await put(key, value, options);
      f.db.sqlite.prepare("UPDATE audit_jobs SET lease_token='new-owner',lease_expires_at=? WHERE id='audit:report:1'").run(start + 60_000);
    };
    await runOneJob(f.dependencies);
    const report = (await f.store.getReport("report"))!;
    assert.equal(report.status, "preparing"); assert.equal(report.kvKey, null);
    assert.equal((await f.store.getJob("audit:report:1"))!.leaseToken, "new-owner");
    assert.equal(f.files.size, 1); // Unpublished attempt has the original absolute TTL.
    f.dependencies.kv.put = put; f.setNow(start + 61_000);
    await runOneJob(f.dependencies);
    const ready = (await f.store.getReport("report"))!;
    assert.equal(ready.status, "ready"); assert.equal(ready.reportExpiresAt, report.reportExpiresAt);
    assert.equal((await f.store.getJob("audit:report:1"))!.attempts.render, 2);
  } finally { f.db.close(); }
});

test("closing snapshot does not commit over a concurrently changed session revision", async () => {
  const f = await fixture();
  try {
    f.db.beforeBatch = () => {
      f.db.beforeBatch = null;
      f.db.sqlite.prepare("UPDATE audit_sessions SET revision=revision+1 WHERE id='session'").run();
    };
    await runOneJob(f.dependencies);
    assert.equal((await f.store.getReport("report"))!.snapshotId, null);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM audit_snapshots").get()!.n, 0);
    assert.equal((await f.store.getJob("audit:report:1"))!.state, "retry_wait");
  } finally { f.db.close(); }
});

test("controlled file recovery reuses the existing job, immutable content and absolute expiry", async () => {
  const f = await fixture();
  try {
    await runOneJob(f.dependencies); await runOneJob(f.dependencies); await runOneJob(f.dependencies);
    const original = (await f.store.getReport("report"))!;
    f.files.clear(); f.setNow(start + 60_000);
    assert.equal(await f.store.reopenRenderJob("report", start + 60_000), true);
    await runOneJob(f.dependencies);
    const recovered = (await f.store.getReport("report"))!;
    assert.equal(recovered.status, "ready"); assert.equal(recovered.contentHash, original.contentHash);
    assert.equal(recovered.snapshotId, original.snapshotId); assert.equal(recovered.reportExpiresAt, original.reportExpiresAt);
    assert.equal(recovered.publishedAt, original.publishedAt); assert.notEqual(recovered.kvKey, original.kvKey);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM audit_jobs").get()!.n, 1);
    assert.equal(await f.store.reopenRenderJob("report", original.reportExpiresAt!), false);
  } finally { f.db.close(); }
});

test("duplicate email request has one delivery; accepted job survives management token expiry", async () => {
  const f = await fixture();
  try {
    await runOneJob(f.dependencies); await runOneJob(f.dependencies); await runOneJob(f.dependencies);
    const request = { store: f.store, sessionId: "session", operationId: "send-one", recipient: "person@example.com", consent: { accepted: true, version: "v1" }, now: start };
    const first = await requestEmail(request); const duplicate = await requestEmail(request);
    assert.equal(duplicate.id, first.id); assert.equal(duplicate.duplicate, true);
    let sent = 0;
    f.dependencies.smtp = { send: async message => { sent++; assert.ok(message.downloadUrl?.startsWith("https://audit.example.com/api/report/")); assert.notEqual(message.downloadUrl?.split("/").at(-1), "a".repeat(64)); return { status: "sent" }; } };
    f.setNow(start + 25 * 60 * 60 * 1000);
    await runOneJob(f.dependencies); await runOneJob(f.dependencies);
    assert.equal(sent, 1); assert.equal((await f.store.getEmail(first.id!))!.status, "sent");
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM report_access_tokens").get()!.n, 2);
  } finally { f.db.close(); }
});

test("KV miss delays email; SMTP unknown is terminal and is never automatically resent", async () => {
  const f = await fixture();
  try {
    await runOneJob(f.dependencies); await runOneJob(f.dependencies); await runOneJob(f.dependencies);
    const request = await requestEmail({ store: f.store, sessionId: "session", operationId: "send-one", recipient: "person@example.com", consent: { accepted: true, version: "v1" }, now: start });
    const get = f.dependencies.kv.get; let sent = 0;
    f.dependencies.smtp = { send: async () => { sent++; return { status: "unknown" }; } };
    f.dependencies.kv.get = async () => null;
    await runOneJob(f.dependencies); assert.equal(sent, 0); assert.equal((await f.store.getEmail(request.id!))!.status, "pending");
    f.dependencies.kv.get = get; f.setNow(start + 60_000);
    await runOneJob(f.dependencies); f.setNow(start + 120_000); await runOneJob(f.dependencies);
    assert.equal(sent, 1); assert.equal((await f.store.getEmail(request.id!))!.status, "unknown");
    assert.equal(f.renders, 1);
  } finally { f.db.close(); }
});

test("too little information: no PDF, the notice on the site and in an e-mail without attachment", async () => {
  const f = await fixture("chat", []);
  try {
    await runOneJob(f.dependencies); await runOneJob(f.dependencies);
    const report = (await f.store.getReport("report"))!;
    // The code minimum stops the report before any model call.
    assert.equal(report.status, "ready"); assert.equal(report.outcome, "insufficient"); assert.equal(report.kvKey, null); assert.equal(report.content, null);
    assert.equal((report.review as Record<string, unknown>).by, "code"); assert.equal(f.renders, 0); assert.equal(f.files.size, 0);
    assert.equal((await f.store.requireSession("session")).state.status, "ready");
    assert.equal((await runOneJob(f.dependencies)).kind, "idle");
    const response = await getReportResponse(f.store, f.dependencies.kv, "a".repeat(64), start);
    assert.deepEqual(await response.json(), { status: "insufficient", message: INSUFFICIENT_NOTICE });
    const mails: unknown[] = [];
    f.dependencies.smtp = { send: async message => { mails.push(message); return { status: "sent" }; } };
    const email = await requestEmail({ store: f.store, sessionId: "session", operationId: "notice", recipient: "person@example.com", consent: { accepted: true, version: "v1" }, now: start });
    await runOneJob(f.dependencies);
    assert.deepEqual(mails, [{ to: "person@example.com", reportId: "report", notice: INSUFFICIENT_NOTICE, now: start }]);
    assert.equal((await f.store.getEmail(email.id!))!.status, "sent");
    const mime = buildMime({ from: "audit@example.com", clientHostname: "audit.example.com" }, { to: "person@example.com", reportId: "report", notice: INSUFFICIENT_NOTICE, now: start });
    assert.doesNotMatch(mime, /application\/pdf|multipart/);
    assert.ok(mime.includes(btoa(String.fromCharCode(...new TextEncoder().encode(INSUFFICIENT_NOTICE))).slice(0, 60)));
  } finally { f.db.close(); }
});

test("DeepSeek V4 Pro may stop the report; a failed check is retried, then the code minimum decides", async () => {
  const stopped = await fixture();
  try {
    const inputs: unknown[] = [];
    stopped.dependencies.review = async (_session, input) => { inputs.push(input); return { verdict: "insufficient", reasons: ["Описание проблемы слишком общее."] }; };
    await runOneJob(stopped.dependencies); await runOneJob(stopped.dependencies);
    const report = (await stopped.store.getReport("report"))!;
    assert.equal(report.outcome, "insufficient"); assert.equal(stopped.renders, 0);
    assert.deepEqual(report.review, { verdict: "insufficient", reasons: ["Описание проблемы слишком общее."], by: "deepseek-v4-pro" });
    // The check sees the visitor's answers with their questions and the draft, never the library rules.
    const input = inputs[0] as { answers: { question: string; value: unknown; key_for_report: boolean }[]; draft: { problems: { title: string; steps: string[] }[]; price_options: unknown[] } };
    assert.ok(input.answers.some(item => item.value && JSON.stringify(item.value).includes("Продажи из CRM") && item.key_for_report));
    assert.ok(input.draft.problems.length === 1 && input.draft.problems[0].steps.length >= 4 && input.draft.price_options.length > 0);
  } finally { stopped.db.close(); }
  const failing = await fixture();
  try {
    let calls = 0;
    failing.dependencies.review = async () => { calls++; return null; };
    await runOneJob(failing.dependencies); await runOneJob(failing.dependencies);
    const job = failing.db.sqlite.prepare("SELECT state, attempts_json, next_attempt_at FROM audit_jobs").get() as { state: string; attempts_json: string; next_attempt_at: number };
    assert.equal(job.state, "retry_wait"); assert.equal(JSON.parse(job.attempts_json).review, 1); assert.equal(job.next_attempt_at, start + 3 * 60_000);
    for (let attempt = 1; attempt < 10; attempt++) { failing.setNow(start + attempt * 3 * 60_000); await runOneJob(failing.dependencies); }
    assert.equal(calls, 10);
    const analysed = (await failing.store.getReport("report"))!;
    assert.equal(analysed.outcome, "report"); assert.equal((analysed.review as Record<string, unknown>).by, "code_after_review_failure");
    await runOneJob(failing.dependencies);
    assert.equal((await failing.store.getReport("report"))!.status, "ready"); assert.equal(failing.renders, 1);
  } finally { failing.db.close(); }
});

test("the report writer runs only in a scheduled run, under a longer lease; its texts go into the PDF, failures fall back to the template", async () => {
  const f = await fixture();
  try {
    const inputs: unknown[] = []; let calls = 0;
    const leases: number[] = [];
    f.dependencies.writer = async (_session, input) => { calls++; inputs.push(input); leases.push((f.db.sqlite.prepare("SELECT lease_expires_at FROM audit_jobs").get() as { lease_expires_at: number }).lease_expires_at); return { summary: "Главное — связать оплаты с источниками заявок, начать стоит с этого.", plan_intro: "Сначала связываем источники и оплаты.",
      problems: input.problems.map(problem => ({ id: problem.id, situation: "Продажи из CRM не связаны с рекламными источниками, поэтому отдачу каналов не видно.", priority: "low" as const, why: "Проблема подтверждена Вашими ответами." })) }; };
    await runOneJob(f.dependencies); await runOneJob(f.dependencies);
    // Enough information: the result is kept and the writer's step waits for a scheduled run.
    const analysed = (await f.store.getReport("report"))!;
    assert.equal(analysed.outcome, "report"); assert.ok(analysed.result); assert.equal(analysed.content, null);
    assert.equal((await runOneJob(f.dependencies)).kind, "idle", "an HTTP waitUntil run never starts the writer");
    assert.equal(calls, 0);
    f.dependencies.longTasks = true;
    await runOneJob(f.dependencies);
    const lease = f.db.sqlite.prepare("SELECT stage FROM audit_jobs").get() as { stage: string };
    assert.equal(lease.stage, "render"); assert.equal(calls, 1);
    assert.deepEqual(leases, [start + 5 * 60_000], "the writer holds a five-minute lease");
    const composed = (await f.store.getReport("report"))!;
    assert.ok(JSON.stringify(composed.content).includes("Главное — связать оплаты с источниками заявок"));
    assert.equal((composed.review as Record<string, unknown>).writer, "deepseek-v4-pro");
    assert.ok((inputs[0] as { problems: unknown[] }).problems.length === 1);
    await runOneJob(f.dependencies);
    assert.equal((await f.store.getReport("report"))!.status, "ready"); assert.equal(f.renders, 1);
  } finally { f.db.close(); }
  const failing = await fixture();
  try {
    let calls = 0;
    failing.dependencies.writer = async () => { calls++; return null; };
    failing.dependencies.longTasks = true;
    await runOneJob(failing.dependencies); await runOneJob(failing.dependencies); await runOneJob(failing.dependencies);
    const job = failing.db.sqlite.prepare("SELECT state, attempts_json, next_attempt_at, lease_expires_at FROM audit_jobs").get() as { state: string; attempts_json: string; next_attempt_at: number };
    assert.equal(job.state, "retry_wait"); assert.equal(JSON.parse(job.attempts_json).writer, 1); assert.equal(job.next_attempt_at, start + 2 * 60_000);
    failing.setNow(start + 2 * 60_000); await runOneJob(failing.dependencies);
    failing.setNow(start + 4 * 60_000); await runOneJob(failing.dependencies);
    assert.equal(calls, 3);
    const composed = (await failing.store.getReport("report"))!;
    assert.equal((composed.review as Record<string, unknown>).writer, "template");
    assert.ok(JSON.stringify(composed.content).includes(library.report.texts.summary_fallback));
  } finally { failing.db.close(); }
});
