import type { AuditFact } from './contracts.ts';
import type { AuditLibrary } from './library.ts';
import { isRecord } from './rules.ts';

/** The owner-approved priority of the report kit: critical, high, medium or low, from the visitor's answers only. */
export type PriorityLevel = 'critical' | 'high' | 'medium' | 'low';
export type Consequence = 'stops_operation' | 'loss_or_delay' | 'limited' | 'no_effect';
export const PRIORITY_RANK: Record<PriorityLevel, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const LEVELS: PriorityLevel[] = ['low', 'medium', 'high', 'critical'];
/** Relations where the first problem has to be solved before the second: the first is the bottleneck. */
export const ORDER_RELATIONS = ['measurement_before_optimization', 'configure_then_validate', 'permissions_before_contact', 'access_before_actions', 'validation_before_rollout', 'restore_before_change', 'validate_task_before_build', 'goal_before_production'];

export interface ProblemFacts {
  id: string; title: string; domain: string; domainTitle: string;
  /** What the visitor said the topic does to the business; null when not said. */
  consequence: Consequence | null;
  /** Position of the topic among those the visitor named as the main difficulty; -1 when not named. */
  named: number;
  /** The library marks the problem as already happening rather than a gap, hypothesis or opportunity. */
  reported: boolean;
  type: 'data_gap' | 'hypothesis' | 'opportunity' | 'reported_issue';
  libraryIndex: number;
}
const known = (fact: AuditFact | undefined) => fact?.state === 'known' && fact.confirmation === 'explicit';

export function problemFacts(ids: readonly string[], facts: Record<string, AuditFact>, lib: AuditLibrary): ProblemFacts[] {
  const priority = facts['context.priority'];
  const named = known(priority) && Array.isArray(priority.value) ? priority.value.filter((value): value is string => typeof value === 'string') : [];
  return ids.map(id => {
    const index = lib.solutions.findIndex(block => block.id === id), block = lib.solutions[index]!;
    const domain = lib.domains.find(item => item.id === block.domain);
    const impact = facts[`${block.domain}.impact`];
    const level = known(impact) && isRecord(impact.value) ? impact.value.level : undefined;
    return { id, title: String(block.pdf.heading || block.title), domain: block.domain, domainTitle: domain?.title ?? block.domain,
      consequence: ['stops_operation', 'loss_or_delay', 'limited', 'no_effect'].includes(String(level)) ? level as Consequence : null,
      named: named.findIndex(value => value === block.domain || value === domain?.title), reported: block.type === 'reported_issue', type: block.type, libraryIndex: index };
  });
}

/** Pairs [bottleneck, dependent] among the given problems. Another possible cause of a complaint comes before it,
 * unless each is listed as a possible cause of the other. */
export function orderPairs(ids: readonly string[], lib: AuditLibrary): [string, string][] {
  const among = (relation: { a: string; b: string }) => ids.includes(relation.a) && ids.includes(relation.b);
  const cause = (a: string, b: string) => lib.relationships.some(relation => relation.relation === 'alternative_cause' && relation.a === a && relation.b === b);
  const pairs: [string, string][] = [
    ...lib.relationships.filter(relation => ORDER_RELATIONS.includes(relation.relation) && among(relation)).map((relation): [string, string] => [relation.a, relation.b]),
    ...lib.relationships.filter(relation => relation.relation === 'alternative_cause' && among(relation) && !cause(relation.b, relation.a)).map((relation): [string, string] => [relation.b, relation.a]),
  ];
  return pairs.filter(([before, after], index) => pairs.findIndex(([a, b]) => a === before && b === after) === index);
}

/** Critical and high need named consequences that stop work or bring losses or delays; the library forbids them when the consequences are unknown. */
export function levelCap(problem: ProblemFacts): PriorityLevel {
  return problem.consequence === 'stops_operation' || problem.consequence === 'loss_or_delay' ? 'critical' : 'medium';
}

/** The approved code rule; its reasons are the approved phrases. Used on its own when the report writer fails. */
export function codePriorities(problems: readonly ProblemFacts[], pairs: readonly [string, string][], lib: AuditLibrary): Map<string, { level: PriorityLevel; reasons: string[] }> {
  const reasons = lib.report.priority.reasons, result = new Map<string, { level: PriorityLevel; reasons: string[] }>();
  for (const problem of problems) {
    const named = problem.named >= 0;
    const level: PriorityLevel = problem.consequence === 'stops_operation' ? 'critical' : problem.consequence === 'loss_or_delay' && named ? 'high'
      : problem.consequence === 'loss_or_delay' || (named && problem.consequence !== 'no_effect') ? 'medium' : 'low';
    result.set(problem.id, { level, reasons: [...(problem.consequence ? [reasons[problem.consequence]] : []), ...(named ? [reasons.named] : [])] });
  }
  // A bottleneck is never below the problem that depends on it, within its own cap.
  for (let changed = true, guard = 0; changed && guard < 50; guard++) {
    changed = false;
    for (const [before, after] of pairs) {
      const first = result.get(before)!, second = result.get(after)!, problem = problems.find(item => item.id === before)!;
      const wanted = Math.min(PRIORITY_RANK[second.level], PRIORITY_RANK[levelCap(problem)]);
      if (PRIORITY_RANK[first.level] < wanted) {
        first.level = LEVELS[wanted - 1]!;
        first.reasons.push(reasons.bottleneck.replace('{title}', problems.find(item => item.id === after)!.title));
        changed = true;
      }
    }
  }
  for (const value of result.values()) if (!value.reasons.length) value.reasons.push(reasons.confirmed);
  return result;
}

export function formatPriority(level: PriorityLevel, reasons: readonly string[], lib: AuditLibrary): string {
  return `${lib.report.priority.levels[level]}: ${reasons.join('; ')}.`;
}

/** Levels from the report writer must keep the approved limits: critical and high only with severe named consequences, critical only when work stops
 * or for the bottleneck of a critical problem, a bottleneck not below its dependent. */
export function levelsAllowed(problems: readonly ProblemFacts[], pairs: readonly [string, string][], levels: ReadonlyMap<string, PriorityLevel>): boolean {
  if (problems.some(problem => !levels.has(problem.id) || PRIORITY_RANK[levels.get(problem.id)!] > PRIORITY_RANK[levelCap(problem)])) return false;
  if (problems.some(problem => levels.get(problem.id) === 'critical' && problem.consequence !== 'stops_operation' &&
    !pairs.some(([before, after]) => before === problem.id && levels.get(after) === 'critical'))) return false;
  return pairs.every(([before, after]) => PRIORITY_RANK[levels.get(before)!] >= Math.min(PRIORITY_RANK[levels.get(after)!], PRIORITY_RANK[levelCap(problems.find(item => item.id === before)!)]));
}

/** Importance order: level, then the order the visitor named the topics, then problems already happening, then the library order. */
export function importanceOrder(problems: readonly ProblemFacts[], levels: ReadonlyMap<string, PriorityLevel>): string[] {
  const named = (problem: ProblemFacts) => problem.named < 0 ? Number.MAX_SAFE_INTEGER : problem.named;
  return [...problems].sort((a, b) => PRIORITY_RANK[levels.get(b.id)!] - PRIORITY_RANK[levels.get(a.id)!] || named(a) - named(b) || Number(b.reported) - Number(a.reported) || a.libraryIndex - b.libraryIndex).map(problem => problem.id);
}

/** Execution order: the importance order with every bottleneck moved right before the first problem that depends on it. */
export function executionOrder(order: readonly string[], pairs: readonly [string, string][]): string[] {
  const result = [...order];
  for (let changed = true, guard = 0; changed && guard < 50; guard++) {
    changed = false;
    for (const [before, after] of pairs) {
      const from = result.indexOf(before), to = result.indexOf(after);
      if (from > to) { result.splice(from, 1); result.splice(to, 0, before); changed = true; }
    }
  }
  return result;
}

/** The report kit's scores, all from the visitor's answers (see the comments of the approved LLM sample). */
export function influenceScore(problem: ProblemFacts): number {
  return ({ stops_operation: 10, loss_or_delay: 8, limited: 5, no_effect: 2 } as const)[problem.consequence ?? 'limited'];
}
export function urgencyScore(problem: ProblemFacts, pairs: readonly [string, string][]): number {
  const scores = [problem.consequence === 'no_effect' ? 3 : 5];
  if (problem.consequence === 'stops_operation') scores.push(10);
  if (problem.named === 0) scores.push(9); else if (problem.named > 0) scores.push(8);
  if (pairs.some(([before]) => before === problem.id)) scores.push(8);
  if (problem.consequence === 'loss_or_delay') scores.push(7);
  return Math.max(...scores);
}
export function complexityScore(steps: number): number { return Math.min(10, 2 + steps); }
export const CONFIDENCE: Record<ProblemFacts['type'], { percent: number; status: string }> = {
  reported_issue: { percent: 90, status: 'проблема подтверждена Вашими ответами; причина — гипотеза' },
  data_gap: { percent: 85, status: 'подтверждено Вашими ответами' },
  hypothesis: { percent: 70, status: 'сильный сигнал; причина — гипотеза' },
  opportunity: { percent: 60, status: 'возможность роста' },
};
/** The business map: a direction's score and potential follow its highest problem level; a direction without problems the visitor discussed scores 8. */
export const MAP_SCORE: Record<PriorityLevel | 'none', { score: number; potential: string }> = {
  critical: { score: 2, potential: 'очень высокий' }, high: { score: 3, potential: 'высокий' }, medium: { score: 5, potential: 'средний' }, low: { score: 7, potential: 'низкий' }, none: { score: 8, potential: 'низкий' },
};
