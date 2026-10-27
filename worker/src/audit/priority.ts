import type { AuditFact } from './contracts.ts';
import type { AuditLibrary } from './library.ts';
import { isRecord } from './rules.ts';

/** The owner-approved priority (MoSCoW form): high, medium or low, from the visitor's answers only. */
export type PriorityLevel = 'high' | 'medium' | 'low';
export type Consequence = 'stops_operation' | 'loss_or_delay' | 'limited' | 'no_effect';
export const PRIORITY_RANK: Record<PriorityLevel, number> = { high: 3, medium: 2, low: 1 };
const LEVELS: PriorityLevel[] = ['low', 'medium', 'high'];
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
      named: named.findIndex(value => value === block.domain || value === domain?.title), reported: block.type === 'reported_issue', libraryIndex: index };
  });
}

/** Pairs [bottleneck, dependent] among the given problems. */
export function orderPairs(ids: readonly string[], lib: AuditLibrary): [string, string][] {
  return lib.relationships.filter(relation => ORDER_RELATIONS.includes(relation.relation) && ids.includes(relation.a) && ids.includes(relation.b)).map(relation => [relation.a, relation.b]);
}

/** High needs named consequences that stop work or bring losses or delays; the library forbids high when they are unknown. */
export function levelCap(problem: ProblemFacts): PriorityLevel {
  return problem.consequence === 'stops_operation' || problem.consequence === 'loss_or_delay' ? 'high' : 'medium';
}

/** The approved code rule; its reasons are the approved phrases. Used on its own when the report writer fails. */
export function codePriorities(problems: readonly ProblemFacts[], pairs: readonly [string, string][], lib: AuditLibrary): Map<string, { level: PriorityLevel; reasons: string[] }> {
  const reasons = lib.report.priority.reasons, result = new Map<string, { level: PriorityLevel; reasons: string[] }>();
  for (const problem of problems) {
    const named = problem.named >= 0;
    const level: PriorityLevel = problem.consequence === 'stops_operation' || (problem.consequence === 'loss_or_delay' && named) ? 'high'
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

/** Levels from the report writer must keep the approved limits: high only with severe named consequences, a bottleneck not below its dependent. */
export function levelsAllowed(problems: readonly ProblemFacts[], pairs: readonly [string, string][], levels: ReadonlyMap<string, PriorityLevel>): boolean {
  if (problems.some(problem => !levels.has(problem.id) || PRIORITY_RANK[levels.get(problem.id)!] > PRIORITY_RANK[levelCap(problem)])) return false;
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
