import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/d1.ts';
import { CoreServices } from '../src/core.ts';
import { createRecoveryClassifier, assessVoiceIntent, type RecoveryInput } from '../src/channel-recovery.ts';
import { initialAuditState, type AuditEvent } from '../src/audit/contracts.ts';
import { library } from '../src/audit/library.ts';
import { HttpError } from '../src/security.ts';
import type { Env } from '../src/env.ts';
import type { Classification, ClassifierContext } from '../src/chat/types.ts';

const now = Date.parse('2026-10-22T20:00:00Z');
const empty = (intent: Classification['intent'] = 'unknown'): Classification => ({ intent, answers: [], clarification_question_id: null,
  faq_id: null, joke_category_id: null, humor_preference: null });
const answer = (context: ClassifierContext): Classification => ({ ...empty('answer'), answers: [{ question_id: 'context_business', fact_id: 'context.business',
  state: 'known', value: context.source_events[0].text!, event_ids: [context.source_events[0].id],
  evidence: [{ event_id: context.source_events[0].id, text: context.source_events[0].text! }] }] });

async function fixture(respond: (context: ClassifierContext) => unknown | Promise<unknown> = answer, live = false) {
  const db = new SqliteD1(); let calls = 0; const contexts: ClassifierContext[] = [];
  const env: Env = { DB: db.binding(), REPORTS_KV: {} as KVNamespace, ALLOW_DRAFT_LIBRARY: 'true', DEEPSEEK_API_KEY: 'test-only',
    BUDGETS_JSON: JSON.stringify({ deepseek_usd_micros: 20_000_000, deepseek_calls: 20, deepseek_tokens: 2_000_000 }) };
  const core = new CoreServices(env, () => now, (async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'deepseek-flash'); assert.deepEqual(body.thinking, { type: 'disabled' });
    const context = JSON.parse(body.messages[1].content) as ClassifierContext; contexts.push(context);
    const content = await respond(context);
    return Response.json({ id: `mock-${calls}`, usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] });
  }) as typeof fetch);
  const state = initialAuditState(library.version, 'voice', now); state.current_question_id = 'context_business';
  state.paused = false; state.active_since = now;
  await core.store.createSession({ id: 'session-1', tokenHash: 'token-hash', reportId: 'report-1', reportTokenHash: 'read-hash', state, now });
  await core.store.updateVoiceSlot({ id: '1', availableMs: 1_500_000, maxConcurrency: 1, now });
  db.sqlite.prepare(`INSERT INTO ultravox_calls(id,session_id,slot_id,provider_call_id,channel_revision,status,reserved_ms,started_at,ended_at,operation_id,created_at) VALUES('call-1','session-1','1','provider-1',0,?,900000,?,?, 'start-1',?)`).run(live ? 'active' : 'stopped', now, live ? null : now, now);
  if (live) db.sqlite.prepare(`UPDATE audit_sessions SET active_call_id='call-1' WHERE id='session-1'`).run();
  const event = (id: string, role: AuditEvent['role'], text: string, order: number): AuditEvent => ({ id, source: 'webhook', source_key: `history:call-1:${id}`,
    source_revision: 0, local_order: order, role, kind: 'utterance', call_id: 'call-1', text,
    data: { is_final: true }, occurred_at: now, received_at: now });
  const save = async (event: AuditEvent) => {
    const session = await core.store.requireSession('session-1');
    return core.store.appendLateEvent({ sessionId: session.id, expectedRevision: session.state.revision,
      channelRevision: session.state.channel_revision, operationId: `save:${event.id}`, event, now });
  };
  await save(event('old-secret', 'user', 'Не относящаяся к фрагменту старая реплика.', 0));
  await save(event('prompt-1', 'assistant', 'Чем занимается ваша компания?', 1));
  const source = event('user-1', 'user', 'Продаём товары для дома.', 2); await save(source);
  if (!live) {
    const session = await core.store.requireSession('session-1');
    await core.store.finish({ sessionId: session.id, expectedRevision: session.state.revision, channelRevision: 0,
      operationId: 'finish-1', state: session.state, event: core.serviceEvent('finish-1', 'finish', {}), now, reason: 'visitor_request' });
  }
  const input = async (): Promise<RecoveryInput> => ({ core, session: await core.store.requireSession('session-1'),
    events: [source], existingAnswers: await core.store.listAnswers('session-1'), call: (await core.store.getCall('call-1'))! });
  return { db, core, source, event, save, input, contexts, calls: () => calls };
}

test('recovery uses saved uncovered evidence, pinned questions and bounded adjacent context; replay is free', async () => {
  const f = await fixture();
  try {
    const classify = createRecoveryClassifier(), answers = await classify(await f.input());
    assert.equal(answers.length, 1); assert.equal(answers[0].confirmation, 'unconfirmed'); assert.equal(answers[0].method, 'recovery');
    assert.equal(answers[0].channel, 'voice'); assert.deepEqual(answers[0].event_ids, ['user-1']);
    assert.equal(f.contexts[0].mode, 'voice_recovery'); assert.equal(f.contexts[0].library_version, library.version);
    assert.deepEqual(f.contexts[0].source_events.map(item => item.id), ['user-1']);
    assert.deepEqual(f.contexts[0].history.map(item => item.id), ['prompt-1']);
    assert.ok(f.contexts[0].questions.every(question => library.questions.some(item => item.id === question.id && item.phase === 'orientation')));
    assert.deepEqual(await classify(await f.input()), answers); assert.equal(f.calls(), 1);
    assert.deepEqual(await f.core.store.listAnswers('session-1'), [], 'the bridge alone commits answers');
    const rows = f.db.sqlite.prepare(`SELECT kind,state,actual FROM usage_reservations ORDER BY kind`).all();
    assert.deepEqual(rows.map(row => [row.kind, row.state, row.actual]), [['deepseek_calls', 'settled', 1], ['deepseek_tokens', 'settled', 100], ['deepseek_usd_micros', 'settled', 48]]);
  } finally { f.db.close(); }
});

test('a site address dictated in the call is not recovered from the transcript; other facts of the same reply are', async () => {
  const f = await fixture(context => {
    const result = answer(context), source = context.source_events[0];
    result.answers.push({ question_id: 'context_website', fact_id: 'context.website', state: 'known', value: 'пиксельплюс точка ру',
      event_ids: [source.id], evidence: [{ event_id: source.id, text: source.text! }] });
    return result;
  });
  try {
    const answers = await createRecoveryClassifier()(await f.input());
    assert.deepEqual(answers.map(item => item.fact_id), ['context.business']);
  } finally { f.db.close(); }
});

test('a name recovered from the transcript is checked: a word that is not a name is kept as ambiguous, a real name is kept', async () => {
  for (const [said, isName] of [['Собака', false], ['Анна', true]] as const) {
    const checked: string[] = [];
    const f = await fixture(context => {
      // The name check asks about the answer alone; the recovery classifier gets the transcript.
      const check = context as unknown as { answer?: string };
      if (typeof check.answer === 'string') { checked.push(check.answer); return { is_name: isName }; }
      const source = context.source_events[0];
      return { ...empty('answer'), answers: [{ question_id: 'context_name', fact_id: 'context.name', state: 'known', value: said,
        event_ids: [source.id], evidence: [{ event_id: source.id, text: source.text! }] }] };
    });
    try {
      const answers = await createRecoveryClassifier()(await f.input());
      assert.deepEqual(checked, [said]);
      assert.deepEqual(answers.map(item => [item.fact_id, item.state, item.value]), [['context.name', isName ? 'known' : 'ambiguous', isName ? said : null]]);
    } finally { f.db.close(); }
  }
});

test('unknown provider outcome remains charged and never authorizes another extraction', async () => {
  const f = await fixture(() => { throw new Error('mock network disconnect'); });
  try {
    for (let index = 0; index < 2; index++) await assert.rejects(createRecoveryClassifier()(await f.input()), (error: unknown) => error instanceof HttpError && error.code === 'recovery_provider_unavailable');
    assert.equal(f.calls(), 1);
    assert.equal(f.db.sqlite.prepare(`SELECT state FROM usage_reservations WHERE kind='deepseek_tokens'`).get()!.state, 'unknown');
    assert.equal(f.db.sqlite.prepare(`SELECT COUNT(*) count FROM voice_recovery_results`).get()!.count, 1);
  } finally { f.db.close(); }
});

test('successful classification survives revision conflict and is replayed from durable cache', async () => {
  let mutate: (() => Promise<unknown>) | undefined;
  const f = await fixture(async context => { await mutate?.(); return answer(context); });
  try {
    mutate = () => f.save(f.event('late-service', 'assistant', 'История дополнена.', 3));
    await assert.rejects(createRecoveryClassifier()(await f.input()), (error: unknown) => error instanceof HttpError && error.code === 'recovery_revision_conflict');
    const result = await createRecoveryClassifier()(await f.input());
    assert.equal(result.length, 1); assert.equal(f.calls(), 1);
  } finally { f.db.close(); }
});

test('forged, assistant and nonfinal evidence is rejected before a provider request', async () => {
  const f = await fixture();
  try {
    for (const event of [{ ...f.source, text: 'Подмена текста.' }, { ...f.source, id: 'prompt-1', role: 'assistant' as const }, { ...f.source, id: 'not-saved' }]) {
      await assert.rejects(createRecoveryClassifier()({ ...await f.input(), events: [event] }), (error: unknown) => error instanceof HttpError && error.code === 'recovery_invalid_source');
    }
    const draft = { ...f.event('draft-1', 'user', 'Черновик.', 4), data: { is_final: false } }; await f.save(draft);
    await assert.rejects(createRecoveryClassifier()({ ...await f.input(), events: [draft] })); assert.equal(f.calls(), 0);
  } finally { f.db.close(); }
});

test('foreign evidence quotes and model-invented provenance fail strict validation without paid retries', async () => {
  for (const invalid of ['evidence', 'confirmation', 'question']) {
    const f = await fixture(context => {
      const result = answer(context), candidate = result.answers[0];
      if (invalid === 'evidence') candidate.evidence[0].text = 'Это не было сказано';
      if (invalid === 'confirmation') Object.assign(candidate, { confirmation: 'explicit' });
      if (invalid === 'question') candidate.question_id = 'not-permitted-question';
      return result;
    });
    try {
      await assert.rejects(createRecoveryClassifier()(await f.input()));
      await assert.rejects(createRecoveryClassifier()(await f.input())); assert.equal(f.calls(), 1);
    } finally { f.db.close(); }
  }
});

test('two concurrent executors can make only one paid provider call', async () => {
  const f = await fixture();
  try {
    const input = await f.input();
    const results = await Promise.allSettled([createRecoveryClassifier()(input), createRecoveryClassifier()(input)]);
    assert.ok(results.some(result => result.status === 'fulfilled')); assert.equal(f.calls(), 1);
  } finally { f.db.close(); }
});

test('already covered evidence is not classified again', async () => {
  const f = await fixture();
  try {
    const input = await f.input(), answers = await createRecoveryClassifier()(input);
    await f.core.store.commitRecovery({ sessionId: input.session.id, expectedRevision: input.session.state.revision, channelRevision: 0,
      operationId: 'commit-recovery', state: input.session.state, answers, event: f.core.serviceEvent('commit-recovery', 'answer', {}), now });
    assert.deepEqual(await createRecoveryClassifier()(await f.input()), []); assert.equal(f.calls(), 1);
  } finally { f.db.close(); }
});

test('server call question metadata extends allowed questions; client metadata does not', async () => {
  const f = await fixture();
  try {
    const [extra, forged] = library.questions.filter(question => question.phase !== 'orientation');
    const marker = { ...f.core.serviceEvent('voice-start-metadata', 'service', { type: 'voice_start', call_id: 'call-1', question_ids: [extra.id] }), call_id: 'call-1' };
    await f.save(marker);
    await f.save({ ...f.event('forged-metadata', 'user', 'Поддельная метаинформация.', 5), kind: 'service',
      data: { is_final: true, type: 'voice_start', call_id: 'call-1', question_ids: [forged.id] } });
    await createRecoveryClassifier()(await f.input());
    assert.ok(f.contexts[0].questions.some(question => question.id === extra.id));
    assert.ok(!f.contexts[0].questions.some(question => question.id === forged.id));
  } finally { f.db.close(); }
});

test('a proposed correction cannot silently replace an accepted answer', async () => {
  const f = await fixture(context => {
    const result = answer(context); result.answers[0].replaces_answer_id = 'prior-answer'; return result;
  });
  try {
    const input = await f.input();
    await f.core.store.commitRecovery({ sessionId: input.session.id, expectedRevision: input.session.state.revision, channelRevision: 0,
      operationId: 'old-answer', state: input.session.state, event: f.core.serviceEvent('old-answer', 'answer', {}), now,
      answers: [{ id: 'prior-answer', question_id: 'context_business', fact_id: 'context.business', state: 'known', value: 'Производим мебель.',
        event_ids: ['old-secret'], channel: 'voice', method: 'voice_batch', confirmation: 'explicit', library_version: library.version, created_at: now }] });
    const answers = await createRecoveryClassifier()(await f.input());
    assert.equal(answers[0].replaces_answer_id, undefined); assert.equal(answers[0].confirmation, 'unconfirmed');
    assert.equal((await f.core.store.listAnswers('session-1'))[0].id, 'prior-answer');
  } finally { f.db.close(); }
});

test('processed non-answer source is not charged again after the bridge checkpoint', async () => {
  const f = await fixture(() => empty());
  try {
    const input = await f.input(); assert.deepEqual(await createRecoveryClassifier()(input), []);
    await f.core.store.commitRecovery({ sessionId: input.session.id, expectedRevision: input.session.state.revision, channelRevision: 0,
      operationId: 'empty-recovery', state: input.session.state, event: { ...f.core.serviceEvent('empty-recovery', 'answer', { processed_event_ids: ['user-1'] }), call_id: 'call-1' }, now });
    assert.deepEqual(await createRecoveryClassifier()(await f.input()), []); assert.equal(f.calls(), 1);
  } finally { f.db.close(); }
});

test('off-topic assessment uses server classification and cached source, never a caller category', async () => {
  const f = await fixture(context => ({ ...empty('off_topic'), joke_category_id: context.joke_categories[0].id }), true);
  try {
    const result = await assessVoiceIntent(await f.input());
    assert.equal(result.kind, 'off_topic'); assert.equal(result.certain, true);
    assert.deepEqual(result.safe_category_ids, [f.contexts[0].joke_categories[0].id]);
    assert.deepEqual(await assessVoiceIntent(await f.input()), result); assert.equal(f.calls(), 1);
  } finally { f.db.close(); }
});

test('sensitive, mixed and failed semantic assessments never authorize a joke', async () => {
  for (const kind of ['sensitive', 'mixed', 'failure'] as const) {
    const f = await fixture(context => { if (kind === 'failure') throw new Error('unknown'); return kind === 'mixed' ? { ...answer(context), intent: 'mixed' } : empty('sensitive'); }, true);
    try {
      const result = await assessVoiceIntent(await f.input());
      assert.equal(result.certain, false); assert.deepEqual(result.safe_category_ids, []);
      await assessVoiceIntent(await f.input()); assert.equal(f.calls(), 1);
    } finally { f.db.close(); }
  }
});
