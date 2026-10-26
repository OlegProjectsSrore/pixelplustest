import { INTERVIEW_BUDGET_MS, MAX_VOICE_QUESTIONS, type AuditAnswer, type AuditEvent, type AuditFact, type AuditResult, type AuditSnapshot, type AuditState, type Contradiction, type Json, type QuestionView } from './contracts.ts';
import { assertLibraryReady, isApproved, library, type AuditLibrary, type FactDefinition, type Question, type Solution } from './library.ts';
import { evaluateRule, isRecord } from './rules.ts';
import { validateAuditResult, validateAuditState } from './validation.ts';
import { mergeStructuredValues, validateRuntimeValue } from './value-schemas.ts';

export interface EngineOptions { allowDraft?: boolean }
const allowedStates = ['known', 'unknown', 'not_measured', 'not_applicable', 'declined', 'ambiguous', 'other'];
const own = (value: object, key: string) => Object.hasOwn(value, key);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const known = (fact: AuditFact | undefined) => fact?.state === 'known' && fact.confirmation === 'explicit';
const permitted = (item: { status: string; reviewer?: string | null; approved_at?: string | null }, options: EngineOptions) => isApproved(item) || (options.allowDraft === true && ['draft', 'in_review'].includes(item.status));
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
};

function assertJson(value: unknown, depth = 0): asserts value is Json {
  if (depth > 12) throw new Error('Answer value is too deeply nested');
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value === 'string' && value.length <= 8000) return;
  if (Array.isArray(value) && value.length <= 100) { value.forEach(item => assertJson(item, depth + 1)); return; }
  if (isRecord(value) && Object.keys(value).length <= 64) {
    for (const [key, item] of Object.entries(value)) { if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Forbidden value key'); assertJson(item, depth + 1); }
    return;
  }
  throw new Error('Invalid JSON answer value');
}

function validateValue(definition: FactDefinition, answer: AuditAnswer): void {
  const value = answer.value;
  if (answer.state !== 'known') {
    if (answer.state !== 'other' && value !== null) throw new Error('Uncertain answers require a null value');
    if (answer.state === 'other' && value !== null && !nonempty(value)) throw new Error('Other must preserve a text value');
    return;
  }
  if (definition.value_type === 'text' && !nonempty(value)) throw new Error('Expected a nonempty text value');
  if (definition.value_type === 'boolean' && typeof value !== 'boolean') throw new Error('Expected an explicit boolean value');
  if (definition.value_type === 'enum' && !definition.values?.some(option => option.id === value)) throw new Error('Value is outside the pinned vocabulary');
  if (definition.value_type === 'string_list' && (!Array.isArray(value) || !value.length || !value.every(nonempty))) throw new Error('Expected nonempty string list');
  if (definition.runtime_schema && (isRecord(value) || !['money', 'number'].includes(definition.value_type))) {
    validateRuntimeValue(value, definition.runtime_schema);
    if (isRecord(value) && !Object.keys(value).length) throw new Error('Expected a nonempty structured value');
    validateSuppliedQuantities(value);
    if (definition.id.endsWith('.history') && isRecord(value)) validateHistory(value);
    return;
  }
  if (['money', 'number'].includes(definition.value_type)) {
    const quantity = isRecord(value) ? value : { ...answer.parameters, value };
    const hasValue = typeof quantity.value === 'number' && Number.isFinite(quantity.value);
    const hasRange = typeof quantity.min === 'number' && typeof quantity.max === 'number' && Number.isFinite(quantity.min) && Number.isFinite(quantity.max) && quantity.min <= quantity.max;
    if ((!hasValue && !hasRange) || !nonempty(quantity.unit) || !(nonempty(quantity.period) || isRecord(quantity.period)) || typeof quantity.approximate !== 'boolean') throw new Error('Quantity requires a value/range, unit, period and approximate flag');
    if (definition.value_type === 'money' && !nonempty(quantity.currency)) throw new Error('Money requires currency');
  }
  if (definition.value_type === 'period' && !(nonempty(value) || isRecord(value))) throw new Error('Period is missing');
  if (definition.value_type === 'object') {
    if (!isRecord(value)) throw new Error('Expected a structured value');
    if (definition.required_fields) {
      for (const field of definition.required_fields) {
        const part = value[field];
        if (!isRecord(part) || !allowedStates.includes(String(part.state)) || !own(part, 'value')) throw new Error(`Missing structured field: ${field}`);
        if (part.state === 'known' && (part.value === null || part.value === '')) throw new Error(`Empty known field: ${field}`);
        if (!['known', 'other'].includes(String(part.state)) && part.value !== null) throw new Error(`Uncertain structured field must be null: ${field}`);
      }
      if (Object.keys(value).some(key => !definition.required_fields!.includes(key))) throw new Error('Unknown structured field');
    }
    if (definition.fields) {
      if (Object.keys(value).some(key => !own(definition.fields!, key))) throw new Error('Unknown fact field');
      for (const [field, choices] of Object.entries(definition.fields)) {
        if (Array.isArray(choices) && (!own(value, field) || !choices.includes(value[field]))) throw new Error(`Unknown or missing ${field}`);
      }
      if (definition.id.endsWith('.history')) validateHistory(value);
    }
  }
}

function validateHistory(value: Record<string, unknown>): void {
  if (value.attempts_status === 'not_tried') {
    if (value.attempts !== undefined && (!Array.isArray(value.attempts) || value.attempts.length !== 0)) throw new Error('Not tried cannot contain attempts');
    return;
  }
  if (value.attempts === undefined) return;
  if (!Array.isArray(value.attempts)) throw new Error('Past work requires attempts');
  const ids = new Set<string>();
  const fields = ['work', 'period_and_duration', 'goal', 'executor_and_resources', 'outcome', 'measurement', 'current_status', 'stop_reason'];
  for (const attempt of value.attempts) {
    if (!isRecord(attempt) || !nonempty(attempt.attempt_id) || ids.has(attempt.attempt_id) || (attempt.applies_to_block_ids !== undefined && (!Array.isArray(attempt.applies_to_block_ids) || !attempt.applies_to_block_ids.every(nonempty)))) throw new Error('Invalid attempt identity/scope');
    ids.add(attempt.attempt_id);
    for (const field of fields) {
      const part = attempt[field];
      if (part === undefined) continue;
      if (!isRecord(part) || !allowedStates.includes(String(part.state)) || !own(part, 'value')) throw new Error(`Past work field missing: ${field}`);
    }
  }
}

function validateSuppliedQuantities(value: Json): void {
  if (Array.isArray(value)) { value.forEach(validateSuppliedQuantities); return; }
  if (!isRecord(value)) return;
  if (typeof value.min === 'number' && typeof value.max === 'number' && value.min > value.max) throw new Error('Quantity range is reversed');
  if (typeof value.value === 'number' && ((typeof value.min === 'number' && value.value < value.min) || (typeof value.max === 'number' && value.value > value.max))) throw new Error('Quantity value is outside its range');
  Object.values(value).forEach(item => validateSuppliedQuantities(item as Json));
}

/** Call before the transaction. Evidence IDs must refer to already delivered user events. */
export function validateAnswers(answers: AuditAnswer[], events: AuditEvent[], existing: AuditAnswer[] = [], lib: AuditLibrary = library, options: EngineOptions = {}): void {
  if (!options.allowDraft) assertLibraryReady(lib);
  if (!Array.isArray(answers) || answers.length > 64) throw new Error('Invalid answer batch');
  const ids = new Set(existing.map(answer => answer.id));
  const all = new Map(existing.map(answer => [answer.id, answer]));
  const replaced = new Set(existing.map(answer => answer.replaces_answer_id).filter(Boolean));
  const eventMap = new Map(events.map(event => [event.id, event]));
  for (const answer of answers) {
    if (!isRecord(answer) || !nonempty(answer.id) || answer.id.length > 128 || ids.has(answer.id)) throw new Error('Duplicate/invalid answer ID');
    if (Object.keys(answer).some(key => !['id', 'question_id', 'answer_id', 'fact_id', 'state', 'value', 'parameters', 'event_ids', 'channel', 'method', 'confirmation', 'replaces_answer_id', 'library_version', 'created_at'].includes(key))) throw new Error('Unknown answer property');
    if (!allowedStates.includes(answer.state)) throw new Error('Collection/conflict states cannot be submitted as visitor answers');
    if (answer.library_version !== lib.version || !Number.isSafeInteger(answer.created_at) || answer.created_at < 0) throw new Error('Invalid answer version/time');
    if (!['chat', 'voice'].includes(answer.channel) || !['selection', 'classification', 'voice_batch', 'recovery'].includes(answer.method) || !['explicit', 'unconfirmed', 'disputed'].includes(answer.confirmation)) throw new Error('Invalid provenance');
    const question = lib.questions.find(item => item.id === answer.question_id);
    const definition = lib.facts.find(item => item.id === answer.fact_id);
    if (!question || !definition || !question.fact_ids.includes(answer.fact_id) || !permitted(question, options) || !permitted(definition, options)) throw new Error('Unknown or inactive question/fact pair');
    if (!Array.isArray(answer.event_ids) || !answer.event_ids.length || answer.event_ids.length > 32 || new Set(answer.event_ids).size !== answer.event_ids.length) throw new Error('Missing/repeated evidence');
    for (const id of answer.event_ids) {
      const event = eventMap.get(id);
      if (!event || event.role !== 'user' || !['utterance', 'answer', 'correction'].includes(event.kind)) throw new Error('Answer lacks delivered user evidence');
      if ((answer.channel === 'chat' && event.source !== 'chat') || (answer.channel === 'voice' && !['voice', 'webhook'].includes(event.source))) throw new Error('Evidence channel mismatch');
      if (answer.replaces_answer_id && !answer.event_ids.some(eventId => eventMap.get(eventId)?.kind === 'correction')) throw new Error('Replacement requires explicit correction evidence');
    }
    if (answer.answer_id !== undefined && !(definition.values?.some(option => option.id === answer.answer_id && option.id === answer.value) || (answer.answer_id === answer.state && answer.state !== 'known') || (answer.fact_id === 'context.priority' && Array.isArray(answer.value) && answer.value.length === 1 && answer.value[0] === answer.answer_id && lib.domains.some(domain => domain.id === answer.answer_id)))) throw new Error('Answer option does not match value');
    assertJson(answer.value); if (answer.parameters !== undefined) assertJson(answer.parameters);
    validateValue(definition, answer);
    if (answer.replaces_answer_id) {
      const previous = all.get(answer.replaces_answer_id);
      if (!previous || previous.fact_id !== answer.fact_id || replaced.has(previous.id)) throw new Error('Correction does not target an active answer for this fact');
      replaced.add(previous.id);
    }
    ids.add(answer.id); all.set(answer.id, answer);
  }
}

export function deriveFacts(answers: AuditAnswer[], lib: AuditLibrary = library): { facts: Record<string, AuditFact>; contradictions: Contradiction[] } {
  const superseded = new Set(answers.flatMap(answer => answer.replaces_answer_id ? [answer.replaces_answer_id] : []));
  const groups = new Map<string, AuditAnswer[]>();
  for (const answer of answers) if (!superseded.has(answer.id)) groups.set(answer.fact_id, [...(groups.get(answer.fact_id) ?? []), answer]);
  const facts: Record<string, AuditFact> = Object.create(null), contradictions: Contradiction[] = [];
  for (const [factId, submitted] of groups) {
    // Learning a previously unknown value is not a contradiction or an implicit correction.
    // Assertions such as not_applicable/not_measured remain distinct and cannot be overwritten this way.
    const hasExplicitValue = submitted.some(answer => answer.state === 'known' && answer.confirmation === 'explicit');
    const group = hasExplicitValue ? submitted.filter(answer => !['unknown', 'ambiguous', 'declined'].includes(answer.state)) : submitted;
    const variants = new Set(group.map(answer => canonical({ state: answer.state, value: answer.value, parameters: answer.parameters ?? null })));
    const first = group[0];
    let merged = first.value, conflicted = variants.size > 1 || group.some(answer => answer.confirmation === 'disputed');
    const definition = lib.facts.find(fact => fact.id === factId);
    if (variants.size > 1 && definition?.runtime_schema && group.every(answer => answer.state === 'known' && answer.confirmation !== 'disputed' && isRecord(answer.value) && canonical(answer.parameters ?? null) === canonical(first.parameters ?? null))) {
      try {
        merged = group.slice(1).reduce((value, answer) => mergeStructuredValues(value, answer.value), first.value);
        validateRuntimeValue(merged, definition.runtime_schema);
        validateSuppliedQuantities(merged);
        if (factId.endsWith('.history') && isRecord(merged)) validateHistory(merged);
        conflicted = false;
      } catch { conflicted = true; }
    }
    const explicit = group.every(answer => answer.confirmation === 'explicit') || (variants.size === 1 && group.some(answer => answer.confirmation === 'explicit'));
    facts[factId] = { fact_id: factId, state: conflicted ? 'conflicting' : first.state, value: conflicted ? null : merged, answer_ids: group.map(answer => answer.id), confirmation: conflicted ? 'disputed' : explicit ? 'explicit' : 'unconfirmed', ...(first.parameters && !conflicted ? { parameters: first.parameters } : {}) };
    if (conflicted) contradictions.push({ fact_id: factId, answer_ids: group.map(answer => answer.id), reason: 'Сведения не согласованы явным исправлением; последнее сообщение не имеет приоритета.' });
  }
  return { facts, contradictions };
}

export function elapsedInterviewMs(state: AuditState, now: number): number {
  return Math.min(INTERVIEW_BUDGET_MS, Math.max(0, state.elapsed_ms + (state.active_channel !== 'voice' || state.active_since === null || state.paused ? 0 : Math.max(0, now - state.active_since))));
}
function questionDomain(question: Question): string | undefined {
  return question.domain ?? question.fact_ids.find(id => !id.startsWith('context.'))?.split('.')[0];
}
function collected(fact: AuditFact | undefined): boolean { return !!fact && fact.state !== 'not_asked'; }
function usableFact(fact: AuditFact | undefined): boolean { return !!fact && fact.state !== 'conflicting' && fact.state !== 'ambiguous' && fact.confirmation === 'explicit'; }

function needsQuestion(question: Question, state: AuditState, lib: AuditLibrary): boolean {
  if (question.phase === 'history') {
    const fact = state.facts[question.fact_ids[0]];
    if (!fact) return true;
    if (fact.state !== 'known' || !isRecord(fact.value)) return false;
    if (fact.value.attempts_status === undefined) return true;
    if (fact.value.attempts_status !== 'tried') return false;
    const attempts = fact.value.attempts;
    return !Array.isArray(attempts) || !attempts.length || attempts.some(attempt => isRecord(attempt) && question.fields?.some(field => !isRecord(attempt[field]) || attempt[field].state === 'not_asked'));
  }
  return question.fact_ids.some(id => {
    const fact = state.facts[id], definition = lib.facts.find(item => item.id === id);
    if (!collected(fact)) return true;
    if (fact.state !== 'known' || !isRecord(fact.value)) return false;
    if (definition?.required_fields) return definition.required_fields.some(field => !own(fact.value as object, field));
    if (definition?.value_type === 'money' || definition?.value_type === 'number') {
      const quantity = fact.value;
      return fact.answer_ids.length <= lib.scenario.routing.max_clarifications_per_fact &&
        (!(typeof quantity.value === 'number' || (typeof quantity.min === 'number' && typeof quantity.max === 'number')) ||
        !nonempty(quantity.unit) || !nonempty(quantity.period) || typeof quantity.approximate !== 'boolean' || (definition.value_type === 'money' && !nonempty(quantity.currency)));
    }
    return false;
  });
}
function candidates(state: AuditState, lib: AuditLibrary, options: EngineOptions): Solution[] {
  return lib.solutions.filter(block => permitted(block, options) && known(state.facts[`${block.domain}.applicable`]) && state.facts[`${block.domain}.applicable`].value === true && known(state.facts[`${block.id}.signal`]) && state.facts[`${block.id}.signal`].value === 'target' && evaluateRule(block.exclusion, state.facts) !== true);
}
export function nextQuestion(state: AuditState, now: number, lib: AuditLibrary = library, options: EngineOptions = {}): QuestionView | null {
  if (state.library_version !== lib.version) throw new Error('Pinned library mismatch');
  if (!options.allowDraft) assertLibraryReady(lib);
  const elapsed = elapsedInterviewMs(state, now);
  // In questions mode the assistant only answers; the survey waits until the visitor asks for the diagnostic.
  if (state.status !== 'in_progress' || state.paused || elapsed >= INTERVIEW_BUDGET_MS || state.mode === 'questions') return null;
  // A voice interview asks at most MAX_VOICE_QUESTIONS distinct questions; the last place is kept for the confirmation.
  const answeredCount = state.questions_answered ?? 0, voiceCap = state.active_channel === 'voice';
  if (voiceCap && answeredCount >= MAX_VOICE_QUESTIONS) return null;
  // The introductory block precedes adaptive branches in both channels. Explicit
  // unknown/declined answers count as collected; they must not trap the visitor.
  const mandatory = (lib.scenario.mandatory_entry_questions ?? [])
    .map(id => lib.questions.find(question => question.id === id))
    .find(question => question && permitted(question, options) && needsQuestion(question, state, lib));
  if (mandatory) return { id: mandatory.id, text: mandatory[state.active_channel], fact_ids: mandatory.fact_ids, options: [] };
  const activeBlocks = candidates(state, lib, options), domains = new Set(activeBlocks.map(block => block.domain));
  const priority = state.facts['context.priority'];
  const namedTopics = known(priority) && Array.isArray(priority.value) ? priority.value.filter((value): value is string => typeof value === 'string') : [];
  const requestedDomains = lib.domains.filter(domain => namedTopics.includes(domain.id) || namedTopics.includes(domain.title)).map(domain => domain.id);
  for (const domain of lib.domains) if (known(state.facts[`${domain.id}.applicable`]) && state.facts[`${domain.id}.applicable`].value === true && !requestedDomains.includes(domain.id)) requestedDomains.push(domain.id);
  const unresolved = elapsed < lib.scenario.clock.closing_from * 1000 ? state.contradictions.find(item => (state.facts[item.fact_id]?.answer_ids.length ?? 0) < 4) : undefined;
  const ambiguous = !unresolved && elapsed < lib.scenario.clock.closing_from * 1000 ? Object.values(state.facts).find(fact => (fact.state === 'ambiguous' || (fact.state === 'known' && fact.confirmation === 'unconfirmed')) && fact.answer_ids.length <= lib.scenario.routing.max_clarifications_per_fact) : undefined;
  let selected = unresolved || ambiguous ? lib.questions.find(question => permitted(question, options) && question.fact_ids.includes((unresolved ?? ambiguous)!.fact_id) && elapsed + question.estimated_seconds * 1000 <= INTERVIEW_BUDGET_MS) : undefined;
  if (!selected) {
    const weighted = lib.questions.flatMap((question, order) => {
      if (!permitted(question, options) || !needsQuestion(question, state, lib) || (question.condition && evaluateRule(question.condition, state.facts) !== true)) return [];
      if (voiceCap && answeredCount >= MAX_VOICE_QUESTIONS - 1 && question.phase !== 'confirmation') return [];
      const domain = questionDomain(question);
      const applicable = domain ? state.facts[`${domain}.applicable`] : undefined;
      if (question.phase === 'routing' && (!domain || !requestedDomains.includes(domain))) return [];
      if (domain && question.phase !== 'routing' && !(known(applicable) && applicable!.value === true)) return [];
      if (question.related_block && !activeBlocks.some(block => block.id === question.related_block) && question.phase !== 'screen') return [];
      if ((question.phase === 'history' || (question.phase === 'detail' && !question.related_block)) && (!domain || !domains.has(domain))) return [];
      // Once a stated task has a substantive branch, close its gaps instead of walking the catalogue.
      if (question.phase === 'screen' && domain && domains.has(domain)) return [];
      if (question.phase === 'orientation' && !lib.scenario.entry_questions.includes(question.id) && !activeBlocks.some(block => block.matrix.clarifying.some(id => question.fact_ids.includes(id)))) return [];
      if (elapsed >= lib.scenario.clock.no_new_deep_branch_after * 1000 && ['routing', 'screen'].includes(question.phase)) return [];
      if (elapsed >= lib.scenario.clock.closing_from * 1000 && question.phase !== 'confirmation') return [];
      if (elapsed + question.estimated_seconds * 1000 > INTERVIEW_BUDGET_MS) return [];
      const entryIndex = lib.scenario.entry_questions.indexOf(question.id);
      const priorities: Record<string, number> = { orientation: entryIndex >= 0 ? 200 - entryIndex : 80, detail: question.related_block ? 100 : 80, history: 90, screen: 60, routing: 50, confirmation: 0 };
      const domainOrder = domain ? requestedDomains.indexOf(domain) : -1;
      return [{ question, score: (priorities[question.phase] ?? 0) + (question.priority ?? 0), order: domainOrder < 0 ? order : domainOrder * 1000 + order }];
    }).sort((a, b) => b.score - a.score || a.order - b.order);
    selected = weighted[0]?.question;
  }
  if (!selected) return null;
  const optionsForQuestion = selected.id === 'context_priority' ? lib.domains.map(domain => ({ id: domain.id, text: domain.title })) : selected.fact_ids.flatMap(id => lib.facts.find(fact => fact.id === id)?.values?.map(value => ({ id: value.id, text: value.label })) ?? []);
  return { id: selected.id, text: unresolved ? `Уточните противоречащие друг другу сведения. ${selected[state.active_channel]}` : ambiguous ? `Пожалуйста, уточните, верно ли записаны сведения. ${selected[state.active_channel]}` : selected[state.active_channel], fact_ids: selected.fact_ids, options: optionsForQuestion };
}

export function advanceAudit(state: AuditState, answers: AuditAnswer[], now: number, lib: AuditLibrary = library, options: EngineOptions = {}): AuditState {
  const derived = deriveFacts(answers, lib);
  const updated: AuditState = { ...state, facts: derived.facts, contradictions: derived.contradictions,
    questions_answered: new Set(answers.filter(answer => answer.library_version === lib.version).map(answer => answer.question_id)).size };
  const active = candidates(updated, lib, options);
  updated.candidate_blocks = active.map(block => block.id);
  updated.missing_facts = [...new Set(active.flatMap(block => [...block.matrix.required, block.previous_attempts.fact]).filter(id => !usableFact(updated.facts[id])))];
  updated.current_question_id = nextQuestion(updated, now, lib, options)?.id ?? null;
  validateAuditState(updated, lib);
  return updated;
}

export function interviewSufficiency(state: AuditState, now: number, lib: AuditLibrary = library, options: EngineOptions = {}): { sufficient: boolean; reason: string; missing: string[] } {
  if (elapsedInterviewMs(state, now) >= INTERVIEW_BUDGET_MS) return { sufficient: false, reason: 'time_limit', missing: state.missing_facts };
  if (state.contradictions.length || state.missing_facts.length) return { sufficient: false, reason: 'needs_clarification', missing: state.missing_facts };
  const orientation = lib.questions.filter(question => lib.scenario.entry_questions.includes(question.id) && permitted(question, options)).flatMap(question => question.fact_ids);
  const missing = orientation.filter(id => !usableFact(state.facts[id]));
  if (missing.length) return { sufficient: false, reason: 'missing_context', missing };
  // Sufficiency is about the survey itself, whichever mode the conversation is in.
  const remaining = nextQuestion({ ...state, mode: 'diagnostic' }, now, lib, options);
  return { sufficient: remaining === null, reason: remaining === null ? 'sufficient' : 'questions_remaining', missing: [] };
}

function previousWorkAllows(block: Solution, facts: Record<string, AuditFact>): boolean {
  if (!block.previous_attempts.required_before_recommendation) return true;
  const history = facts[block.previous_attempts.fact];
  // Repeating prior work needs an explicitly approved difference rule; free text is not executable authority.
  return known(history) && isRecord(history.value) && history.value.attempts_status === 'not_tried';
}

/** Only approved material may become a recommendation, including when an interview is a draft preview. */
export function analyzeAudit(snapshot: AuditSnapshot, lib: AuditLibrary = library, options: EngineOptions = {}): AuditResult {
  if (snapshot.library_version !== lib.version || snapshot.state.library_version !== lib.version) throw new Error('Snapshot library mismatch');
  if (!options.allowDraft) assertLibraryReady(lib);
  const { facts, contradictions } = deriveFacts(snapshot.answers, lib);
  const result: AuditResult = {
    snapshot_id: snapshot.id, library_version: lib.version, rules_version: lib.rulesVersion, tariffs_version: lib.tariffVersion, template_version: lib.templateVersion,
    profile: Object.fromEntries(Object.values(facts).filter(fact => fact.fact_id.startsWith('context.') && fact.fact_id !== 'context.goal' && known(fact)).map(fact => [fact.fact_id, fact.value])),
    goal: known(facts['context.goal']) ? facts['context.goal'].value : null, facts: Object.values(facts), previous_work: Object.values(facts).filter(fact => fact.fact_id.endsWith('.history')),
    situations: [], solutions: [], actions: [], tariffs: [], gaps: [], contradictions,
    limitations: [...snapshot.limitations, 'Сведения получены со слов посетителя; независимая проверка сайта, отчётов и систем не проводилась.'], summary: '',
  };
  if (lib.status !== 'approved') result.limitations.push('Библиотека находится на экспертной проверке. Черновые диагностические правила, решения и тарифы не включены в заключение.');
  const selected = new Set<string>();
  for (const block of lib.solutions.filter(isApproved)) {
    if (evaluateRule(block.exclusion, facts) === true) continue;
    const inclusion = evaluateRule(block.inclusion, facts);
    const signal = facts[`${block.id}.signal`];
    if (inclusion !== true && !(known(signal) && signal.value === 'target')) continue;
    const missing = block.matrix.required.filter(id => !known(facts[id]));
    result.gaps.push(...missing);
    const status = inclusion === true && !missing.length ? 'supported' : block.type === 'hypothesis' ? 'hypothesis' : 'insufficient';
    const evidence = [...new Set(block.matrix.required.flatMap(id => facts[id]?.answer_ids ?? []))];
    const duplicates = lib.relationships.find(relation => ['same_observation', 'same_work', 'shared_deliverable'].includes(relation.relation) && ((relation.a === block.id && selected.has(relation.b)) || (relation.b === block.id && selected.has(relation.a))));
    if (duplicates) { result.limitations.push(`Тема «${block.title}» пересекается с уже включённым блоком; повторный объём работ не назначен.`); continue; }
    selected.add(block.id);
    // Significance prose is not a numeric/ordinal approved rule. Unknown is preserved until such a rule exists.
    result.situations.push({ id: block.id, title: status === 'supported' ? block.pdf.heading as string || block.title : `Требует проверки: ${block.title}`, kind: block.type === 'opportunity' ? 'opportunity' : block.type === 'reported_issue' ? 'problem' : block.type === 'data_gap' ? 'verification' : 'hypothesis', evidence_status: status, evidence_answer_ids: evidence, significance: { level: 'unknown', reason: 'Значимость не установлена утверждённым правилом по полученным сведениям.' }, limitations: [...block.solution.limitations, ...(status !== 'supported' ? ['Недостаточно оснований для утверждения проблемы.'] : [])] });
    if (status !== 'supported' || !previousWorkAllows(block, facts)) { result.gaps.push(block.previous_attempts.fact); continue; }
    const conflict = lib.relationships.some(relation => relation.relation === 'alternatives_require_comparison' && ((relation.a === block.id && selected.has(relation.b)) || (relation.b === block.id && selected.has(relation.a))));
    if (conflict) { result.limitations.push(`Для «${block.title}» требуется сравнение альтернатив до назначения работ.`); continue; }
    const actions = [...block.solution.steps].sort((a, b) => a.order - b.order).map((step, index, steps) => ({ id: `${block.id}:${step.order}`, text: step.text, after: index ? [`${block.id}:${steps[index - 1].order}`] : [], parallel_with: [] as string[], deferred_reason: block.solution.prerequisites.length ? block.solution.prerequisites.join('; ') : null }));
    result.actions.push(...actions);
    result.solutions.push({ id: block.id, title: block.title, text: block.solution.deliverable, service_ids: block.services, action_ids: actions.map(action => action.id), limitations: block.solution.limitations });
  }
  for (const relation of lib.relationships) {
    if (!['measurement_before_optimization', 'configure_then_validate', 'permissions_before_contact', 'access_before_actions', 'validation_before_rollout', 'restore_before_change', 'validate_task_before_build', 'goal_before_production'].includes(relation.relation)) continue;
    const before = result.solutions.find(solution => solution.id === relation.a), after = result.solutions.find(solution => solution.id === relation.b);
    if (before && after) { const action = result.actions.find(item => item.id === after.action_ids[0]); if (action) action.after.push(before.action_ids[before.action_ids.length - 1]); }
  }
  const services = new Set(result.solutions.flatMap(solution => solution.service_ids));
  for (const tariff of lib.tariffs) {
    // A matching rule makes a tariff a preliminary option, not a selected package.
    if (!services.has(tariff.service_id) || !isApproved(tariff) || tariff.commercial_approval !== 'approved' || tariff.conflicts.length || !tariff.selection_rule || evaluateRule(tariff.selection_rule, facts) !== true) continue;
    if (tariff.price.valid_until && Date.parse(tariff.price.valid_until) < snapshot.created_at) continue;
    const source = lib.sources.find(item => item.id === tariff.source.id);
    if (source?.url) result.tariffs.push({ id: tariff.id, title: tariff.name, details: {
      selection_status: 'option_requires_scope_confirmation', service_id: tariff.service_id,
      price: tariff.price as unknown as Json, conditions: tariff.conditions, included: tariff.included, excluded: tariff.excluded,
      not_stated: tariff.not_stated, tax: (tariff.tax ?? null) as unknown as Json, source_checked_on: tariff.source.checked_on,
    }, source_urls: [source.url] });
  }
  result.gaps = [...new Set([...result.gaps, ...Object.values(facts).filter(fact => !known(fact) && fact.state !== 'not_applicable').map(fact => fact.fact_id)])];
  result.limitations = [...new Set(result.limitations)];
  result.summary = result.situations.some(item => item.evidence_status === 'supported') ? 'Зафиксированы ситуации, подтверждённые сообщёнными сведениями в пределах указанных ограничений.' : 'Полученных сведений и утверждённых правил недостаточно для обоснованного заключения о проблемах. Отсутствие вывода не подтверждает отсутствие проблем.';
  validateAuditResult(result, lib, snapshot);
  return result;
}
export const analyzeSnapshot = analyzeAudit;
