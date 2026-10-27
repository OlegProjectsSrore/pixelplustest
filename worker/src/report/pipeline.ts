import { HISTORY_WAIT_MS, REPORT_RETENTION_MS } from "../audit/contracts.ts";
import type { AuditSnapshot, Json } from "../audit/contracts.ts";
import { analyzeAudit } from "../audit/engine.ts";
import { getLibrary } from "../audit/library.ts";
import type { D1Store } from "../storage/d1-store.ts";
import type { AuditJob, EmailJob, StoredSession } from "../storage/types.ts";
import { buildReportContent, readReportContent } from "./content.ts";
import type { ReportKv } from "./download.ts";
import { randomReadToken, renderPdf, ReportFailure, sha256, withTimeout } from "./pdf.ts";
import type { PdfBrowser } from "./pdf.ts";
import { validateMailbox } from "./smtp.ts";
import type { MailTransport } from "./smtp.ts";
import { buildReviewInput, INSUFFICIENT_NOTICE, meetsMinimum, REVIEW_MODEL, type ReviewVerdict } from "./review.ts";
import { buildWriterInput, WRITER_MODEL, type WriterInput, type WriterOutput } from "./report-writer.ts";

export interface PipelineDependencies {
  store: D1Store;
  kv: ReportKv;
  browser?: PdfBrowser;
  budgets: Record<string, number>;
  publicWorkerUrl: string;
  smtp?: MailTransport;
  allowDraft?: boolean;
  reconcile?: (session: StoredSession, now: number) => Promise<{ complete: boolean; limitations: string[] }>;
  /** The information check by DeepSeek V4 Pro; null when the call failed. Without it the code minimum decides. */
  review?: (session: StoredSession, input: Json, attempt: number) => Promise<ReviewVerdict | null>;
  /** The report writer (DeepSeek V4 Pro, reasoning high); null when the call or its checks failed. Without it the template texts are used. */
  writer?: (session: StoredSession, input: WriterInput, attempt: number) => Promise<WriterOutput | null>;
  /** True only in a scheduled run: 15 minutes of wall time, while waitUntil after an HTTP response ends after 30 seconds. */
  longTasks?: boolean;
  now?: () => number;
}
// A failed information check is retried for about half an hour; then the code minimum decides.
const REVIEW_ATTEMPTS = 10;
const REVIEW_RETRY_MS = 3 * 60_000;
// The writer thinks for up to seven minutes over the report kit's ten sections: its step holds a longer lease and is retried twice before the template texts.
const WRITER_LEASE_MS = 8 * 60_000;
const WRITER_ATTEMPTS = 3;
const WRITER_RETRY_MS = 2 * 60_000;
const LEASE_MS = 60_000;
// Stop/status, provider history and metered extraction can each take up to 12s.
// Leave lease time for rereading durable progress and committing the snapshot.
const RECONCILE_TIMEOUT_MS = 40_000;
const RENDER_TIMEOUT_MS = 18_000;
// Provider-side page/action deadlines are 5s+10s; retain additional startup allowance.
const BROWSER_RESERVATION_SECONDS = 30;
const nowOf = (dependencies: PipelineDependencies) => dependencies.now?.() ?? Date.now();

async function reserve(dependencies: PipelineDependencies, kind: string, amount: number, id: string, minIntervalMs = 0): Promise<boolean> {
  const now = nowOf(dependencies);
  const day = new Date(now).toISOString().slice(0, 10);
  const reservation = await dependencies.store.reserveUsage({ id, period: day, kind, amount,
    limit: dependencies.budgets[kind] ?? 0, now, expiresAt: Date.parse(day + "T00:00:00Z") + 2 * 86_400_000, minIntervalMs });
  return reservation?.state === "reserved" && reservation.newlyCreated === true;
}

async function runAuditJob(dependencies: PipelineDependencies, candidate: AuditJob): Promise<boolean> {
  const { store } = dependencies;
  const owner = crypto.randomUUID();
  // The writer's step runs only in a scheduled run and under a longer lease.
  const composing = candidate.stage === "analyze" && dependencies.writer !== undefined && await store.getReport(candidate.reportId).then(item => item?.outcome === "report" && item.content === null);
  if (composing && !dependencies.longTasks) return false;
  const job = await store.claimJob(candidate.id, owner, nowOf(dependencies), composing ? WRITER_LEASE_MS : LEASE_MS);
  if (!job) return false;
  try {
    const report = await store.getReport(job.reportId);
    if (!report) throw new ReportFailure("REPORT_NOT_FOUND", false);
    const now = nowOf(dependencies);
    if ((report.publishedAt === null && report.prepareDeadline !== null && now >= report.prepareDeadline) ||
        (report.reportExpiresAt !== null && now >= report.reportExpiresAt)) throw new ReportFailure("REPORT_EXPIRED", false);

    if (job.stage === "reconcile") {
      let session = await store.requireSession(job.sessionId);
      let complete = session.state.history_status === "complete";
      const limitations: string[] = [];
      let calls = await store.listCalls(session.id);
      if (!complete && calls.length === 0 && session.state.active_channel === "chat") {
        const events = await store.listEvents(session.id, Math.max(0, session.state.through_seq - 500), 500);
        const finish = events.findLast(event => event.kind === "finish");
        const boundary = finish?.data && typeof finish.data === "object" && !Array.isArray(finish.data) ? finish.data : {};
        const through = boundary.last_event_seq;
        const sourceKey = boundary.last_source_key;
        complete = Boolean(finish) && (typeof through !== "number" || session.state.through_seq >= through) &&
          (typeof sourceKey !== "string" || events.some(event => event.source_key === sourceKey));
      }
      if (!complete && dependencies.reconcile) {
        let timedOut = false;
        try {
          const outcome = await withTimeout(dependencies.reconcile(session, now), RECONCILE_TIMEOUT_MS, "HISTORY_TIMEOUT");
          complete = outcome.complete;
          limitations.push(...outcome.limitations);
        } catch (error) {
          timedOut = error instanceof ReportFailure && error.code === "HISTORY_TIMEOUT";
          limitations.push("Полноту истории разговора не удалось подтвердить.");
        }
        // The hook may have stopped a call or saved evidence before returning or rejecting.
        [session, calls] = await Promise.all([store.requireSession(job.sessionId), store.listCalls(session.id)]);
        if (timedOut) {
          // Promise.race does not cancel the hook. Do not freeze a snapshot while this invocation's
          // recovery can still commit; retry from its durable progress under a fresh job lease.
          await store.checkpointJob(job.id, owner, nowOf(dependencies), {
            state: "retry_wait", nextAttemptAt: nowOf(dependencies) + 15_000, errorCode: "HISTORY_TIMEOUT",
          });
          return true;
        }
      }
      const unresolvedCalls = calls.some(call => ["reserved", "active", "stopping", "unknown"].includes(call.status));
      if (unresolvedCalls) complete = false;
      const lastChannelEnd = Math.max(session.closedAt ?? now, ...calls.map(call => call.endedAt ?? session.closedAt ?? now));
      if (!complete && nowOf(dependencies) < lastChannelEnd + HISTORY_WAIT_MS) {
        await store.checkpointJob(job.id, owner, nowOf(dependencies), { state: "retry_wait", nextAttemptAt: Math.min(lastChannelEnd + HISTORY_WAIT_MS, nowOf(dependencies) + 15_000) });
        return true;
      }
      if (!complete) limitations.push("История разговора могла поступить не полностью; использованы только доступные проверенные сведения.");
      if (unresolvedCalls) limitations.push("Окончание голосового соединения не подтверждено провайдером.");
      const answers = await store.listAnswers(session.id);
      const snapshot: AuditSnapshot = {
        id: crypto.randomUUID(), session_id: session.id, library_version: session.state.library_version,
        created_at: nowOf(dependencies), through_seq: session.state.through_seq, answers,
        state: { ...session.state, status: "preparing", history_status: complete ? "complete" : "incomplete" }, limitations,
      };
      const serialized = JSON.stringify(snapshot);
      if (new TextEncoder().encode(serialized).byteLength > 512_000) throw new ReportFailure("SNAPSHOT_TOO_LARGE", false);
      const saved = await store.checkpointJob(job.id, owner, nowOf(dependencies), {
        stage: "analyze", state: "pending", nextAttemptAt: nowOf(dependencies),
        snapshot: { data: snapshot, hash: await sha256(serialized) },
        reportPatch: { snapshotId: snapshot.id, status: "preparing" }, sessionState: snapshot.state,
        expectedSessionRevision: session.state.revision,
      });
      if (!saved) await store.checkpointJob(job.id, owner, nowOf(dependencies), { state: "retry_wait", nextAttemptAt: nowOf(dependencies) + 1000 });
      return true;
    }
    if (job.stage === "analyze") {
      // An interrupted worker must reuse previously committed content, including its embedded fonts.
      if (report.content !== null) {
        await store.checkpointJob(job.id, owner, nowOf(dependencies), { stage: "render", state: "pending", nextAttemptAt: nowOf(dependencies) });
        return true;
      }
      const snapshot = report.snapshotId ? await store.getSnapshot(report.snapshotId) : null;
      if (!snapshot) throw new ReportFailure("SNAPSHOT_MISSING", false);
      const library = getLibrary(snapshot.library_version);
      if (library.status !== "approved" && !dependencies.allowDraft) throw new ReportFailure("LIBRARY_NOT_APPROVED", false);
      if (report.outcome === "report" && report.result) {
        // The writer's step: its checked texts, or the template texts and the code priority after the last failed try.
        const tries = job.attempts.writer ?? 0;
        const input = buildWriterInput(snapshot, report.result, library);
        const written = dependencies.writer ? await dependencies.writer(await store.requireSession(job.sessionId), input, tries).catch(() => null) : null;
        if (!written && dependencies.writer && tries + 1 < WRITER_ATTEMPTS) {
          await store.checkpointJob(job.id, owner, nowOf(dependencies), { state: "retry_wait", errorCode: "WRITER_UNAVAILABLE", nextAttemptAt: nowOf(dependencies) + WRITER_RETRY_MS, incrementAttempt: "writer" });
          return true;
        }
        const composed = buildReportContent(report.result, snapshot, library, 512_000, written);
        await store.checkpointJob(job.id, owner, nowOf(dependencies), { stage: "render", state: "pending", nextAttemptAt: nowOf(dependencies), reportPatch: {
          content: composed as unknown as Json, contentHash: await sha256(JSON.stringify(composed)),
          review: { ...(report.review && typeof report.review === "object" && !Array.isArray(report.review) ? report.review : {}), writer: written ? WRITER_MODEL : "template", writer_tries: tries + 1 },
        } });
        return true;
      }
      const result = analyzeAudit(snapshot, library, { allowDraft: dependencies.allowDraft });
      const content = buildReportContent(result, snapshot, library, 512_000);
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 512_000) throw new ReportFailure("RESULT_TOO_LARGE", false);
      // The information check: the code minimum first, then DeepSeek V4 Pro, which may only stop the report.
      let review: ReviewVerdict & { by: string };
      if (!meetsMinimum(result)) review = { verdict: "insufficient", reasons: ["Нет подтверждённой проблемы с порядком работ и вариантом стоимости."], by: "code" };
      else if (!dependencies.review) review = { verdict: "sufficient", reasons: ["Проверка DeepSeek не подключена; решение по правилу кода."], by: "code" };
      else {
        const tries = job.attempts.review ?? 0;
        const verdict = await dependencies.review(await store.requireSession(job.sessionId), buildReviewInput(snapshot, result, library), tries).catch(() => null);
        if (!verdict && tries + 1 < REVIEW_ATTEMPTS) {
          await store.checkpointJob(job.id, owner, nowOf(dependencies), { state: "retry_wait", errorCode: "REVIEW_UNAVAILABLE", nextAttemptAt: nowOf(dependencies) + REVIEW_RETRY_MS, incrementAttempt: "review" });
          return true;
        }
        review = verdict ? { ...verdict, by: REVIEW_MODEL } : { verdict: "sufficient", reasons: ["DeepSeek V4 Pro не ответил за отведённое время; решение по правилу кода."], by: "code_after_review_failure" };
      }
      if (review.verdict === "insufficient") {
        // No PDF: the site shows the notice and an e-mail carries it instead of the report.
        const reportExpiresAt = report.reportExpiresAt ?? nowOf(dependencies) + REPORT_RETENTION_MS;
        await store.checkpointJob(job.id, owner, nowOf(dependencies), { state: "done", errorCode: null, reportPatch: {
          result, outcome: "insufficient", review: review as unknown as Json, status: "ready", reportExpiresAt, publishedAt: nowOf(dependencies), errorCode: null,
          rulesVersion: result.rules_version, tariffsVersion: result.tariffs_version, templateVersion: result.template_version,
        } });
        return true;
      }
      if (dependencies.writer) {
        // Enough information: the result is kept and the writer's step follows in a scheduled run.
        await store.checkpointJob(job.id, owner, nowOf(dependencies), { stage: "analyze", state: "pending", nextAttemptAt: nowOf(dependencies), reportPatch: {
          result, outcome: "report", review: review as unknown as Json, rulesVersion: result.rules_version, tariffsVersion: result.tariffs_version, templateVersion: result.template_version,
        } });
        return true;
      }
      await store.checkpointJob(job.id, owner, nowOf(dependencies), {
        stage: "render", state: "pending", nextAttemptAt: nowOf(dependencies), reportPatch: {
          result, content: content as unknown as Json, contentHash: await sha256(JSON.stringify(content)),
          rulesVersion: result.rules_version, tariffsVersion: result.tariffs_version, templateVersion: result.template_version,
          outcome: "report", review: review as unknown as Json,
        },
      });
      return true;
    }

    if (job.attempts.render >= 3) throw new ReportFailure("PDF_ATTEMPTS_EXHAUSTED", false);
    if (!dependencies.browser) throw new ReportFailure("PDF_NOT_CONFIGURED", false);
    const content = readReportContent(report.content);
    if (await sha256(JSON.stringify(content)) !== report.contentHash) throw new ReportFailure("REPORT_CONTENT_HASH_MISMATCH", false);
    const renderReservation = `pdf:${job.id}:${owner}`;
    const secondsReservation = `browser:${job.id}:${owner}`;
    if (!await reserve(dependencies, "pdf_renders", 1, renderReservation, 10_000)) throw new ReportFailure("PDF_BUDGET_WAIT", true, 60_000);
    if (!await reserve(dependencies, "browser_seconds", BROWSER_RESERVATION_SECONDS, secondsReservation)) {
      await store.settleUsage(renderReservation, 0, nowOf(dependencies));
      throw new ReportFailure("PDF_BUDGET_WAIT", true, 60_000);
    }
    const reportExpiresAt = report.reportExpiresAt ?? nowOf(dependencies) + REPORT_RETENTION_MS;
    const started = await store.checkpointJob(job.id, owner, nowOf(dependencies), { incrementAttempt: "render", reportPatch: { reportExpiresAt } });
    if (!started) {
      await store.settleUsage(renderReservation, 0, nowOf(dependencies));
      await store.settleUsage(secondsReservation, 0, nowOf(dependencies));
      return true;
    }
    job.attempts.render++;
    try {
      const pdf = await renderPdf(dependencies.browser, content.html, 8 * 1024 * 1024, RENDER_TIMEOUT_MS);
      // Retain a conservative browser-time reservation: Quick Actions does not return billed duration.
      await store.settleUsage(renderReservation, 1, nowOf(dependencies));
      await store.settleUsage(secondsReservation, null, nowOf(dependencies));
      if (reportExpiresAt <= nowOf(dependencies) + 60_000) throw new ReportFailure("REPORT_EXPIRED", false);
      const kvKey = `reports/${report.id}/${report.version}/${owner}`;
      await withTimeout(dependencies.kv.put(kvKey, pdf, { expiration: Math.floor(reportExpiresAt / 1000) }), 5000, "KV_WRITE_TIMEOUT");
      await store.checkpointJob(job.id, owner, nowOf(dependencies), {
        state: "done", reportPatch: { status: "ready", kvKey, reportExpiresAt, publishedAt: nowOf(dependencies), pdfHash: await sha256(pdf), errorCode: null },
      });
    } catch (error) {
      await store.settleUsage(renderReservation, null, nowOf(dependencies));
      await store.settleUsage(secondsReservation, null, nowOf(dependencies));
      throw error;
    }
  } catch (error) {
    const failure = error instanceof ReportFailure ? error : new ReportFailure("REPORT_PREPARATION_ERROR");
    const exhausted = job.stage === "render" && job.attempts.render >= 3;
    const terminal = !failure.retryable || exhausted;
    await dependencies.store.checkpointJob(job.id, owner, nowOf(dependencies), terminal ? {
      state: "failed", errorCode: failure.code,
      reportPatch: { status: "failed", errorCode: failure.code, failedAt: nowOf(dependencies) },
    } : { state: "retry_wait", errorCode: failure.code, nextAttemptAt: nowOf(dependencies) + failure.retryAfterMs });
  }
  return true;
}

async function runEmailJob(dependencies: PipelineDependencies, candidate: EmailJob): Promise<boolean> {
  const { store } = dependencies;
  const owner = crypto.randomUUID();
  const job = await store.claimEmail(candidate.id, owner, nowOf(dependencies), LEASE_MS);
  if (!job) return false;
  let smtpStarted = false;
  const reservationId = `email:${job.id}:${owner}`;
  try {
    const report = await store.getReport(job.reportId);
    if (!report || report.status !== "ready" || !report.reportExpiresAt || report.reportExpiresAt <= nowOf(dependencies)) throw new ReportFailure("EMAIL_REPORT_UNAVAILABLE", false);
    if (!dependencies.smtp) throw new ReportFailure("EMAIL_NOT_CONFIGURED", false);
    if (report.outcome === "insufficient") {
      // Too little information: the letter carries the notice instead of the PDF and its link.
      if (!await reserve(dependencies, "email_attempts", 1, reservationId)) throw new ReportFailure("EMAIL_BUDGET_WAIT", true, 60_000);
      if (!await store.markEmailSending(job.id, owner, nowOf(dependencies))) { await store.settleUsage(reservationId, 0, nowOf(dependencies)); return true; }
      smtpStarted = true;
      const outcome = await withTimeout(dependencies.smtp.send({ to: job.recipient, reportId: report.id, notice: INSUFFICIENT_NOTICE, now: nowOf(dependencies) }), 22_000, "EMAIL_TIMEOUT");
      await store.settleUsage(reservationId, 1, nowOf(dependencies));
      await store.checkpointEmail(job.id, owner, nowOf(dependencies), { status: outcome.status, errorCode: outcome.error ?? null, outcome: outcome.status === "sent" ? "smtp_accepted" : outcome.status });
      return true;
    }
    if (!report.kvKey) throw new ReportFailure("EMAIL_REPORT_UNAVAILABLE", false);
    const pdf = await withTimeout(dependencies.kv.get(report.kvKey, "arrayBuffer"), 5000, "KV_READ_TIMEOUT");
    if (!pdf) throw new ReportFailure("EMAIL_PDF_NOT_VISIBLE", true, 60_000);
    if (report.pdfHash && await sha256(pdf) !== report.pdfHash) throw new ReportFailure("EMAIL_PDF_HASH_MISMATCH", false);
    const base = new URL(dependencies.publicWorkerUrl);
    if (base.protocol !== "https:") throw new ReportFailure("EMAIL_INVALID_PUBLIC_URL", false);
    if (!await reserve(dependencies, "email_attempts", 1, reservationId)) throw new ReportFailure("EMAIL_BUDGET_WAIT", true, 60_000);
    const rawToken = randomReadToken();
    if (!await store.addReportAccessToken(report.id, await sha256(rawToken), "email", nowOf(dependencies))) {
      await store.settleUsage(reservationId, 0, nowOf(dependencies));
      throw new ReportFailure("EMAIL_REPORT_UNAVAILABLE", false);
    }
    if (!await store.markEmailSending(job.id, owner, nowOf(dependencies))) { await store.settleUsage(reservationId, 0, nowOf(dependencies)); return true; }
    smtpStarted = true;
    const outcome = await withTimeout(dependencies.smtp.send({ to: job.recipient, reportId: report.id, pdf,
      downloadUrl: new URL(`/api/report/${rawToken}`, base).href, now: nowOf(dependencies) }), 22_000, "EMAIL_TIMEOUT");
    await store.settleUsage(reservationId, 1, nowOf(dependencies));
    await store.checkpointEmail(job.id, owner, nowOf(dependencies), { status: outcome.status, errorCode: outcome.error ?? null, outcome: outcome.status === "sent" ? "smtp_accepted" : outcome.status });
  } catch (error) {
    const failure = error instanceof ReportFailure ? error : new ReportFailure("EMAIL_ERROR");
    if (smtpStarted) {
      await store.settleUsage(reservationId, null, nowOf(dependencies));
      await store.checkpointEmail(job.id, owner, nowOf(dependencies), { status: "unknown", errorCode: "SMTP_DELIVERY_UNKNOWN" });
    } else {
      await store.checkpointEmail(job.id, owner, nowOf(dependencies), { status: failure.retryable ? "pending" : "failed", nextAttemptAt: nowOf(dependencies) + failure.retryAfterMs, errorCode: failure.code });
    }
  }
  return true;
}

/** Both HTTP waitUntil and Cron call this. At most one oldest eligible job/stage runs. */
export async function runOneJob(dependencies: PipelineDependencies): Promise<{ kind: "audit" | "email" | "idle"; id?: string }> {
  const now = nowOf(dependencies);
  await dependencies.store.recoverExpiredSending(now, 10);
  const [audits, emails] = await Promise.all([dependencies.store.listDueJobs(now, 1), dependencies.store.listDueEmails(now, 1)]);
  const audit = audits[0], email = emails[0];
  if (audit && (!email || audit.createdAt <= email.createdAt)) return await runAuditJob(dependencies, audit) ? { kind: "audit", id: audit.id } : { kind: "idle" };
  if (email) return await runEmailJob(dependencies, email) ? { kind: "email", id: email.id } : { kind: "idle" };
  return { kind: "idle" };
}

/** Caller authenticates session management rights; read-only report tokens are insufficient. */
export async function requestEmail(input: { store: D1Store; sessionId: string; operationId: string; recipient: string; consent: Json; now?: number; requestHash?: string }): Promise<{ status: string; id: string | null; duplicate: boolean }> {
  if (!validateMailbox(input.recipient) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.operationId)) throw new ReportFailure("EMAIL_INVALID_REQUEST", false);
  if (!input.consent || typeof input.consent !== "object" || Array.isArray(input.consent) || input.consent.accepted !== true || typeof input.consent.version !== "string" || !input.consent.version.trim()) throw new ReportFailure("EMAIL_CONSENT_REQUIRED", false);
  const session = await input.store.requireSession(input.sessionId);
  const created = await input.store.enqueueEmail({ id: crypto.randomUUID(), sessionId: session.id, reportId: session.reportId,
    operationId: input.operationId, recipient: input.recipient, consent: input.consent, now: input.now ?? Date.now(), requestHash: input.requestHash });
  return { status: created.job?.status ?? "rejected", id: created.job?.id ?? null, duplicate: created.kind === "duplicate" };
}
