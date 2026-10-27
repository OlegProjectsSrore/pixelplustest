import assert from 'node:assert/strict';
import test from 'node:test';
import { ANSWER_MODEL, ANSWER_TEMPERATURE, answerQuestion, buildAnswerPrompt, checkAnswer, formatAnswer, NO_ANSWER, type AnswerInput } from './answerer.ts';
import { ANSWER_STYLE } from './answer-style.ts';
import type { ClassifierRuntime, ProviderExchange } from './types.ts';

const seo = 'https://pixelplus.ru/tarify/seo/', dev = 'https://pixelplus.ru/razrabotka/';
const input: AnswerInput = { question: 'Сколько стоит продвижение?', history: [], fragments: [
  { title: 'Цены на SEO', heading: 'Тарифы', url: seo, text: 'Продвижение по позициям — от 79 500 руб./мес. Поддержка 24/7.' },
  { title: 'Разработка', heading: 'Сайты', url: dev, text: 'Создаём сайты на Битрикс с 2007 года.' }] };
const out = (answer: string, sources: string[]) => JSON.stringify({ answer, sources });

test('a grounded answer passes and is shown with its source links', () => {
  assert.deepEqual(checkAnswer(out('Продвижение по позициям стоит от 79 500 руб. в месяц, поддержка работает 24/7.', [seo]), input),
    { answer: 'Продвижение по позициям стоит от 79 500 руб. в месяц, поддержка работает 24/7.', sources: [seo] });
  assert.equal(formatAnswer({ answer: 'Ответ.', sources: [seo, dev] }), `Ответ.\nПодробнее: ${seo} ${dev}`);
});

test('numbers absent from the fragments, foreign sources, links and markup are rejected', () => {
  assert.equal(checkAnswer(out('Продвижение стоит от 50 000 руб. в месяц.', [seo]), input), null, 'an invented price');
  assert.equal(checkAnswer(out('Продвижение по позициям — от 79 500 руб. в месяц.', ['https://pixelplus.ru/other/']), input), null);
  assert.equal(checkAnswer(out('Подробнее на https://pixelplus.ru/tarify/seo/ — от 79 500 руб.', [seo]), input), null);
  assert.equal(checkAnswer(out('**Цена:** от 79 500 руб. в месяц за продвижение.', [seo]), input), null);
  assert.equal(checkAnswer(out('Продвижение по позициям — от 79 500 руб. в месяц.', [seo, dev, 'https://pixelplus.ru/third/']), input), null, 'at most two sources');
  assert.equal(checkAnswer(JSON.stringify({ answer: 'Длинный достаточный ответ без цифр.', sources: [seo], extra: 1 }), input), null);
});

test('no answer in the fragments is a result of its own, not a failure: an empty answer or an answer based on no fragment', () => {
  assert.equal(checkAnswer(out('', []), input), NO_ANSWER);
  assert.equal(checkAnswer(out('Во фрагментах нет информации о том, какие работы «Пиксель Плюс» не выполняет.', []), input), NO_ANSWER);
  assert.equal(checkAnswer(out('', [seo]), input), NO_ANSWER);
  assert.equal(checkAnswer('не JSON', input), null, 'a broken reply is still a failure');
});

test('the prompt keeps the editable style, the fixed contract and the fragments as data', () => {
  const [system, user] = buildAnswerPrompt(input);
  assert(system.content.startsWith(ANSWER_STYLE)); assert.match(system.content, /Верни только JSON-объект \{"answer":"\.\.\.","sources":\["\.\.\."\]\}/);
  assert.deepEqual(JSON.parse(user.content).fragments.map((fragment: { url: string }) => fragment.url), [seo, dev]);
});

test('one DeepSeek call at a low temperature; failures and empty fragments return null without a call', async () => {
  const bodies: Record<string, unknown>[] = [];
  const runtime = (reply: ProviderExchange): ClassifierRuntime => ({ api_key: 'key', max_tokens: 900, timeout_ms: 5000,
    fetch: (async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(null); }) as unknown as typeof fetch,
    async runAuthorized(_request, call) { await call(); return reply; } });
  const completed = (content: string): ProviderExchange => ({ outcome: 'completed', status: 200, usage: null, error: null, body: { choices: [{ finish_reason: 'stop', message: { content } }] } });
  assert.deepEqual(await answerQuestion(input, runtime(completed(out('Создаём сайты на Битрикс с 2007 года.', [dev])))), { answer: 'Создаём сайты на Битрикс с 2007 года.', sources: [dev] });
  assert.equal(bodies[0].temperature, ANSWER_TEMPERATURE);
  assert.equal(await answerQuestion(input, runtime({ outcome: 'unknown', status: null, body: null, usage: null, error: 'timeout' })), null);
  assert.equal(await answerQuestion(input, runtime(completed(out('', [])))), NO_ANSWER);
  assert.equal(await answerQuestion({ ...input, fragments: [] }, runtime(completed('{}'))), null);
  assert.equal(bodies.length, 3, 'no call without fragments');
});

test('visitor answers are written by DeepSeek V4 Pro; the spoken variant asks for short sentences', async () => {
  const bodies: Record<string, unknown>[] = [];
  const runtime: ClassifierRuntime = { api_key: 'key', max_tokens: 900, timeout_ms: 5000,
    fetch: (async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(null); }) as unknown as typeof fetch,
    async runAuthorized(request, call) { assert.equal(request.model, 'deepseek-v4-pro'); await call(); return { outcome: 'unknown', status: null, body: null, usage: null, error: 'timeout' }; } };
  await answerQuestion(input, runtime);
  assert.equal(ANSWER_MODEL, 'deepseek-v4-pro'); assert.equal(bodies[0].model, 'deepseek-v4-pro'); assert.deepEqual(bodies[0].thinking, { type: 'disabled' });
  const [chat] = buildAnswerPrompt(input), [voice] = buildAnswerPrompt({ ...input, channel: 'voice' });
  assert.doesNotMatch(chat.content, /прозвучит голосом/); assert.match(voice.content, /Ответ прозвучит голосом: 1–3 коротких предложения/);
  assert.match(ANSWER_STYLE, /не предлагай пройти опрос или экспресс-диагностику и не возвращай к ним/);
});
