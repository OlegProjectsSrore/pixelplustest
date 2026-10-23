import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLexical } from '../../../knowledge-base/search/search-text.mjs';
import { createKnowledgeSearch } from './knowledge.mjs';

function fixture() {
  const texts = ['# Аналитика\n\nОписание аналитики сайта и её измерений.', '# Аналитика\n\nИндивидуальные рекомендации и тарифы.', '# Поддержка\n\nРаботы по поддержке сайта.'];
  const index = { corpus: 'a'.repeat(64), docs: texts.map((t, i) => [`d${i}`, `kb/${i}.md`, `https://pixelplus.ru/test/${i}/`, `Источник ${i}`, 'service', 'test', t.length]),
    chunks: texts.map((t, i) => [`c${i}`, i, '', '', 0, t.length]), lexical: buildLexical(texts) };
  let reads = [];
  const readDocument = path => { reads.push(path); return texts[Number(path.match(/\d+/)[0])]; };
  return { index, texts, readDocument, reads, approval: { corpus: index.corpus, chunk_ids: ['c0'] } };
}
test('existing BM25 returns only core-approved chunks and full text with citations', async () => {
  const f = fixture(), search = createKnowledgeSearch(f);
  const result = await search('аналитика', f.approval);
  assert.deepEqual(result.map(x => x.id), ['c0']);
  assert.equal(result[0].text, f.texts[0]);
  assert.equal(result[0].url, 'https://pixelplus.ru/test/0/');
  assert.deepEqual(f.reads, ['kb/0.md']);
});
test('a stale corpus, missing approval and invalid query never load source documents', async () => {
  const f = fixture(), search = createKnowledgeSearch(f);
  await assert.rejects(search('аналитика', { ...f.approval, corpus: 'b'.repeat(64) }));
  await assert.rejects(search('аналитика', null));
  await assert.rejects(search('x'.repeat(501), f.approval));
  assert.deepEqual(await search('аналитика', { ...f.approval, chunk_ids: [] }), []);
  assert.deepEqual(f.reads, []);
});
test('foreign, insecure and credential-bearing source URLs are excluded before reading', async () => {
  for (const url of ['https://example.org/a', 'http://pixelplus.ru/a', 'https://token@pixelplus.ru/a', 'https://pixelplus.ru:8080/a']) {
    const f = fixture(); f.index.docs[0][2] = url;
    assert.deepEqual(await createKnowledgeSearch(f)('аналитика', f.approval), []);
    assert.deepEqual(f.reads, []);
  }
});
test('mismatched documents fail instead of presenting a stale excerpt', async () => {
  const f = fixture(); f.texts[0] += ' Изменённый текст.';
  await assert.rejects(createKnowledgeSearch(f)('аналитика', f.approval), /mismatch/);
});
