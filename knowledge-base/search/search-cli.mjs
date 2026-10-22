// Проверка индекса из командной строки.
//   node knowledge-base/search/search-cli.mjs --verify            — куски покрывают каждый документ целиком и по порядку
//   node knowledge-base/search/search-cli.mjs "вопрос" [--vectors] — поиск BM25 (с --vectors ещё и по смыслу, RRF)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkText, stripFrontMatter, searchLexical, fuse } from './search-text.mjs';
import { embed, query } from './cloudflare.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'search-index.json'), 'utf8'));
const textCache = new Map();
const docText = d => {
  if (!textCache.has(d)) textCache.set(d, stripFrontMatter(fs.readFileSync(path.join(ROOT, index.docs[d][1]), 'utf8')));
  return textCache.get(d);
};

if (process.argv.includes('--verify')) {
  let problems = 0;
  const byDoc = new Map();
  for (const c of index.chunks) (byDoc.get(c[1]) ?? byDoc.set(c[1], []).get(c[1])).push(c);
  index.docs.forEach((doc, d) => {
    const text = docText(d);
    if (text.length !== doc[6]) { problems++; console.log(`Длина изменилась: ${doc[1]}`); return; }
    let at = 0;
    for (const [, , , , start, end] of byDoc.get(d) ?? []) {
      // Шапка большой таблицы не входит в границы куска: chunkText добавляет её к каждой группе строк.
      const gap = text.slice(at, start).trim();
      if (gap && !(gap.startsWith('|') && chunkText(text, { start, end }).startsWith(gap))) { problems++; console.log(`Пропущен текст: ${doc[1]} ${at}–${start}`); }
      at = end;
    }
    if (text.slice(at).trim()) { problems++; console.log(`Пропущен конец: ${doc[1]}`); }
  });
  console.log(problems ? `Ошибок: ${problems}` : `Все ${index.docs.length} документов покрыты кусками без пропусков.`);
  process.exit(problems ? 1 : 0);
}

const question = process.argv.slice(2).filter(a => !a.startsWith('--')).join(' ');
const lists = [searchLexical(index.lexical, question, 30)];
const byId = new Map(index.chunks.map((c, i) => [c[0], i]));
if (process.argv.includes('--vectors')) {
  const [vector] = await embed([question]);
  lists.push((await query(vector, 30)).map(id => byId.get(id)).filter(i => i !== undefined));
}
const ranked = lists.length > 1 ? fuse(lists) : lists[0];
for (const i of ranked.slice(0, 8)) {
  const [id, d, chunkPath, , start, end] = index.chunks[i];
  const marks = lists.map((l, n) => `${n ? 'смысл' : 'BM25'} ${l.indexOf(i) + 1 || '—'}`).join(', ');
  const excerpt = chunkText(docText(d), { start, end }).replace(/\s+/g, ' ').slice(0, 160);
  console.log(`\n[${marks}] ${index.docs[d][3]} › ${chunkPath}\n  ${index.docs[d][2] || index.docs[d][1]}\n  ${excerpt}`);
}
