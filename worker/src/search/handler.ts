import type { AdapterContext, AdapterHandler } from '../integration.ts';
import type { StoredSession } from '../storage/types.ts';
import { fail, identifier, textField } from '../security.ts';
import { createKnowledgeSearch, type KnowledgeIndex, type ReferenceApproval } from './knowledge.mjs';

export interface ReferenceSearchDependencies {
  index: KnowledgeIndex;
  readDocument(path: string): string | Promise<string>;
  /** Core-approved FAQ scope only; never accept chunk IDs or a scope supplied by the browser. */
  authorizeQuery(context: AdapterContext, session: StoredSession, query: string): Promise<ReferenceApproval | null>;
}

/** Optional route. Registration is disabled until the core supplies an approved FAQ scope. */
export function createReferenceSearchHandler(dependencies: ReferenceSearchDependencies): AdapterHandler {
  const search = createKnowledgeSearch(dependencies);
  return async (request, context) => {
    const url = new URL(request.url);
    const session = await context.core.authenticate(request, identifier(url.searchParams.get('session_id'), 'session_id'));
    const query = textField(url.searchParams.get('q'), 'q', 500);
    if (session.state.status !== 'in_progress') fail(409, 'interview_closed', 'Сбор сведений уже завершён.');
    const scope = await dependencies.authorizeQuery(context, session, query);
    if (!scope) fail(403, 'reference_not_allowed', 'Для этого вопроса справочный поиск не разрешён.');
    const snippets = await search(query, scope!);
    return { corpus: dependencies.index.corpus, snippets: snippets.map(snippet => ({ ...snippet })) };
  };
}
