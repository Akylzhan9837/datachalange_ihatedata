import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildPrompt,
  buildSchema,
  checkAnswer,
  checklistProblems,
  evaluateConversation,
  renderTranscript,
  EvaluationError,
  PROMPT_VERSION,
  type EvalChecklist,
} from '../server/evaluate.js';
import { geminiCall, parseResponse, type LlmCall, type LlmRequest } from '../server/llm.js';
import type { Conversation } from '../shared/types.js';

const cl: EvalChecklist = JSON.parse(fs.readFileSync(path.resolve('data/checklists/cqa-full.json'), 'utf-8'));

const chat: Conversation = {
  conversation_id: 't-chat',
  channel: 'agent chat',
  language: 'RU',
  audio_url: null,
  transcript: [
    { timestamp: '00:00', speaker: 'client', text: 'Где посмотреть тариф?' },
    { timestamp: '00:05', speaker: 'system', text: 'Эскалация на оператора.' },
    { timestamp: '00:40', speaker: 'operator', text: 'Здравствуйте, меня зовут Анна. Тариф — во вкладке «Кабинет».' },
    { timestamp: '00:50', speaker: 'client', text: 'Нашла, спасибо.' },
    { timestamp: '00:55', speaker: 'operator', text: 'Рада помочь. Хорошего дня!' },
  ],
};

const call: Conversation = {
  conversation_id: 't-call',
  channel: 'voice call',
  language: 'RU',
  audio_url: 'https://example.environment.api.powerplatform.com/x',
  transcript: [
    { timestamp: '2026-11-03T15:49:13.1900670+00:00', speaker: 'system', text: 'Запись запущена.' },
    { timestamp: '2026-11-03T15:50:21.0000000+00:00', speaker: 'operator', text: 'Здравствуйте,\nменя зовут [Имя скрыто].' },
  ],
};

const good = {
  items: [
    { criterion_id: '01', analysis: 'a', answer: 'yes', evidence: [3], reason: 'Контакт — Да.' },
    { criterion_id: '02', analysis: 'a', answer: 'na', evidence: [1], reason: 'N/A.', na_reason: 'Данных хватало с начала.' },
    { criterion_id: '03', analysis: 'a', answer: 'na', evidence: [], reason: 'N/A.', na_reason: 'Общий вопрос.' },
    { criterion_id: '04', analysis: 'a', answer: '20', evidence: [3, 4], reason: 'Консультация — 20.' },
    { criterion_id: '05', analysis: 'a', answer: 'yes', evidence: [3], reason: 'Вежлив.' },
    { criterion_id: '06', analysis: 'a', answer: '10', evidence: [3], reason: 'Ясно.' },
    { criterion_id: '07', analysis: 'a', answer: 'yes', evidence: [5], reason: 'Попрощался.' },
    { criterion_id: '08', analysis: 'a', answer: 'no', evidence: [], checked_range: [3, 5], reason: 'Нарушений нет.' },
  ],
};

const fake = (...answers: object[]): LlmCall & { calls: LlmRequest[] } => {
  const calls: LlmRequest[] = [];
  const fn = (async (req: LlmRequest) => {
    calls.push(req);
    const next = answers[Math.min(calls.length - 1, answers.length - 1)];
    return { text: JSON.stringify(next), model: 'fake', usage: { input_tokens: 100, output_tokens: 50 } };
  }) as LlmCall & { calls: LlmRequest[] };
  fn.calls = calls;
  return fn;
};

test('prompt is built from the checklist, not from code', () => {
  const p = buildPrompt(cl, chat);
  for (const k of cl.criteria) assert.ok(p.system.includes(`КРИТЕРИЙ ${k.id}. ${k.title}`));
  assert.ok(p.system.includes('Приветствие бота не засчитывается'), 'guidance is rendered');
  assert.ok(p.system.includes('20 — Все существенные вопросы закрыты'), 'scale steps are rendered');
  assert.ok(p.system.includes('N/A для этого критерия запрещён'));
  assert.ok(p.user.includes('[#3 ОПЕРАТОР 00:40] Здравствуйте, меня зовут Анна.'));
});

test('replacing a criterion changes prompt and schema with no code change', () => {
  const replaced: EvalChecklist = {
    ...cl,
    version: cl.version + 1,
    criteria: cl.criteria.map((k) =>
      k.id === '07'
        ? { id: '09', section: k.section, title: 'Предложение помощи', description: 'Да — спросил, остались ли вопросы.', type: 'binary', weight: 5, na_allowed: false, is_gross: false }
        : k),
  };
  const p = buildPrompt(replaced, chat);
  assert.ok(p.system.includes('КРИТЕРИЙ 09. Предложение помощи'));
  assert.ok(!p.system.includes('КРИТЕРИЙ 07.'));
  const ids = (buildSchema(replaced) as any).properties.items.items.properties.criterion_id.enum;
  assert.deepEqual(ids, ['01', '02', '03', '04', '05', '06', '09', '08']);
});

test('call timestamps become offsets, newlines are flattened', () => {
  const t = renderTranscript(call);
  assert.ok(t.includes('[#1 СИСТЕМА 00:00] Запись запущена.'));
  assert.ok(t.includes('[#2 ОПЕРАТОР 01:07] Здравствуйте, меня зовут [Имя скрыто].'));
});

test('valid answer → items with numeric steps, one call', async () => {
  const llm = fake(good);
  const r = await evaluateConversation(chat, cl, llm);
  assert.equal(r.usage.calls, 1);
  assert.equal(r.items.length, 8);
  assert.equal(r.items.find((i) => i.criterion_id === '04')!.answer, 20);
  assert.equal(r.items.find((i) => i.criterion_id === '06')!.answer, 10);
  assert.equal(r.items.every((i) => !i.needs_review), true);
  assert.equal(r.checklist_version, cl.version);
  assert.equal(r.prompt_version, PROMPT_VERSION);
  assert.equal(r.votes, 1);
});

test('forbidden N/A → retry with the error text → success', async () => {
  const bad = { items: good.items.map((i) => (i.criterion_id === '01' ? { ...i, answer: 'na' } : i)) };
  const llm = fake(bad, good);
  const r = await evaluateConversation(chat, cl, llm);
  assert.equal(r.usage.calls, 2);
  assert.equal(r.usage.input_tokens, 200);
  assert.ok(llm.calls[1].user.includes('критерий 01: N/A запрещён'));
});

test('still invalid after retry → EvaluationError, no silent substitution', async () => {
  const bad = { items: good.items.map((i) => (i.criterion_id === '04' ? { ...i, answer: '12' } : i)) };
  await assert.rejects(evaluateConversation(chat, cl, fake(bad)), EvaluationError);
  await assert.rejects(evaluateConversation(chat, cl, fake({ items: good.items.slice(1) })), /критерий 01/);
});

test('soft problems → needs_review, answer kept', () => {
  const soft = { items: good.items.map((i) => (i.criterion_id === '05' ? { ...i, evidence: [99] } : i.criterion_id === '02' ? { ...i, na_reason: '' } : i)) };
  const { items, hard } = checkAnswer(cl, chat, JSON.stringify(soft));
  assert.deepEqual(hard, []);
  assert.match(items.find((i) => i.criterion_id === '05')!.review_reason!, /вне диапазона 1–5/);
  assert.equal(items.find((i) => i.criterion_id === '02')!.needs_review, true);
  assert.equal(items.find((i) => i.criterion_id === '01')!.needs_review, false);
});

test('broken JSON is a hard error', () => {
  assert.deepEqual(checkAnswer(cl, chat, 'not json').hard, ['ответ не является JSON']);
});

test('Gemini response parsing: text without thoughts, usage, block reasons', () => {
  const r = parseResponse({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'thinking…', thought: true }, { text: '{"items":' }, { text: '[]}' }] } }],
    usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 300, thoughtsTokenCount: 200 },
    modelVersion: 'gemini-x',
  }, 'fallback');
  assert.equal(r.text, '{"items":[]}');
  assert.deepEqual(r.usage, { input_tokens: 1000, output_tokens: 500 });
  assert.equal(r.model, 'gemini-x');
  assert.throws(() => parseResponse({ promptFeedback: { blockReason: 'SAFETY' } }, 'm'), /SAFETY/);
  assert.throws(() => parseResponse({ candidates: [{ finishReason: 'MAX_TOKENS' }] }, 'm'), /MAX_TOKENS/);
});

const req: LlmRequest = { system: 's', user: 'u', schema: {} };
const ok = () => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{}' }] } }] }), { status: 200 });
const fail = (status: number, retryDelay?: string) => new Response(
  JSON.stringify({ error: { code: status, details: retryDelay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] : [] } }),
  { status },
);

function mockFetch(handler: (model: string, key: string) => Response) {
  const realFetch = globalThis.fetch;
  const calls: { model: string; url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const model = url.split('/models/')[1].split(':')[0];
    calls.push({ model, url, init });
    return handler(model, (init.headers as Record<string, string>)['x-goog-api-key']);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

test('Gemini: key only in a header; temperature and thinking set per model generation', async () => {
  const m = mockFetch(() => ok());
  try {
    await geminiCall({ apiKey: 'SECRET', model: 'gemini-3.5-flash', thinkingLevel: 'high' })(req);
    await geminiCall({ apiKey: 'SECRET', model: 'gemini-2.5-flash', thinkingLevel: 'high' })(req);
  } finally {
    m.restore();
  }
  for (const c of m.calls) {
    assert.ok(!c.url.includes('SECRET'));
    assert.equal((c.init.headers as Record<string, string>)['x-goog-api-key'], 'SECRET');
  }
  const [g3, g2] = m.calls.map((c) => JSON.parse(String(c.init.body)).generationConfig);
  assert.equal(g3.temperature, undefined);
  assert.deepEqual(g3.thinkingConfig, { thinkingLevel: 'high' });
  assert.equal(g2.temperature, 0);
  assert.equal(g2.thinkingConfig, undefined);
});

test('Gemini: 503, 429 and network errors move to the next model, 400 stops at once', async () => {
  const plan: Record<string, () => Response> = { a: () => fail(503), b: () => fail(429, '80413s'), c: () => ok() };
  const m = mockFetch((model) => plan[model]());
  try {
    const r = await geminiCall({ apiKey: 'k', model: 'a, b ,c', maxAttempts: 1 })(req);
    assert.equal(r.model, 'c');
    assert.deepEqual(m.calls.map((c) => c.model), ['a', 'b', 'c']);

    m.calls.length = 0;
    plan.a = () => fail(400);
    await assert.rejects(geminiCall({ apiKey: 'k', model: 'a,c', maxAttempts: 1 })(req), /a HTTP 400/);
    assert.deepEqual(m.calls.map((c) => c.model), ['a']);

    plan.a = () => { throw new TypeError('fetch failed'); };
    plan.c = () => fail(503);
    await assert.rejects(geminiCall({ apiKey: 'k', model: 'a,c', maxAttempts: 1 })(req), /a network: fetch failed; c HTTP 503/);
  } finally {
    m.restore();
  }
});

test('Gemini 429: short retryDelay → same model again, daily limit → next model at once', async () => {
  let first = true;
  const plan: Record<string, () => Response> = {
    a: () => (first ? ((first = false), fail(429, '0s')) : ok()),
    b: () => ok(),
  };
  const m = mockFetch((model) => plan[model]());
  try {
    await geminiCall({ apiKey: 'k', model: 'a,b', maxAttempts: 3 })(req);
    assert.deepEqual(m.calls.map((c) => c.model), ['a', 'a']);

    m.calls.length = 0;
    plan.a = () => fail(429, '80413s');
    await geminiCall({ apiKey: 'k', model: 'a,b', maxAttempts: 3 })(req);
    assert.deepEqual(m.calls.map((c) => c.model), ['a', 'b']);
  } finally {
    m.restore();
  }
});

test('several keys: best model on every key first, spent or invalid keys are skipped', async () => {
  const seen: string[] = [];
  const m = mockFetch((model, key) => {
    seen.push(`${model}/${key}`);
    if (key === 'k1') return fail(429, '80413s');
    if (key === 'bad') return fail(403);
    return model === 'a' && key === 'k3' ? ok() : fail(503);
  });
  try {
    const llm = geminiCall({ apiKey: 'k1, bad ,k3', model: 'a,b', maxAttempts: 1 });
    await llm(req);
    assert.deepEqual(seen, ['a/k1', 'a/bad', 'a/k3']);
    seen.length = 0;
    await llm(req);
    assert.deepEqual(seen, ['a/k3'], 'исчерпанный и неверный ключи больше не дёргаются');
    const r = await geminiCall({ apiKey: 'k1,k2', model: 'a', maxAttempts: 1 })(req).catch((e: Error) => e.message);
    assert.match(String(r), /a key#1 HTTP 429; a key#2 HTTP 503/);
    assert.doesNotMatch(String(r), /k1|k2/);
  } finally {
    m.restore();
  }
});

test('broken checklist fails before any model call', async () => {
  assert.deepEqual(checklistProblems(cl), []);
  const llm = fake(good);
  const dup: EvalChecklist = { ...cl, criteria: [...cl.criteria, cl.criteria[0]] };
  await assert.rejects(evaluateConversation(chat, dup, llm), /01: id повторяется/);
  const noSteps: EvalChecklist = { ...cl, criteria: cl.criteria.map((k) => (k.id === '04' ? { ...k, steps: undefined } : k)) };
  await assert.rejects(evaluateConversation(chat, noSteps, llm), /04: у шкалы/);
  await assert.rejects(evaluateConversation(chat, { ...cl, criteria: [] }, llm), /нет критериев/);
  assert.equal(llm.calls.length, 0);
});

test('binary criteria never add scale steps to the answer enum', () => {
  const odd: EvalChecklist = { ...cl, criteria: cl.criteria.map((k) => (k.id === '01' ? { ...k, steps: [1, 2] } : k)) };
  const answers: string[] = (buildSchema(odd) as any).properties.items.items.properties.answer.enum;
  assert.ok(!answers.includes('1') && !answers.includes('2'));
});

test('answer wrapped in a ```json fence is accepted, evidence is cleaned', () => {
  const messy = { items: good.items.map((i) => (i.criterion_id === '04' ? { ...i, evidence: [4, 3, 3, 99] } : i)) };
  const { items, hard } = checkAnswer(cl, chat, '```json\n' + JSON.stringify(messy) + '\n```');
  assert.deepEqual(hard, []);
  const k04 = items.find((i) => i.criterion_id === '04')!;
  assert.deepEqual(k04.evidence, [3, 4]);
  assert.match(k04.review_reason!, /вне диапазона 1–5: 99/);
});

test('votes: majority wins, disagreement is flagged, scale tie takes the median', async () => {
  const flip = (id: string, answer: string) => ({ items: good.items.map((i) => (i.criterion_id === id ? { ...i, answer } : i)) });
  const r = await evaluateConversation(chat, cl, fake(good, flip('05', 'no'), good), 3);
  assert.equal(r.votes, 3);
  assert.equal(r.usage.calls, 3);
  const k05 = r.items.find((i) => i.criterion_id === '05')!;
  assert.equal(k05.answer, 'yes');
  assert.equal(k05.needs_review, true);
  assert.match(k05.review_reason!, /прогоны разошлись: yes×2, no×1/);
  assert.equal(r.items.find((i) => i.criterion_id === '01')!.needs_review, false);

  const s = await evaluateConversation(chat, cl, fake(flip('04', '5'), flip('04', '20'), flip('04', '10')), 3);
  assert.equal(s.items.find((i) => i.criterion_id === '04')!.answer, 10);
});
