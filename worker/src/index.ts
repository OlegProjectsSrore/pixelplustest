import type { Env } from './env.ts';
import type { Json } from './audit/contracts.ts';
import { CoreServices } from './core.ts';
import { refreshVoiceAccounts } from './voice-accounts.ts';
import { channelAdapters, type ChannelAdapters } from './integration.ts';
import { HttpError, bearer, budgets, fail, hashIp, hashToken, identifier, mutation, originAllowed, readJson, requestHash, textField, verifyTurnstile } from './security.ts';
import { StoreError } from './storage/d1-store.ts';
import { getReportResponse } from './report/download.ts';
import { requestEmail, runOneJob } from './report/pipeline.ts';
import { SmtpTransport, validateMailbox } from './report/smtp.ts';
import { presentPayload, sessionView } from './http-view.ts';
import { normalizeVoiceAnswers } from './channel-voice.ts';
import { composeFirstQuestion, createChatRuntime } from './channel-runtime.ts';
import { reviewReport } from './report/review.ts';
import type { AdapterContext } from './integration.ts';
import { parseVoiceAnswerPayload } from './voice/client-tools.ts';
import type { AuditAnswer } from './audit/contracts.ts';

function json(value: unknown, status = 200): Response { return Response.json(value, { status }); }
function finishResponse(response: Response, origin: string | null, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store'); headers.set('X-Content-Type-Options', 'nosniff'); headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Request-ID', requestId); headers.set('Vary', 'Origin');
  if (origin) headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Expose-Headers', 'Retry-After, X-Request-ID');
  return new Response(response.body, { status: response.status, headers });
}
async function pipeline(core: CoreServices, adapters: ChannelAdapters) {
  const env = core.env; let smtp: SmtpTransport | undefined;
  if (env.SMTP_HOST && env.SMTP_USERNAME && env.SMTP_PASSWORD && env.SMTP_FROM && env.PUBLIC_WORKER_URL && (!env.SMTP_PORT || env.SMTP_PORT === '465' || env.SMTP_PORT === '587')) {
    const { connect } = await import('cloudflare:sockets');
    smtp = new SmtpTransport({ hostname: env.SMTP_HOST, username: env.SMTP_USERNAME, password: env.SMTP_PASSWORD,
      from: env.SMTP_FROM, clientHostname: new URL(env.PUBLIC_WORKER_URL).hostname, port: env.SMTP_PORT === '587' ? 587 : 465 }, (address, settings) => connect(address, { ...settings, allowHalfOpen: false }));
  }
  return runOneJob({ store: core.store, kv: env.REPORTS_KV, browser: env.BROWSER, budgets: budgets(env),
    publicWorkerUrl: env.PUBLIC_WORKER_URL ?? '', smtp, reconcile: adapters.reconcile ? (session, now) => adapters.reconcile!(session, now, core) : undefined, now: core.now, allowDraft: core.engineOptions.allowDraft,
    // DeepSeek V4 Pro checks the information before the PDF; each try is metered like a chat call.
    review: env.DEEPSEEK_API_KEY ? async (session, input, attempt) => reviewReport(input, { ...await createChatRuntime({ core, env } as AdapterContext, session, `report-review:${session.reportId}`, attempt), max_tokens: 800, timeout_ms: 35_000 }) : undefined });
}
export function createWorker(adapters: ChannelAdapters = channelAdapters, options: { now?: () => number; fetcher?: typeof fetch } = {}) {
  return {
    async fetch(request: Request, env: Env, execution: ExecutionContext): Promise<Response> {
      const requestId = crypto.randomUUID(); let origin: string | null = null;
      try {
        origin = originAllowed(request, env);
        const url = new URL(request.url); const path = url.pathname; const method = request.method;
        if (method === 'OPTIONS') {
          if (!origin) fail(403, 'origin_required', 'Требуется разрешённый источник.');
          return finishResponse(new Response(null, { status: 204, headers: { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' } }), origin, requestId);
        }
        const core = new CoreServices(env, options.now, options.fetcher);
        const key = await hashIp(request.headers.get('CF-Connecting-IP') ?? 'local', env.IP_HASH_SALT);
        if (env.REQUEST_LIMITER) {
          if (!(await env.REQUEST_LIMITER.limit({ key })).success) fail(429, 'rate_limited', 'Слишком много запросов.', true);
        } else {
          const now = core.now();
          const limit = budgets(env).requests_per_ip_per_minute ?? 120;
          const reservation = await core.store.reserveUsage({ id: `http:${requestId}`, period: String(Math.floor(now / 60000)), kind: `http:${key}`,
            amount: 1, limit, now, expiresAt: now + 120000 });
          if (!reservation) fail(429, 'rate_limited', 'Слишком много запросов.', true);
          await core.store.settleUsage(reservation!.id, 1, now);
        }
        let response: Response; let operationId: string | undefined; let readOnly = false;
        if (method === 'GET' && path.startsWith('/api/report/')) {
          response = await getReportResponse(core.store, env.REPORTS_KV, path.slice('/api/report/'.length), core.now());
        } else if (method === 'POST' && path === '/api/session') {
          const body = await readJson(request); operationId = typeof body.operation_id === 'string' ? body.operation_id : undefined;
          const created = await core.create(request, body) as Record<string, Json>;
          const sessionId = (created.session as Record<string, Json> | undefined)?.session_id;
          const phrasing = body.channel === 'chat' && typeof sessionId === 'string' ? await composeFirstQuestion({ core, env, execution }, sessionId) : null;
          response = json(phrasing ? { ...created, question_phrasing: phrasing } : created, 201);
        } else if (method === 'GET' && /^\/api\/session\/[^/]+$/.test(path)) {
          const id = identifier(path.slice('/api/session/'.length), 'session_id');
          const hash = await hashToken(bearer(request));
          const management = await core.store.authenticateSession(id, hash, core.now());
          if (management) response = json({ session: await sessionView(core, management) });
          else {
            const report = await core.store.findReportByTokenHash(hash, core.now());
            if (!report || report.sessionId !== id) {
              const expired = await core.store.getSession(id);
              if (expired?.tokenHash === hash && expired.accessExpiresAt <= core.now()) fail(401, 'session_expired', 'Срок управления опросом истёк.');
              fail(401, 'unauthorized', 'Право чтения сессии отсутствует.');
            }
            readOnly = true;
            response = json({ session: await sessionView(core, await core.store.requireSession(id), true) });
          }
        } else if (method === 'POST' && path === '/api/voice/control') {
          if (!adapters.voiceControl) fail(503, 'integration_unavailable', 'Голосовой обработчик ещё не подключён.');
          const body = await readJson(request);
          const value = await adapters.voiceControl!(request, { core, env, execution, body });
          response = value instanceof Response ? value : json(value);
        } else if (method === 'POST' && path === '/api/webhooks/ultravox') {
          if (!adapters.ultravoxWebhook) fail(503, 'integration_unavailable', 'Голосовой обработчик ещё не подключён.');
          const value = await adapters.ultravoxWebhook!(request, { core, env, execution }); response = value instanceof Response ? value : json(value);
        } else if (method === 'GET' && path === '/api/tools/search') {
          if (!adapters.search) fail(503, 'integration_unavailable', 'Справочный поиск ещё не подключён.');
          const session = await core.authenticate(request, identifier(url.searchParams.get('session_id'), 'session_id'));
          const value = await adapters.search!(request, { core, env, execution, session }); response = value instanceof Response ? value : json(value);
        } else if (method === 'POST' && ['/api/audit/finish', '/api/session/channel', '/api/session/pause', '/api/session/resume', '/api/report/generate', '/api/email/send', '/api/chat', '/api/voice/start', '/api/voice/transcript', '/api/voice/answers'].includes(path)) {
          const body = await readJson(request); const input = mutation(body); const session = await core.authenticate(request, input.session_id);
          operationId = input.operation_id;
          if (input.library_version !== session.state.library_version) fail(409, 'library_mismatch', 'Версия библиотеки не совпадает.');
          if (path === '/api/audit/finish') {
            let lastPacket: { answers: AuditAnswer[] } | undefined;
            if (body.answers !== undefined && session.state.active_channel === 'voice') {
              if (await core.store.getOperation(session.id, input.operation_id)) lastPacket = { answers: [] };
              else {
                const call = await core.store.getCall(identifier(body.call_id, 'call_id'));
                if (!call || call.sessionId !== session.id || call.id !== session.activeCallId || call.channelRevision !== input.channel_revision) fail(403, 'call_mismatch', 'Звонок не принадлежит активному каналу.');
                let candidates;
                try { candidates = parseVoiceAnswerPayload({ answers: body.answers }).answers; }
                catch { fail(400, 'invalid_answers', 'Некорректный последний пакет голосовых ответов.'); }
                lastPacket = { answers: await normalizeVoiceAnswers(core, session, call!, candidates!) };
              }
            }
            const value = await core.finish(request, body, lastPacket); response = json(value, 202);
            execution.waitUntil(pipeline(core, adapters).catch(() => undefined));
          } else if (path === '/api/session/channel' || path === '/api/session/pause' || path === '/api/session/resume') {
            response = json(await core.channel(request, { ...body, action: path.endsWith('/pause') ? 'pause' : path.endsWith('/resume') ? 'resume' : body.action ?? 'switch' }, adapters.pollVoice));
          }
          else if (path === '/api/report/generate') {
            if (session.state.status === 'in_progress') fail(409, 'interview_active', 'Сначала завершите интервью.');
            response = json(await core.view(session), session.state.status === 'ready' ? 200 : 202);
            execution.waitUntil(pipeline(core, adapters).catch(() => undefined));
          } else if (path === '/api/email/send') {
            const consent = body.consent === true ? { accepted: true, version: 'pixelplus-audit-email-v1' } : body.consent;
            if (!consent || typeof consent !== 'object' || Array.isArray(consent) || (consent as Record<string, unknown>).accepted !== true) fail(400, 'consent_required', 'Требуется согласие на отправку.');
            const version = textField((consent as Record<string, unknown>).version, 'consent.version', 64);
            const recipient = textField(body.email, 'email', 254);
            if (!validateMailbox(recipient)) fail(400, 'invalid_request', 'Некорректный адрес электронной почты.');
            if (body.report_id !== undefined && body.report_id !== session.reportId) fail(403, 'forbidden', 'Отчёт не принадлежит сессии.');
            const result = await requestEmail({ store: core.store, sessionId: session.id, operationId: input.operation_id,
              recipient, consent: { accepted: true, version, received_at: core.now() }, requestHash: await requestHash(body), now: core.now() });
            if (result.status === 'rejected') fail(409, 'report_not_ready', 'Отчёт ещё не готов либо предел отправок исчерпан.');
            response = json(result, 202); execution.waitUntil(pipeline(core, adapters).catch(() => undefined));
          } else {
            const key = ({ '/api/chat': 'chat', '/api/voice/start': 'voiceStart', '/api/voice/transcript': 'voiceTranscript', '/api/voice/answers': 'voiceAnswers' } as const)[path as '/api/chat'];
            const handler = adapters[key]; if (!handler) fail(503, 'integration_unavailable', 'Обработчик канала ещё не подключён.');
            if (path === '/api/voice/start' && !(await core.store.getOperation(session.id, input.operation_id))) {
              if (session.state.status !== 'in_progress' || session.state.active_channel !== 'voice' || input.expected_revision !== session.state.revision || input.channel_revision !== session.state.channel_revision) fail(409, 'channel_conflict', 'Состояние голосового канала изменилось.');
              await verifyTurnstile(request, body.turnstile_token, env, 'voice_start', options.fetcher);
            }
            const value = await handler!(request, { core, env, execution, body, session }); response = value instanceof Response ? value : json(value);
          }
        } else fail(404, 'not_found', 'Маршрут не найден.');
        if (response!.ok && response!.headers.get('Content-Type')?.includes('application/json')) {
          const original = await response!.json();
          const payload = await presentPayload(core, original as Json, readOnly);
          if (payload && typeof payload === 'object' && !Array.isArray(payload) && operationId) payload.operation_id = operationId;
          const headers = new Headers(response!.headers);
          headers.delete('Content-Length');
          // Preserve the channel client's public top-level contract while exposing the versioned envelope.
          const legacy = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
          response = Response.json({ ...legacy, ok: true, data: payload }, { status: response!.status, headers });
        }
        return finishResponse(response!, origin, requestId);
      } catch (error) {
        const known = error instanceof HttpError || error instanceof StoreError;
        const status = known ? error.status : 500;
        const originalCode = known ? error.code : 'internal_error';
        const code = ({ body_too_large: 'payload_too_large', origin_denied: 'forbidden', origin_required: 'forbidden', configuration_required: 'not_configured', budget_not_configured: 'not_configured', integration_unavailable: 'not_configured' } as Record<string,string>)[originalCode] ?? originalCode;
        const message = error instanceof HttpError ? error.message : status < 500 ? 'Операция не может быть выполнена в текущем состоянии.' : 'Сервис временно недоступен.';
        const retryable = error instanceof HttpError ? error.retryable : status >= 500;
        const response = json({ ok: false, error: { code, message, retryable, retry_after_seconds: status === 429 || status === 503 ? 10 : null }, request_id: requestId }, status);
        if (status === 429 || status === 503) response.headers.set('Retry-After', '10');
        return finishResponse(response, origin, requestId);
      }
    },
    async scheduled(_controller: ScheduledController, env: Env, execution: ExecutionContext): Promise<void> {
      const core = new CoreServices(env, options.now, options.fetcher);
      if (env.VOICE_PROVIDER !== 'openai') execution.waitUntil(refreshVoiceAccounts(core));
      execution.waitUntil((async () => { if (adapters.recoverVoice) await adapters.recoverVoice(core);
        await core.store.closeExpiredSessions(core.now(), 10); await core.store.recoverExpiredSending(core.now(), 20);
        await pipeline(core, adapters); await core.store.cleanup(core.now(), 20); })());
    },
  };
}
export default createWorker();
