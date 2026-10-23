import type { Json } from './contracts.ts';
import type { FactDefinition } from './library.ts';

/** Core-owned declarations, structurally compatible with the channel's small ValueSchema. */
export type RuntimeValueSchema =
  | { type: 'string'; enum?: readonly string[]; max_length?: number }
  | { type: 'number'; minimum?: number; maximum?: number }
  | { type: 'boolean' | 'null' }
  | { type: 'array'; items: RuntimeValueSchema; max_items?: number }
  | { type: 'object'; properties: Readonly<Record<string, RuntimeValueSchema>>; required?: readonly string[] }
  | { type: 'union'; any_of: readonly RuntimeValueSchema[] };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text: RuntimeValueSchema = { type: 'string', max_length: 8000 };
const nullable = (schema: RuntimeValueSchema): RuntimeValueSchema => ({ type: 'union', any_of: [schema, { type: 'null' }] });
const object = (properties: Record<string, RuntimeValueSchema>, required?: string[]): RuntimeValueSchema => ({ type: 'object', properties, ...(required ? { required } : {}) });

// facts.json record_contract.quantity and the methodology: preserve only supplied dimensions.
// No calendar-object shape is specified in the sources, so periods retain the visitor's wording.
export function quantitySchema(money = false): RuntimeValueSchema {
  return object({ value: nullable({ type: 'number' }), min: nullable({ type: 'number' }), max: nullable({ type: 'number' }),
    unit: nullable(text), ...(money ? { currency: nullable(text) } : {}), period: nullable(text), approximate: { type: 'boolean' } });
}
function statefulField(): RuntimeValueSchema {
  const quantity = quantitySchema(true) as Extract<RuntimeValueSchema, { type: 'object' }>;
  const completeQuantity: RuntimeValueSchema = { type: 'union', any_of: [
    object({ ...quantity.properties, value: { type: 'number' }, unit: text, period: text }, ['value', 'unit', 'period', 'approximate']),
    object({ ...quantity.properties, min: { type: 'number' }, max: { type: 'number' }, unit: text, period: text }, ['min', 'max', 'unit', 'period', 'approximate']),
  ] };
  return { type: 'union', any_of: [
    object({ state: { type: 'string', enum: ['known'] }, value: { type: 'union', any_of: [text, completeQuantity] } }, ['state', 'value']),
    object({ state: { type: 'string', enum: ['other'] }, value: text }, ['state', 'value']),
    object({ state: { type: 'string', enum: ['unknown', 'not_measured', 'not_applicable', 'declined', 'ambiguous'] }, value: { type: 'null' } }, ['state', 'value']),
  ] };
}
export const HISTORY_FIELDS = ['work', 'period_and_duration', 'goal', 'executor_and_resources', 'outcome', 'measurement', 'current_status', 'stop_reason'] as const;
const DETAIL_FIELDS = new Set(['description', 'object', 'observation', 'period', 'context', 'task', 'current_way', 'constraint']);

/** Select by documented family AND declared field names; an unknown content shape stays unsupported. */
export function runtimeSchemaForFact(fact: FactDefinition, blockIds: readonly string[] = []): RuntimeValueSchema | undefined {
  if (fact.value_type === 'money' || fact.value_type === 'number') return quantitySchema(fact.value_type === 'money');
  if (fact.value_type === 'period') return text;
  if (fact.value_type !== 'object') return undefined;
  if (fact.id.endsWith('.details') && fact.field_states === true && fact.required_fields?.length && fact.required_fields.every(field => DETAIL_FIELDS.has(field))) {
    return object(Object.fromEntries(fact.required_fields.map(field => [field, statefulField()])));
  }
  if (fact.id.endsWith('.history') && record(fact.fields) && Array.isArray(fact.fields.attempts_status) &&
      fact.fields.attempts_status.every(value => typeof value === 'string') && record(fact.fields.attempts) && record(fact.fields.attempts.item)) {
    const declared = fact.fields.attempts.item;
    if (Object.keys(declared).some(field => !['attempt_id', 'applies_to_block_ids', ...HISTORY_FIELDS].includes(field))) return undefined;
    const fields: Record<string, RuntimeValueSchema> = { attempt_id: text,
      applies_to_block_ids: { type: 'array', items: blockIds.length ? { type: 'string', enum: blockIds } : text } };
    for (const field of HISTORY_FIELDS) if (Object.hasOwn(declared, field)) fields[field] = statefulField();
    return object({ attempts_status: { type: 'string', enum: fact.fields.attempts_status }, attempts: { type: 'array', items: object(fields, ['attempt_id']) } });
  }
  if (fact.id.endsWith('.impact') && record(fact.fields) && Array.isArray(fact.fields.level) && fact.fields.level.every(value => typeof value === 'string') &&
      Object.keys(fact.fields).every(field => ['level', 'description', 'period'].includes(field))) {
    return object({ level: { type: 'string', enum: fact.fields.level }, description: text, period: text });
  }
  if (fact.id === 'context.scale' && Array.isArray(fact.parameters) && fact.parameters.every(field => ['metric', 'value', 'min', 'max', 'unit', 'period', 'approximate'].includes(field))) {
    const quantity = quantitySchema() as Extract<RuntimeValueSchema, { type: 'object' }>;
    return object(Object.fromEntries(fact.parameters.map(field => [field, field === 'metric' ? text : quantity.properties[field]!])));
  }
  return undefined;
}

/** Validates supplied fields only. It never coerces, enriches, mutates or fills missing data. */
export function validateRuntimeValue(value: unknown, schema: RuntimeValueSchema, depth = 0): asserts value is Json {
  if (depth > 16) throw new Error('Structured value exceeds depth limit');
  let valid = false;
  switch (schema.type) {
    case 'null': valid = value === null; break;
    case 'boolean': valid = typeof value === 'boolean'; break;
    case 'number': valid = typeof value === 'number' && Number.isFinite(value) && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum); break;
    case 'string': valid = typeof value === 'string' && value.trim().length > 0 && value.length <= (schema.max_length ?? 8000) && (!schema.enum || schema.enum.includes(value)); break;
    case 'array':
      valid = Array.isArray(value) && value.length <= (schema.max_items ?? 100);
      if (valid) for (const item of value as unknown[]) validateRuntimeValue(item, schema.items, depth + 1);
      break;
    case 'object':
      valid = record(value) && Object.keys(value).every(key => !['__proto__', 'prototype', 'constructor'].includes(key) && Object.hasOwn(schema.properties, key)) && (schema.required ?? []).every(key => Object.hasOwn(value, key));
      if (valid) for (const [key, item] of Object.entries(value as Record<string, unknown>)) validateRuntimeValue(item, schema.properties[key]!, depth + 1);
      break;
    case 'union':
      for (const member of schema.any_of) { try { validateRuntimeValue(value, member, depth + 1); valid = true; break; } catch { /* Try another declared branch. */ } }
  }
  if (!valid) throw new Error('Value does not match the declared runtime schema');
}

/** Merge only compatible observations. History array identity is explicit, never positional. */
export function mergeStructuredValues(first: Json, second: Json, path = ''): Json {
  if (JSON.stringify(first) === JSON.stringify(second)) return structuredClone(first);
  if (record(first) && record(second)) {
    if (['unknown', 'ambiguous', 'declined'].includes(String(first.state)) && second.state === 'known') return structuredClone(second) as Json;
    if (['unknown', 'ambiguous', 'declined'].includes(String(second.state)) && first.state === 'known') return structuredClone(first) as Json;
    const merged = structuredClone(first) as Record<string, Json>;
    for (const [key, value] of Object.entries(second)) merged[key] = Object.hasOwn(merged, key) ? mergeStructuredValues(merged[key]!, value as Json, path ? `${path}.${key}` : key) : structuredClone(value) as Json;
    return merged;
  }
  if (Array.isArray(first) && Array.isArray(second) && path === 'attempts') {
    const attempts = new Map<string, Json>();
    for (const item of [...first, ...second]) {
      if (!record(item) || typeof item.attempt_id !== 'string') throw new Error('History attempt has no stable ID');
      attempts.set(item.attempt_id, attempts.has(item.attempt_id) ? mergeStructuredValues(attempts.get(item.attempt_id)!, item as Json, `attempts.${item.attempt_id}`) : structuredClone(item) as Json);
    }
    return [...attempts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  }
  throw new Error('Structured observations conflict');
}
