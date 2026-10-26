import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeVoiceAdapter } from './audit-realtime.js';

const turn = () => new Promise(resolve => setTimeout(resolve, 10));
function fixture(t, overrides = {}) {
  const peers = [], controls = [], captions = [], batches = [], tools = [], errors = [], states = [];
  let stoppedTracks = 0, pausedAudio = 0;
  const adapter = createRealtimeVoiceAdapter({
    peerFactory() {
      const dc = { readyState: 'connecting', sent: [], send(data) { this.sent.push(JSON.parse(data)); }, close() { this.readyState = 'closed'; } };
      const pc = { dc, connectionState: 'new', close() { this.connectionState = 'closed'; }, addTrack() {},
        createDataChannel() { return dc; }, async createOffer() { return { type: 'offer', sdp: 'v=0\r\nm=audio' }; }, async setLocalDescription() {},
        async setRemoteDescription() { dc.readyState = 'open'; dc.onopen(); } };
      peers.push(pc); return pc;
    },
    mediaDevices: { async getUserMedia() { const track = { stop() { stoppedTracks++; } }; return { getAudioTracks: () => [track], getTracks: () => [track] }; } },
    audioFactory: () => ({ pause() { pausedAudio++; }, async play() {} }),
    onControl: async (...args) => controls.push(args), onState: state => states.push(state), onTranscript: event => captions.push(event),
    onEvents: async events => batches.push(events), onError: e => errors.push(e), onTool: async (name, args) => { tools.push({ name, args }); return { accepted: true, realtime_instructions: 'Следующий вопрос' }; }, ...overrides,
  });
  t.after(async () => { await adapter.stop().catch(() => {}); });
  return { adapter, peers, controls, captions, batches, tools, errors, states, get stoppedTracks() { return stoppedTracks; }, get pausedAudio() { return pausedAudio; },
    emit(event) { peers.at(-1).dc.onmessage?.({ data: JSON.stringify(event) }); },
    async start(id = 'call1') { await adapter.prepare(); await adapter.start({ call_id: id, sdp_answer: 'v=0', first_message: 'Как Вас зовут?', session: { remaining_ms: 900000 } }); },
  };
}

test('Realtime streams both captions, keeps ordinal order when ASR is late, deduplicates revisions', async t => {
  const f = fixture(t); await f.start();
  f.emit({ type: 'input_audio_buffer.speech_started', item_id: 'user1' });
  f.emit({ type: 'response.output_audio_transcript.delta', item_id: 'agent1', delta: 'Добрый ' });
  f.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'user1', delta: 'Ол' });
  f.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user1', transcript: 'Олег' });
  f.emit({ type: 'response.output_audio_transcript.done', item_id: 'agent1', transcript: 'Добрый день' });
  f.emit({ type: 'response.output_audio_transcript.done', item_id: 'agent1', transcript: 'Добрый день' });
  assert.equal(f.captions.length, 4);
  await f.adapter.flush();
  const latest = f.batches.flat(); assert.equal(latest.length, 2);
  assert.equal(latest.find(e => e.role === 'user').local_order, 0);
  assert.equal(latest.find(e => e.role === 'assistant').local_order, 1);
  assert(latest.every(e => e.data.is_final)); assert.equal(latest.find(e => e.role === 'user').text, 'Олег');
});

test('First message is conveyed in the model\'s own words, never read as a verbatim script', async t => {
  const f = fixture(t); await f.start();
  const first = f.peers.at(-1).dc.sent.find(e => e.type === 'response.create');
  assert.match(first.response.instructions, /своими словами, дружелюбно и на «Вы», полностью сохранив смысл/);
  assert.match(first.response.instructions, /не зачитывай дословно: "Как Вас зовут\?"/);
  assert.doesNotMatch(first.response.instructions, /Произнеси только этот вопрос/);
});

test('Tool executes only after response completion and durable ASR delivery, exactly once', async t => {
  const order = [];
  const f = fixture(t, { onEvents: async () => { order.push('saved'); }, onTool: async () => { order.push('tool'); return { accepted: true, realtime_instructions: 'Next' }; } });
  await f.start();
  f.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Олег' });
  const tool = { type: 'function_call', name: 'saveAnswers', call_id: 'tool1', arguments: '{"answers":[]}' };
  f.emit({ ...tool, type: 'response.function_call_arguments.done' }); await turn(); assert.deepEqual(order, []);
  f.emit({ type: 'response.done', response: { status: 'completed', output: [tool] } });
  await turn(); assert.deepEqual(order, ['saved', 'tool']);
  f.emit({ type: 'response.done', response: { status: 'completed', output: [tool] } }); await turn(); assert.deepEqual(order, ['saved', 'tool']);
  const sent = f.peers[0].dc.sent;
  assert(sent.some(e => e.type === 'session.update' && e.session.instructions === 'Next'));
  assert(sent.some(e => e.type === 'conversation.item.create' && e.item.type === 'function_call_output'));
});

test('Stop immediately releases audio/microphone even when saving fails, and retries outstanding delivery', async t => {
  let fail = true;
  const f = fixture(t, { onEvents: async () => { if (fail) throw new Error('offline'); } }); await f.start();
  f.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u', transcript: 'Олег' });
  await assert.rejects(f.adapter.stop(), /offline/);
  assert.equal(f.stoppedTracks, 1); assert.equal(f.pausedAudio, 1); assert.equal(f.adapter.active, false);
  assert.deepEqual(f.controls[0], ['stop', 'call1', false]); assert.equal(f.adapter.pendingEvents.length, 1);
  fail = false; await f.adapter.flush(); assert.equal(f.adapter.pendingEvents.length, 0);
});

test('Repeated connect/stop releases every track and ignores late events from old connections', async t => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) {
    await f.start(`call${i}`); const receive = f.peers.at(-1).dc.onmessage;
    await Promise.all([f.adapter.stop(), f.adapter.stop()]);
    receive({ data: JSON.stringify({ type: 'response.output_audio_transcript.delta', item_id: 'stale', delta: 'Устаревший ответ' }) });
  }
  assert.equal(f.controls.length, 4); assert.equal(f.stoppedTracks, 4); assert.equal(f.captions.length, 0); assert.equal(f.errors.length, 0);
});

test('Microphone rejection occurs before an offer or any server call', async t => {
  const f = fixture(t, { mediaDevices: { async getUserMedia() { throw new Error('permission denied'); } } });
  await assert.rejects(f.adapter.prepare(), /permission denied/); assert.equal(f.peers.length, 0); assert.equal(f.controls.length, 0);
});

test('User speech during a tool request cannot create overlapping responses', async t => {
  let resolveTool;
  const f = fixture(t, { onTool: () => new Promise(resolve => { resolveTool = resolve; }) }); await f.start();
  f.emit({ type: 'response.created' });
  const call = { type: 'function_call', call_id: 'slow-tool', name: 'saveAnswers', arguments: '{"answers":[]}' };
  f.emit({ type: 'response.done', response: { status: 'completed', output: [call] } }); await turn();
  f.emit({ type: 'input_audio_buffer.speech_started', item_id: 'u2' });
  resolveTool({ accepted: true }); await turn();
  assert.equal(f.peers[0].dc.sent.filter(e => e.type === 'response.create').length, 1);
  f.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u2', transcript: 'Да' }); await turn();
  assert.equal(f.peers[0].dc.sent.filter(e => e.type === 'response.create').length, 2);
  f.emit({ type: 'response.created' });
  f.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u3', transcript: 'Ещё уточнение' }); await turn();
  assert.equal(f.peers[0].dc.sent.filter(e => e.type === 'response.create').length, 2);
  f.emit({ type: 'response.done', response: { status: 'cancelled', output: [] } }); await turn();
  assert.equal(f.peers[0].dc.sent.filter(e => e.type === 'response.create').length, 3);
});

test('searchKnowledge reads fragments without the save barrier; a failed search tells the model to move on', async t => {
  const calls = [];
  const f = fixture(t, { onTool: async (name, args) => {
    calls.push([name, args]);
    if (args.query === 'сбой') throw new Error('offline');
    return { found: true, fragments: [{ title: 'Битрикс', url: 'https://pixelplus.ru/razrabotka-sajtov/cms/bitrix/', text: 'Создаём сайты на Битрикс.' }] };
  } });
  await f.start();
  const dc = f.peers.at(-1).dc;
  const search = (id, query) => f.emit({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call', call_id: id, name: 'searchKnowledge', arguments: JSON.stringify({ query }) }] } });
  const outputs = () => dc.sent.filter(event => event.type === 'conversation.item.create' && event.item.type === 'function_call_output').map(event => JSON.parse(event.item.output));
  f.emit({ type: 'input_audio_buffer.speech_started', item_id: 'pending-user' });
  search('s1', 'сайты на Битрикс'); await turn(); await turn();
  assert.equal(outputs()[0].found, true, 'an unfinished transcription does not delay a search');
  assert.equal(outputs()[0].fragments[0].url, 'https://pixelplus.ru/razrabotka-sajtov/cms/bitrix/');
  search('s2', 'сбой'); await turn(); await turn();
  assert.equal(outputs()[1].found, false); assert.match(outputs()[1].message, /вернись к вопросу экспресс-диагностики/);
  assert.equal(f.errors.length, 0, 'a failed search is not shown as a save error');
  assert.deepEqual(calls.map(([name, args]) => [name, args.query]), [['searchKnowledge', 'сайты на Битрикс'], ['searchKnowledge', 'сбой']]);
});
