import type { AuditAnswer, AuditEvent, Confirmation } from '../audit/contracts.ts';
import type { StoredSession, VoiceCall } from '../storage/types.ts';
import type { VoiceAnswerCandidate } from './types.ts';
import { record } from './validation.ts';

export interface EvidenceAssessment {
  confirmation: Confirmation;
  /** Assigned by a trusted assessor after inspecting actual correction evidence, never copied from the model. */
  replaces_answer_id?: string;
}
export interface VoiceEvidenceInput {
  session: StoredSession; call: VoiceCall; candidates: VoiceAnswerCandidate[];
  events: AuditEvent[]; existing_answers: AuditAnswer[]; operation_id: string; now: number;
}
export type EvidenceAssessor = (input: { candidate: VoiceAnswerCandidate; evidence: AuditEvent[]; history: AuditEvent[]; existing_answers: AuditAnswer[]; session: StoredSession }) => Promise<EvidenceAssessment>;
export interface ResolvedVoiceAnswers { answers: AuditAnswer[]; event: AuditEvent }
const normalized = (text: string) => text.normalize('NFC').replace(/\s+/g, ' ').trim();

/** Retain only the latest version of each utterance before resolving quoted evidence. */
export function latestVoiceEvents(events: AuditEvent[], call: VoiceCall): AuditEvent[] {
  const byKey = new Map<string, AuditEvent>();
  for (const event of events) {
    if (event.call_id !== call.id || !['voice', 'webhook'].includes(event.source) || !['utterance', 'correction'].includes(event.kind)) continue;
    const key = `${event.source}:${event.source_key}`, previous = byKey.get(key);
    if (previous && previous.source_revision === event.source_revision && (previous.text !== event.text || previous.role !== event.role || JSON.stringify(previous.data) !== JSON.stringify(event.data))) throw new Error('Conflicting stored transcript versions');
    if (!previous || event.source_revision > previous.source_revision) byKey.set(key, event);
  }
  return [...byKey.values()].sort((a, b) => a.local_order - b.local_order);
}

export function resolveCandidateEvidence(candidate: VoiceAnswerCandidate, history: AuditEvent[]): AuditEvent[] {
  // Provider ingestion also explicitly marks finality. Missing/partial finality is not silently upgraded.
  const eligible = history.filter(event => event.role === 'user' && typeof event.text === 'string' && record(event.data) && event.data.is_final === true);
  const ordinals = candidate.source_ordinals?.length ? new Set(candidate.source_ordinals) : null;
  // SDK ordinals and provider history message order are different namespaces.
  const scoped = ordinals ? eligible.filter(event => event.source === 'voice' && ordinals.has(event.local_order)) : eligible;
  const selected = new Map<string, AuditEvent>();
  for (const quote of candidate.source_quotes) {
    const needle = normalized(quote);
    const matches = scoped.filter(event => normalized(event.text!).includes(needle));
    if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous voice evidence' : 'Voice evidence has not been delivered');
    selected.set(matches[0].id, matches[0]);
  }
  if (!selected.size || (ordinals && [...ordinals].some(ordinal => ![...selected.values()].some(event => event.local_order === ordinal)))) throw new Error('Voice evidence ordinals do not match quotations');
  return [...selected.values()];
}

/** Builds server-owned metadata. Semantic confirmation/correction requires independent trusted assessment. */
export async function resolveVoiceAnswers(input: VoiceEvidenceInput, assess?: EvidenceAssessor): Promise<ResolvedVoiceAnswers> {
  const history = latestVoiceEvents(input.events, input.call), answers: AuditAnswer[] = [];
  const allEvidence = new Map<string, AuditEvent>();
  const proofId = crypto.randomUUID(), alreadyReplaced = new Set(input.existing_answers.flatMap(answer => answer.replaces_answer_id ? [answer.replaces_answer_id] : []));
  let hasCorrection = false;
  for (const candidate of input.candidates) {
    const evidence = resolveCandidateEvidence(candidate, history);
    for (const event of evidence) allEvidence.set(event.id, event);
    const assessment = assess ? await assess({ candidate, evidence, history, existing_answers: input.existing_answers, session: input.session }) : { confirmation: 'unconfirmed' as const };
    if (!['explicit', 'unconfirmed', 'disputed'].includes(assessment.confirmation)) throw new Error('Invalid trusted evidence assessment');
    const eventIds = evidence.map(event => event.id);
    if (assessment.replaces_answer_id) {
      const target = input.existing_answers.find(answer => answer.id === assessment.replaces_answer_id);
      if (!target || target.fact_id !== candidate.fact_id || alreadyReplaced.has(target.id)) throw new Error('Invalid verified correction target');
      alreadyReplaced.add(target.id); hasCorrection = true; eventIds.push(proofId);
    }
    answers.push({
      id: crypto.randomUUID(), question_id: candidate.question_id, fact_id: candidate.fact_id,
      ...(candidate.answer_id === undefined ? {} : { answer_id: candidate.answer_id }),
      state: candidate.state, value: structuredClone(candidate.value),
      ...(candidate.parameters === undefined ? {} : { parameters: structuredClone(candidate.parameters) }),
      event_ids: eventIds, channel: 'voice', method: 'voice_batch', confirmation: assessment.confirmation,
      ...(assessment.replaces_answer_id ? { replaces_answer_id: assessment.replaces_answer_id } : {}),
      library_version: input.session.state.library_version, created_at: input.now,
    });
  }
  return { answers, event: {
    id: proofId, source: 'voice', source_key: `answer-batch:${input.operation_id}`, source_revision: 0,
    local_order: Math.max(0, ...[...allEvidence.values()].map(event => event.local_order)),
    role: hasCorrection ? 'user' : 'system', kind: hasCorrection ? 'correction' : 'answer', call_id: input.call.id,
    ...(hasCorrection ? { text: [...allEvidence.values()].map(event => event.text ?? '').join('\n') } : {}),
    data: { evidence_event_ids: [...allEvidence.keys()], verified_correction: hasCorrection }, occurred_at: input.now, received_at: input.now,
  } };
}
