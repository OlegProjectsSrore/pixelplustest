import type { AuditAnswer, AuditEvent, Json, MutationRequest, QuestionView } from '../audit/contracts.ts';
import { INTERVIEW_BUDGET_MS } from '../audit/contracts.ts';
import { elapsedInterviewMs, nextQuestion } from '../audit/engine.ts';
import { getLibrary, type AuditLibrary } from '../audit/library.ts';
import type { AdapterContext, AdapterHandler } from '../integration.ts';
import type { StoredSession } from '../storage/types.ts';
import { fail, mutation, object, requestHash, textField } from '../security.ts';
import { buildChatContext, type ChatContextInput } from './build-context.ts';
import { classifyTurn } from './classifier.ts';
import type { Classification, ClassifierRuntime } from './types.ts';

export interface PreparedChatTurn {
  input: MutationRequest;
  request_hash: string;
  event: AuditEvent;
  answers: AuditAnswer[];
  classification: Classification | null;
  action: 'answer' | 'clarify' | 'faq' | 'question' | 'off_topic' | 'sensitive' | 'role_change' | 'humor_preference' | 'pause' | 'resume' | 'finish' | 'start_diagnostic';
  /** Only an approved service entry or a deterministic clarification; never a recommendation. */
  service_text: string | null;
  /** When the request started; the core keeps the whole turn within the browser's wait. */
  started_at: number;
}
export interface ChatHandlerDependencies {
  /** Must claim an external attempt atomically and persist its outcome before replay. */
  runtime(context: AdapterContext, session: StoredSession, operationId: string, attempt: number): Promise<ClassifierRuntime>;
  /**
   * The core owns the transaction: validate answers, apply intent, select/reserve a joke,
   * advance the engine and save the reply under input.operation_id + request_hash.
   * It must recheck revision/channel/time after the external request. No partial commits.
   */
  commitTurn(request: Request, context: AdapterContext, session: StoredSession, turn: PreparedChatTurn): Promise<Response | Json>;
  context?(context: AdapterContext, session: StoredSession, lib: AuditLibrary): Promise<Pick<ChatContextInput, 'allowedQuestionIds' | 'allowedAttemptIds' | 'dialog' | 'currentQuestionText'> & {
    faqs?: { id: string; question: string; answer: string }[];
    clarificationQuestions?: { id: string; text: string }[];
  }>;
}
const empty = (): Classification => ({ intent: 'unknown', answers: [], clarification_question_id: null, faq_id: null, joke_category_id: null, humor_preference: null });
/** Key phrases that ask for the diagnostic in any form: «экспресс-диагностика», «аудит бизнеса», «персональный отчёт», «пройти опрос».
 * A question about an SEO or site audit service does not match: it names no business and no survey. */
export const DIAGNOSTIC_REQUEST = /экспресс[\s-]*диагностик|(?:диагностик|аудит)\p{L}*\s+(?:\p{L}+\s+)?бизнес|персональн\p{L}*\s+(?:pdf[\s-]*)?отч[её]т|(?:пройти|начать|продолжить|провести|пройд[её]м|начн[её]м|продолжим|давайте|хочу)\s+(?:\p{L}+\s+)?(?:диагностик|опрос|анкет)/iu;
const clarifyText = 'Не удалось однозначно записать ответ. Пожалуйста, уточните его или выберите подходящий вариант.';

/** Deterministic selection only from the engine's current question. No model is involved. */
export function selectionAnswers(input: unknown, question: QuestionView, lib: AuditLibrary, event: AuditEvent, now: number): AuditAnswer[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 32 || !input.every(item => typeof item === 'string') || new Set(input).size !== input.length) fail(400, 'invalid_selection', 'Выберите предложенные варианты без повторений.');
  const optionIds = input as string[], optionId = optionIds[0];
  if (optionIds.some(id => !question.options.some(option => option.id === id))) fail(400, 'invalid_selection', 'Вариант не принадлежит текущему вопросу.');
  const definitions = question.fact_ids.map(id => lib.facts.find(fact => fact.id === id)).filter(fact => fact !== undefined);
  const matches = definitions.filter(fact => fact.values?.some(option => option.id === optionId));
  const priority = question.id === 'context_priority' && question.fact_ids.includes('context.priority') && optionIds.every(id => lib.domains.some(domain => domain.id === id));
  if (!priority && optionIds.length !== 1) fail(400, 'invalid_selection', 'Для этого вопроса выберите один вариант.');
  if (!priority && matches.length !== 1) fail(400, 'ambiguous_selection', 'Вариант нельзя однозначно сопоставить с фактом.');
  return [{ id: crypto.randomUUID(), question_id: question.id, fact_id: priority ? 'context.priority' : matches[0].id,
    ...(optionIds.length === 1 ? { answer_id: optionId } : {}), state: 'known', value: priority ? [...optionIds] : optionId,
    event_ids: [event.id], channel: 'chat', method: 'selection', confirmation: 'explicit', library_version: lib.version, created_at: now }];
}

export function createChatHandler(dependencies: ChatHandlerDependencies): AdapterHandler {
  if (typeof dependencies?.runtime !== 'function' || typeof dependencies?.commitTurn !== 'function') {
    throw new Error('Chat handler requires runtime and atomic commitTurn dependencies');
  }
  return async (request, context) => {
    const body = object(context.body), input = mutation(body), core = context.core, startedAt = core.now();
    // Do not rely on a caller-provided session object for access control.
    const session = await core.authenticate(request, input.session_id);
    if (input.library_version !== session.state.library_version) fail(409, 'library_mismatch', 'Версия библиотеки изменилась.');
    const hash = await requestHash(body);
    const previous = await core.store.getOperation(session.id, input.operation_id);
    if (previous) {
      if (previous.requestHash !== hash) fail(409, 'operation_reused', 'Идентификатор операции уже использован для другого запроса.');
      return { kind: 'duplicate', operation: previous.result, session: await core.view(session) };
    }
    if (input.expected_revision !== session.state.revision || input.channel_revision !== session.state.channel_revision) fail(409, 'revision_conflict', 'Состояние изменилось. Обновите опрос.');
    if (session.state.active_channel !== 'chat') fail(409, 'channel_conflict', 'Активен другой канал.');
    if (session.state.status !== 'in_progress') fail(409, 'interview_closed', 'Сбор сведений уже завершён.');
    if (elapsedInterviewMs(session.state, core.now()) >= INTERVIEW_BUDGET_MS) fail(409, 'time_limit', 'Время опроса закончилось. Завершите сбор сведений.');
    const lib = getLibrary(input.library_version);
    const question = nextQuestion(session.state, core.now(), lib, core.engineOptions);
    if (body.question_id !== (question?.id ?? null)) fail(409, 'question_conflict', 'Текущий вопрос изменился.');
    const content = object(body.input), now = core.now();
    if (Object.keys(content).some(key => !['kind', 'text', 'option_ids'].includes(key))) fail(400, 'invalid_input', 'Неизвестное поле ответа.');
    const event: AuditEvent = { id: crypto.randomUUID(), source: 'chat', source_key: input.operation_id, source_revision: 0,
      local_order: 0, role: 'user', kind: 'utterance', occurred_at: now, received_at: now };
    let classification: Classification | null = null, answers: AuditAnswer[] = [], serviceText: string | null = null;
    let action: PreparedChatTurn['action'] = 'answer';
    if (content.kind === 'selection') {
      if (session.state.paused || !question || content.text !== undefined) fail(400, 'invalid_selection', 'Сейчас нельзя выбрать вариант ответа.');
      answers = selectionAnswers(content.option_ids, question!, lib, event, now);
      event.kind = 'answer';
      const selectedIds = content.option_ids as string[];
      event.text = selectedIds.map(id => question!.options.find(option => option.id === id)!.text).join(', ');
      event.data = { question_id: question!.id, option_ids: [...selectedIds] };
    } else if (content.kind === 'text') {
      if (content.option_ids !== undefined) fail(400, 'invalid_input', 'Ответ содержит несовместимые поля.');
      event.text = textField(content.text, 'input.text', 10000);
      const [events, existingAnswers, extras] = await Promise.all([
        core.store.listEvents(session.id, 0, 1000), core.store.listAnswers(session.id), dependencies.context?.(context, session, lib) ?? Promise.resolve({}),
      ]);
      const modelContext = buildChatContext({ lib, state: session.state, events, existingAnswers, currentQuestion: question,
        sourceEvents: [event], allowDraft: core.engineOptions.allowDraft, ...extras });
      const runAttempt = async (current: StoredSession, attempt: number) => {
        const remaining = () => INTERVIEW_BUDGET_MS - elapsedInterviewMs(current.state, core.now());
        if (remaining() <= 0) fail(409, 'time_limit', 'Время опроса закончилось. Завершите сбор сведений.');
        const runtime = await dependencies.runtime(context, current, input.operation_id, attempt);
        const timeLeft = remaining();
        if (timeLeft <= 0) fail(409, 'time_limit', 'Время опроса закончилось. Завершите сбор сведений.');
        return classifyTurn(modelContext, { ...runtime, timeout_ms: Math.min(runtime.timeout_ms, timeLeft) });
      };
      let result = await runAttempt(session, 0);
      // Only an invalid, completed response permits a second metered attempt here.
      // Unknown/network outcomes are reconciled by the core; never blindly repeat them.
      if (!result.ok && result.error.code === 'provider_output' && result.error.retryable) {
        const refreshed = await core.authenticate(request, input.session_id);
        const completed = await core.store.getOperation(session.id, input.operation_id);
        if (completed) {
          if (completed.requestHash !== hash) fail(409, 'operation_reused', 'Идентификатор операции уже использован для другого запроса.');
          return { kind: 'duplicate', operation: completed.result, session: await core.view(refreshed) };
        }
        if (refreshed.state.revision !== input.expected_revision || refreshed.state.channel_revision !== input.channel_revision) fail(409, 'revision_conflict', 'Состояние изменилось. Обновите опрос.');
        if (refreshed.state.library_version !== input.library_version || refreshed.state.active_channel !== 'chat' || refreshed.state.status !== 'in_progress' || refreshed.state.paused !== session.state.paused) fail(409, 'channel_conflict', 'Состояние общения изменилось.');
        if (elapsedInterviewMs(refreshed.state, core.now()) >= INTERVIEW_BUDGET_MS) fail(409, 'time_limit', 'Время опроса закончилось. Завершите сбор сведений.');
        result = await runAttempt(refreshed, 1);
      }
      if (!result.ok && result.error.code !== 'provider_output') fail(503, result.error.code, 'Не удалось обработать ответ. Ваш текст сохранён в браузере.', result.error.retryable);
      classification = result.ok ? result.classification : empty();
      const currentClassification = classification;
      answers = currentClassification.answers.map(candidate => {
        const { evidence: _evidence, ...accepted } = candidate;
        return { ...accepted, id: crypto.randomUUID(), channel: 'chat', method: 'classification',
          confirmation: 'unconfirmed', library_version: lib.version, created_at: now };
      });
      if (answers.some(answer => answer.replaces_answer_id)) event.kind = 'correction';
      const intent = currentClassification.intent;
      action = intent === 'mixed' || intent === 'decline' ? 'answer' : intent === 'unknown' ? 'clarify' : intent;
      if (intent === 'decline' && !answers.length) {
        // The intent alone does not identify which facts the visitor declined.
        // Keep the utterance, but do not manufacture one answer per question fact.
        action = 'clarify';
        serviceText = 'Вы можете пропустить вопрос или завершить опрос. Уточните, как продолжить.';
      }
      const catalog = extras as Awaited<ReturnType<NonNullable<ChatHandlerDependencies['context']>>>;
      if (currentClassification.faq_id) serviceText = catalog.faqs?.find(item => item.id === currentClassification.faq_id)?.answer ?? null;
      if (currentClassification.clarification_question_id) serviceText = catalog.clarificationQuestions?.find(item => item.id === currentClassification.clarification_question_id)?.text ?? null;
      if (action === 'clarify' && serviceText === null) serviceText = clarifyText;
      // Key phrases back the classifier up when it did not recognise the request for the diagnostic.
      if (!answers.length && (['clarify', 'off_topic'].includes(action) || (action === 'resume' && !session.state.paused)) && DIAGNOSTIC_REQUEST.test(event.text ?? '')) {
        action = 'start_diagnostic'; serviceText = null;
      }
      if (session.state.paused && !['resume', 'finish'].includes(action)) fail(409, 'session_paused', 'Сначала возобновите опрос.');
    } else fail(400, 'invalid_input', 'Неизвестный вид ответа.');
    return dependencies.commitTurn(request, context, session, { input, request_hash: hash, event, answers, classification, action, service_text: serviceText, started_at: startedAt });
  };
}
