import type { AuditFact, AuditResult, AuditSnapshot, AuditState } from './contracts.ts';
import { library, isApproved, type AuditLibrary } from './library.ts';
import { evaluateRule, isRecord } from './rules.ts';

const states = new Set(['known', 'unknown', 'not_measured', 'not_applicable', 'declined', 'ambiguous', 'other', 'not_asked', 'conflicting']);
function fail(path: string): never { throw new Error(`Invalid audit data: ${path}`); }
function record(value: unknown, path: string): asserts value is Record<string, unknown> { if (!isRecord(value)) fail(path); }
function text(value: unknown, path: string, empty = false): asserts value is string { if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > 100_000) fail(path); }
function integer(value: unknown, path: string): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 0) fail(path); }
function list(value: unknown, path: string, maximum = 2000): asserts value is unknown[] { if (!Array.isArray(value) || value.length > maximum) fail(path); }
function strings(value: unknown, path: string): asserts value is string[] { list(value, path); value.forEach(item => text(item, path)); }
function unique(value: string[], path: string): void { if (new Set(value).size !== value.length) fail(path); }
function fields(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
  for (const key of Object.keys(value)) if (![...required, ...optional].includes(key)) fail(`unexpected ${key}`);
}
function json(value: unknown, path: string, depth = 0): void {
  if (depth > 15) fail(path);
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (Array.isArray(value)) { if (value.length > 2000) fail(path); value.forEach(item => json(item, path, depth + 1)); return; }
  if (isRecord(value)) { for (const [key, item] of Object.entries(value)) { if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(path); json(item, path, depth + 1); } return; }
  fail(path);
}
function fact(value: unknown, lib: AuditLibrary): asserts value is AuditFact {
  record(value, 'fact'); fields(value, ['fact_id', 'state', 'value', 'answer_ids', 'confirmation'], ['parameters']);
  if (!lib.facts.some(item => item.id === value.fact_id) || !states.has(String(value.state)) || !['explicit', 'unconfirmed', 'disputed'].includes(String(value.confirmation))) fail('fact identity/state');
  strings(value.answer_ids, 'fact.answer_ids'); unique(value.answer_ids, 'fact.answer_ids'); json(value.value, 'fact.value');
  if (!['known', 'other'].includes(String(value.state)) && value.value !== null) fail('uncertain fact has a value');
  if (value.state === 'conflicting' && value.confirmation !== 'disputed') fail('conflicting fact confirmation');
  if (value.parameters !== undefined) { record(value.parameters, 'fact.parameters'); json(value.parameters, 'fact.parameters'); }
}
function contradictions(value: unknown, lib: AuditLibrary): void {
  list(value, 'contradictions');
  for (const item of value) {
    record(item, 'contradiction'); fields(item, ['fact_id', 'answer_ids', 'reason']);
    if (!lib.facts.some(fact => fact.id === item.fact_id)) fail('contradiction.fact_id');
    strings(item.answer_ids, 'contradiction.answer_ids'); text(item.reason, 'contradiction.reason');
  }
}
const stateFields = ['library_version', 'revision', 'channel_revision', 'active_channel', 'status', 'current_question_id', 'facts', 'contradictions', 'missing_facts', 'candidate_blocks', 'elapsed_ms', 'active_since', 'paused', 'finish_reason', 'humor', 'through_seq', 'extracted_through_seq', 'history_status'];

/** The Worker contract is separate from the content team's offline audit-state schema. */
export function validateAuditState(value: unknown, lib: AuditLibrary = library): asserts value is AuditState {
  record(value, 'state'); fields(value, stateFields);
  if (value.library_version !== lib.version) fail('state.library_version');
  for (const key of ['revision', 'channel_revision', 'elapsed_ms', 'through_seq', 'extracted_through_seq']) integer(value[key], `state.${key}`);
  if ((value.elapsed_ms as number) > 900_000 || (value.extracted_through_seq as number) > (value.through_seq as number)) fail('state timing/event boundary');
  if (!['chat', 'voice'].includes(String(value.active_channel)) || !['in_progress', 'closing', 'preparing', 'ready', 'failed'].includes(String(value.status)) || !['pending', 'complete', 'incomplete'].includes(String(value.history_status))) fail('state enum');
  if (typeof value.paused !== 'boolean') fail('state.paused');
  if (value.active_since !== null) integer(value.active_since, 'state.active_since');
  if (value.finish_reason !== null) text(value.finish_reason, 'state.finish_reason');
  if (value.current_question_id !== null && !lib.questions.some(question => question.id === value.current_question_id)) fail('state.current_question_id');
  record(value.facts, 'state.facts');
  for (const [key, item] of Object.entries(value.facts)) { fact(item, lib); if (item.fact_id !== key) fail('state fact key mismatch'); }
  contradictions(value.contradictions, lib);
  strings(value.missing_facts, 'state.missing_facts'); for (const id of value.missing_facts) if (!lib.facts.some(fact => fact.id === id)) fail('state.missing_facts reference');
  strings(value.candidate_blocks, 'state.candidate_blocks'); for (const id of value.candidate_blocks) if (!lib.solutions.some(block => block.id === id)) fail('state.candidate_blocks reference');
  record(value.humor, 'state.humor'); fields(value.humor, ['enabled', 'reserved_ids', 'used_ids', 'operations']);
  if (typeof value.humor.enabled !== 'boolean') fail('humor.enabled');
  const jokeIds = new Set(lib.jokes.categories.flatMap(category => category.jokes.map(joke => joke.id)));
  for (const key of ['reserved_ids', 'used_ids']) { strings(value.humor[key], `humor.${key}`); unique(value.humor[key], `humor.${key}`); for (const id of value.humor[key]) if (!jokeIds.has(id)) fail(`humor.${key} reference`); }
  record(value.humor.operations, 'humor.operations');
  for (const [operationId, operation] of Object.entries(value.humor.operations)) {
    text(operationId, 'humor operation ID'); record(operation, 'humor operation'); fields(operation, ['joke_id', 'text', 'status', 'question_id']);
    if (operation.joke_id !== null && !jokeIds.has(String(operation.joke_id))) fail('humor operation joke');
    text(operation.text, 'humor operation text', true);
    if (!['reserved', 'delivered'].includes(String(operation.status))) fail('humor operation status');
    if (operation.question_id !== null && !lib.questions.some(question => question.id === operation.question_id)) fail('humor operation question');
  }
}

export function validateAuditResult(value: unknown, lib: AuditLibrary = library, snapshot?: AuditSnapshot): asserts value is AuditResult {
  record(value, 'result'); fields(value, ['snapshot_id', 'library_version', 'rules_version', 'tariffs_version', 'template_version', 'profile', 'goal', 'facts', 'previous_work', 'situations', 'solutions', 'actions', 'tariffs', 'gaps', 'contradictions', 'limitations', 'summary']);
  text(value.snapshot_id, 'result.snapshot_id');
  if (value.library_version !== lib.version || value.rules_version !== lib.rulesVersion || value.tariffs_version !== lib.tariffVersion || value.template_version !== lib.templateVersion || (snapshot && value.snapshot_id !== snapshot.id)) fail('result pinned versions');
  record(value.profile, 'result.profile'); json(value.profile, 'result.profile'); json(value.goal, 'result.goal');
  for (const key of ['facts', 'previous_work']) { list(value[key], `result.${key}`); for (const item of value[key]) fact(item, lib); }
  strings(value.gaps, 'result.gaps'); strings(value.limitations, 'result.limitations'); text(value.summary, 'result.summary'); contradictions(value.contradictions, lib);
  const evidenceIds = snapshot ? new Set(snapshot.answers.map(answer => answer.id)) : undefined;
  list(value.situations, 'result.situations');
  for (const item of value.situations) {
    record(item, 'situation'); fields(item, ['id', 'title', 'kind', 'evidence_status', 'evidence_answer_ids', 'significance', 'limitations']);
    const block = lib.solutions.find(block => block.id === item.id);
    if (!block || !isApproved(block)) fail('situation is not approved');
    text(item.title, 'situation.title');
    if (!['problem', 'hypothesis', 'verification', 'opportunity'].includes(String(item.kind)) || !['supported', 'hypothesis', 'insufficient'].includes(String(item.evidence_status))) fail('situation enum');
    strings(item.evidence_answer_ids, 'situation evidence'); if (evidenceIds && item.evidence_answer_ids.some(id => !evidenceIds.has(id))) fail('situation evidence is not in snapshot');
    strings(item.limitations, 'situation limitations'); record(item.significance, 'significance'); fields(item.significance, ['level', 'reason']);
    if (!['high', 'medium', 'low', 'unknown'].includes(String(item.significance.level))) fail('significance level'); text(item.significance.reason, 'significance reason');
  }
  list(value.actions, 'result.actions');
  const actionIds = new Set<string>(), edges = new Map<string, string[]>();
  for (const item of value.actions) {
    record(item, 'action'); fields(item, ['id', 'text', 'after', 'parallel_with', 'deferred_reason']); text(item.id, 'action.id'); text(item.text, 'action.text');
    if (actionIds.has(item.id)) fail('duplicate action'); actionIds.add(item.id);
    strings(item.after, 'action.after'); strings(item.parallel_with, 'action.parallel_with'); edges.set(item.id, item.after);
    if (item.deferred_reason !== null) text(item.deferred_reason, 'action.deferred_reason');
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): void => { if (visiting.has(id)) fail('cyclic action dependencies'); if (visited.has(id)) return; visiting.add(id); for (const dependency of edges.get(id) ?? []) { if (!actionIds.has(dependency)) fail('unknown action dependency'); visit(dependency); } visiting.delete(id); visited.add(id); };
  actionIds.forEach(visit);
  list(value.solutions, 'result.solutions');
  for (const item of value.solutions) {
    record(item, 'solution'); fields(item, ['id', 'title', 'text', 'service_ids', 'action_ids', 'limitations']);
    const block = lib.solutions.find(block => block.id === item.id); if (!block || !isApproved(block)) fail('solution is not approved');
    text(item.title, 'solution.title'); text(item.text, 'solution.text'); strings(item.limitations, 'solution limitations'); strings(item.action_ids, 'solution actions'); strings(item.service_ids, 'solution services');
    if (item.action_ids.some(id => !actionIds.has(id)) || item.service_ids.some(id => !lib.services.some(service => service.id === id))) fail('solution reference');
  }
  list(value.tariffs, 'result.tariffs');
  const tariffIds = new Set<string>();
  for (const item of value.tariffs) {
    record(item, 'tariff'); fields(item, ['id', 'title', 'details', 'source_urls']);
    text(item.id, 'tariff.id');
    if (tariffIds.has(item.id)) fail('duplicate tariff option'); tariffIds.add(item.id);
    const tariff = lib.tariffs.find(tariff => tariff.id === item.id);
    if (!tariff || !isApproved(tariff) || tariff.commercial_approval !== 'approved' || tariff.conflicts.length || !tariff.selection_rule) fail('tariff is not approved for report options');
    text(item.title, 'tariff.title'); record(item.details, 'tariff.details'); json(item.details, 'tariff.details'); strings(item.source_urls, 'tariff URLs');
    if (item.title !== tariff.name || item.details.selection_status !== 'option_requires_scope_confirmation' || item.details.service_id !== tariff.service_id || item.details.source_checked_on !== tariff.source.checked_on || JSON.stringify(item.details.price) !== JSON.stringify(tariff.price)) fail('tariff option does not match approved catalog');
    if (JSON.stringify(item.details.tax) !== JSON.stringify(tariff.tax ?? null)) fail('tariff tax differs from catalog');
    for (const key of ['conditions', 'included', 'excluded', 'not_stated'] as const) if (JSON.stringify(item.details[key]) !== JSON.stringify(tariff[key])) fail(`tariff ${key} differs from catalog`);
    if (!value.solutions.some(solution => isRecord(solution) && Array.isArray(solution.service_ids) && solution.service_ids.includes(tariff.service_id))) fail('tariff service is not supported by a solution');
    const ruleFacts = Object.fromEntries((value.facts as AuditFact[]).map(fact => [fact.fact_id, { state: fact.state, value: fact.value, confirmation: fact.confirmation, parameters: fact.parameters }]));
    if (evaluateRule(tariff.selection_rule, ruleFacts) !== true) fail('tariff evidence rule does not match');
    const source = lib.sources.find(source => source.id === tariff.source.id);
    if (!source?.url || item.source_urls.length !== 1 || item.source_urls[0] !== source.url) fail('tariff source');
    if (snapshot && tariff.price.valid_until && Date.parse(tariff.price.valid_until) < snapshot.created_at) fail('expired tariff option');
  }
}
