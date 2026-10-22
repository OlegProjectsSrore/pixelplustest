// Обработка текста для гибридного поиска: нарезка Markdown на куски и термины для BM25.
// Перенесено из сайта портфолио (src/worker/chat/search-text.ts) без изменения правил, чтобы скрипт сборки
// индекса и будущий Worker давали одинаковые куски и термины. Отличие: кусок принадлежит документу базы
// (doc), а не проекту, и нумерованных разделов («# 21. …») здесь нет.

const MAX_CHUNK = 4000;
const MIN_CHUNK = 1200;

export const normalize = text => text.replace(/\r\n?/g, '\n');

// Тело файла базы без блока метаданных в начале (--- … ---).
export function stripFrontMatter(text) {
  const match = /^---\n[\s\S]*?\n---\n+/.exec(normalize(text));
  return match ? normalize(text).slice(match[0].length) : normalize(text);
}

// Разделы Markdown по заголовкам 1–4 уровня; строки с # внутри блоков кода не считаются заголовками.
function sections(text) {
  const result = [];
  const stack = [];
  let fence = false, start = 0, offset = 0, path = [];
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    const heading = !fence && /^(#{1,4}) (.+)$/.exec(line);
    if (heading) {
      if (offset > start) result.push({ start, end: offset, path });
      const level = heading[1].length;
      stack.length = level - 1;
      stack[level - 1] = heading[2].trim();
      path = stack.filter(Boolean);
      start = offset;
    }
    offset += line.length + 1;
  }
  if (text.length > start) result.push({ start, end: text.length, path });
  return result;
}

// Блоки длинного раздела: абзацы; таблицы делятся группами строк, и каждая группа повторяет шапку.
function blocks(text, start, end) {
  const out = [];
  const body = text.slice(start, end);
  const re = /\n{2,}/g;
  let from = 0, match;
  const parts = [];
  while ((match = re.exec(body))) { parts.push([from, match.index]); from = match.index + match[0].length; }
  parts.push([from, body.length]);
  for (const [a, b] of parts) {
    const piece = body.slice(a, b);
    if (piece.length <= MAX_CHUNK || !/^\|/.test(piece)) { out.push({ start: start + a, end: start + b }); continue; }
    const rows = piece.split('\n');
    const header = rows.slice(0, 2).join('\n') + '\n';
    let rowStart = a + header.length, size = 0, groupStart = rowStart;
    for (const row of rows.slice(2)) {
      if (size + row.length > MAX_CHUNK - header.length && size > 0) { out.push({ start: start + groupStart, end: start + rowStart - 1, prefix: header }); groupStart = rowStart; size = 0; }
      size += row.length + 1; rowStart += row.length + 1;
    }
    out.push({ start: start + groupStart, end: start + b, prefix: header });
  }
  return out.filter(x => x.end > x.start);
}

// Куски: короткие соседние разделы под одним заголовком верхнего уровня объединяются, длинные режутся по
// абзацам и группам строк таблиц. Ничего не теряется: куски покрывают весь текст по порядку.
export function chunkDocument(doc, raw) {
  const text = normalize(raw);
  const chunks = [];
  let current;
  const make = (start, end, path) => ({ id: `${doc}#${chunks.length}`, doc, path: path.join(' › '), h2: path.slice(0, 2).join(' › '), start, end });
  const flush = () => { if (current) chunks.push(make(current.start, current.end, current.path)); current = undefined; };
  for (const s of sections(text)) {
    const size = s.end - s.start;
    if (size > MAX_CHUNK) {
      flush();
      let group;
      for (const b of blocks(text, s.start, s.end)) {
        if (b.prefix) { if (group) { chunks.push(make(group.start, group.end, s.path)); group = undefined; } chunks.push({ ...make(b.start, b.end, s.path), table: true }); continue; }
        if (group && b.end - group.start > MAX_CHUNK) { chunks.push(make(group.start, group.end, s.path)); group = undefined; }
        group = group ? { start: group.start, end: b.end } : { start: b.start, end: b.end };
      }
      if (group) chunks.push(make(group.start, group.end, s.path));
      continue;
    }
    const sameTop = current && current.path[0] === s.path[0];
    if (current && sameTop && current.end - current.start < MIN_CHUNK && s.end - current.start <= MAX_CHUNK) { current.end = s.end; continue; }
    flush();
    current = { start: s.start, end: s.end, path: s.path };
  }
  flush();
  return mergeShort(chunks, doc);
}

// Отличие от портфолио: короткий кусок (меньше MIN_CHUNK), оставшийся после длинного раздела, присоединяется
// к соседнему, если вместе они не длиннее MAX_CHUNK. Так база укладывается в бесплатный объём Vectorize.
// Куски таблиц с повторённой шапкой не объединяются: их границы задают группы строк.
function mergeShort(chunks, doc) {
  const out = [];
  const table = c => c.table;
  for (const chunk of chunks) {
    const prev = out.at(-1);
    const short = c => c.end - c.start < MIN_CHUNK;
    if (prev && prev.end <= chunk.start && (short(chunk) || short(prev)) && chunk.end - prev.start <= MAX_CHUNK && !table(prev) && !table(chunk)) {
      prev.end = chunk.end;
      continue;
    }
    out.push({ ...chunk });
  }
  return out.map((c, i) => ({ ...c, id: `${doc}#${i}` }));
}

// Куски таблиц после первой группы строк снова получают шапку таблицы.
export function chunkText(text, chunk) {
  const body = text.slice(chunk.start, chunk.end);
  if (!body.startsWith('|')) return body;
  const before = text.lastIndexOf('\n\n', chunk.start - 1);
  const table = text.slice(before + 2, chunk.start);
  const header = table.startsWith('|') ? table.split('\n').slice(0, 2).join('\n') + '\n' : '';
  return header && !body.startsWith(header) ? header + body : body;
}

const STOP = new Set('и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между это также который которые которая которого которых the a an of to and or in on for is are be with by as at from that this it'
  .split(' '));
const ENDINGS = ['иями', 'ями', 'ами', 'иях', 'ость', 'ости', 'ению', 'ения', 'ение', 'ании', 'ание', 'ания', 'иться', 'ться', 'ировать', 'ировал', 'ового', 'ового', 'ыми', 'ими', 'ого', 'его', 'ому', 'ему', 'ыми', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ый', 'ий', 'ой', 'ую', 'юю', 'ах', 'ях', 'ам', 'ям', 'ов', 'ев', 'ом', 'ем', 'ей', 'ия', 'ие', 'ий', 'ию', 'ии', 'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'ь', 'й']
  .sort((a, b) => b.length - a.length);

function stem(word) {
  if (!/^[а-я]+$/.test(word)) return word.length > 4 && /^[a-z]+s$/.test(word) ? word.slice(0, -1) : word;
  for (const ending of ENDINGS) if (word.length - ending.length >= 3 && word.endsWith(ending)) return word.slice(0, -ending.length);
  return word;
}

// Технические обозначения (1с-битрикс, b2b, utm-метки) остаются целыми и дополнительно индексируются по частям.
export function terms(text) {
  const out = [];
  for (const match of text.toLowerCase().replace(/ё/g, 'е').matchAll(/[\p{L}\p{N}]+(?:[._\-/][\p{L}\p{N}]+)*/gu)) {
    const token = match[0];
    if (/[._\-/]/.test(token)) { out.push(token); for (const part of token.split(/[._\-/]/)) if (part.length > 1 && !STOP.has(part)) out.push(stem(part)); continue; }
    if (token.length < 2 || STOP.has(token)) continue;
    out.push(stem(token));
  }
  return out;
}

export function buildLexical(texts) {
  const postings = {};
  const lengths = texts.map((text, i) => {
    const counts = new Map();
    const list = terms(text);
    for (const t of list) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [t, n] of counts) (postings[t] ??= []).push(i, n);
    return list.length;
  });
  return { k1: 1.2, b: 0.75, avg: lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length), lengths, postings };
}

// Ранжирование BM25; `allowed` ограничивает выдачу номерами нужных кусков.
export function searchLexical(index, query, limit, allowed) {
  const scores = new Map();
  const n = index.lengths.length;
  for (const term of new Set(terms(query))) {
    const list = index.postings[term];
    if (!list) continue;
    const df = list.length / 2;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    for (let j = 0; j < list.length; j += 2) {
      const i = list[j], tf = list[j + 1];
      if (allowed && !allowed(i)) continue;
      const norm = tf * (index.k1 + 1) / (tf + index.k1 * (1 - index.b + index.b * index.lengths[i] / index.avg));
      scores.set(i, (scores.get(i) ?? 0) + idf * norm);
    }
  }
  return [...scores].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([i]) => i);
}

// Объединение ранжированных списков методом взаимного ранга (RRF).
export function fuse(lists, k = 60) {
  const scores = new Map();
  for (const list of lists) list.forEach((i, rank) => scores.set(i, (scores.get(i) ?? 0) + 1 / (k + rank + 1)));
  return [...scores].sort((a, b) => b[1] - a[1]).map(([i]) => i);
}
