// Reuse the exact tokenizer/ranker/chunk boundaries used by the project's index builder.
import { searchLexical, chunkText, stripFrontMatter } from '../../../knowledge-base/search/search-text.mjs';

/** Read-only, local BM25 retrieval. Approval and document loading are server dependencies. */
export function createKnowledgeSearch({ index, readDocument }) {
  if (!index || !/^[a-f0-9]{64}$/.test(index.corpus) || !Array.isArray(index.docs) || !Array.isArray(index.chunks) || !index.lexical) throw new Error('Invalid knowledge index');
  if (typeof readDocument !== 'function') throw new Error('A bundled document reader is required');
  const byId = new Map(index.chunks.map((chunk, i) => [chunk[0], i]));
  return async function search(query, approval) {
    if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new Error('Invalid reference query');
    // Corpus pinning prevents an old allow-list from authorizing newly changed chunks.
    if (!approval || approval.corpus !== index.corpus || !Array.isArray(approval.chunk_ids)) throw new Error('A current approved reference scope is required');
    const allowed = new Set(approval.chunk_ids.map(id => byId.get(id)).filter(i => i !== undefined));
    if (!allowed.size) return [];
    const selected = searchLexical(index.lexical, query, 3, i => allowed.has(i));
    const result = [];
    for (const i of selected) {
      const [id, d, heading, , start, end] = index.chunks[i];
      const doc = index.docs[d];
      if (!doc || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) throw new Error('Invalid knowledge chunk');
      let source;
      try { source = new URL(doc[2]); } catch { continue; }
      if (source.protocol !== 'https:' || !['pixelplus.ru', 'www.pixelplus.ru'].includes(source.hostname) || source.username || source.password || source.port) continue;
      const raw = await readDocument(doc[1]);
      if (typeof raw !== 'string') throw new Error('Knowledge document is unavailable');
      const text = stripFrontMatter(raw);
      if (text.length !== doc[6] || end > text.length) throw new Error('Knowledge index/document mismatch');
      const excerpt = chunkText(text, { start, end });
      // Do not cut a price/table condition in half. Oversized entries are not returned.
      if (excerpt.length > 8000) continue;
      result.push({ id, title: doc[3], heading, url: source.href, text: excerpt });
    }
    return result;
  };
}
