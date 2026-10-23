import type { AuditAnswer, AuditEvent, Json } from '../audit/contracts.ts';
import type { CoreServices } from '../core.ts';
import type { StoredSession, VoiceCall } from '../storage/types.ts';
import type { ProviderMessage, ProviderWebhook } from './types.ts';
import type { createVoiceProvider } from './provider.ts';

export interface VoiceReconcileResult { complete: boolean; limitations: string[] }
export interface VoiceReconcileHooks {
  providerForCall?: (core: CoreServices, call: VoiceCall) => Promise<ReturnType<typeof createVoiceProvider>>;
  applyProviderEvent?: (core: CoreServices, event: ProviderWebhook, source: 'webhook' | 'lookup') => Promise<Json>;
  /** Reconcile source identity, durably save missing provider events, and return their actual stored IDs. */
  ingestProviderHistory?: (core: CoreServices, session: StoredSession, call: VoiceCall, messages: ProviderMessage[]) => Promise<VoiceReconcileResult & { events: AuditEvent[] }>;
  /** Classify only uncovered events, validate, and durably accept recovery answers under the pinned version. */
  recoverAnswers?: (core: CoreServices, session: StoredSession, call: VoiceCall, events: AuditEvent[], existing: AuditAnswer[]) => Promise<VoiceReconcileResult>;
}
/** Bound to the core/store of the active worker invocation, not a process-global mutable instance. */
export function createVoiceReconciler(core: CoreServices, hooks: VoiceReconcileHooks) {
  return async (session: StoredSession, _now: number): Promise<VoiceReconcileResult> => {
    const calls = await core.store.listCalls(session.id), limitations: string[] = [];
    if (!calls.length) return { complete: true, limitations };
    if (!hooks.providerForCall || !hooks.applyProviderEvent || !hooks.ingestProviderHistory) return { complete: false, limitations: ['Не подключено восстановление голосовой истории.'] };
    let complete = true;
    for (const call of calls) {
      if (call.sessionId !== session.id) throw new Error('Stored call ownership mismatch');
      if (!call.providerCallId) {
        if (call.status !== 'failed') { complete = false; limitations.push('Результат создания голосового звонка ещё не подтверждён.'); }
        continue;
      }
      try {
        const provider = await hooks.providerForCall(core, call), providerCall = await provider.getCall(call.providerCallId);
        if (providerCall.ended_at === null) { complete = false; limitations.push('Остановка голосового звонка ещё не подтверждена провайдером.'); continue; }
        await hooks.applyProviderEvent(core, { event: 'call.ended', call: providerCall }, 'lookup');
        const history = await provider.getCallHistory(call.providerCallId);
        const currentSession = await core.store.getSession(session.id);
        if (!currentSession) throw new Error('Session disappeared during voice reconciliation');
        const ingested = await hooks.ingestProviderHistory(core, currentSession, call, history);
        limitations.push(...ingested.limitations);
        if (!ingested.complete) { complete = false; continue; }
        const existing = await core.store.listAnswers(session.id);
        const superseded = new Set(existing.flatMap(answer => answer.replaces_answer_id ? [answer.replaces_answer_id] : []));
        const covered = new Set(existing.filter(answer => answer.confirmation === 'explicit' && !superseded.has(answer.id)).flatMap(answer => answer.event_ids));
        const uncovered = ingested.events.filter(event => event.call_id === call.id && event.role === 'user' && !covered.has(event.id));
        if (!uncovered.length) continue;
        if (!hooks.recoverAnswers) { complete = false; limitations.push('Не подключено извлечение недостающих ответов из голосовой истории.'); continue; }
        const recovered = await hooks.recoverAnswers(core, currentSession, call, uncovered, existing);
        if (!recovered.complete) complete = false;
        limitations.push(...recovered.limitations);
      } catch {
        // No request bodies, transcript text, provider credentials, or private URL reach logging/limitations.
        complete = false; limitations.push('Не удалось полностью восстановить голосовую историю.');
      }
    }
    return { complete, limitations: [...new Set(limitations)] };
  };
}

/** Matches ChannelAdapters.reconcile(session, now, core); no stale global core closure is retained. */
export function createVoiceReconcileHandler(hooks: VoiceReconcileHooks) {
  return (session: StoredSession, now: number, core: CoreServices) => createVoiceReconciler(core, hooks)(session, now);
}
