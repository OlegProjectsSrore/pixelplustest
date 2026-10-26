import type { AdapterContext, AdapterHandler } from '../integration.ts';
import type { StoredSession } from '../storage/types.ts';
import { fail, identifier, textField } from '../security.ts';
import index from './kb-index.mjs';
import { createHybridSearch, type HybridResult } from './hybrid.mjs';

// One search per database binding: it caches whether the D1 texts match the bundled index.
const searches = new WeakMap<D1Database, ReturnType<typeof createHybridSearch>>();

/** One metered hybrid search for this session; the daily knowledge_searches budget applies to chat and voice alike. */
export async function searchKnowledge(context: AdapterContext, session: StoredSession, query: string, options?: { limit?: number; maxChars?: number }): Promise<HybridResult> {
  const { core, env } = context;
  if (env.KNOWLEDGE_ANSWERS_ENABLED !== 'true') return { fragments: [], vectors: 'off', ready: false };
  let search = searches.get(env.DB);
  if (!search) { search = createHybridSearch({ index, ai: env.AI, vectorize: env.VECTORIZE, db: env.DB }); searches.set(env.DB, search); }
  const reservation = await core.reserve('knowledge_searches', 1, `${session.id}:${crypto.randomUUID()}`);
  try { return await search(query, options); }
  finally { await core.store.settleUsage(reservation.id, 1, core.now()); }
}

/** GET /api/tools/search for the voice model's searchKnowledge tool: source fragments only, the model words the answer. */
export function createKnowledgeSearchHandler(): AdapterHandler {
  return async (request, context) => {
    const url = new URL(request.url);
    const session = await context.core.authenticate(request, identifier(url.searchParams.get('session_id'), 'session_id'));
    const query = textField(url.searchParams.get('q'), 'q', 300);
    if (session.state.status !== 'in_progress') fail(409, 'interview_closed', 'Сбор сведений уже завершён.');
    const result = await searchKnowledge(context, session, query, { limit: 4, maxChars: 1200 });
    return { corpus: index.corpus, snippets: result.fragments.map(fragment => ({ ...fragment })) };
  };
}
