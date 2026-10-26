import type { VoicePromptInput } from './types.ts';
import { CLOSING_MESSAGE } from './call-config.ts';
import { nonempty, remainingSeconds } from './validation.ts';
import { INTERVIEW_PROMPT } from './interview-prompt.ts';

/** Fills {{name}} marks in one pass, so inserted data is never read as a mark; a missing or unused value is a bug. */
export function renderPrompt(template: string, values: Record<string, string>): string {
  const used = new Set<string>();
  const text = template.replace(/\{\{(\w+)\}\}/g, (_mark, name: string) => {
    if (!Object.hasOwn(values, name)) throw new Error(`Prompt value is missing: ${name}`);
    used.add(name); return values[name];
  });
  for (const name of Object.keys(values)) if (!used.has(name)) throw new Error(`Prompt value is unused: ${name}`);
  return text;
}

/** Deliberately accepts interview data only; never receives solution blocks, tariffs, or credentials. */
export function buildInterviewPrompt(input: VoicePromptInput): string {
  nonempty(input.library_version, 'library version', 128);
  const seconds = remainingSeconds(input.remaining_seconds);
  if (input.current_question_id !== null && !input.questions.some(question => question.id === input.current_question_id)) throw new Error('Current question is outside the supplied block');
  const context = {
    library_version: input.library_version, current_question_id: input.current_question_id,
    remaining_seconds: seconds, humor_enabled: input.humor_enabled,
    questions: input.questions.map(question => ({ id: question.id, text: question.text, fact_ids: question.fact_ids, options: question.options })),
    facts: input.accepted_facts.map(fact => ({ fact_id: fact.fact_id, state: fact.state, value: fact.value, parameters: fact.parameters ?? null, confirmation: fact.confirmation })),
    off_topic_categories: (input.off_topic_categories ?? []).map(category => ({ id: category.id, selection_source: category.selection_source, do_not_use_when: category.do_not_use_when })),
    service_faq: (input.service_faq ?? []).map(item => ({ question: item.question, answer: item.answer })),
  };
  return renderPrompt(INTERVIEW_PROMPT, { closing_message: CLOSING_MESSAGE, context: JSON.stringify(context),
    fact_formats: JSON.stringify(input.fact_formats ?? []), history: JSON.stringify(input.history ?? []) });
}
