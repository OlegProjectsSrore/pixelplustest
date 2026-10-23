import type { ProviderMessage } from './types.ts';
import { callId, nullableString, record, ULTRAVOX_API_ORIGIN } from './validation.ts';

export interface HistoryOptions { max_pages?: number; max_messages?: number; page_size?: number }
const roles: Record<string, ProviderMessage['role']> = { MESSAGE_ROLE_USER: 'user', MESSAGE_ROLE_AGENT: 'assistant', MESSAGE_ROLE_TOOL_CALL: 'tool_call', MESSAGE_ROLE_TOOL_RESULT: 'tool_result', MESSAGE_ROLE_UNSPECIFIED: 'unknown' };
function timespan(value: unknown): ProviderMessage['timespan'] {
  if (value == null) return null;
  if (!record(value)) throw new Error('Invalid provider timespan');
  const duration = (item: unknown) => {
    if (item == null) return null;
    if (typeof item !== 'string' || !/^-?(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,9})?s$/.test(item)) throw new Error('Invalid provider duration');
    return item;
  };
  return { start: duration(value.start), end: duration(value.end) };
}
export function normalizeProviderMessage(raw: unknown, id: string, order: number): ProviderMessage {
  if (!record(raw) || (raw.text !== undefined && typeof raw.text !== 'string')) throw new Error('Invalid provider message');
  const stageIndex = raw.callStageMessageIndex;
  if (stageIndex != null && (!Number.isSafeInteger(stageIndex) || (stageIndex as number) < 0)) throw new Error('Invalid provider message index');
  if (raw.role !== undefined && (typeof raw.role !== 'string' || !Object.hasOwn(roles, raw.role))) throw new Error('Unknown provider role');
  if (raw.medium !== undefined && !['MESSAGE_MEDIUM_UNSPECIFIED', 'MESSAGE_MEDIUM_VOICE', 'MESSAGE_MEDIUM_TEXT'].includes(String(raw.medium))) throw new Error('Unknown provider medium');
  return {
    source: 'provider', call_id: callId(id), call_stage_id: nullableString(raw.callStageId, 'call stage ID'),
    call_stage_message_index: stageIndex == null ? null : stageIndex as number, provider_order: order,
    role: typeof raw.role === 'string' ? roles[raw.role] : 'unknown', text: (raw.text as string | undefined) ?? '',
    medium: raw.medium === 'MESSAGE_MEDIUM_VOICE' ? 'voice' : raw.medium === 'MESSAGE_MEDIUM_TEXT' ? 'text' : 'unknown',
    invocation_id: nullableString(raw.invocationId, 'invocation ID'), tool_name: nullableString(raw.toolName, 'tool name'),
    timespan: timespan(raw.timespan), wall_clock_timespan: timespan(raw.wallClockTimespan),
  };
}
/** read_page must be the authorized provider transport; no session/evidence decisions happen here. */
export async function fetchCallHistory(id: string, read_page: (url: URL) => Promise<unknown>, options: HistoryOptions = {}): Promise<ProviderMessage[]> {
  const path = `/api/calls/${callId(id)}/messages`;
  const maxPages = options.max_pages ?? 100, maxMessages = options.max_messages ?? 10_000, pageSize = options.page_size ?? 100;
  for (const value of [maxPages, maxMessages, pageSize]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid pagination limit');
  let url = new URL(path, ULTRAVOX_API_ORIGIN);
  url.searchParams.set('mode', 'in_call'); url.searchParams.set('pageSize', String(pageSize));
  const seenPages = new Set<string>(), seenMessages = new Map<string, string>(), messages: ProviderMessage[] = [];
  for (let page = 0; page < maxPages; page++) {
    if (seenPages.has(url.href)) throw new Error('Provider pagination loop');
    seenPages.add(url.href);
    const raw = await read_page(url);
    if (!record(raw) || !Array.isArray(raw.results) || (raw.next !== null && raw.next !== undefined && typeof raw.next !== 'string')) throw new Error('Invalid provider history page');
    for (const item of raw.results) {
      const message = normalizeProviderMessage(item, id, messages.length);
      if (message.call_stage_id !== null && message.call_stage_message_index !== null) {
        const key = JSON.stringify([message.call_stage_id, message.call_stage_message_index]);
        const content = JSON.stringify({ ...message, provider_order: 0 });
        const previous = seenMessages.get(key);
        if (previous !== undefined) {
          if (previous !== content) throw new Error('Conflicting provider history pages');
          continue;
        }
        seenMessages.set(key, content);
      }
      messages.push(message);
      if (messages.length > maxMessages) throw new Error('Provider history exceeds message limit');
    }
    if (raw.next == null) return messages;
    const next = new URL(raw.next as string, url);
    if (next.origin !== ULTRAVOX_API_ORIGIN || ![path, `${path}/`].includes(next.pathname) || next.username || next.password || next.hash) throw new Error('Unsafe provider pagination URL');
    if (next.searchParams.has('mode') && next.searchParams.get('mode') !== 'in_call') throw new Error('Provider pagination changed history mode');
    next.searchParams.set('mode', 'in_call');
    url = next;
  }
  throw new Error('Provider history exceeds page limit');
}
