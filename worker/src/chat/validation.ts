import type { FactStatus, Json } from '../audit/contracts.ts';
import { INTENTS, type AnswerCandidate, type Classification, type ClassifierContext, type ValueSchema } from './types.ts';

export class ClassificationValidationError extends Error {
  readonly path: string;
  constructor(path: string) {
    // Deliberately omit model output and visitor text from error messages.
    super(`Invalid classifier output at ${path}`);
    this.path = path;
    this.name = 'ClassificationValidationError';
  }
}
function fail(path: string): never { throw new ClassificationValidationError(path); }
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const own = (v: object, key: string) => Object.prototype.hasOwnProperty.call(v, key);
function keys(v: unknown, required: string[], optional: string[], path: string): asserts v is Record<string, unknown> {
  if (!record(v) || required.some(k => !own(v, k)) || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) fail(path);
}
function text(v: unknown, path: string, limit = 10000): asserts v is string {
  if (typeof v !== 'string' || !v.trim() || v.length > limit) fail(path);
}
function json(v: unknown, path: string, depth = 0): asserts v is Json {
  if (depth > 12) fail(path);
  if (v === null || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 8000)) return;
  if (typeof v === 'number' && Number.isFinite(v)) return;
  if (Array.isArray(v)) {
    if (v.length > 100) fail(path);
    v.forEach((x, i) => json(x, `${path}[${i}]`, depth + 1)); return;
  }
  if (!record(v) || Object.keys(v).length > 64) fail(path);
  for (const [k, x] of Object.entries(v)) {
    if (['__proto__', 'prototype', 'constructor'].includes(k)) fail(path);
    json(x, `${path}.${k}`, depth + 1);
  }
}
function matches(v: Json, schema: ValueSchema, depth = 0): boolean {
  if (depth > 16) return false;
  switch (schema.type) {
    case 'null': return v === null;
    case 'boolean': return typeof v === 'boolean';
    case 'number': return typeof v === 'number' && Number.isFinite(v) && (schema.minimum === undefined || v >= schema.minimum) && (schema.maximum === undefined || v <= schema.maximum);
    case 'string': return typeof v === 'string' && v.length <= (schema.max_length ?? 10000) && (!schema.enum || schema.enum.includes(v));
    case 'array': return Array.isArray(v) && v.length <= (schema.max_items ?? 100) && v.every(item => matches(item, schema.items, depth + 1));
    case 'object': return record(v) && Object.keys(v).every(k => own(schema.properties, k) && matches(v[k] as Json, schema.properties[k], depth + 1)) && (schema.required ?? []).every(k => own(v, k));
    case 'union': return schema.any_of.some(s => matches(v, s, depth + 1));
  }
}
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  return record(a) && record(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => own(b, k) && equal(a[k], b[k]));
}
function checkAttempts(value: Json, allowed: readonly string[], path: string): void {
  if (Array.isArray(value)) { value.forEach((v, i) => checkAttempts(v, allowed, `${path}[${i}]`)); return; }
  if (!record(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'attempts') {
      if (!Array.isArray(child)) fail(`${path}.attempts`);
      const seen = new Set<string>();
      for (const item of child) {
        if (!record(item) || typeof item.attempt_id !== 'string' || !allowed.includes(item.attempt_id) || seen.has(item.attempt_id)) fail(`${path}.attempts.attempt_id`);
        seen.add(item.attempt_id);
      }
    }
    checkAttempts(child as Json, allowed, `${path}.${key}`);
  }
}
const STATES: readonly FactStatus[] = ['known', 'unknown', 'not_measured', 'not_applicable', 'declined', 'ambiguous', 'other'];

/** Validation does not establish truth or merge facts; it produces uncommitted candidates. */
export function parseClassification(payload: unknown, context: ClassifierContext): Classification {
  let value: unknown = payload;
  if (typeof value === 'string') {
    if (!value.trim() || value.length > 131072) fail('$');
    try { value = JSON.parse(value); } catch { fail('$'); }
  }
  keys(value, ['intent', 'answers', 'clarification_question_id', 'faq_id', 'joke_category_id', 'humor_preference'], [], '$');
  if (!(INTENTS as readonly unknown[]).includes(value.intent)) fail('intent');
  if (!Array.isArray(value.answers) || value.answers.length > 50) fail('answers');
  if (value.humor_preference !== null && value.humor_preference !== 'allow' && value.humor_preference !== 'decline') fail('humor_preference');
  for (const [key, allowed] of [
    ['clarification_question_id', context.clarification_questions],
    ['faq_id', context.faqs],
    ['joke_category_id', context.joke_categories],
  ] as const) {
    if (value[key] !== null && (typeof value[key] !== 'string' || !allowed.some(x => x.id === value[key]))) fail(key);
  }
  if (value.joke_category_id !== null && (value.intent !== 'off_topic' || !context.humor_enabled || value.humor_preference !== null)) fail('joke_category_id');
  if (value.faq_id !== null && !['faq', 'mixed'].includes(value.intent as string)) fail('faq_id');
  if (value.clarification_question_id !== null && !['answer', 'mixed', 'clarify', 'unknown', 'decline'].includes(value.intent as string)) fail('clarification_question_id');
  if (value.answers.length > 0 && !['answer', 'mixed', 'decline'].includes(value.intent as string)) fail('answers');
  if (value.intent === 'answer' && value.answers.length === 0) fail('answers');
  if (value.intent === 'humor_preference' && value.humor_preference === null) fail('humor_preference');

  const answers: AnswerCandidate[] = [];
  value.answers.forEach((candidate: unknown, i: number) => {
    const path = `answers[${i}]`;
    keys(candidate, ['question_id', 'fact_id', 'state', 'value', 'event_ids', 'evidence'], ['answer_id', 'parameters', 'replaces_answer_id'], path);
    text(candidate.question_id, `${path}.question_id`, 200); text(candidate.fact_id, `${path}.fact_id`, 200);
    const question = context.questions.find(q => q.id === candidate.question_id);
    const fact = context.facts.find(f => f.id === candidate.fact_id);
    if (!question || !fact || !question.fact_ids.includes(fact.id)) fail(`${path}.fact_id`);
    if (!STATES.includes(candidate.state as FactStatus) || !fact.states.includes(candidate.state as string)) fail(`${path}.state`);
    if (value.intent === 'decline' && candidate.state !== 'declined') fail(`${path}.state`);
    json(candidate.value, `${path}.value`);
    if (candidate.state === 'known') {
      if (candidate.value === null || !matches(candidate.value, fact.value_schema)) fail(`${path}.value`);
      if (fact.value_type === 'text') text(candidate.value, `${path}.value`, 8000);
      if (fact.value_type === 'string_list' && (!Array.isArray(candidate.value) || candidate.value.length === 0 || !candidate.value.every(item => typeof item === 'string' && item.trim().length > 0))) fail(`${path}.value`);
      if (fact.value_type === 'object' && (!record(candidate.value) || Object.keys(candidate.value).length === 0)) fail(`${path}.value`);
      if (fact.value_type === 'enum' && !own(candidate, 'answer_id')) fail(`${path}.answer_id`);
    } else if (candidate.state === 'other') {
      text(candidate.value, `${path}.value`);
    } else if (candidate.value !== null) fail(`${path}.value`);
    checkAttempts(candidate.value, fact.allowed_attempt_ids ?? [], `${path}.value`);
    if (own(candidate, 'answer_id')) {
      text(candidate.answer_id, `${path}.answer_id`, 200);
      const allowed = context.allowed_answers.find(a => a.id === candidate.answer_id && a.question_id === question.id && a.fact_id === fact.id);
      if (!allowed || allowed.question_id !== question.id || allowed.fact_id !== fact.id || allowed.state !== candidate.state || !equal(allowed.value, candidate.value)) fail(`${path}.answer_id`);
    }
    if (own(candidate, 'parameters')) {
      json(candidate.parameters, `${path}.parameters`);
      if (!record(candidate.parameters) || !matches(candidate.parameters, fact.parameters_schema ?? { type: 'object', properties: {} })) fail(`${path}.parameters`);
    }
    if (!Array.isArray(candidate.event_ids) || candidate.event_ids.length === 0 || candidate.event_ids.length > 32 || new Set(candidate.event_ids).size !== candidate.event_ids.length) fail(`${path}.event_ids`);
    const ids = candidate.event_ids as unknown[];
    for (const id of ids) {
      text(id, `${path}.event_ids`, 200);
      if (!context.source_events.some(e => e.id === id && e.role === 'user' && typeof e.text === 'string')) fail(`${path}.event_ids`);
    }
    if (!Array.isArray(candidate.evidence) || candidate.evidence.length === 0 || candidate.evidence.length > 100) fail(`${path}.evidence`);
    const evidenceIds = new Set<string>();
    for (const item of candidate.evidence) {
      keys(item, ['event_id', 'text'], [], `${path}.evidence`);
      text(item.event_id, `${path}.evidence.event_id`, 200); text(item.text, `${path}.evidence.text`);
      const source = context.source_events.find(e => e.id === item.event_id && e.role === 'user');
      if (!ids.includes(item.event_id) || !source?.text?.includes(item.text)) fail(`${path}.evidence`);
      evidenceIds.add(item.event_id);
    }
    if (ids.some(id => !evidenceIds.has(id as string))) fail(`${path}.evidence`);
    if (own(candidate, 'replaces_answer_id')) {
      text(candidate.replaces_answer_id, `${path}.replaces_answer_id`, 200);
      const previous = context.correctable_answers.find(a => a.id === candidate.replaces_answer_id && a.fact_id === fact.id);
      if (!previous || !ids.some(id => !previous.event_ids.includes(id as string))) fail(`${path}.replaces_answer_id`);
    }
    if (answers.some(a => equal(a, candidate))) fail(path);
    // Clone to prevent a later caller mutation from changing the validated candidate.
    answers.push(JSON.parse(JSON.stringify(candidate)) as AnswerCandidate);
  });
  return { intent: value.intent as Classification['intent'], answers, clarification_question_id: value.clarification_question_id as string | null, faq_id: value.faq_id as string | null, joke_category_id: value.joke_category_id as string | null, humor_preference: value.humor_preference as Classification['humor_preference'] };
}
