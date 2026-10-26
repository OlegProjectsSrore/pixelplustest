import { INTENTS, type ClassifierContext } from './types.ts';
import { CLASSIFIER_PROMPT } from './classifier-prompt.ts';
import { renderPrompt } from '../prompt-template.ts';

export function buildClassifierPrompt(context: ClassifierContext): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: renderPrompt(CLASSIFIER_PROMPT, { intents: INTENTS.join(', ') }) },
    { role: 'user', content: JSON.stringify(context) },
  ];
}
