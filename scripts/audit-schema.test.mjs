import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSchema } from './audit-schema.mjs';

test('runtime integer and typed dictionaries reject fractional or malformed values', () => {
  const schema = { type: 'object', additionalProperties: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } };
  assert.deepEqual(validateSchema({ a: 0, b: 42 }, schema), []);
  for (const value of [{ a: .5 }, { a: '1' }, { a: -1 }, { a: Infinity }]) assert.ok(validateSchema(value, schema).length);
});
test('array limits, semantic uniqueness, Unicode length and referenced sibling constraints', () => {
  assert.ok(validateSchema([{ a: 1, b: 2 }, { b: 2, a: 1 }], { type: 'array', uniqueItems: true }).length);
  assert.ok(validateSchema([1, 2], { type: 'array', maxItems: 1 }).length);
  assert.deepEqual(validateSchema('😀', { type: 'string', minLength: 1, maxLength: 1 }), []);
  assert.ok(validateSchema('аб', { type: 'string', maxLength: 1 }).length);
  assert.ok(validateSchema(2, { $defs: { value: { type: 'integer' } }, $ref: '#/$defs/value', maximum: 1 }).length);
  assert.deepEqual(validateSchema({ a: 1 }, true), []);
  assert.ok(validateSchema(null, false).length);
  assert.ok(validateSchema({ constructor: 'forbidden' }, { type: 'object', properties: { constructor: false } }).length);
  assert.deepEqual(validateSchema({ constructor: 'ordinary JSON key' }, { type: 'object', properties: {}, additionalProperties: { type: 'string' } }), []);
});
