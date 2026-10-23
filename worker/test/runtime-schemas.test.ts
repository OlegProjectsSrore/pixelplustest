import test from 'node:test';
import assert from 'node:assert/strict';
import { initialAuditState, type AuditFact, type AuditResult, type AuditSnapshot, type AuditState } from '../src/audit/contracts.ts';
import { analyzeAudit } from '../src/audit/engine.ts';
import { library } from '../src/audit/library.ts';
import { runtimeStateSchema, runtimeResultSchema } from '../src/audit/runtime-schemas.ts';
import { validateAuditResult, validateAuditState } from '../src/audit/validation.ts';

// The project-owned validator is JavaScript; loading its URL needs no extra package or copied validator.
const validateSchema: (value: unknown, schema: unknown) => string[] = (await import(new URL('../../scripts/audit-schema.mjs', import.meta.url).href)).validateSchema;
const now = Date.parse('2026-10-22T20:00:00Z');
const fresh = (): AuditState => initialAuditState(library.version, 'chat', now);
function analyzed(): AuditResult {
  const snapshot: AuditSnapshot = { id: 'snapshot-1', session_id: 'session-1', library_version: library.version,
    created_at: now, through_seq: 0, answers: [], state: fresh(), limitations: [] };
  const result = analyzeAudit(snapshot, library, { allowDraft: true });
  validateAuditResult(result, library, snapshot);
  return result;
}
const fact: AuditFact = { fact_id: 'context.business', state: 'known', value: 'Магазин', answer_ids: ['answer-1'], confirmation: 'unconfirmed',
  parameters: { nested: { values: [null, true, 1.25, 'текст'] } } };
function populatedState(): AuditState {
  return { ...fresh(), facts: { 'context.business': structuredClone(fact) },
    contradictions: [{ fact_id: 'context.business', answer_ids: ['answer-1', 'answer-2'], reason: 'Два разных сообщения.' }],
    humor: { enabled: true, reserved_ids: [], used_ids: [], operations: { operation1: { joke_id: null, text: '', status: 'reserved', question_id: null } } } };
}
/** Structural examples exercise arrays that remain empty while editorial recommendations are unapproved. */
function populatedResult(): AuditResult {
  return { ...analyzed(), profile: { business: 'Магазин', details: { values: [true, null, 2] } }, goal: { objective: 'Уточнить сведения' },
    facts: [structuredClone(fact)], previous_work: [structuredClone(fact)],
    situations: [{ id: 'block-1', title: 'Проверка', kind: 'verification', evidence_status: 'insufficient', evidence_answer_ids: ['answer-1'],
      significance: { level: 'unknown', reason: 'Недостаточно сведений' }, limitations: ['Нужна проверка'] }],
    solutions: [{ id: 'block-1', title: 'Пример', text: 'Текст', service_ids: ['service-1'], action_ids: ['action-1'], limitations: [] }],
    actions: [{ id: 'action-1', text: 'Проверить', after: [], parallel_with: [], deferred_reason: null }],
    tariffs: [{ id: 'tariff-1', title: 'Пример тарифа', details: { amount: null, currency: 'RUB' }, source_urls: ['https://example.test/source'] }],
    contradictions: [{ fact_id: 'context.business', answer_ids: ['answer-1', 'answer-2'], reason: 'Разные сведения' }],
  };
}

test('initial Worker state and actual draft analysis satisfy standalone runtime schemas', () => {
  const state = fresh(); validateAuditState(state);
  assert.deepEqual(validateSchema(state, runtimeStateSchema), []);
  assert.deepEqual(validateSchema(analyzed(), runtimeResultSchema), []);
  assert.deepEqual(validateSchema(initialAuditState(library.version, 'voice', now), runtimeStateSchema), []);
  for (const [schema, value] of [[runtimeStateSchema, state], [runtimeResultSchema, analyzed()]] as const) {
    assert.deepEqual(validateSchema(JSON.parse(JSON.stringify(value)), JSON.parse(JSON.stringify(schema))), []);
  }
  assert.deepEqual(Object.keys(runtimeStateSchema.properties).sort(), Object.keys(state).sort());
  assert.deepEqual(Object.keys(runtimeResultSchema.properties).sort(), Object.keys(analyzed()).sort());
});

test('all nested Worker objects and typed dictionaries have complete valid shapes', () => {
  const state = populatedState(); validateAuditState(state);
  assert.deepEqual(validateSchema(state, runtimeStateSchema), []);
  assert.deepEqual(validateSchema(populatedResult(), runtimeResultSchema), []);
});

test('every top-level required field is enforced and extra fields are rejected', () => {
  for (const [schema, original] of [[runtimeStateSchema, fresh()], [runtimeResultSchema, analyzed()]] as const) {
    for (const key of schema.required) {
      const value = structuredClone(original) as unknown as Record<string, unknown>; delete value[key];
      assert.ok(validateSchema(value, schema).length > 0, `missing ${schema.title}.${key}`);
    }
    assert.ok(validateSchema({ ...original, invented: true }, schema).some(error => error.includes('invented')));
  }
});

test('state schema rejects wrong primitive types, enums, fractional revisions and invalid clocks', () => {
  const cases = [
    { revision: '0' }, { revision: 0.5 }, { revision: -1 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { active_channel: 'email' }, { status: 'completed' }, { history_status: 'done' }, { paused: 'false' },
    { active_since: false }, { finish_reason: 3 }, { elapsed_ms: 900_001 }, { through_seq: Number.NaN },
    { missing_facts: [4] }, { candidate_blocks: {} }, { current_question_id: [] },
  ];
  for (const change of cases) assert.ok(validateSchema({ ...fresh(), ...change }, runtimeStateSchema).length > 0, JSON.stringify(change));
});

test('typed map entries reject malformed facts and malformed humor operations', () => {
  for (const invalid of [true, { ...fact, extra: 1 }, { ...fact, confirmation: 'certain' }, { ...fact, answer_ids: ['same', 'same'] },
    { ...fact, state: 'unknown', value: 'not-null' }, { ...fact, state: 'conflicting', value: null, confirmation: 'explicit' }, { ...fact, parameters: [] }]) {
    assert.ok(validateSchema({ ...fresh(), facts: { arbitrary: invalid } }, runtimeStateSchema).length > 0);
  }
  for (const invalid of [false, { joke_id: null, text: '', status: 'used', question_id: null },
    { joke_id: null, text: '', status: 'reserved' }, { joke_id: null, text: '', status: 'reserved', question_id: null, extra: 1 }]) {
    const value = fresh(); (value.humor.operations as Record<string, unknown>).operation = invalid;
    assert.ok(validateSchema(value, runtimeStateSchema).length > 0);
  }
});

test('result schema enforces each nested definition, including required fields and additional properties', () => {
  const value = populatedResult();
  const examples = {
    Fact: value.facts[0], Contradiction: value.contradictions[0], Situation: value.situations[0],
    Significance: value.situations[0].significance, Solution: value.solutions[0], Action: value.actions[0], Tariff: value.tariffs[0],
  };
  for (const [name, example] of Object.entries(examples)) {
    const definition = (runtimeResultSchema.$defs as Record<string, { required: string[] }>)[name];
    const schema = { ...definition, $defs: runtimeResultSchema.$defs };
    assert.deepEqual(validateSchema(example, schema), [], name);
    assert.ok(validateSchema({ ...example, unknown: true }, schema).length > 0, name);
    for (const key of definition.required) {
      const incomplete = structuredClone(example) as unknown as Record<string, unknown>; delete incomplete[key];
      assert.ok(validateSchema(incomplete, schema).length > 0, `${name}.${key}`);
    }
  }
});

test('result enum and collection element types are validated below the root', () => {
  const changes: ((value: AuditResult) => void)[] = [
    value => { Object.assign(value.situations[0], { kind: 'diagnosis' }); },
    value => { Object.assign(value.situations[0], { evidence_status: 'proven' }); },
    value => { Object.assign(value.situations[0].significance, { level: 'critical' }); },
    value => { Object.assign(value.actions[0], { after: [3] }); },
    value => { Object.assign(value.tariffs[0], { source_urls: [false] }); },
    value => { Object.assign(value.tariffs[0], { details: [] }); },
    value => { Object.assign(value.solutions[0], { service_ids: 'service-1' }); },
    value => { Object.assign(value, { profile: [], summary: '' }); },
  ];
  for (const change of changes) { const value = populatedResult(); change(value); assert.ok(validateSchema(value, runtimeResultSchema).length > 0); }
});

test('recursive JSON rejects non-JSON values and prototype keys, while preserving valid scalar/array/object values', () => {
  for (const goal of [null, true, false, 4, 'text', [null, { nested: [1, true] }], { nested: { value: 'text' } }]) {
    assert.deepEqual(validateSchema({ ...analyzed(), goal }, runtimeResultSchema), []);
  }
  for (const goal of [undefined, Number.POSITIVE_INFINITY, { nested: undefined }, JSON.parse('{"constructor":0}'), JSON.parse('{"prototype":{}}'), JSON.parse('{"__proto__":true}')]) {
    assert.ok(validateSchema({ ...analyzed(), goal }, runtimeResultSchema).length > 0);
  }
  assert.ok(validateSchema({ ...analyzed(), gaps: new Array(2001).fill('gap') }, runtimeResultSchema).length > 0);
  assert.ok(validateSchema({ ...analyzed(), summary: 'a'.repeat(100_001) }, runtimeResultSchema).length > 0);
});
