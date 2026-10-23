import type { AuditAnswer, AuditEvent, AuditState, QuestionView } from '../audit/contracts.ts';
import { isApproved, type AuditLibrary, type FactDefinition, type Question } from '../audit/library.ts';
import type { AllowedAnswer, ClassifierContext, ClassifierFact, ValueSchema } from './types.ts';

export interface ChatContextInput {
  lib: AuditLibrary;
  state: AuditState;
  events: readonly AuditEvent[];
  existingAnswers: readonly AuditAnswer[];
  currentQuestion: Pick<Question | QuestionView, 'id'> | null;
  mode?: 'chat' | 'voice_recovery';
  sourceEvents: readonly AuditEvent[];
  allowDraft?: boolean;
  /** Core-selected additional questions. No question or fact is selected by the model. */
  allowedQuestionIds?: readonly string[];
  /** Caller supplies only core-approved service entries. */
  faqs?: readonly { id: string; question: string }[];
  clarificationQuestions?: readonly { id: string; text: string }[];
  allowedAttemptIds?: Readonly<Record<string, readonly string[]>>;
}
const STATES = ['known', 'unknown', 'not_measured', 'not_applicable', 'declined', 'ambiguous', 'other'];
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => Array.isArray(v) && v.every(x => typeof x === 'string') ? v : [];
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
function permitted(v: unknown, allowDraft: boolean): boolean {
  return record(v) && typeof v.status === 'string' && (isApproved(v as { status: string; reviewer?: string; approved_at?: string }) || (allowDraft && ['draft', 'in_review'].includes(v.status)));
}
function vocabulary(fact: FactDefinition): { id: string; label: string }[] {
  const values: unknown = fact.values;
  // Strings without IDs are not silently promoted to the {id,label} contract.
  if (!Array.isArray(values) || values.length === 0 || !values.every(v => record(v) && nonempty(v.id) && nonempty(v.label))) return [];
  const result = values as { id: string; label: string }[];
  return new Set(result.map(v => v.id)).size === result.length ? result : [];
}

/** Only explicit primitive/enum/array/object declarations are interpreted as types. */
function fieldSchema(value: unknown, depth = 0): ValueSchema | null {
  if (depth > 8) return null;
  if (value === 'string') return { type: 'string', max_length: 8000 };
  if (value === 'number') return { type: 'number' };
  if (value === 'boolean') return { type: 'boolean' };
  if (value === 'null') return { type: 'null' };
  if (Array.isArray(value) && value.length && value.every(nonempty)) return { type: 'string', enum: value };
  if (!record(value)) return null;
  if (value.type === 'array' && Object.keys(value).every(k => ['type', 'item', 'items'].includes(k))) {
    const item = fieldSchema(value.items ?? value.item, depth + 1);
    return item ? { type: 'array', items: item } : null;
  }
  if (value.type === 'object' && record(value.properties)) {
    if (Object.keys(value).some(k => !['type', 'properties', 'required'].includes(k))) return null;
    const fields = objectSchema(value.properties, depth + 1);
    const required = value.required === undefined ? [] : strings(value.required);
    if (!fields || (value.required !== undefined && (!Array.isArray(value.required) || !value.required.every(nonempty))) || required.some(k => !Object.hasOwn(fields.properties, k))) return null;
    return { ...fields, ...(required.length ? { required } : {}) };
  }
  // A named fields object is an explicit structure. Natural-language descriptions
  // and example_schema content fail projection instead of becoming invented types.
  if (!Object.hasOwn(value, 'type')) return objectSchema(value, depth + 1);
  if (value.type === 'string' && Object.keys(value).every(k => ['type', 'enum'].includes(k))) {
    const values = value.enum === undefined ? undefined : strings(value.enum);
    return value.enum !== undefined && !values?.length ? null : { type: 'string', ...(values ? { enum: values } : {}) };
  }
  if ((value.type === 'number' || value.type === 'boolean' || value.type === 'null') && Object.keys(value).length === 1) return { type: value.type };
  return null;
}
function objectSchema(fields: Record<string, unknown>, depth = 0): Extract<ValueSchema, { type: 'object' }> | null {
  if (!Object.keys(fields).length || depth > 8) return null;
  const properties: Record<string, ValueSchema> = Object.create(null);
  for (const [key, definition] of Object.entries(fields)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) return null;
    const schema = fieldSchema(definition, depth + 1);
    if (!schema) return null;
    properties[key] = schema;
  }
  return { type: 'object', properties };
}
function projectFact(fact: FactDefinition, attemptIds?: readonly string[]): ClassifierFact {
  let schema: ValueSchema | null = null;
  if (fact.value_type === 'text') schema = { type: 'string', max_length: 8000 };
  if (fact.value_type === 'boolean') schema = { type: 'boolean' };
  if (fact.value_type === 'string_list') schema = { type: 'array', items: { type: 'string', max_length: 8000 } };
  if (fact.value_type === 'enum') {
    const values = vocabulary(fact);
    if (values.length) schema = { type: 'string', enum: values.map(v => v.id) };
  }
  if (fact.value_type === 'object' && record(fact.fields)) schema = objectSchema(fact.fields);
  if (fact.runtime_schema) schema = fact.runtime_schema;
  // Money/period and structures need explicit field types, not just an example.
  // Unsupported known values remain verbatim 'other', never guessed object schemas.
  return {
    id: fact.id, label: fact.label, value_type: fact.value_type,
    states: fact.states.filter(s => STATES.includes(s) && (schema !== null || s !== 'known')),
    value_schema: schema ?? { type: 'null' },
    ...(attemptIds ? { allowed_attempt_ids: [...attemptIds] } : {}),
  };
}

/** Projects a core-pinned library; it never imports data files or diagnostic blocks itself. */
export function buildChatContext(input: ChatContextInput): ClassifierContext {
  const { lib, state, events, existingAnswers, currentQuestion, sourceEvents } = input;
  const mode = input.mode ?? 'chat', allowDraft = input.allowDraft === true;
  if (state.library_version !== lib.version) throw new Error('Classifier library version mismatch');
  const availableFacts = new Map(lib.facts.filter(f => permitted(f, allowDraft)).map(f => [f.id, f]));
  const availableQuestions = lib.questions.filter(q => permitted(q, allowDraft));
  const wanted = new Set(input.allowedQuestionIds ?? [
    ...availableQuestions.filter(q => q.phase === 'orientation').map(q => q.id),
    ...existingAnswers.filter(a => a.library_version === lib.version).map(a => a.question_id),
  ]);
  if (currentQuestion) {
    const q = availableQuestions.find(q => q.id === currentQuestion.id);
    if (!q || q.fact_ids.some(id => !availableFacts.has(id))) throw new Error('Current question or fact is not approved/available');
    wanted.add(currentQuestion.id);
  }
  const questions = availableQuestions.filter(q => wanted.has(q.id) && q.fact_ids.every(id => availableFacts.has(id)));
  const factIds = new Set(questions.flatMap(q => q.fact_ids));
  const facts = [...factIds].map(id => projectFact(availableFacts.get(id)!, input.allowedAttemptIds?.[id]));
  const mappingRules = [
    'Сохранять все явно сообщённые факты; не выводить причины, бюджет и согласие из намерения.',
    'Схема неустановленного типа не даёт права генерировать объект. Для сообщённого содержательного значения используй other с исходным смыслом, unknown только для явного незнания.',
  ];
  const allowedAnswers: AllowedAnswer[] = [];
  for (const question of questions) for (const factId of question.fact_ids) {
    const definition = availableFacts.get(factId)!;
    const group = lib.answers.find(group => group.fact_id === factId && permitted(group, allowDraft));
    const rawGroup: Record<string, unknown> = record(group) ? group : {};
    const rawFact: unknown = definition;
    if (record(rawFact) && nonempty(rawFact.normalization)) mappingRules.push(`${factId}: ${rawFact.normalization}`);
    if (nonempty(rawGroup.bare_yes_no)) mappingRules.push(`${factId}: ${rawGroup.bare_yes_no}`);
    if (!facts.find(f => f.id === factId)?.states.includes('known')) mappingRules.push(`${factId}: нет надёжной схемы известного значения; не создавай структуру, сохрани сообщение как other или явную неизвестность.`);
    for (const option of vocabulary(definition)) {
      const clause = group?.standard_values.find(v => v.value === option.id);
      const rawClause: Record<string, unknown> = record(clause) ? clause : {};
      const boundary = record(rawGroup.boundary_example) && nonempty(rawGroup.boundary_example.utterance) ? rawGroup.boundary_example.utterance : null;
      const counterexamples = [...(boundary ? [boundary] : []), ...(option.id === 'target' && nonempty(rawGroup.negative_example) ? [rawGroup.negative_example] : [])];
      allowedAnswers.push({
        id: option.id, question_id: question.id, fact_id: factId, state: 'known', value: option.id,
        meaning: clause?.meaning ?? option.label,
        ...(nonempty(rawClause.entailment) ? { entailment: rawClause.entailment } : {}),
        ...(strings(rawClause.training_paraphrases).length ? { examples: strings(rawClause.training_paraphrases) } : {}),
        ...(counterexamples.length ? { counterexamples } : {}),
      });
    }
  }
  const superseded = new Set(existingAnswers.flatMap(a => a.replaces_answer_id ? [a.replaces_answer_id] : []));
  const sources = sourceEvents.filter(e => e.role === 'user' && ['utterance', 'answer', 'correction'].includes(e.kind) && nonempty(e.text) && (mode === 'chat' ? e.source === 'chat' : ['voice', 'webhook'].includes(e.source)));
  if (sources.length !== sourceEvents.length || new Set(sources.map(e => e.id)).size !== sources.length || sources.some(e => e.text!.length > 10000)) throw new Error('Invalid classifier source events');
  return {
    library_version: lib.version, mode, current_question_id: currentQuestion?.id ?? null,
    questions: questions.map(q => ({ id: q.id, chat: q.chat, voice: q.voice, fact_ids: [...q.fact_ids] })),
    facts, allowed_answers: allowedAnswers,
    accepted_facts: Object.values(state.facts).filter(f => factIds.has(f.fact_id)).map(f => ({ fact_id: f.fact_id, state: f.state, value: f.value, answer_ids: [...f.answer_ids], confirmation: f.confirmation, ...(f.parameters ? { parameters: f.parameters } : {}) })),
    correctable_answers: existingAnswers.filter(a => a.library_version === lib.version && factIds.has(a.fact_id) && !superseded.has(a.id)).map(a => ({ id: a.id, fact_id: a.fact_id, value: a.value, event_ids: [...a.event_ids] })),
    source_events: sources.map(e => ({ id: e.id, role: e.role, text: e.text })),
    history: events.filter(e => nonempty(e.text) && ['user', 'assistant'].includes(e.role)).slice(-12).map(e => ({ id: e.id, role: e.role, text: e.text })),
    clarification_questions: [...(input.clarificationQuestions ?? [])], faqs: [...(input.faqs ?? [])],
    joke_categories: lib.jokes.categories.map(c => {
      const raw: unknown = c;
      return { id: c.id, meaning: record(raw) && nonempty(raw.title) ? raw.title : c.selection_source, do_not_use_when: c.do_not_use_when };
    }),
    mapping_rules: [...new Set(mappingRules)], humor_enabled: state.humor.enabled,
  };
}

export function buildClassifierContext(lib: AuditLibrary, state: AuditState, events: readonly AuditEvent[], existingAnswers: readonly AuditAnswer[], currentQuestion: Pick<Question | QuestionView, 'id'> | null, mode: 'chat' | 'voice_recovery', sourceEvents: readonly AuditEvent[]): ClassifierContext {
  return buildChatContext({ lib, state, events, existingAnswers, currentQuestion, mode, sourceEvents });
}
