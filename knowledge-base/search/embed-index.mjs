// Загружает векторы кусков (Workers AI bge-m3) в индекс Vectorize pixelplus-services.
// Запуск: node knowledge-base/search/embed-index.mjs [--create] [--from N]
//   --create  сначала создаёт индекс и индексы метаданных kind и section (до первой загрузки).
//   --from N  продолжить с куска N после сбоя.
// Перед загрузкой проверяет, что все индексы аккаунта вместе уложатся в бесплатные 5 млн хранимых измерений.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkText, stripFrontMatter } from './search-text.mjs';
import { api, embed, INDEX, DIMENSIONS } from './cloudflare.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FREE_STORED_DIMENSIONS = 5_000_000;
const BATCH = 20;

const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'search-index.json'), 'utf8'));
const texts = index.docs.map(doc => stripFrontMatter(fs.readFileSync(path.join(ROOT, doc[1]), 'utf8')));
const from = Number(process.argv[process.argv.indexOf('--from') + 1]) || 0;

if (process.argv.includes('--create')) {
  await api('vectorize/v2/indexes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: INDEX, config: { dimensions: DIMENSIONS, metric: 'cosine' } }) });
  for (const propertyName of ['kind', 'section']) {
    await api(`vectorize/v2/indexes/${INDEX}/metadata_index/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ propertyName, indexType: 'string' }) });
  }
  console.log(`Создан индекс ${INDEX} с индексами метаданных kind и section.`);
}

let stored = 0;
for (const { name, config } of await api('vectorize/v2/indexes')) {
  if (name === INDEX) continue;
  stored += (await api(`vectorize/v2/indexes/${name}/info`)).vectorCount * config.dimensions;
}
const total = stored + index.chunks.length * DIMENSIONS;
console.log(`Хранимых измерений после загрузки: ${total.toLocaleString('ru')} из ${FREE_STORED_DIMENSIONS.toLocaleString('ru')} бесплатных.`);
if (total > FREE_STORED_DIMENSIONS && !process.argv.includes('--force')) {
  console.error('Превышен бесплатный объём Vectorize. Загрузка остановлена (--force, чтобы загрузить всё равно).');
  process.exit(1);
}

let uploaded = 0;
for (let i = from; i < index.chunks.length; i += BATCH) {
  const batch = index.chunks.slice(i, i + BATCH);
  const input = batch.map(([, d, chunkPath, , start, end]) => `${index.docs[d][3]}\n${chunkPath}\n${chunkText(texts[d], { start, end })}`);
  const vectors = await embed(input);
  const ndjson = batch.map(([id, d], j) => JSON.stringify({
    id, values: vectors[j], metadata: { kind: index.docs[d][4], section: index.docs[d][5], corpus: index.corpus.slice(0, 12) },
  })).join('\n');
  await api(`vectorize/v2/indexes/${INDEX}/upsert`, { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body: ndjson });
  uploaded += batch.length;
  process.stdout.write(`\r${i + batch.length}/${index.chunks.length}`);
}
console.log(`\nЗагружено ${uploaded} векторов для corpus ${index.corpus.slice(0, 12)}.`);

// Векторы кусков, которых больше нет в индексе (страница удалена или нарезана иначе), удаляются из Vectorize.
const current = new Set(index.chunks.map(c => c[0]));
const stale = [];
for (let cursor; ;) {
  const page = await api(`vectorize/v2/indexes/${INDEX}/list?count=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  stale.push(...page.vectors.map(v => v.id).filter(id => !current.has(id)));
  if (!page.isTruncated) break;
  cursor = page.nextCursor;
}
for (let i = 0; i < stale.length; i += 1000) {
  await api(`vectorize/v2/indexes/${INDEX}/delete_by_ids`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: stale.slice(i, i + 1000) }) });
}
console.log(`Удалено устаревших векторов: ${stale.length}. Vectorize применяет изменения не сразу; проверка — check-vectors.mjs.`);
