import { createChatHandler as createPreparedChatHandler, type PreparedChatTurn } from './chat/handler.ts';
import type { ClassifierRuntime } from './chat/types.ts';
import { composeChatMessage, type ComposeInput, type Composed } from './chat/composer.ts';
import { answerQuestion, formatAnswer, NO_ANSWER } from './chat/answerer.ts';
import { checkPersonalName, screenNameAnswers } from './chat/name-check.ts';
import { screenWebsiteAnswers, websiteExists } from './chat/website-check.ts';
import { searchKnowledge } from './search/service.ts';
import type { AdapterContext, AdapterHandler, ChannelAdapters } from './integration.ts';
import type { StoredSession, UsageReservation } from './storage/types.ts';
import { diagnosticStarted, INTERVIEW_BUDGET_MS, type AuditAnswer, type AuditEvent, type AuditState, type Json, type QuestionView } from './audit/contracts.ts';
import { advanceAudit, elapsedInterviewMs, nextQuestion, validateAnswers } from './audit/engine.ts';
import { getLibrary, isApproved, type AuditLibrary } from './audit/library.ts';
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
      await core.store.settleUsage(money.id, measuredDeepseekMicros(exchange.usage, input.model), core.now());
      return exchange;
    },
  };
}

// Classification uses attempts 0 and 1 of an operation; wording takes its own metered attempt.
const COMPOSE_ATTEMPT = 2;
const ANSWER_ATTEMPT = 3;
// The browser waits 30 s for a turn; classification, search, answer and wording share this budget.
const TURN_BUDGET_MS = 24_000;
const NOT_FOUND = 'В материалах Pixel Plus точного ответа на этот вопрос нет. Уточнить детали можно у специалистов студии: https://pixelplus.ru/contact/zakaz/';
// Reworded by DeepSeek; the composer's reply carries no question mark.
const HELP_NOTICE = 'Подскажите, чем могу помочь.';
// Shown when the composer cannot word an explanation of the current question; the question itself stays below.
const EXPLAIN_FALLBACK = 'Ответьте, как понимаете вопрос: подойдёт любой ответ своими словами.';
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
/** The chat as the visitor saw it, for the composer: each message, the reaction to it and the question asked next, oldest first.
 * Only the visitor's messages are events; the reactions and questions live in the turn results. */
type Turn = { text: string; result: Json };
const resultOf = (turn: Turn): Record<string, Json> => turn.result && typeof turn.result === 'object' && !Array.isArray(turn.result) ? turn.result : {};
function shownQuestion(turn: Turn, lib: AuditLibrary): string {
  const result = resultOf(turn);
  if (typeof result.question_text === 'string' && result.question_text.trim()) return result.question_text;
  return typeof result.question_id === 'string' ? lib.questions.find(question => question.id === result.question_id)?.chat ?? '' : '';
}
function chatDialog(turns: Turn[], lib: AuditLibrary): { role: string; text: string }[] {
  return turns.flatMap(turn => {
    const reply = resultOf(turn).text;
    return [{ role: 'user', text: turn.text }, { role: 'assistant', text: typeof reply === 'string' ? reply : '' }, { role: 'assistant', text: shownQuestion(turn, lib) }];
  }).filter(item => item.text.trim()).map(item => ({ role: item.role, text: item.text.slice(0, 400) })).slice(-12);
}
/** The survey question on screen when the visitor wrote: the wording of the latest turn when it asked this question, else the library text. */
function questionOnScreen(id: string | null | undefined, turns: Turn[], lib: AuditLibrary): { id: string; text: string } | null {
  if (!id) return null;
  const last = turns.at(-1);
  const text = last && resultOf(last).question_id === id ? shownQuestion(last, lib) : lib.questions.find(question => question.id === id)?.chat ?? '';
  return text ? { id, text } : null;
}

/** Answers a visitor question from the knowledge base; null when the feature is off or fails, so the turn is never blocked.
 * answered is false for the honest fallbacks (nothing found or no answer in the materials, or only the closest page). */
async function answerFromKnowledge(context: AdapterContext, session: StoredSession, operationId: string, question: string, history: { role: string; text: string }[], timeoutMs: number): Promise<{ text: string; answered: boolean; none?: boolean } | null> {
  if (context.env.KNOWLEDGE_ANSWERS_ENABLED !== 'true' || !question.trim() || timeoutMs < 2_000) return null;
  try {
    const { fragments } = await searchKnowledge(context, session, question.slice(0, 500), { limit: 6, maxChars: 1500 });
    if (!fragments.length) return { text: NOT_FOUND, answered: false, none: true };
    const runtime = await createChatRuntime(context, session, operationId, ANSWER_ATTEMPT);
    const answered = await answerQuestion({ question, fragments, history }, { ...runtime, max_tokens: 900, timeout_ms: timeoutMs });
    // The materials hold no answer: the visitor is told so. The pages found are then only close in wording («Какие работы не делает…»
    // found the FAQ of the 1С page), so no link is offered.
    if (answered === NO_ANSWER) return { text: NOT_FOUND, answered: false, none: true };
    // A failure (provider, format or checks): the closest page is still useful and honest.
    return answered ? { text: formatAnswer(answered), answered: true } : { text: 'Подробнее об этом — на странице «' + fragments[0].title + '»: ' + fragments[0].url, answered: false };
  } catch (error) {
    console.warn(JSON.stringify({ event: 'knowledge_answer_failed', reason: error instanceof Error ? error.message : 'unknown' }));
    return null;
  }
}
/** The voice model's searchKnowledge: DeepSeek V4 Pro writes a short spoken answer from the fragments; null leaves the fragments to the voice model. */
export async function voiceKnowledgeAnswer(context: AdapterContext, session: StoredSession, question: string, fragments: { title: string; heading: string; url: string; text: string }[]): Promise<string | null> {
  if (!fragments.length) return null;
  try {
    const runtime = await createChatRuntime(context, session, `voice-answer:${crypto.randomUUID()}`, ANSWER_ATTEMPT);
    const answered = await answerQuestion({ question, fragments, history: [], channel: 'voice' }, { ...runtime, max_tokens: 600, timeout_ms: 15_000 });
    return answered && answered !== NO_ANSWER ? answered.answer : null;
  } catch (error) {
    console.warn(JSON.stringify({ event: 'voice_knowledge_answer_failed', reason: error instanceof Error ? error.message : 'unknown' }));
    return null;
  }
}
const dialog = (events: AuditEvent[]) => events.filter(event => (event.role === 'user' || event.role === 'assistant') && typeof event.text === 'string' && event.text.trim())
  .slice(-8).map(event => ({ role: event.role, text: event.text!.slice(0, 400) }));

/** Whether the visitor's answer to «Как Вас зовут?» is a person's name; null when the check is unavailable. */
async function checkNameWith(context: AdapterContext, session: StoredSession, operationId: string, text: string): Promise<boolean | null> {
  try { return await checkPersonalName(text, { ...await createChatRuntime(context, session, operationId, 0), max_tokens: 32, timeout_ms: 8_000 }); }
  catch { return null; }
}
/** The name check for voice packets: the same rule as in the chat. */
export async function screenVoiceNameAnswers(input: { core: AdapterContext['core']; session: StoredSession; answers: AuditAnswer[] }): Promise<AuditAnswer[]> {
  return screenNameAnswers(input.answers, text => checkNameWith({ core: input.core, env: input.core.env, execution: {} as ExecutionContext }, input.session, `name-check:${crypto.randomUUID()}`, text));
}

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
  const given = turn.answers.map(answer => ({ ...answer, confirmation: 'explicit' as const }));
  if (given.some(answer => answer.channel !== 'chat' || !['selection', 'classification'].includes(answer.method))) fail(400, 'invalid_answers', 'Недопустимое происхождение ответа чата.');
  // A word that is not a person's name («Собака») is not taken as the visitor's name, and a typed site address with no site behind it
  // is not taken as the site: the key question is asked again.
  const named = await screenNameAnswers(given, text => checkNameWith(context, session, `name-check:${turn.input.operation_id}`, text));
  const answers = await screenWebsiteAnswers(named, host => websiteExists(host, core.fetcher));
  try { validateAnswers(answers, [...evidence, turn.event], existing, lib, core.engineOptions); }
  catch { fail(400, 'invalid_answers', 'Ответ не прошёл проверку словаря или исходного сообщения.'); }
  const state = advanceAudit(session.state, [...existing, ...answers], now, lib, core.engineOptions);
  if (turn.classification?.humor_preference === 'decline') state.humor.enabled = false;
  if (turn.classification?.humor_preference === 'allow') state.humor.enabled = true;
  let serviceText = turn.service_text;
  let jokeId: string | null = null;
  // The visitor asked for the diagnostic: it starts, or continues from the question where it stopped.
  if (turn.action === 'start_diagnostic') {
    serviceText = diagnosticStarted(session.state) ? 'Продолжим экспресс-диагностику.' : 'Начинаем экспресс-диагностику.';
    state.mode = 'diagnostic';
  }
  // A question about services pauses the diagnostic: no survey question until the visitor asks to continue.
  if (turn.action === 'question') state.mode = 'questions';
  let question = nextQuestion(state, now, lib, core.engineOptions);
  state.current_question_id = question?.id ?? null;
  // The visitor asks what the current question means («Какой именно результат?»): the question is explained and asked again;
  // the survey goes on.
  let explain = turn.action === 'clarify' && turn.classification?.intent === 'clarify' && question !== null && state.mode !== 'questions';
  if (explain) serviceText = EXPLAIN_FALLBACK;
  const surveyOn = session.state.mode !== 'questions' && session.state.current_question_id !== null;
  if (['off_topic', 'humor_preference', 'role_change'].includes(turn.action)) {
    const reply = selectHumorReply(state, humorIntent(turn, now), question, lib);
    serviceText = reply.text; jokeId = reply.joke_id;
    if (jokeId) state.humor.reserved_ids.push(jokeId);
    state.humor.operations[turn.input.operation_id] = { ...reply, status: 'reserved' };
  }
  if (turn.action === 'sensitive') serviceText = 'Я услышал Вас. Можно сделать паузу или завершить разговор.';
  const timeLeft = () => turn.started_at + TURN_BUDGET_MS - core.now();
  // A question about services is answered from the knowledge base; a mixed reply also keeps its facts.
  const asksKnowledge = turn.action === 'question' || (turn.classification?.intent === 'mixed' && !turn.service_text);
  if (asksKnowledge) {
    const found = await answerFromKnowledge(context, session, turn.input.operation_id, turn.event.text ?? '', dialog(evidence), Math.min(12_000, timeLeft()));
    // During the survey a question the materials have no answer to is most likely about the survey question itself: it is explained
    // and the survey goes on, rather than «нет ответа» and a pause.
    if (turn.action === 'question' && surveyOn && found?.none) {
      state.mode = session.state.mode;
      question = nextQuestion(state, now, lib, core.engineOptions);
      state.current_question_id = question?.id ?? null;
      explain = question !== null;
    }
    // During the survey a mixed reply shows only a real answer; otherwise its facts get the usual reaction and the next question.
    if (explain) serviceText = EXPLAIN_FALLBACK;
    else if (turn.action === 'question' || state.mode === 'questions') serviceText = found?.text ?? NOT_FOUND;
    else if (found?.answered) serviceText = found.text;
    if (found?.answered && state.mode !== 'questions') { state.mode = 'questions'; question = null; state.current_question_id = null; }
  }
  // In questions mode a message that is not a question and got no library text (a greeting, a name, an unclear remark)
  // gets an offer to help, never a survey prompt and never an empty reply.
  const offerHelp = state.mode === 'questions' && !asksKnowledge && turn.action !== 'sensitive' && (['answer', 'clarify'].includes(turn.action) || !serviceText);
  if (offerHelp) serviceText = HELP_NOTICE;
  // A key question asked again: the visitor first hears why the answer is needed for the report.
  if (question?.reask && !serviceText && ['answer', 'clarify'].includes(turn.action)) serviceText = question.reask.reason;
  const libraryText = serviceText;
  let questionText: string | null = null;
  // The survey question does not change after a pure question, so its earlier wording stays.
  if (turn.action !== 'sensitive' && (turn.action !== 'question' || explain) && timeLeft() > 1_500) {
    const approved = explain ? null : (APPROVED_TEXT_ACTIONS.includes(turn.action) && !offerHelp) || asksKnowledge ? serviceText : null;
    // The composer sees the whole exchange and the question being answered, so its reaction is to this answer, not to an earlier one.
    const turns = await context.core.store.recentTurns(session.id);
    const composed = await composeTurn(context, session, turn.input.operation_id, COMPOSE_ATTEMPT, Math.min(8_000, timeLeft()), { visitor_text: turn.event.text ?? null,
      answered_question: questionOnScreen(session.state.current_question_id, turns, lib), ...(explain ? { explain: true } : {}),
      // A clarification of the current question would only repeat it; ask for a clearer answer instead.
      approved_text: approved, notice_to_rephrase: approved || explain ? null : serviceText && serviceText === question?.text ? 'Ответ не удалось однозначно понять: попросите уточнить его.' : serviceText,
      question: question ? { text: question.text, options: question.options.map(option => option.text), ...(question.reask ? { reask: true } : {}) } : null, history: chatDialog(turns, lib),
      previous_replies: await context.core.store.recentReplies(session.id) });
    // An empty reworded reply keeps the notice it was meant to convey.
    if (composed) { questionText = composed.question_text; if (!approved) serviceText = composed.reply || serviceText; }
  }
  // A reaction to a plain answer is shown to the visitor but leaves the answer event untouched.
  const event = { ...turn.event, kind: answers.length ? turn.event.kind : 'service' as const,
    ...(libraryText ? { data: { intent: turn.classification?.intent ?? turn.action, assistant_text: serviceText ?? libraryText } } : {}) };
  validateAuditState(state, lib);
  const result: Json = { text: serviceText, joke_id: jokeId, question_id: turn.action === 'sensitive' ? null : question?.id ?? null, question_text: questionText,
    operation_id: turn.input.operation_id, ...(turn.action === 'sensitive' ? { suppress_question: true } : {}) };
  return core.response(await core.store.commit({ ...common, event, answers, state, result }));
}

/** Attempt IDs the classifier may use: the saved attempts of each history, plus one new ID only for the first attempt or when the
 * current question asks what was done; otherwise the model would restate the saved attempt under a new ID. */
export function chatAttemptIds(lib: AuditLibrary, state: AuditState, current: QuestionView | null, operationId: string): Record<string, string[]> {
  const asksWork = current !== null && lib.questions.find(question => question.id === current.id)?.fields?.includes('work') === true;
  const ids: Record<string, string[]> = {};
  for (const fact of lib.facts.filter(fact => fact.id.endsWith('.history'))) {
    const existing = state.facts[fact.id]?.value;
    const attempts = existing && typeof existing === 'object' && !Array.isArray(existing) && Array.isArray(existing.attempts) ? existing.attempts : [];
    const saved = attempts.flatMap(attempt => attempt && typeof attempt === 'object' && !Array.isArray(attempt) && typeof attempt.attempt_id === 'string' ? [attempt.attempt_id] : []);
    ids[fact.id] = [...saved, ...(saved.length && !(asksWork && current.fact_ids.includes(fact.id)) ? [] : [`${operationId}:${fact.id}:1`])];
  }
  return ids;
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
      // The classifier sees the chat as the visitor saw it, so «Какой именно результат?» reads as a question about the question on screen.
      const turns = await context.core.store.recentTurns(session.id);
      return { faqs, allowedAttemptIds: chatAttemptIds(lib, session.state, current, operationId), clarificationQuestions: current ? [{ id: current.id, text: current.text }] : [],
        dialog: chatDialog(turns, lib), currentQuestionText: questionOnScreen(current?.id, turns, lib)?.text ?? null };
    },
  });
}

export function createChannelAdapters(): ChannelAdapters { return { chat: createChatAdapter() }; }
export const createChatHandler = createChatAdapter;
export const adapters = createChannelAdapters();
