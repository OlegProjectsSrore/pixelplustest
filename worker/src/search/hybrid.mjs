// Hybrid retrieval over the services knowledge base, as on the portfolio site: BM25 over the bundled index and meaning
// from Workers AI bge-m3 + Vectorize, fused by reciprocal rank. Chunk texts come from D1 (kb_chunks).
import { searchLexical, fuse } from '../../../knowledge-base/search/search-text.mjs';

const PER_LIST = 30;
const ALLOWED_HOSTS = ['pixelplus.ru', 'www.pixelplus.ru'];

/** Long excerpts are cut at a paragraph or line end so a price or condition is not split mid-sentence. */
export function excerpt(text, maxChars) {
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf('\n', maxChars);
  return `${text.slice(0, cut > maxChars / 2 ? cut : maxChars).trimEnd()} …`;
}

export function createHybridSearch({ index, ai, vectorize, db }) {
  const byId = new Map(index.chunks.map((chunk, i) => [chunk[0], i]));
  let ready;
  // D1 rows are usable only when they were loaded from the same knowledge base as the bundled index.
  const corpusMatches = () => (ready ??= db.prepare(`SELECT value FROM kb_meta WHERE key='corpus'`).first()
    .then(row => row?.value === index.corpus, () => { ready = undefined; return false; }));
  return async function search(query, { limit = 5, maxChars = 1500 } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new Error('Invalid knowledge query');
    if (!(await corpusMatches())) return { fragments: [], vectors: 'off', ready: false };
    const lists = [searchLexical(index.lexical, query, PER_LIST)];
    let vectors = 'off';
    if (ai && vectorize) {
      try {
        const embedded = await ai.run('@cf/baai/bge-m3', { text: [query], truncate_inputs: true });
        const vector = embedded?.data?.[0];
        if (!Array.isArray(vector)) throw new Error('No embedding');
        const result = await vectorize.query(vector, { topK: PER_LIST, returnValues: false, returnMetadata: 'none' });
        lists.push(result.matches.map(match => byId.get(match.id)).filter(i => i !== undefined));
        vectors = 'ok';
      } catch { vectors = 'failed'; /* lexical results still answer */ }
    }
    const ids = fuse(lists).slice(0, limit).map(i => index.chunks[i][0]);
    if (!ids.length) return { fragments: [], vectors, ready: true };
    const { results } = await db.prepare(`SELECT id,url,title,heading,text FROM kb_chunks WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    const rows = new Map(results.map(row => [row.id, row]));
    const fragments = ids.flatMap(id => {
      const row = rows.get(id);
      if (!row) return [];
      let url;
      try { url = new URL(row.url); } catch { return []; }
      if (url.protocol !== 'https:' || !ALLOWED_HOSTS.includes(url.hostname) || url.username || url.password || url.port) return [];
      return [{ id, title: row.title, heading: row.heading, url: url.href, text: excerpt(row.text, maxChars) }];
    });
    return { fragments, vectors, ready: true };
  };
}
