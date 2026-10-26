import { INTERVIEW_BUDGET_MS, type AuditState, type QuestionView } from './contracts.ts';
import { elapsedInterviewMs } from './engine.ts';
import { library, type AuditLibrary } from './library.ts';

/** Classifier output, not keyword matching. Only clearly safe, compatible categories are eligible. */
export interface HumorIntent {
  kind: 'off_topic' | 'mixed' | 'answer' | 'sensitive' | 'clarification' | 'complaint' | 'role_change' | 'humor_declined' | 'humor_enabled' | 'pause' | 'finish' | 'ambiguous';
  certain: boolean;
  safe_category_ids: string[];
  excluded_joke_ids?: string[];
  previous_topic_category_ids?: string[];
  now: number;
}
export interface HumorReply { joke_id: string | null; text: string; question_id: string | null }
/** Return phrases take turns by the number of jokes already used or reserved, so a replayed operation keeps its own phrase.
 * In questions mode there is no survey to return to: the phrase invites more questions instead. */
const returnPhrase = (state: AuditState, lib: AuditLibrary) => {
  const phrases = state.mode === 'questions' && lib.jokes.questions_return_phrases?.length ? lib.jokes.questions_return_phrases : lib.jokes.return_phrases;
  return phrases[(state.humor.used_ids.length + state.humor.reserved_ids.length) % phrases.length];
};
/** Pure selection. Caller must reserve this result atomically with revision/operation checks. */
export function selectHumorReply(state: AuditState, intent: HumorIntent, question: QuestionView | null, lib: AuditLibrary = library): HumorReply {
  if (state.library_version !== lib.version) throw new Error('Pinned library mismatch');
  const neutral = lib.jokes.neutral_replies;
  if (intent.kind === 'pause' || intent.kind === 'finish' || state.status !== 'in_progress' || state.paused || elapsedInterviewMs(state, intent.now) >= INTERVIEW_BUDGET_MS) return { joke_id: null, text: neutral.pause_or_stop, question_id: null };
  if (intent.kind === 'humor_enabled') return { joke_id: null, text: returnPhrase(state, lib), question_id: question?.id ?? null };
  if (intent.kind === 'humor_declined' || !state.humor.enabled) return { joke_id: null, text: neutral.humor_declined, question_id: question?.id ?? null };
  if (intent.kind === 'role_change') return { joke_id: null, text: neutral.role_change, question_id: question?.id ?? null };
  // Questions mode has no current survey question, yet a safe off-topic remark still gets a joke.
  if (intent.kind !== 'off_topic' || !intent.certain || (!question && state.mode !== 'questions')) return { joke_id: null, text: '', question_id: null };
  const excluded = new Set([...state.humor.used_ids, ...state.humor.reserved_ids, ...(intent.excluded_joke_ids ?? [])]);
  for (const source of ['question_topic', 'previous_audit_topic', 'fallback']) {
    const categories = lib.jokes.categories.filter(category => category.selection_source === source && intent.safe_category_ids.includes(category.id) && (source !== 'previous_audit_topic' || intent.previous_topic_category_ids?.includes(category.id)));
    for (const category of categories) {
      const joke = category.jokes.find(item => !excluded.has(item.id));
      if (joke) return { joke_id: joke.id, text: `${joke.text} ${returnPhrase(state, lib)}`, question_id: question?.id ?? null };
    }
  }
  return { joke_id: null, text: neutral.off_topic, question_id: question?.id ?? null };
}
