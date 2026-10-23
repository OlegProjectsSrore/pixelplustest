/** Ultravox browser boundary. Session ownership and persistence stay on the server. */
export async function checkMicrophone(mediaDevices = navigator.mediaDevices) {
  if (!mediaDevices?.getUserMedia) throw new Error('Микрофон недоступен в этом браузере. Продолжите опрос в чате.');
  let stream;
  try { stream = await mediaDevices.getUserMedia({ audio: true }); }
  catch (error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
      throw new Error('Доступ к микрофону не разрешён. Разрешите его в браузере или продолжите в чате.');
    }
    if (error?.name === 'NotFoundError') throw new Error('Микрофон не найден. Продолжите опрос в чате.');
    throw new Error('Не удалось включить микрофон. Проверьте устройство или продолжите в чате.');
  } finally { stream?.getTracks().forEach(track => track.stop()); }
}

export async function loadVoiceSdk(url) {
  if (!url) throw new Error('Голосовой опрос пока недоступен. Можно использовать чат.');
  const target = new URL(url, location.href);
  if (target.origin !== location.origin || !['http:', 'https:'].includes(target.protocol)) {
    throw new Error('Не настроен голосовой опрос. Можно использовать чат.');
  }
  const module = await import(target.href);
  if (typeof module.UltravoxSession !== 'function') throw new Error('Не удалось загрузить голосовой опрос.');
  return module;
}

export function createVoiceAdapter({ sdk, onState, onEvents, onTool, onError, now = Date.now }) {
  let session = null;
  let callId = null;
  let snapshots = new Map();
  let pending = new Map();
  let flushTimer;
  let flushing = null;
  let joining = false;
  let closing = false;
  let stopping = null;
  let generation = 0;
  const listeners = [];

  function capture() {
    if (!session || !callId) return;
    for (const transcript of session.transcripts || []) {
      if (!transcript || !Number.isSafeInteger(transcript.ordinal) || transcript.ordinal < 0 ||
          !['user', 'agent'].includes(transcript.speaker) || typeof transcript.text !== 'string' || !transcript.text.trim()) continue;
      const key = `${callId}:${transcript.ordinal}`;
      const content = JSON.stringify([transcript.text, transcript.isFinal, transcript.speaker, transcript.medium]);
      const previous = snapshots.get(key);
      if (previous?.content === content) continue;
      const revision = previous ? previous.revision + 1 : 0;
      const occurredAt = previous?.occurredAt ?? now();
      snapshots.set(key, { content, revision, occurredAt });
      pending.set(key, {
        id: `voice:${key}`, source: 'voice', source_key: key, source_revision: revision,
        local_order: transcript.ordinal, role: transcript.speaker === 'user' ? 'user' : 'assistant',
        kind: 'utterance', text: transcript.text, call_id: callId, occurred_at: occurredAt,
        data: { is_final: transcript.isFinal === true, medium: transcript.medium || 'voice' },
      });
    }
  }

  async function flush() {
    clearTimeout(flushTimer);
    capture();
    if (flushing) { await flushing; if (pending.size) return flush(); return; }
    if (!pending.size) return;
    const batch = Array.from(pending.values());
    // Keep the batch until the caller confirms durable delivery. An error is not an acknowledgement.
    flushing = Promise.resolve().then(() => onEvents(batch, callId)).then(() => {
      for (const event of batch) {
        if (pending.get(event.source_key)?.source_revision === event.source_revision) pending.delete(event.source_key);
      }
    });
    try { await flushing; } finally { flushing = null; }
    // A newer transcript may have arrived while the previous revision was in flight.
    if (pending.size) return flush();
  }

  function scheduleFlush() {
    capture();
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { void flush().catch(error => onError(error)); }, 350);
  }

  async function start({ call_id, join_url }) {
    if (joining || session) throw new Error('Предыдущий голосовой разговор ещё не завершён.');
    if (typeof call_id !== 'string' || !call_id || typeof join_url !== 'string' || !join_url.startsWith('wss://')) {
      throw new Error('Сервис не вернул параметры голосового разговора.');
    }
    if (pending.size) throw new Error('Сначала необходимо доставить предыдущие реплики.');
    joining = true;
    closing = false;
    const current = ++generation;
    callId = call_id;
    snapshots = new Map();
    try { session = new sdk.UltravoxSession(); }
    catch (error) { joining = false; throw error; }
    const instance = session;
    for (const name of ['saveAnswers', 'finishAudit', 'offTopicReply']) {
      instance.registerToolImplementation(name, async args => {
        try {
          if (current !== generation || closing) return JSON.stringify({ accepted: false, error: 'channel_closed' });
          await flush();
          const result = await onTool(name, args, callId);
          // finishAudit must allow the spoken closing message; the agent then calls strict hangUp.
          return { result: JSON.stringify(result), responseType: 'tool-response', agentReaction: 'speaks' };
        } catch {
          onError(new Error('Не удалось сохранить сведения. Проверьте соединение.'));
          return JSON.stringify({ accepted: false, error: 'delivery_pending', message: 'Сведения ещё не сохранены. Не переходите к новому вопросу.' });
        }
      });
    }
    const transcripts = () => { if (current === generation) scheduleFlush(); };
    const status = () => {
      if (current !== generation) return;
      onState(instance.status, callId);
      if (instance.status === 'disconnected') {
        closing = true;
        void flush().catch(error => onError(error)).finally(() => release(instance));
      }
    };
    instance.addEventListener('transcripts', transcripts);
    instance.addEventListener('status', status);
    listeners.push(() => instance.removeEventListener('transcripts', transcripts), () => instance.removeEventListener('status', status));
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => finish(new Error('Не удалось установить голосовое соединение.')), 20000);
        function finish(error) {
          if (settled) return;
          settled = true; clearTimeout(timer); instance.removeEventListener('status', connected);
          error ? reject(error) : resolve();
        }
        function connected() {
          if (['idle', 'listening', 'thinking', 'speaking'].includes(instance.status)) finish();
          else if (instance.status === 'disconnected') finish(new Error('Голосовое соединение прервалось.'));
        }
        instance.addEventListener('status', connected);
        try {
          const joiningCall = instance.joinCall(join_url);
          // The documented SDK returns void; tolerate an async wrapper without an unhandled rejection.
          Promise.resolve(joiningCall).catch(() => finish(new Error('Не удалось начать голосовой разговор.')));
          connected();
        } catch { finish(new Error('Не удалось начать голосовой разговор.')); }
      });
    } catch (error) {
      await stop().catch(() => {});
      throw error;
    } finally { joining = false; }
  }

  function release(instance) {
    if (session !== instance) return;
    capture();
    for (const remove of listeners.splice(0)) remove();
    clearTimeout(flushTimer);
    session = null; joining = false;
    generation += 1;
  }

  async function stopOnce() {
    if (!session) { if (pending.size) await flush(); return; }
    closing = true;
    const instance = session;
    let deliveryError;
    try { await flush(); } catch (error) { deliveryError = error; }
    // A rejected leaveCall is an unknown outcome, not proof of disconnection.
    // Keep the instance so a new call cannot start over it.
    let leaveError;
    try { await instance.leaveCall(); release(instance); }
    catch (error) { leaveError = error; capture(); }
    try { await flush(); } catch (error) { deliveryError = error; }
    if (leaveError) throw leaveError;
    if (deliveryError) throw deliveryError;
  }

  function stop() {
    if (!stopping) stopping = stopOnce().finally(() => { stopping = null; });
    return stopping;
  }

  return { start, stop, flush, get callId() { return callId; }, get active() { return !!session; },
    get pendingEvents() { return Array.from(pending.values()); } };
}
