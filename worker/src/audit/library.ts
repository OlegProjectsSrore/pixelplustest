import factsData from './data/facts.json' with { type: 'json' };
import questionsData from './data/question-bank.json' with { type: 'json' };
import answersData from './data/answer-options.json' with { type: 'json' };
import solutionsData from './data/bottlenecks.json' with { type: 'json' };
import domainsData from './data/domains.json' with { type: 'json' };
import tariffsData from './data/tariffs.json' with { type: 'json' };
import sourcesData from './data/sources.json' with { type: 'json' };
import jokesData from './data/off-topic-jokes.json' with { type: 'json' };
import scenarioData from './data/scenario.json' with { type: 'json' };
import servicesData from './data/services-catalog.json' with { type: 'json' };
import casesData from './data/cases-map.json' with { type: 'json' };
import stateSchemaData from './data/audit-state.schema.json' with { type: 'json' };
import resultSchemaData from './data/audit-result.schema.json' with { type: 'json' };
import { evaluateRule, isRecord, validateRule, type Rule, type RuleFact, type Truth } from './rules.ts';
import { runtimeSchemaForFact, type RuntimeValueSchema } from './value-schemas.ts';
import { runtimeStateSchema, runtimeResultSchema } from './runtime-schemas.ts';

export interface Governed { id: string; version: string; status: string; reviewer: string | null; approved_at: string | null }
export interface FactDefinition extends Governed {
  label: string; value_type: string; states: string[]; values?: { id: string; label: string }[];
  required_fields?: string[]; fields?: Record<string, unknown>; field_states?: boolean;
  parameters?: string[];
  /** Formal server projection; independent of source JSON examples and editorial approval. */
  runtime_schema?: RuntimeValueSchema;
}
export interface Question extends Governed {
  fact_ids: string[]; chat: string; voice: string; phase: string; estimated_seconds: number;
  domain?: string; related_block?: string; fields?: string[]; condition?: Rule; priority?: number;
  transitions?: Record<string, string>; max_clarifications?: number;
}
export interface Solution extends Governed {
  domain: string; title: string; type: 'data_gap' | 'hypothesis' | 'opportunity' | 'reported_issue';
  matrix: { required: string[]; clarifying: string[]; excluding: string[] };
  inclusion: Rule; exclusion: Rule;
  significance: { fact: string; rule: string };
  previous_attempts: { fact: string; required_before_recommendation: boolean; if_failed: string; if_unknown: string };
  solution: { steps: { order: number; text: string; owner: string; prerequisites: string[] }[]; deliverable: string; prerequisites: string[]; limitations: string[] };
  services: string[]; sources: { source_id: string; locator: string }[];
  pdf: Record<string, unknown>; checks: Record<string, string>;
  test_cases?: { id: string; category: string; facts: Record<string, RuleFact>; inclusion: Truth; exclusion: Truth }[];
}
export interface Tariff extends Governed {
  service_id: string; name: string; commercial_approval: string; auto_selectable: boolean;
  selection_rule?: Rule; price: { type: string; amount: number | null; currency: string; unit: string; billing_period: string; valid_until: string | null; min?: number; max?: number };
  source: { id: string; checked_on: string }; conditions: string[]; included: string[]; excluded: string[]; not_stated: string[];
  tax?: Record<string, unknown>; conflicts: unknown[];
}
export interface Source { id: string; url: string | null; title: string; local_path: string; sha256: string; review?: { scope?: string } }
export interface Service extends Governed { name: string; source_id: string; scope: string[]; tariff_ids: string[]; block_ids: string[] }
export interface Case { id: string; source_id: string; block_ids: string[]; status: string; visitor_forecast: boolean }
export interface Scenario {
  entry_questions: string[];
  mandatory_entry_questions?: string[];
  clock: { max_seconds: number; no_new_deep_branch_after: number; closing_from: number };
  phases: { id: string; next?: string; terminal?: boolean }[];
  routing: { max_clarifications_per_fact: number };
}
export interface JokeCategory { id: string; selection_source: string; do_not_use_when: string; jokes: { id: string; text: string }[] }
export interface JokeLibrary {
  library_version: string; joke_count: number; categories: JokeCategory[]; return_phrases: string[]; neutral_replies: Record<string, string>;
}
export interface AuditLibrary {
  version: string; rulesVersion: string; tariffVersion: string; templateVersion: string;
  status: string; facts: FactDefinition[]; questions: Question[]; solutions: Solution[]; tariffs: Tariff[]; sources: Source[];
  answers: { id: string; fact_id: string; standard_values: { value: string; meaning: string }[] }[];
  domains: { id: string; title: string }[];
  relationships: { a: string; b: string; relation: string }[];
  jokes: JokeLibrary;
  scenario: Scenario; services: Service[]; cases: Case[];
  /** Editorial content schemas; Worker transport/state schemas are separate runtime-schemas.ts exports. */
  schemas: { state: { required: string[] }; result: { required: string[] } };
}

/** Version is intentionally pinned; a changed content release must receive a new version. */
export const library: AuditLibrary = {
  version: '0.1.4', rulesVersion: '1.0.0', tariffVersion: tariffsData.version, templateVersion: '1.2.0',
  status: solutionsData.status,
  facts: (factsData.items as FactDefinition[]).map(fact => ({ ...fact, runtime_schema: runtimeSchemaForFact(fact, solutionsData.items.map(block => block.id)) })), questions: questionsData.items as Question[],
  solutions: solutionsData.items as unknown as Solution[], tariffs: tariffsData.items as unknown as Tariff[],
  sources: sourcesData.items as Source[], answers: answersData.items,
  domains: domainsData.items, relationships: domainsData.relationships, jokes: jokesData as JokeLibrary,
  scenario: scenarioData, services: servicesData.items as Service[], cases: casesData.items,
  schemas: { state: stateSchemaData, result: resultSchemaData },
};

// 0.1.4 only adds the introductory block. Keep the previous projection available
// for already-created sessions and report snapshots pinned to 0.1.3.
const introductionIds = new Set(scenarioData.mandatory_entry_questions);
const introductionFacts = new Set(questionsData.items.filter(question => introductionIds.has(question.id)).flatMap(question => question.fact_ids));
const previousLibrary: AuditLibrary = {
  ...library, version: '0.1.3',
  facts: library.facts.filter(fact => !introductionFacts.has(fact.id)),
  questions: library.questions.filter(question => !introductionIds.has(question.id)),
  scenario: { ...library.scenario, entry_questions: library.scenario.entry_questions.filter(id => !introductionIds.has(id)), mandatory_entry_questions: [] },
  schemas: {
    state: { ...stateSchemaData, properties: { ...stateSchemaData.properties, library_version: { const: '0.1.3' } } },
    result: { ...resultSchemaData, properties: { ...resultSchemaData.properties, library_version: { const: '0.1.3' } } },
  } as AuditLibrary['schemas'],
};

export function getLibrary(version = library.version): AuditLibrary {
  if (version === previousLibrary.version) return previousLibrary;
  if (version !== library.version) throw new Error(`Library version is unavailable: ${version}`);
  return library;
}
export function isApproved(item: { status: string; reviewer?: string | null; approved_at?: string | null }): boolean {
  return item.status === 'approved' && typeof item.reviewer === 'string' && item.reviewer.trim().length > 0 && typeof item.approved_at === 'string' && Number.isFinite(Date.parse(item.approved_at));
}
export function assertLibraryReady(lib = library): void {
  if (lib.status !== 'approved' || !lib.questions.some(isApproved) || !lib.solutions.some(isApproved)) throw new Error('LIBRARY_NOT_APPROVED');
  if (editorialSchemaErrors(lib).length) throw new Error('LIBRARY_CONTENT_SCHEMA_INCOMPATIBLE');
  if (!runtimeSchemasCompatible()) throw new Error('LIBRARY_RUNTIME_SCHEMA_INCOMPATIBLE');
}

function runtimeSchemasCompatible(): boolean {
  return ['revision', 'channel_revision', 'elapsed_ms', 'humor', 'contradictions'].every(key => runtimeStateSchema.required.includes(key)) &&
    ['snapshot_id', 'situations', 'solutions', 'actions', 'tariffs'].every(key => runtimeResultSchema.required.includes(key));
}
function editorialSchemaErrors(lib: AuditLibrary): string[] {
  const errors: string[] = [];
  const entries = [
    ['state', lib.schemas.state, ['audit_session_id', 'library_version', 'channel', 'elapsed_seconds', 'status', 'facts', 'history', 'asked_question_ids']],
    ['result', lib.schemas.result, ['title', 'library_version', 'preview', 'limitations', 'findings', 'gaps', 'tariff_ids']],
  ] as const;
  for (const [name, schema, required] of entries) {
    const raw: unknown = schema;
    if (!isRecord(raw) || raw.type !== 'object' || !Array.isArray(raw.required) || !required.every(key => (raw.required as unknown[]).includes(key)) ||
        !isRecord(raw.properties) || !isRecord(raw.properties.library_version) || raw.properties.library_version.const !== lib.version) {
      errors.push(`Editorial ${name} schema does not describe the pinned content format`);
    }
  }
  return errors;
}

export interface LibraryValidation { errors: string[]; warnings: string[]; counts: Record<string, number>; productionReady: boolean }
export function validateLibrary(lib: AuditLibrary = library, options: { ruleChecks?: unknown } = {}): LibraryValidation {
  const errors: string[] = [], warnings: string[] = [];
  const ruleChecks = options.ruleChecks === undefined ? undefined : validateRuleChecks(options.ruleChecks, lib);
  if (ruleChecks) errors.push(...ruleChecks.errors);
  const reviewedChecks = isRecord(options.ruleChecks) && options.ruleChecks.status === 'approved' && typeof options.ruleChecks.reviewer === 'string' && options.ruleChecks.reviewer.trim() && typeof options.ruleChecks.approved_at === 'string' && Number.isFinite(Date.parse(options.ruleChecks.approved_at)) && ruleChecks?.errors.length === 0;
  const index = (items: { id: string }[], name: string) => {
    const ids = new Set<string>();
    for (const item of items) {
      if (!item || typeof item.id !== 'string' || !/^[a-z][a-z0-9_.-]*$/.test(item.id)) errors.push(`${name}: invalid id`);
      else if (ids.has(item.id)) errors.push(`${name}: duplicate ${item.id}`);
      else ids.add(item.id);
    }
    return ids;
  };
  const factIds = index(lib.facts, 'facts'), questionIds = index(lib.questions, 'questions'), solutionIds = index(lib.solutions, 'solutions');
  const sourceIds = index(lib.sources, 'sources'), domainIds = index(lib.domains, 'domains'), serviceIds = index(lib.services, 'services');
  const tariffIds = index(lib.tariffs, 'tariffs'); index(lib.answers, 'answers'); index(lib.cases, 'cases');
  const ref = (id: string, ids: Set<string>, context: string) => { if (!ids.has(id)) errors.push(`${context}: unknown reference ${id}`); };
  const rule = (value: unknown, context: string) => { try { validateRule(value, factIds); } catch (error) { errors.push(`${context}: ${String(error)}`); } };
  for (const fact of lib.facts) {
    if (!['text', 'enum', 'boolean', 'money', 'period', 'string_list', 'object', 'number'].includes(fact.value_type) || !Array.isArray(fact.states)) errors.push(`fact ${fact.id}: invalid shape`);
    if (fact.value_type === 'enum' && !fact.values?.length) warnings.push(`fact ${fact.id}: enum values are missing; known values cannot be accepted`);
    if (isApproved(fact) && fact.value_type === 'enum' && !fact.values?.length) errors.push(`fact ${fact.id}: approved enum has no vocabulary`);
  }
  for (const question of lib.questions) {
    if (!question.chat || !question.voice || !question.fact_ids?.length || !Number.isFinite(question.estimated_seconds) || question.estimated_seconds <= 0) errors.push(`question ${question.id}: incomplete shape`);
    for (const fact of question.fact_ids ?? []) ref(fact, factIds, question.id);
    if (question.domain) ref(question.domain, domainIds, question.id);
    if (question.related_block) ref(question.related_block, solutionIds, question.id);
    if (question.condition) rule(question.condition, question.id);
    if (question.transitions) for (const target of Object.values(question.transitions)) {
      if (!questionIds.has(target) && !['next_relevant_question', 'record_unknown_and_continue', 'record_not_measured_and_continue', 'exclude_block', 'skip_without_reask', 'one_neutral_clarification', 'clarify_before_replacing'].includes(target)) errors.push(`${question.id}: unknown transition ${target}`);
      if (target === question.id) errors.push(`${question.id}: transition loop without progress`);
    }
  }
  for (const answer of lib.answers) { ref(answer.fact_id, factIds, answer.id); const seen = new Set<string>(); for (const option of answer.standard_values) { if (!option.value || seen.has(option.value)) errors.push(`${answer.id}: duplicate/invalid option`); seen.add(option.value); } }
  for (const block of lib.solutions) {
    ref(block.domain, domainIds, block.id); rule(block.inclusion, block.id); rule(block.exclusion, block.id);
    for (const fact of [...block.matrix.required, ...block.matrix.clarifying, ...block.matrix.excluding]) ref(fact, factIds, block.id);
    for (const fact of block.matrix.required) if (!lib.questions.some(question => question.fact_ids.includes(fact))) errors.push(`${block.id}: unreachable required fact ${fact}`);
    for (const source of block.sources) ref(source.source_id, sourceIds, block.id);
    for (const service of block.services) ref(service, serviceIds, block.id);
    if (!block.solution.steps.length || !block.sources.length) errors.push(`${block.id}: missing steps/sources`);
    if (isApproved(block)) {
      if (!['positive', 'exclusion', 'insufficient', 'boundary'].every(key => typeof block.checks[key] === 'string' && block.checks[key])) errors.push(`${block.id}: missing check references`);
      // Existing checks are identifiers, not executable approved evidence. Release must supply reviewed examples.
      if (!Array.isArray(block.test_cases) && !reviewedChecks) errors.push(`${block.id}: approved block lacks reviewed executable test_cases or rule-checks`);
      else if (block.test_cases) {
        for (const category of ['positive', 'exclusion', 'insufficient', 'boundary']) if (!block.test_cases.some(example => example.category === category)) errors.push(`${block.id}: missing ${category} example`);
        for (const example of block.test_cases) {
          if (!isRecord(example.facts) || ![true, false, 'unknown'].includes(example.inclusion) || ![true, false, 'unknown'].includes(example.exclusion)) { errors.push(`${block.id}: invalid example ${example.id}`); continue; }
          for (const fact of Object.keys(example.facts)) ref(fact, factIds, example.id);
          if (evaluateRule(block.inclusion, example.facts) !== example.inclusion || evaluateRule(block.exclusion, example.facts) !== example.exclusion) errors.push(`${block.id}: example failed ${example.id}`);
        }
      }
    }
  }
  for (const relationship of lib.relationships) { ref(relationship.a, solutionIds, 'relationship'); ref(relationship.b, solutionIds, 'relationship'); }
  for (const tariff of lib.tariffs) {
    ref(tariff.service_id, serviceIds, tariff.id); ref(tariff.source.id, sourceIds, tariff.id);
    if (tariff.selection_rule) rule(tariff.selection_rule, tariff.id);
    if (isApproved(tariff) && tariff.commercial_approval === 'approved' && !tariff.selection_rule) errors.push(`${tariff.id}: approved tariff lacks an evidence rule`);
    if (tariff.auto_selectable && (!isApproved(tariff) || tariff.commercial_approval !== 'approved' || !tariff.selection_rule || tariff.conflicts.length)) errors.push(`${tariff.id}: unsafe automatic tariff`);
  }
  for (const service of lib.services) { ref(service.source_id, sourceIds, service.id); for (const id of service.tariff_ids) ref(id, tariffIds, service.id); for (const id of service.block_ids) ref(id, solutionIds, service.id); }
  for (const item of lib.cases) { ref(item.source_id, sourceIds, item.id); item.block_ids.forEach(id => ref(id, solutionIds, item.id)); if (item.visitor_forecast !== false) errors.push(`${item.id}: a case must not forecast the visitor's result`); }
  for (const id of lib.scenario.entry_questions) ref(id, questionIds, 'scenario entry');
  const mandatory = lib.scenario.mandatory_entry_questions ?? [];
  if (new Set(mandatory).size !== mandatory.length) errors.push('Duplicate mandatory entry question');
  for (const [index, id] of mandatory.entries()) {
    const question = lib.questions.find(item => item.id === id);
    if (lib.scenario.entry_questions[index] !== id || !question || question.phase !== 'orientation' || question.condition) errors.push(`Invalid mandatory entry question: ${id}`);
  }
  if (lib.scenario.clock.max_seconds !== 900 || lib.scenario.clock.no_new_deep_branch_after !== 720 || lib.scenario.clock.closing_from !== 840) errors.push('Scenario clock disagrees with architecture');
  const phases = new Map(lib.scenario.phases.map(phase => [phase.id, phase]));
  for (const phase of phases.values()) {
    const seen = new Set<string>(); let current: typeof phase | undefined = phase;
    while (current && !current.terminal) {
      if (seen.has(current.id) || !current.next) { errors.push(`scenario ${phase.id}: no path to terminal phase`); break; }
      seen.add(current.id); current = phases.get(current.next);
    }
    if (!current) errors.push(`scenario ${phase.id}: missing next phase`);
  }
  errors.push(...editorialSchemaErrors(lib));
  if (!runtimeSchemasCompatible()) errors.push('Worker runtime schemas disagree with the runtime contracts');
  for (const source of lib.sources) {
    if (source.url === null && source.review?.scope === 'requirements_reference' && source.local_path && /^[a-f0-9]{64}$/.test(source.sha256)) continue;
    try { if (!source.url || new URL(source.url).protocol !== 'https:') errors.push(`${source.id}: source must be HTTPS`); } catch { errors.push(`${source.id}: invalid source URL`); }
  }
  const jokes = lib.jokes.categories.flatMap(category => category.jokes);
  index(lib.jokes.categories, 'joke categories'); index(jokes, 'jokes');
  if (jokes.length !== lib.jokes.joke_count || new Set(jokes.map(joke => joke.text.trim())).size !== jokes.length) errors.push('Joke count or text uniqueness mismatch');
  if (!lib.jokes.return_phrases.length || !lib.jokes.neutral_replies.off_topic) errors.push('Missing neutral/return replies');
  for (const category of lib.jokes.categories) if (!['question_topic', 'previous_audit_topic', 'fallback'].includes(category.selection_source) || !category.do_not_use_when || category.jokes.some(joke => !joke.text)) errors.push(`${category.id}: invalid joke category`);
  const governed = [...lib.facts, ...lib.questions, ...lib.solutions, ...lib.tariffs];
  for (const item of governed) if (item.status === 'approved' && !isApproved(item)) errors.push(`${item.id}: approval lacks reviewer/date`);
  let productionReady = false; try { assertLibraryReady(lib); productionReady = errors.length === 0; } catch (error) { warnings.push(`Public sessions and production recommendations are disabled: ${error instanceof Error ? error.message : String(error)}`); }
  return { errors, warnings, counts: { facts: factIds.size, questions: questionIds.size, solutions: solutionIds.size, tariffs: lib.tariffs.length, jokes: jokes.length }, productionReady };
}

/** Build-time export; only the selected block is supplied to a voice call. No recommendations are sent. */
export function compileVoiceBlocks(lib: AuditLibrary = library, options: { allowDraft?: boolean } = {}): Record<string, { library_version: string; questions: { id: string; text: string; fact_ids: string[]; options: { id: string; text: string }[] }[] }> {
  if (!options.allowDraft) assertLibraryReady(lib);
  const blocks: ReturnType<typeof compileVoiceBlocks> = {};
  for (const question of lib.questions) {
    if (!isApproved(question) && !(options.allowDraft && question.status === 'draft')) continue;
    // Save each mandatory introductory answer before the server chooses the next question.
    const key = lib.scenario.mandatory_entry_questions?.includes(question.id) ? question.id : question.related_block ?? question.domain ?? question.phase;
    const block = blocks[key] ??= { library_version: lib.version, questions: [] };
    block.questions.push({ id: question.id, text: question.voice, fact_ids: question.fact_ids, options: question.fact_ids.flatMap(id => lib.facts.find(fact => fact.id === id)?.values?.map(value => ({ id: value.id, text: value.label })) ?? []) });
  }
  return blocks;
}

export interface LibraryManifest { library_version: string; files: (({ path: string; name?: string } | { name: string; path?: string }) & { sha256: string; bytes?: number })[] }
/** Exact bytes are supplied by the build script; no runtime filesystem dependency. */
export async function validateLibraryManifest(manifest: unknown, files: Record<string, Uint8Array>): Promise<string[]> {
  if (!isRecord(manifest) || typeof manifest.library_version !== 'string' || !Array.isArray(manifest.files)) return ['Invalid library manifest shape'];
  const errors: string[] = [], seen = new Set<string>();
  if (manifest.library_version !== library.version) errors.push('Manifest library version differs from runtime');
  for (const item of manifest.files) {
    if (!isRecord(item)) { errors.push('Invalid manifest entry'); continue; }
    const path = item.path ?? item.name;
    if (typeof path !== 'string' || path.includes('..') || path.includes('/') || path.includes('\\') || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) || seen.has(path)) { errors.push('Invalid or duplicate manifest entry'); continue; }
    seen.add(path);
    if (!Object.hasOwn(files, path)) { errors.push(`Missing manifest input: ${path}`); continue; }
    const bytes = new Uint8Array(files[path]);
    if (item.bytes !== undefined && item.bytes !== bytes.byteLength) errors.push(`Manifest byte size mismatch: ${path}`);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (hash !== item.sha256) errors.push(`Manifest hash mismatch: ${path}`);
  }
  for (const path of Object.keys(files)) if (!seen.has(path)) errors.push(`Input absent from manifest: ${path}`);
  return errors;
}

/** Build-only bridge from the existing editorial fixture format into the Worker rule interpreter. */
export function validateRuleChecks(input: unknown, lib: AuditLibrary = library): { errors: string[]; count: number } {
  if (!isRecord(input) || !Array.isArray(input.items)) return { errors: ['Invalid rule-checks collection'], count: 0 };
  const errors: string[] = [], seen = new Set<string>();
  for (const item of input.items) {
    if (!isRecord(item) || typeof item.id !== 'string' || !Array.isArray(item.fact_fixture) || seen.has(item.id)) { errors.push('Invalid or duplicate rule check'); continue; }
    seen.add(item.id);
    const block = lib.solutions.find(block => block.id === item.block_id);
    if (!block) { errors.push(`${item.id}: unknown block`); continue; }
    if (block.checks[String(item.kind)] !== item.id) errors.push(`${item.id}: block check reference differs`);
    const facts: Record<string, RuleFact> = Object.create(null);
    for (const fixture of item.fact_fixture) {
      if (!isRecord(fixture) || typeof fixture.fact_id !== 'string' || !lib.facts.some(fact => fact.id === fixture.fact_id) || Object.hasOwn(facts, fixture.fact_id)) { errors.push(`${item.id}: invalid fact fixture`); continue; }
      const confirmed = ['confirmed', 'corrected'].includes(String(fixture.confirmation)) && fixture.origin === 'visitor' && Array.isArray(fixture.source_turn_ids) && fixture.source_turn_ids.length > 0 && fixture.source_turn_ids.every(id => typeof id === 'string' && id) && typeof fixture.observed_at === 'string' && Number.isFinite(Date.parse(fixture.observed_at));
      facts[fixture.fact_id] = { state: String(fixture.state), value: fixture.value, confirmation: confirmed ? 'explicit' : 'unconfirmed', ...(isRecord(fixture.parameters) ? { parameters: fixture.parameters } : {}) };
    }
    const inclusion = evaluateRule(block.inclusion, facts), exclusion = evaluateRule(block.exclusion, facts);
    const actual = exclusion === true ? 'excluded' : inclusion === true ? 'eligible' : 'needs_info';
    if (!['eligible', 'excluded', 'needs_info'].includes(String(item.expected)) || actual !== item.expected) errors.push(`${item.id}: expected ${String(item.expected)}, got ${actual}`);
  }
  for (const block of lib.solutions) for (const id of Object.values(block.checks)) if (!seen.has(id)) errors.push(`${block.id}: missing check ${id}`);
  return { errors, count: input.items.length };
}
