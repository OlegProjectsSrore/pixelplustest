// Строит индекс для гибридного поиска по базе kb/: границы кусков и индекс BM25.
// Запускать после каждой пересборки kb/ (extract.py): node knowledge-base/search/build-index.mjs [--check]
// Векторы для тех же кусков загружает отдельно embed-index.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chunkDocument, chunkText, stripFrontMatter, buildLexical } from './search-text.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'search-index.json');

// Короткий постоянный идентификатор документа: идентификатор вектора в Vectorize не длиннее 64 байт.
export const docId = file => createHash('sha1').update(file).digest('hex').slice(0, 10);

const entries = JSON.parse(fs.readFileSync(path.join(ROOT, 'index.json'), 'utf8')).toSorted((a, b) => a.file.localeCompare(b.file));
const hash = createHash('sha256');
const docs = [];
const chunks = [];
const texts = [];
for (const entry of entries) {
  const text = stripFrontMatter(fs.readFileSync(path.join(ROOT, entry.file), 'utf8'));
  const id = docId(entry.file);
  hash.update(entry.file).update('\0').update(text).update('\0');
  const d = docs.length;
  docs.push([id, entry.file, entry.url ?? '', entry.title, entry.kind, entry.section, text.length]);
  for (const chunk of chunkDocument(id, text)) {
    chunks.push([chunk.id, d, chunk.path, chunk.h2, chunk.start, chunk.end]);
    texts.push(`${entry.title}\n${chunk.path}\n${chunkText(text, chunk)}`);
  }
}
const corpus = hash.digest('hex');

if (process.argv.includes('--check')) {
  const current = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  if (current.corpus !== corpus) { console.error('search-index.json устарел: запустите build-index.mjs и заново загрузите векторы.'); process.exit(1); }
  console.log(`Индекс соответствует базе (${chunks.length} кусков).`);
} else {
  const index = { corpus, docs, chunks, lexical: buildLexical(texts) };
  fs.writeFileSync(OUT, JSON.stringify(index));
  const sizes = chunks.map(c => c[5] - c[4]).sort((a, b) => a - b);
  console.log(`Записан search-index.json: документов ${docs.length}, кусков ${chunks.length} (медиана ${sizes[sizes.length >> 1]} знаков, максимум ${sizes.at(-1)}), терминов ${Object.keys(index.lexical.postings).length}, ${(fs.statSync(OUT).size / 1e6).toFixed(1)} МБ, corpus ${corpus.slice(0, 12)}`);
}
