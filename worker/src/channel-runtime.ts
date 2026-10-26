import { createChatHandler as createPreparedChatHandler, type PreparedChatTurn } from './chat/handler.ts';
import type { ClassifierRuntime } from './chat/types.ts';
import { composeChatMessage, type ComposeInput, type Composed } from './chat/composer.ts';
import type { AdapterContext, AdapterHandler, ChannelAdapters } from './integration.ts';
import type { StoredSession, UsageReservation } from './storage/types.ts';
import { INTERVIEW_BUDGET_MS, type AuditEvent, type Json } from './audit/contracts.ts';
import { advanceAudit, elapsedInterviewMs, nextQuestion, validateAnswers } from './audit/engine.ts';
import { getLibrary, isApproved } from './audit/library.ts';
import { selectHumorReply, type HumorIntent } from './audit/humor.ts';
import { validateAuditState } from './audit/validation.ts';
import { fail, object } from './security.ts';
import { measuredDeepseekMicros, reserveDeepseekMicros } from './deepseek-cost.ts';
import faqData from './audit/data/faq.json' with { type: 'json' };
import preparedData from './audit/data/prepared-answers.json' with { type: 'json' };

/** One request attempt owns fresh call/token/cost reservations; old reserves are never authority. */
export async function createChatRuntime(context: AdapterContext, session: StoredSession, operationId: string, attempt: number): Promise<ClassifierRuntime> {
  const { core, env } = context;
  const key = typeof env.DEEPSEEK_API_KEY === 'string' ? env.DEEPSEEK_API_KEY : '';
  return {
    api_key: key, max_tokens: 4096, timeout_ms: 12_000, fetch: core.fetcher,
    async runAuthorized(input, execute) {
      const maximumCost = reserveDeepseekMicros(input);
      const reservationKey = `${session.id}:${operationId}:${attempt}`;
      const calls = await core.reserve('deepseek_calls', 1, reservationKey);
      if (calls.newlyCreated !== true) fail(409, 'provider_attempt_exists', 'Этот запрос к провайдеру уже выполняется или учтён. Повторный вызов запрещён.');
      let tokens: UsageReservation | undefined;
      let money: UsageReservation | undefined;
      try {
        // UTF-8 byte length is a deliberately conservative input bound, not a tokenizer estimate.
        tokens = await core.reserve('deepseek_tokens', input.input_utf8_bytes + input.max_tokens + 256, reservationKey);
        if (tokens.newlyCreated !== true) fail(409, 'provider_attempt_exists', 'Этот запрос к провайдеру уже выполняется или учтён.');
        money = await core.reserve('deepseek_usd_micros', maximumCost, reservationKey);
      } catch (error) {
        if (tokens?.newlyCreated) await core.store.settleUsage(tokens.id, 0, core.now());
        await core.store.settleUsage(calls.id, 0, core.now()); throw error;
      }
      let exchange;
      try { exchange = await execute(); }
      catch (error) {
        await core.store.settleUsage(calls.id, 1, core.now());
        await core.store.settleUsage(tokens.id, null, core.now());
        await core.store.settleUsage(money.id, null, core.now());
        throw error;
      }
      await core.store.settleUsage(calls.id, 1, core.now());
      // Even an HTTP error without usage is not assumed to have cost zero.
      await core.store.settleUsage(tokens.id, exchange.usage?.total_tokens ?? null, core.now());
      await core.store.settleUsage(money.id, measuredDeepseekMicros(exchange.usage), core.now());
      return exchange;
    },
  };
}

// Classification uses attempts 0 and 1 of an operation; wording takes its own metered attempt.
const COMPOSE_ATTEMPT = 2;
// FAQ answers and jokes are approved texts shown verbatim; other notices are reworded by DeepSeek.
const APPROVED_TEXT_ACTIONS = ['faq', 'off_topic', 'humor_preference', 'role_change'];

/** DeepSeek words the turn; any failure (budget, provider, checks) keeps the library texts. */
async function composeTurn(context: AdapterContext, session: StoredSession, operationId: string, attempt: number, timeoutMs: number, input: ComposeInput): Promise<Composed | null> {
  if (context.env.CHAT_COMPOSER_ENABLED !== 'true') return null;
  try {
    const runtime = await createChatRuntime(context, session, operationId, attempt);
    const remaining = INTERVIEW_BUDGET_MS - elapsedInterviewMs(session.state, context.core.now());
    return remaining > 0 ? await composeChatMessage(input, { ...runtime, max_tokens: 600, timeout_ms: Math.min(timeoutMs, remaining) }) : null;
  } catch (error) {
    console.warn(JSON.stringify({ event: 'chat_compose_failed', reason: error instanceof Error ? error.message : 'unknown' }));
    return null;
  }
}
const dialog = (events: AuditEvent[]) => events.filter(event => (event.role === 'user' || event.role === 'assistant') && typeof event.text === 'string' && event.text.trim())
  .slice(-8).map(event => ({ role: event.role, text: event.text!.slice(0, 400) }));

/** The first chat question is worded when the session is created; null keeps the library text. */
export async function composeFirstQuestion(context: AdapterContext, sessionId: string): Promise<{ question_id: string; text: string } | null> {
  try {
    const session = await context.core.store.requireSession(sessionId);
    if (session.state.active_channel !== 'chat') return null;
    const question = nextQuestion(session.state, context.core.now(), getLibrary(session.state.library_version), context.core.engineOptions);
    if (!question) return null;
    const composed = await composeTurn(context, session, 'first-question', 0, 6_000, { visitor_text: null, approved_text: null, notice_to_rephrase: null,
      question: { text: question.text, options: question.options.map(option => option.text) }, history: [], previous_replies: [] });
    return composed?.question_text ? { question_id: question.id, text: composed.question_text } : null;
  } catch { return null; }
}

function humorIntent(turn: PreparedChatTurn, now: number): HumorIntent {
  const classification = turn.classification;
  const kind: HumorIntent['kind'] = turn.action === 'humor_preference' ? classification?.humor_preference === 'allow' ? 'humor_enabled' : 'humor_declined'
    : turn.action === 'off_topic' ? 'off_topic' : turn.action === 'role_change' ? 'role_change' : 'ambiguous';
  return { kind, certain: classification?.intent === 'off_topic' && classification.joke_category_id !== null,
    safe_category_ids: classification?.joke_category_id ? [classification.joke_category_id] : [], now };
}

export async function commitChatTurn(request: Request, context: AdapterContext, _original: StoredSession, turn: PreparedChatTurn): Promise<Json> {
  const { core } = context, now = core.now();
  const session = await core.authenticate(request, turn.input.session_id);
  const previous = await core.store.getOperation(session.id, turn.input.operation_id);
  if (previous) {
    if (previous.requestHash !== turn.request_hash) fail(409, 'operation_reused', 'Идентификатор операции уже использован для другого запроса.');
    return { kind: 'duplicate', operation: previous.result, session: await core.view(session) };
  }
  if (session.state.revision !== turn.input.expected_revision || session.state.channel_revision !== turn.input.channel_revision || session.state.active_channel !== 'chat' || session.state.library_version !== turn.input.library_version) fail(409, 'revision_conflict', 'Состояние изменилось во время обработки ответа.');
  if (session.state.status !== 'in_progress') fail(409, 'interview_closed', 'Сбор сведений уже завершён.');
  const common = { sessionId: session.id, expectedRevision: turn.input.expected_revision, channelRevision: turn.input.channel_revision,
    operationId: turn.input.operation_id, requestHash: turn.request_hash, now };
  if (turn.action === 'pause') return core.response(await core.store.pause(common));
  if (turn.action === 'resume') return core.response(await core.store.changeChannel({ ...common, channel: 'chat' }));
  const lib = getLibrary(session.state.library_version);
  if (turn.action === 'finish') return core.response(await core.store.finish({ ...common, state: session.state,
    event: { ...turn.event, kind: 'finish', data: { reason: 'visitor_request' } }, reason: 'visitor_request',
    result: { text: lib.jokes.neutral_replies.pause_or_stop, question_id: null, operation_id: turn.input.operation_id } }));
  if (session.state.paused) fail(409, 'session_paused', 'Сначала возобновите опрос.');
  if (elapsedInterviewMs(session.state, now) >= INTERVIEW_BUDGET_MS) fail(409, 'time_limit', 'Время опроса закончилось. Завершите сбор сведений.');
  const [existing, evidence] = await Promise.all([core.store.listAnswers(session.id), core.events(session.id)]);
  // Architecture 4.1: a validated written visitor answer is explicit reported evidence.
  // Voice packets and history recovery keep their separate confirmation requirements.
  const answers = turn.answers.map(answer => ({ ...answer, confirmation: 'explicit' as const }));
  if (answers.some(answer => answer.channel !== 'chat' || !['selection', 'classification'].includes(answer.method))) fail(400, 'invalid_answers', 'Недопустимое происхождение ответа чата.');
  try { validateAnswers(answers, [...evidence, turn.event], existing, lib, core.engineOptions); }
  catch { fail(400, 'invalid_answers', 'Ответ не прошёл проверку словаря или исходного сообщения.'); }
  const state = advanceAudit(session.state, [...existing, ...answers], now, lib, core.engineOptions);
  if (turn.classification?.humor_preference === 'decline') state.humor.enabled = false;
  if (turn.classification?.humor_preference === 'allow') state.humor.enabled = true;
  let serviceText = turn.service_text;
  let jokeId: string | null = null;
  const question = nextQuestion(state, now, lib, core.engineOptions);
  if (['off_topic', 'humor_preference', 'role_change'].includes(turn.action)) {
    const reply = selectHumorReply(state, humorIntent(turn, now), question, lib);
    serviceText = reply.text; jokeId = reply.joke_id;
    if (jokeId) state.humor.reserved_ids.push(jokeId);
    state.humor.operations[turn.input.operation_id] = { ...reply, status: 'reserved' };
  }
  if (turn.action === 'sensitive') serviceText = 'Я услышал Вас. Можно сделать паузу или завершить разговор.';
  const libraryText = serviceText;
  let questionText: string | null = null;
  if (turn.action !== 'sensitive') {
    const approved = APPROVED_TEXT_ACTIONS.includes(turn.action) ? serviceText : null;
    const composed = await composeTurn(context, session, turn.input.operation_id, COMPOSE_ATTEMPT, 8_000, { visitor_text: turn.event.text ?? null,
      // A clarification of the current question would only repeat it; ask for a clearer answer instead.
      approved_text: approved, notice_to_rephrase: approved ? null : serviceText && serviceText === question?.text ? 'Ответ не удалось однозначно понять: попросите уточнить его.' : serviceText,
      question: question ? { text: question.text, options: question.options.map(option => option.text) } : null, history: dialog(evidence),
      previous_replies: await context.core.store.recentReplies(session.id) });
    if (composed) { questionText = composed.question_text; if (!approved) serviceText = composed.reply; }
  }
  // A reaction to a plain answer is shown to the visitor but leaves the answer event untouched.
  const event = { ...turn.event, kind: answers.length ? turn.event.kind : 'service' as const,
    ...(libraryText ? { data: { intent: turn.classification?.intent ?? turn.action, assistant_text: serviceText ?? libraryText } } : {}) };
  validateAuditState(state, lib);
  const result: Json = { text: serviceText, joke_id: jokeId, question_id: turn.action === 'sensitive' ? null : question?.id ?? null, question_text: questionText,
    operation_id: turn.input.operation_id, ...(turn.action === 'sensitive' ? { suppress_question: true } : {}) };
  return core.response(await core.store.commit({ ...common, event, answers, state, result }));
}

/** Wires the channel agent's parser/classifier into the shared authorization and state transaction. */
export function createChatAdapter(): AdapterHandler {
  return createPreparedChatHandler({
    runtime: createChatRuntime, commitTurn: commitChatTurn,
    async context(context, session, lib) {
      const allowed = (entry: { status: string; reviewer?: string | null; approved_at?: string | null }) => isApproved(entry) || (context.core.engineOptions.allowDraft && entry.status === 'draft');
      const faqs = allowed(faqData) ? faqData.items.flatMap(faq => {
        const answer = preparedData.items.find(item => item.id === faq.prepared_answer_id && allowed(item) && !item.diagnostic && item.channels.includes('chat'));
        return answer ? [{ id: faq.id, question: faq.question, answer: answer.text }] : [];
      }) : [];
      const current = nextQuestion(session.state, context.core.now(), lib, context.core.engineOptions);
      const body = object(context.body), operationId = String(body.operation_id);
      const allowedAttemptIds: Record<string, string[]> = {};
      for (const fact of lib.facts.filter(fact => fact.id.endsWith('.history'))) {
        const existing = session.state.facts[fact.id]?.value;
        const attempts = existing && typeof existing === 'object' && !Array.isArray(existing) && Array.isArray(existing.attempts) ? existing.attempts : [];
        allowedAttemptIds[fact.id] = [...attempts.flatMap(attempt => attempt && typeof attempt === 'object' && !Array.isArray(attempt) && typeof attempt.attempt_id === 'string' ? [attempt.attempt_id] : []), `${operationId}:${fact.id}:1`];
      }
      return { faqs, allowedAttemptIds, clarificationQuestions: current ? [{ id: current.id, text: current.text }] : [] };
    },
  });
}

export function createChannelAdapters(): ChannelAdapters { return { chat: createChatAdapter() }; }
export const createChatHandler = createChatAdapter;
export const adapters = createChannelAdapters();
