import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildPrompt,
  buildSchema,
  checkAnswer,
  evaluateConversation,
  renderTranscript,
  EvaluationError,
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
  assert.equal(r.prompt_version, 'v0');
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

test('Gemini: 503 and 429 move to the next model, 400 stops at once', async () => {
  const realFetch = globalThis.fetch;
  const seen: string[] = [];
  const reply = (status: number) => new Response(
    status === 200 ? JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{}' }] } }] }) : '{"error":{}}',
    { status },
  );
  try {
    const plan: Record<string, number> = { a: 503, b: 429, c: 200 };
    globalThis.fetch = (async (url: string) => {
      const m = url.split('/models/')[1].split(':')[0];
      seen.push(m);
      return reply(plan[m]);
    }) as typeof fetch;
    const r = await geminiCall({ apiKey: 'k', model: 'a, b ,c', maxAttempts: 1 })({ system: 's', user: 'u', schema: {} });
    assert.equal(r.model, 'c');
    assert.deepEqual(seen, ['a', 'b', 'c']);

    plan.a = 400;
    seen.length = 0;
    await assert.rejects(geminiCall({ apiKey: 'k', model: 'a,c', maxAttempts: 1 })({ system: 's', user: 'u', schema: {} }), /a HTTP 400/);
    assert.deepEqual(seen, ['a']);

    plan.a = 503;
    plan.c = 503;
    await assert.rejects(geminiCall({ apiKey: 'k', model: 'a,c', maxAttempts: 1 })({ system: 's', user: 'u', schema: {} }), /a HTTP 503; c HTTP 503/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
