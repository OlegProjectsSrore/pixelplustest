/** A closed, three-valued rule language. Unknown evidence is never a negative answer. */
export type Truth = true | false | 'unknown';
export interface RuleFact { state: string; value: unknown; confirmation?: string; parameters?: Record<string, unknown> }
export type Rule =
  | { all: Rule[] }
  | { any: Rule[] }
  | { not: Rule }
  | { fact: string; op: 'eq' | 'neq' | 'state'; value: string | number | boolean | null }
  | { fact: string; op: 'in'; value: (string | number | boolean)[] }
  | { fact: string; op: 'fields_known'; fields: string[] }
  | { fact: string; op: 'gt' | 'gte' | 'lt' | 'lte'; value: number; unit: string; period: string };

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const primitive = (value: unknown) => value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value));
const safeKey = (key: string) => !['__proto__', 'prototype', 'constructor'].includes(key);

export function validateRule(value: unknown, facts?: ReadonlySet<string>, depth = 0): asserts value is Rule {
  if (depth > 20 || !isRecord(value)) throw new Error('Invalid rule or excessive rule depth');
  const keys = Object.keys(value);
  for (const combination of ['all', 'any'] as const) {
    if (combination in value) {
      const children = value[combination];
      if (keys.length !== 1 || !Array.isArray(children) || children.length === 0 || children.length > 64) throw new Error(`Invalid ${combination} rule`);
      children.forEach(child => validateRule(child, facts, depth + 1));
      return;
    }
  }
  if ('not' in value) {
    if (keys.length !== 1) throw new Error('Invalid not rule');
    validateRule(value.not, facts, depth + 1);
    return;
  }
  if (typeof value.fact !== 'string' || !safeKey(value.fact) || (facts && !facts.has(value.fact))) throw new Error(`Unknown rule fact: ${String(value.fact)}`);
  const operation = value.op;
  if (['eq', 'neq', 'state'].includes(String(operation))) {
    if (keys.some(key => !['fact', 'op', 'value'].includes(key)) || !('value' in value) || !primitive(value.value)) throw new Error('Invalid comparison');
    if (operation === 'state' && !['known', 'unknown', 'not_measured', 'not_applicable', 'declined', 'ambiguous', 'other', 'not_asked', 'conflicting'].includes(String(value.value))) throw new Error('Invalid fact state');
    if (typeof value.value === 'number') throw new Error('Numeric comparisons require an operation with unit and period');
  } else if (operation === 'in') {
    if (keys.some(key => !['fact', 'op', 'value'].includes(key)) || !Array.isArray(value.value) || !value.value.length || value.value.length > 64 || !value.value.every(item => typeof item === 'string' || typeof item === 'boolean')) throw new Error('Invalid membership rule');
  } else if (operation === 'fields_known') {
    if (keys.some(key => !['fact', 'op', 'fields'].includes(key)) || !Array.isArray(value.fields) || !value.fields.length || value.fields.length > 64 || !value.fields.every(field => typeof field === 'string' && safeKey(field))) throw new Error('Invalid field rule');
  } else if (['gt', 'gte', 'lt', 'lte'].includes(String(operation))) {
    if (keys.some(key => !['fact', 'op', 'value', 'unit', 'period'].includes(key)) || typeof value.value !== 'number' || !Number.isFinite(value.value) || typeof value.unit !== 'string' || !value.unit || typeof value.period !== 'string' || !value.period) throw new Error('Numeric rule needs value, unit and period');
  } else {
    throw new Error(`Unsupported rule operation: ${String(operation)}`);
  }
}

export function evaluateRule(rule: Rule, facts: Readonly<Record<string, RuleFact>>): Truth {
  if ('all' in rule) {
    const values = rule.all.map(child => evaluateRule(child, facts));
    return values.includes(false) ? false : values.includes('unknown') ? 'unknown' : true;
  }
  if ('any' in rule) {
    const values = rule.any.map(child => evaluateRule(child, facts));
    return values.includes(true) ? true : values.includes('unknown') ? 'unknown' : false;
  }
  if ('not' in rule) {
    const value = evaluateRule(rule.not, facts);
    return value === 'unknown' ? 'unknown' : !value;
  }
  const fact = Object.hasOwn(facts, rule.fact) ? facts[rule.fact] : undefined;
  if (rule.op === 'state') return (fact?.state ?? 'not_asked') === rule.value;
  if (!fact || fact.state !== 'known' || (fact.confirmation !== undefined && fact.confirmation !== 'explicit')) return 'unknown';
  if (rule.op === 'eq') return fact.value === rule.value;
  if (rule.op === 'neq') return fact.value !== rule.value;
  if (rule.op === 'in') return rule.value.some(value => value === fact.value);
  if (rule.op === 'fields_known') {
    if (!isRecord(fact.value)) return 'unknown';
    return rule.fields.every(field => {
      const part = (fact.value as Record<string, unknown>)[field];
      return isRecord(part) && part.state === 'known' && part.value !== null && part.value !== undefined;
    }) ? true : 'unknown';
  }
  if (!('unit' in rule)) return 'unknown';
  const quantity = isRecord(fact.value) ? fact.value : { ...fact.parameters, value: fact.value };
  if (!isRecord(quantity) || quantity.unit !== rule.unit || quantity.period !== rule.period || quantity.approximate !== false || quantity.min !== undefined || quantity.max !== undefined || typeof quantity.value !== 'number' || !Number.isFinite(quantity.value)) return 'unknown';
  if (rule.op === 'gt') return quantity.value > rule.value;
  if (rule.op === 'gte') return quantity.value >= rule.value;
  if (rule.op === 'lt') return quantity.value < rule.value;
  return quantity.value <= rule.value;
}

export function ruleFactIds(rule: Rule): string[] {
  if ('all' in rule) return [...new Set(rule.all.flatMap(ruleFactIds))];
  if ('any' in rule) return [...new Set(rule.any.flatMap(ruleFactIds))];
  if ('not' in rule) return ruleFactIds(rule.not);
  return [rule.fact];
}
