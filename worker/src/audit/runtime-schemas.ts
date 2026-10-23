import { INTERVIEW_BUDGET_MS } from './contracts.ts';
import type { AuditAction, AuditFact, AuditResult, AuditSituation, AuditSolution, AuditState, AuditTariff, Contradiction, HumorState } from './contracts.ts';

/** Structural JSON Schema for persisted Worker contracts. Library membership, approval,
 * cross-field relationships, action graphs and JSON depth remain validation.ts checks. */
interface Schema {
  $schema?: string;
  $defs?: Record<string, Schema>;
  $ref?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  anyOf?: Schema[];
  properties?: Record<string, Schema | boolean>;
  required?: string[];
  additionalProperties?: Schema | boolean;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

/** Every field in the TypeScript interface must be explicitly described here. */
function closed<T extends object>(properties: { [K in keyof Required<T>]: Schema }, optional: (keyof T)[] = []) {
  return { type: 'object' as const, properties, required: Object.keys(properties).filter(key => !optional.includes(key as keyof T)), additionalProperties: false as const };
}
const ref = (name: string): Schema => ({ $ref: `#/$defs/${name}` });
const text: Schema = { type: 'string', minLength: 1, maxLength: 100_000 };
const nullableText: Schema = { anyOf: [text, { type: 'null' }] };
const integer: Schema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const array = (items: Schema, unique = false): Schema => ({ type: 'array', items, maxItems: 2000, ...(unique ? { uniqueItems: true } : {}) });
const strings = (unique = false) => array(text, unique);
const jsonMap: Schema = {
  type: 'object',
  // These keys are forbidden by the runtime JSON validator even inside otherwise open JSON maps.
  properties: { ['__proto__']: false, prototype: false, constructor: false },
  additionalProperties: ref('Json'),
};
const uncertainStates = ['unknown', 'not_measured', 'not_applicable', 'declined', 'ambiguous', 'not_asked'];
const fact: Schema = {
  ...closed<AuditFact>({
    fact_id: text,
    state: { type: 'string', enum: ['known', ...uncertainStates, 'other', 'conflicting'] },
    value: ref('Json'), answer_ids: strings(true),
    confirmation: { type: 'string', enum: ['explicit', 'unconfirmed', 'disputed'] },
    parameters: jsonMap,
  }, ['parameters']),
  anyOf: [
    { properties: { state: { enum: ['known', 'other'] } } },
    { properties: { state: { enum: uncertainStates }, value: { type: 'null' } } },
    { properties: { state: { const: 'conflicting' }, value: { type: 'null' }, confirmation: { const: 'disputed' } } },
  ],
};

const common: Record<string, Schema> = {
  Json: { anyOf: [
    { type: 'null' }, { type: 'boolean' }, { type: 'number' }, { type: 'string' },
    array(ref('Json')), jsonMap,
  ] },
  Fact: fact,
  Contradiction: closed<Contradiction>({ fact_id: text, answer_ids: strings(), reason: text }),
};

export const runtimeStateSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Pixel Plus Worker AuditState',
  description: 'Persisted Worker state, separate from editorial library preview schemas. Pinned references and cross-field invariants are validated by validateAuditState.',
  ...closed<AuditState>({
    library_version: text, revision: integer, channel_revision: integer,
    active_channel: { type: 'string', enum: ['chat', 'voice'] },
    status: { type: 'string', enum: ['in_progress', 'closing', 'preparing', 'ready', 'failed'] },
    current_question_id: nullableText,
    facts: { type: 'object', additionalProperties: ref('Fact') },
    contradictions: array(ref('Contradiction')), missing_facts: strings(), candidate_blocks: strings(),
    elapsed_ms: { ...integer, maximum: INTERVIEW_BUDGET_MS },
    active_since: { anyOf: [integer, { type: 'null' }] },
    paused: { type: 'boolean' }, finish_reason: nullableText,
    humor: ref('Humor'), through_seq: integer, extracted_through_seq: integer,
    history_status: { type: 'string', enum: ['pending', 'complete', 'incomplete'] },
  }),
  $defs: {
    ...common,
    Humor: closed<HumorState>({
      enabled: { type: 'boolean' }, reserved_ids: strings(true), used_ids: strings(true),
      operations: { type: 'object', additionalProperties: ref('HumorOperation') },
    }),
    HumorOperation: closed<HumorState['operations'][string]>({
      joke_id: nullableText, text: { type: 'string', maxLength: 100_000 },
      status: { type: 'string', enum: ['reserved', 'delivered'] }, question_id: nullableText,
    }),
  },
};

export const runtimeResultSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Pixel Plus Worker AuditResult',
  description: 'Immutable Worker analysis result. Pinned library versions, approved content, snapshot evidence and action dependencies are validated by validateAuditResult.',
  ...closed<AuditResult>({
    snapshot_id: text, library_version: text, rules_version: text, tariffs_version: text, template_version: text,
    profile: jsonMap, goal: ref('Json'), facts: array(ref('Fact')), previous_work: array(ref('Fact')),
    situations: array(ref('Situation')), solutions: array(ref('Solution')), actions: array(ref('Action')), tariffs: array(ref('Tariff')),
    gaps: strings(), contradictions: array(ref('Contradiction')), limitations: strings(), summary: text,
  }),
  $defs: {
    ...common,
    Situation: closed<AuditSituation>({
      id: text, title: text, kind: { type: 'string', enum: ['problem', 'hypothesis', 'verification', 'opportunity'] },
      evidence_status: { type: 'string', enum: ['supported', 'hypothesis', 'insufficient'] }, evidence_answer_ids: strings(),
      significance: ref('Significance'), limitations: strings(),
    }),
    Significance: closed<AuditSituation['significance']>({
      level: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] }, reason: text,
    }),
    Solution: closed<AuditSolution>({
      id: text, title: text, text, service_ids: strings(), action_ids: strings(), limitations: strings(),
    }),
    Action: closed<AuditAction>({ id: text, text, after: strings(), parallel_with: strings(), deferred_reason: nullableText }),
    Tariff: closed<AuditTariff>({ id: text, title: text, details: jsonMap, source_urls: strings() }),
  },
};
