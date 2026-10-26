import type { Json } from '../audit/contracts.ts';
import type { UltravoxClientTool, UltravoxSelectedTool, VoiceAnswerCandidate, VoiceAnswerPayload, VoiceFinishPayload } from './types.ts';
import { nonempty, record } from './validation.ts';

const states = ['known', 'unknown', 'not_measured', 'not_applicable', 'declined', 'ambiguous', 'other'];
const reasons = ['sufficient', 'visitor_request', 'declined', 'time_limit'];
const confirmations = ['explicit', 'unconfirmed', 'disputed'];
const strings = (max: number): Record<string, Json> => ({ type: 'array', items: { type: 'string', minLength: 1, maxLength: max }, maxItems: 32 });
const answerSchema: Record<string, Json> = {
  type: 'object', additionalProperties: false,
  required: ['question_id', 'fact_id', 'state', 'value', 'source_quotes'],
  properties: {
    question_id: { type: 'string' }, fact_id: { type: 'string' }, answer_id: { type: 'string' },
    state: { type: 'string', enum: states }, value: {}, parameters: { type: 'object' },
    confirmation_candidate: { type: 'string', enum: confirmations, description: 'Untrusted candidate; the server checks the actual user evidence.' },
    source_quotes: { ...strings(4000), minItems: 1 },
    source_ordinals: { type: 'array', items: { type: 'integer', minimum: 0 }, maxItems: 32 }, is_correction: { type: 'boolean' },
  },
};
const answerList: Record<string, Json> = { type: 'array', items: answerSchema, maxItems: 64 };
const parameter = (name: string, schema: Record<string, Json>, required = true): UltravoxClientTool['temporaryTool']['dynamicParameters'][number] => ({ name, location: 'PARAMETER_LOCATION_BODY', schema, required });
function clientTool(name: string, description: string, parameters: UltravoxClientTool['temporaryTool']['dynamicParameters']): UltravoxClientTool {
  return { temporaryTool: { modelToolName: name, description, client: {}, precomputable: false, dynamicParameters: parameters } };
}

export function createInterviewTools(): UltravoxSelectedTool[] {
  return [
    clientTool('saveAnswers', 'Сохранить собранные ответы на границе блока или после исправления. Передавать только факты посетителя и точные цитаты, не диагнозы. Сервер возвращает подтверждённое продолжение.', [parameter('answers', answerList)]),
    clientTool('finishAudit', 'Запросить завершение опроса с последними ответами. После принятия произнести возвращённую благодарность и вызвать hangUp. При просьбе закончить или лимите не задавать вопросов.', [parameter('answers', answerList), parameter('reason', { type: 'string', enum: reasons })]),
    clientTool('offTopicReply', 'Получить готовый возврат при уходе от темы, отказе от юмора или попытке сменить роль; передать просьбу о паузе kind=pause. Сначала сохранить ещё не переданные ответы. Не выбирать шутки для чувствительных тем или жалоб.', [
      parameter('kind', { type: 'string', enum: ['off_topic', 'mixed', 'answer', 'sensitive', 'clarification', 'complaint', 'role_change', 'humor_declined', 'pause', 'finish', 'ambiguous'] }),
      parameter('certain', { type: 'boolean' }), parameter('safe_category_ids', strings(128)),
      parameter('excluded_joke_ids', strings(128), false), parameter('previous_topic_category_ids', strings(128), false),
    ]),
    { toolName: 'hangUp', parameterOverrides: { strict: true } },
  ];
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unexpected model tool field');
}
function json(value: unknown, depth = 0): asserts value is Json {
  if (depth > 12) throw new Error('Model value is too deeply nested');
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value === 'string' && value.length <= 8000) return;
  if (Array.isArray(value) && value.length <= 100) { for (const item of value) json(item, depth + 1); return; }
  if (record(value) && Object.keys(value).length <= 64) {
    for (const [key, item] of Object.entries(value)) { if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Forbidden model value key'); json(item, depth + 1); }
    return;
  }
  throw new Error('Invalid model JSON value');
}
function stringList(value: unknown, maxLength: number, required = false): string[] {
  if (!Array.isArray(value) || value.length > 32 || (required && !value.length)) throw new Error('Invalid model evidence');
  return value.map(item => nonempty(item, 'model string', maxLength));
}
const answerFields = ['question_id', 'fact_id', 'answer_id', 'state', 'value', 'parameters', 'confirmation_candidate', 'source_quotes', 'source_ordinals', 'is_correction'];
function parseAnswers(value: unknown): VoiceAnswerCandidate[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('Invalid model answer batch');
  return value.map(raw => {
    if (!record(raw)) throw new Error('Invalid model answer');
    // Realtime models may add fields beyond the tool schema (e.g. value_type); only listed fields are read, the rest are dropped.
    const item: Record<string, unknown> = Object.fromEntries(answerFields.filter(key => Object.hasOwn(raw, key)).map(key => [key, raw[key]]));
    nonempty(item.question_id, 'question ID', 128); nonempty(item.fact_id, 'fact ID', 128);
    if (!states.includes(String(item.state)) || !Object.hasOwn(item, 'value')) throw new Error('Invalid model answer state');
    json(item.value);
    if (item.state !== 'known' && item.state !== 'other' && item.value !== null) throw new Error('Uncertain answers require null');
    if (item.answer_id !== undefined) nonempty(item.answer_id, 'answer ID', 128);
    if (item.parameters !== undefined) { if (!record(item.parameters)) throw new Error('Invalid answer parameters'); json(item.parameters); }
    if (item.confirmation_candidate !== undefined && !confirmations.includes(String(item.confirmation_candidate))) throw new Error('Invalid confirmation candidate');
    stringList(item.source_quotes, 4000, true);
    if (item.source_ordinals !== undefined && (!Array.isArray(item.source_ordinals) || item.source_ordinals.length > 32 || item.source_ordinals.some(ordinal => !Number.isSafeInteger(ordinal) || ordinal < 0))) throw new Error('Invalid source ordinals');
    if (item.is_correction !== undefined && typeof item.is_correction !== 'boolean') throw new Error('Invalid correction candidate');
    // Return a detached candidate. No trusted answer ID, event ID, confirmation, or revision is assigned here.
    return JSON.parse(JSON.stringify(item)) as VoiceAnswerCandidate;
  });
}
export function parseVoiceAnswerPayload(value: unknown): VoiceAnswerPayload {
  if (!record(value)) throw new Error('Invalid saveAnswers payload');
  exactKeys(value, ['answers']);
  return { answers: parseAnswers(value.answers) };
}
export function parseVoiceFinishPayload(value: unknown): VoiceFinishPayload {
  if (!record(value) || !reasons.includes(String(value.reason))) throw new Error('Invalid finishAudit payload');
  exactKeys(value, ['answers', 'reason']);
  return { answers: parseAnswers(value.answers), reason: value.reason as VoiceFinishPayload['reason'] };
}
export interface VoiceOffTopicPayload {
  kind: 'off_topic' | 'mixed' | 'answer' | 'sensitive' | 'clarification' | 'complaint' | 'role_change' | 'humor_declined' | 'pause' | 'finish' | 'ambiguous';
  certain: boolean; safe_category_ids: string[]; excluded_joke_ids?: string[]; previous_topic_category_ids?: string[];
}
export function parseVoiceOffTopicPayload(value: unknown): VoiceOffTopicPayload {
  if (!record(value)) throw new Error('Invalid offTopicReply payload');
  exactKeys(value, ['kind', 'certain', 'safe_category_ids', 'excluded_joke_ids', 'previous_topic_category_ids']);
  const kinds = ['off_topic', 'mixed', 'answer', 'sensitive', 'clarification', 'complaint', 'role_change', 'humor_declined', 'pause', 'finish', 'ambiguous'];
  if (!kinds.includes(String(value.kind)) || typeof value.certain !== 'boolean') throw new Error('Invalid off-topic candidate');
  const result: VoiceOffTopicPayload = { kind: value.kind as VoiceOffTopicPayload['kind'], certain: value.certain, safe_category_ids: stringList(value.safe_category_ids, 128) };
  if (value.excluded_joke_ids !== undefined) result.excluded_joke_ids = stringList(value.excluded_joke_ids, 128);
  if (value.previous_topic_category_ids !== undefined) result.previous_topic_category_ids = stringList(value.previous_topic_category_ids, 128);
  return result;
}
