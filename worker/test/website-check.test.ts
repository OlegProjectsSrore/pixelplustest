import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuditAnswer } from '../src/audit/contracts.ts';
import { screenWebsiteAnswers, websiteExists, websiteHost } from '../src/chat/website-check.ts';

test('a typed site address becomes its host; words that are not an address do not', () => {
  assert.equal(websiteHost('pixelplus.ru'), 'pixelplus.ru');
  assert.equal(websiteHost('https://www.Pixelplus.ru/uslugi/?a=1'), 'www.pixelplus.ru');
  assert.equal(websiteHost('http://example.com:8080/x'), 'example.com');
  assert.equal(websiteHost('PixelPlus.RU.'), 'pixelplus.ru');
  assert.equal(websiteHost('сайт.рф'), 'xn--80aswg.xn--p1ai');
  for (const text of ['есть сайт', 'kuhni-dub', 'хи-хи-ху-ху-ху и ха-ха цирк', 'a..ru', '-bad-.ru', 'site.1']) assert.equal(websiteHost(text), null, text);
});

test('the site exists when Cloudflare DNS has an address for it; a missing domain or no address is not a site; a resolver fault is unknown', async () => {
  const resolver = (replies: Record<string, unknown>) => (async (url: string) => {
    const type = new URL(url).searchParams.get('type')!;
    const reply = replies[type];
    if (reply instanceof Error) throw reply;
    return Response.json(reply);
  }) as unknown as typeof fetch;
  assert.equal(await websiteExists('pixelplus.ru', resolver({ A: { Status: 0, Answer: [{ type: 1 }] } })), true);
  assert.equal(await websiteExists('www.example.ru', resolver({ A: { Status: 0, Answer: [{ type: 5 }, { type: 1 }] } })), true, 'a CNAME that ends in an address');
  assert.equal(await websiteExists('v6.example.ru', resolver({ A: { Status: 0 }, AAAA: { Status: 0, Answer: [{ type: 28 }] } })), true);
  assert.equal(await websiteExists('nosuch.ru', resolver({ A: { Status: 3 } })), false);
  assert.equal(await websiteExists('parked.ru', resolver({ A: { Status: 0 }, AAAA: { Status: 0 } })), false, 'a registered domain without a site');
  assert.equal(await websiteExists('pixelplus.ru', resolver({ A: new Error('offline') })), null);
  assert.equal(await websiteExists('pixelplus.ru', resolver({ A: { Status: 2 } })), null, 'a resolver failure is not «no site»');
});

test('a site answer without a site behind it is kept as ambiguous; other answers and an unknown check pass', async () => {
  const answer = (fact: string, value: AuditAnswer['value'], state: AuditAnswer['state'] = 'known'): AuditAnswer => ({ id: `${fact}-${String(value)}`, question_id: 'q', answer_id: 'x', fact_id: fact, state, value,
    event_ids: ['e'], channel: 'chat', method: 'classification', confirmation: 'explicit', library_version: '0.2.0', created_at: 0 });
  const checked: string[] = [];
  const exists = async (host: string) => { checked.push(host); return host === 'pixelplus.ru' ? true : host === 'offline.ru' ? null : false; };
  const screened = await screenWebsiteAnswers([answer('context.website', 'https://pixelplus.ru/'), answer('context.website', 'nosuch.ru'), answer('context.website', 'есть сайт'),
    answer('context.website', 'offline.ru'), answer('context.website', null, 'not_applicable'), answer('context.name', 'nosuch.ru')], exists);
  assert.deepEqual(screened.map(item => [item.state, item.value, item.answer_id]), [['known', 'https://pixelplus.ru/', 'x'], ['ambiguous', null, undefined], ['ambiguous', null, undefined],
    ['known', 'offline.ru', 'x'], ['not_applicable', null, 'x'], ['known', 'nosuch.ru', 'x']]);
  assert.deepEqual(checked, ['pixelplus.ru', 'nosuch.ru', 'offline.ru'], 'only well-formed site addresses are looked up');
});
