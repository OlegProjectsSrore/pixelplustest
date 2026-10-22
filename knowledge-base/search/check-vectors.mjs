// Проверяет, что каждый кусок из search-index.json есть в Vectorize и относится к текущему corpus.
// Запуск: node knowledge-base/search/check-vectors.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, INDEX } from './cloudflare.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'search-index.json'), 'utf8'));
const ids = index.chunks.map(c => c[0]);
console.log(`Кусков: ${ids.length}, уникальных идентификаторов: ${new Set(ids).size}`);
const missing = [], stale = [];
for (let i = 0; i < ids.length; i += 20) {
  const batch = ids.slice(i, i + 20);
  const found = await api(`vectorize/v2/indexes/${INDEX}/get_by_ids`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: batch }) });
  const byId = new Map(found.map(v => [v.id, v]));
  for (const id of batch) {
    const vector = byId.get(id);
    if (!vector) missing.push(id);
    else if (vector.metadata?.corpus !== index.corpus.slice(0, 12)) stale.push(id);
  }
}
console.log(`Нет в Vectorize: ${missing.length}${missing.length ? ' — ' + missing.join(', ') : ''}; со старым corpus: ${stale.length}`);
process.exit(missing.length || stale.length ? 1 : 0);
