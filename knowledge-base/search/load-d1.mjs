// Загружает тексты кусков базы знаний в D1 (kb_chunks, kb_meta) для гибридного поиска Worker.
// Запускать после build-index.mjs и embed-index.mjs, когда применена миграция worker/migrations/0007:
//   node knowledge-base/search/load-d1.mjs
// Поиск в Worker включается, только когда kb_meta.corpus совпадает с corpus встроенного search-index.json,
// поэтому corpus сначала снимается и записывается последним — частично загруженная таблица не используется.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkText, stripFrontMatter } from './search-text.mjs';
import { api } from './cloudflare.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATABASE = '9a74183c-b271-47df-8d22-1facab33e988';
// D1: не больше 100 параметров и около 100 КБ на запрос.
const MAX_ROWS = 16;
const MAX_BYTES = 80_000;

const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'search-index.json'), 'utf8'));
const texts = new Map();
const rows = index.chunks.map(([id, d, heading, , start, end]) => {
  const doc = index.docs[d];
  if (!texts.has(d)) {
    const text = stripFrontMatter(fs.readFileSync(path.join(ROOT, doc[1]), 'utf8'));
    if (text.length !== doc[6]) throw new Error(`${doc[1]} не совпадает с индексом: запустите build-index.mjs`);
    texts.set(d, text);
  }
  return [id, doc[2], doc[3], heading, doc[4], chunkText(texts.get(d), { start, end })];
});

const run = (sql, params = []) => api(`d1/database/${DATABASE}/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, params }) });
await run(`DELETE FROM kb_meta WHERE key='corpus'`);
await run('DELETE FROM kb_chunks');
let batch = [], bytes = 0, loaded = 0;
const flush = async () => {
  if (!batch.length) return;
  await run(`INSERT INTO kb_chunks (id,url,title,heading,kind,text) VALUES ${batch.map(() => '(?,?,?,?,?,?)').join(',')}`, batch.flat());
  loaded += batch.length; batch = []; bytes = 0;
  process.stdout.write(`\r${loaded}/${rows.length}`);
};
for (const row of rows) {
  const size = Buffer.byteLength(JSON.stringify(row));
  if (batch.length && (batch.length >= MAX_ROWS || bytes + size > MAX_BYTES)) await flush();
  batch.push(row); bytes += size;
}
await flush();
await run(`INSERT INTO kb_meta (key,value) VALUES ('corpus',?)`, [index.corpus]);
console.log(`\nЗагружено кусков: ${loaded}, corpus ${index.corpus.slice(0, 12)}`);
