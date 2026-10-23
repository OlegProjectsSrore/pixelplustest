import type { AuditEvent } from '../audit/contracts.ts';
import type { VoiceCall } from '../storage/types.ts';
import { record } from './validation.ts';

/** Browser IDs, source, kind, call ID, timestamps, and confirmation flags cannot assign server metadata. */
export function normalizeTranscriptBatch(value: unknown, call: VoiceCall, now: number): AuditEvent[] {
  if (!Array.isArray(value) || !value.length || value.length > 200) throw new Error('Invalid transcript batch size');
  const unique = new Set<string>();
  return value.map(raw => {
    if (!record(raw) || !Number.isSafeInteger(raw.local_order) || (raw.local_order as number) < 0 || !Number.isSafeInteger(raw.source_revision) || (raw.source_revision as number) < 0 || (raw.source_revision as number) > 1_000_000) throw new Error('Invalid transcript position');
    if (!['user', 'assistant'].includes(String(raw.role)) || typeof raw.text !== 'string' || raw.text.length > 8000 || !record(raw.data) || typeof raw.data.is_final !== 'boolean' || !['voice', 'text'].includes(String(raw.data.medium))) throw new Error('Invalid transcript content');
    if (raw.call_id !== undefined && raw.call_id !== call.id) throw new Error('Transcript belongs to another call');
    if (raw.source !== undefined && raw.source !== 'voice') throw new Error('Invalid transcript source');
    if (raw.kind !== undefined && raw.kind !== 'utterance') throw new Error('Browser cannot assign evidence kind');
    const key = `${call.id}:${raw.local_order}`, id = `voice:${key}:${raw.source_revision}`;
    if (raw.source_key !== undefined && raw.source_key !== key) throw new Error('Invalid transcript key');
    if (unique.has(id) || id.length > 128) throw new Error('Repeated or oversized transcript identity');
    unique.add(id);
    const clientTimestamp = Number.isSafeInteger(raw.occurred_at) && (raw.occurred_at as number) >= 0 ? raw.occurred_at as number : null;
    return {
      id, source: 'voice' as const, source_key: key, source_revision: raw.source_revision as number,
      local_order: raw.local_order as number, role: raw.role as 'user' | 'assistant', kind: 'utterance' as const,
      text: raw.text, call_id: call.id, occurred_at: now, received_at: now,
      data: { is_final: raw.data.is_final, medium: raw.data.medium as string, client_occurred_at: clientTimestamp },
    };
  }).sort((a, b) => a.local_order - b.local_order || a.source_revision - b.source_revision);
}
