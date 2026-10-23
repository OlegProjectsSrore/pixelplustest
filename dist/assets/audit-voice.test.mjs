import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMicrophone, createVoiceAdapter } from './audit-voice.js';

function deferred() { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture({ onEvents = async () => {}, onTool = async () => ({}), joinFailure = false } = {}) {
  let instance;
  const errors = [];
  class Session extends EventTarget {
    constructor() { super(); instance = this; this.status = 'connecting'; this.transcripts = []; this.tools = new Map(); }
    registerToolImplementation(name, callback) { this.tools.set(name, callback); }
    joinCall() { queueMicrotask(() => this.setStatus(joinFailure ? 'disconnected' : 'listening')); }
    async leaveCall() { if (this.failLeave) throw new Error('leave unknown'); this.setStatus('disconnected'); }
    setStatus(value) { this.status = value; this.dispatchEvent(new Event('status')); }
    transcript(text, isFinal = false) { this.transcripts[0] = { ordinal: 0, speaker: 'user', text, isFinal, medium: 'voice' }; this.dispatchEvent(new Event('transcripts')); }
  }
  const adapter = createVoiceAdapter({ sdk: { UltravoxSession: Session }, onState() {}, onEvents, onTool, onError: error => errors.push(error) });
  return { adapter, get instance() { return instance; }, errors };
}

test('microphone permission denial creates no stream and successful probing releases every track', async () => {
  await assert.rejects(checkMicrophone({ getUserMedia: async () => { const error = new Error('denied'); error.name = 'NotAllowedError'; throw error; } }), /не разрешён/);
  let stopped = 0;
  await checkMicrophone({ getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }, { stop: () => stopped++ }] }) });
  assert.equal(stopped, 2);
});

test('async connection failure cleans local session without pretending the server ended it', async () => {
  const f = fixture({ joinFailure: true });
  await assert.rejects(f.adapter.start({ call_id: 'c1', join_url: 'wss://voice.example' }), /прервалось/);
  assert.equal(f.adapter.active, false);
  assert.equal(f.adapter.callId, 'c1');
});

test('rejected leave retains active instance and forbids a new call', async () => {
  const f = fixture(); await f.adapter.start({ call_id: 'c1', join_url: 'wss://voice.example' });
  f.instance.failLeave = true;
  await assert.rejects(f.adapter.stop(), /unknown/);
  assert.equal(f.adapter.active, true);
  await assert.rejects(f.adapter.start({ call_id: 'c2', join_url: 'wss://voice.example' }), /не завершён/);
  f.instance.failLeave = false; await f.adapter.stop();
});

test('flush delivers a newer transcript revision before a tool can advance the interview', async () => {
  const gate = deferred(); const batches = []; const tools = [];
  const f = fixture({ onEvents: async events => { batches.push(structuredClone(events)); if (batches.length === 1) await gate.promise; }, onTool: async name => { tools.push(name); return { accepted: true }; } });
  await f.adapter.start({ call_id: 'c1', join_url: 'wss://voice.example' });
  f.instance.transcript('Первые');
  const flush = f.adapter.flush(); await Promise.resolve();
  f.instance.transcript('Первые слова целиком', true);
  const tool = f.instance.tools.get('saveAnswers')({ answers: [] });
  assert.deepEqual(tools, []); gate.resolve();
  await flush; await tool;
  assert.equal(batches.length, 2);
  assert.equal(batches[1][0].text, 'Первые слова целиком');
  assert.equal(batches[1][0].source_revision, 1);
  assert.deepEqual(tools, ['saveAnswers']);
  assert.equal(f.adapter.pendingEvents.length, 0);
  await f.adapter.stop();
});

test('failed delivery keeps source attribution and blocks replacing the pending call ID', async () => {
  let fail = true;
  const delivered = [];
  const f = fixture({ onEvents: async (events, callId) => { if (fail) throw new Error('offline'); delivered.push({ events, callId }); } });
  await f.adapter.start({ call_id: 'c1', join_url: 'wss://voice.example' });
  f.instance.transcript('Сохранить этот ответ', true);
  await assert.rejects(f.adapter.stop(), /offline/);
  assert.equal(f.adapter.active, false);
  await assert.rejects(f.adapter.start({ call_id: 'c2', join_url: 'wss://voice.example' }), /доставить/);
  assert.equal(f.adapter.callId, 'c1');
  fail = false; await f.adapter.flush();
  assert.equal(delivered[0].callId, 'c1');
  assert.equal(delivered[0].events[0].call_id, 'c1');
});
