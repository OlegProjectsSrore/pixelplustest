import type { AuditAnswer } from '../audit/contracts.ts';

export const WEBSITE_FACT = 'context.website';
const DNS_URL = 'https://cloudflare-dns.com/dns-query';

/** The site's host from what the visitor typed («https://www.Example.ru/page» → «www.example.ru», «сайт.рф» → punycode); null when it is not an address. */
export function websiteHost(text: string): string | null {
  const candidate = text.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#\s]/)[0]!.replace(/:\d+$/, '').replace(/\.$/, '');
  if (!candidate.includes('.') || candidate.length > 253) return null;
  let host: string;
  try { host = new URL(`http://${candidate}`).hostname; } catch { return null; }
  const labels = host.split('.');
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels.at(-1)!)) return null;
  return host;
}

/** Whether the site answers in DNS (an A or AAAA record) through Cloudflare's public resolver; null when the resolver is unavailable. */
export async function websiteExists(host: string, fetcher: typeof fetch = fetch, timeoutMs = 4000): Promise<boolean | null> {
  for (const type of ['A', 'AAAA']) {
    try {
      const response = await fetcher(`${DNS_URL}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return null;
      const body = await response.json() as { Status?: unknown; Answer?: { type?: unknown }[] };
      if (body.Status === 3) return false;
      if (body.Status !== 0) return null;
      // A CNAME chain counts once it ends in an address of the asked type.
      if ((body.Answer ?? []).some(record => record.type === (type === 'A' ? 1 : 28))) return true;
    } catch { return null; }
  }
  return false;
}

/** The site address is typed in the chat, never taken from speech: a voice answer that the company has a site is not saved.
 * «No site» (not_applicable) is saved as usual. */
export const spokenWebsite = (answer: Pick<AuditAnswer, 'fact_id' | 'state'>): boolean => answer.fact_id === WEBSITE_FACT && ['known', 'other'].includes(answer.state);

const text = (value: AuditAnswer['value']): string => typeof value === 'string' ? value
  : value && typeof value === 'object' && !Array.isArray(value) && typeof value.value === 'string' ? value.value : '';

/** A typed site address that is not an address or has no site behind it is kept as ambiguous, so the key question is asked again
 * with its own reason. exists is called only for a well-formed address; null from it accepts the address as typed. */
export async function screenWebsiteAnswers(answers: AuditAnswer[], exists: (host: string) => Promise<boolean | null>): Promise<AuditAnswer[]> {
  const screened: AuditAnswer[] = [];
  for (const answer of answers) {
    if (answer.fact_id !== WEBSITE_FACT || answer.state !== 'known') { screened.push(answer); continue; }
    const host = websiteHost(text(answer.value));
    if (host && await exists(host) !== false) { screened.push(answer); continue; }
    const { answer_id: _choice, ...rest } = answer;
    screened.push({ ...rest, state: 'ambiguous', value: null });
  }
  return screened;
}
