import type { AuditFact } from './contracts.ts';
import type { AuditLibrary } from './library.ts';

/** A confirmed sign of a problem says that its topic applies, unless the visitor said the topic does not:
 * a problem found while checking another possible cause needs no separate topic question. */
export function withImpliedTopics(facts: Record<string, AuditFact>, lib: AuditLibrary): Record<string, AuditFact> {
  let result = facts;
  for (const block of lib.solutions) {
    const signal = facts[`${block.id}.signal`], id = `${block.domain}.applicable`, topic = result[id];
    if (signal?.state !== 'known' || signal.confirmation !== 'explicit' || signal.value !== 'target' || (topic && !['unknown', 'ambiguous', 'not_asked'].includes(topic.state))) continue;
    if (result === facts) result = { ...facts };
    result[id] = { fact_id: id, state: 'known', value: true, answer_ids: [...signal.answer_ids], confirmation: 'explicit' };
  }
  return result;
}
