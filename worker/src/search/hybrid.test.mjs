import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLexical } from '../../../knowledge-base/search/search-text.mjs';
import { createHybridSearch, excerpt } from './hybrid.mjs';
import { SqliteD1 } from '../../test/helpers/d1.ts';

const corpus = 'c'.repeat(64);
const docs = [['d1', 'kb/a.md', 'https://pixelplus.ru/razrabotka/', 'Разработка сайтов', 'service', 'dev', 100],
  ['d2', 'kb/b.md', 'https://pixelplus.ru/tarify/seo/', 'Цены на SEO', 'service', 'seo', 100],
  ['d3', 'kb/c.md', 'http://evil.example/x', 'Чужая страница', 'service', 'seo', 100]];
const texts = ['Создаём сайты на Битрикс и Laravel', 'Продвижение сайта от 79 500 руб. в месяц', 'Продвижение сайта бесплатно'];
const index = { corpus, docs, chunks: texts.map((_, i) => [`d${i + 1}#0`, i, docs[i][3], '', 0, 10]), lexical: buildLexical(texts) };

function setup({ ai, vectorize, loaded = corpus } = {}) {
  const db = new SqliteD1();
  texts.forEach((text, i) => db.sqlite.prepare('INSERT INTO kb_chunks VALUES (?,?,?,?,?,?)').run(`d${i + 1}#0`, docs[i][2], docs[i][3], docs[i][3], 'service', text));
  db.sqlite.prepare(`INSERT INTO kb_meta VALUES ('corpus', ?)`).run(loaded);
  return { db, search: createHybridSearch({ index, ai, vectorize, db: db.binding() }) };
}

test('BM25 and Vectorize lists are fused; texts come from D1 and only pixelplus.ru pages are returned', async t => {
  const queries = [];
  const ai = { async run(model, input) { queries.push([model, input.text]); return { data: [[0.1, 0.2]] }; } };
  const vectorize = { async query() { return { matches: [{ id: 'd1#0' }, { id: 'd3#0' }, { id: 'unknown#9' }] }; } };
  const { db, search } = setup({ ai, vectorize }); t.after(() => db.close());
  const result = await search('сколько стоит продвижение сайта', { limit: 5 });
  assert.equal(result.vectors, 'ok'); assert.equal(result.ready, true);
  assert.deepEqual(queries, [['@cf/baai/bge-m3', ['сколько стоит продвижение сайта']]]);
  assert.deepEqual(result.fragments.map(fragment => fragment.id).sort(), ['d1#0', 'd2#0'], 'the non-HTTPS foreign page is dropped');
  assert.equal(result.fragments.find(fragment => fragment.id === 'd2#0').text, texts[1]);
});

test('a failed embedding keeps lexical results; a corpus mismatch disables search', async t => {
  const broken = setup({ ai: { async run() { throw new Error('quota'); } }, vectorize: { async query() { return { matches: [] }; } } });
  t.after(() => broken.db.close());
  const lexical = await broken.search('Битрикс');
  assert.equal(lexical.vectors, 'failed'); assert.deepEqual(lexical.fragments.map(fragment => fragment.id), ['d1#0']);
  const stale = setup({ loaded: 'd'.repeat(64) }); t.after(() => stale.db.close());
  assert.deepEqual(await stale.search('Битрикс'), { fragments: [], vectors: 'off', ready: false });
  await assert.rejects(stale.search(''), /Invalid knowledge query/);
});

test('long excerpts are cut at a line end, never mid-word', () => {
  assert.equal(excerpt('короткий текст', 100), 'короткий текст');
  assert.equal(excerpt(`${'первая строка '.repeat(5)}\nвторая строка с ценой`, 80), `${'первая строка '.repeat(5).trimEnd()} …`);
});
