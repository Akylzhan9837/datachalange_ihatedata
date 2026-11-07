import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { EvalChecklist, EvaluationDraft } from '../server/evaluate.js';
import { criterionCodes, errorEntry, okEntry, resultsProblems, type ResultsFile } from '../server/results.js';
import type { Conversation } from '../shared/types.js';

const cl: EvalChecklist = JSON.parse(fs.readFileSync(path.resolve('data/checklists/cqa-full.json'), 'utf-8'));

const conv: Conversation = {
  conversation_id: 'c-1',
  channel: 'agent chat',
  language: 'RU',
  audio_url: null,
  transcript: [
    { timestamp: '00:00', speaker: 'client', text: 'Где тариф?' },
    { timestamp: '00:05', speaker: 'system', text: 'Эскалация.' },
    { timestamp: '00:40', speaker: 'operator', text: 'Здравствуйте, я Анна. Тариф — в «Кабинете».' },
    { timestamp: '00:50', speaker: 'client', text: 'Спасибо.' },
    { timestamp: '00:55', speaker: 'operator', text: 'Хорошего дня!' },
  ],
};

const item = (criterion_id: string, answer: 'yes' | 'no' | 'na' | number, evidence: number[], checked_range: [number, number] | null = null) => ({
  criterion_id, analysis: 'a', answer, evidence, checked_range, reason: `${criterion_id} — обоснование.`, na_reason: answer === 'na' ? 'условие' : null, needs_review: false, review_reason: null,
});

const draft: EvaluationDraft = {
  conversation_id: 'c-1', checklist_id: cl.id, checklist_version: cl.version, prompt_version: 'v1', model: 'gemini-3.6-flash', votes: 1,
  usage: { calls: 1, input_tokens: 1, output_tokens: 1 }, cost_usd: 0, duration_ms: 1, created_at: '2026-11-08T00:00:00Z',
  items: [
    item('01', 'yes', [3]), item('02', 'na', [1]), item('03', 'na', []), item('04', 15, [3]),
    item('05', 'yes', [3]), item('06', 7, [3, 5]), item('07', 'yes', [5]), item('08', 'no', [], [1, 5]),
  ],
};

const fileOf = (results: ResultsFile['results']): ResultsFile => ({
  schema_version: '1.0', team_name: 'Команда', model: { mode: 'external_api', name: 'gemini-3.6-flash' }, results,
});

test('ok entry: codes, true/false/null/number, rationale, evidence and critical flag', () => {
  const e = okEntry(conv, cl, draft, 92.31);
  assert.deepEqual(e.criteria.map((c) => c.criterion_id), ['contact', 'discovery', 'identification', 'consultation', 'empathy', 'dialogue', 'closure', 'critical']);
  assert.deepEqual(e.criteria.map((c) => c.value), [true, null, null, 15, true, 7, true, false]);
  assert.equal(e.criteria[0].rationale, '01 — обоснование.');
  assert.deepEqual(e.criteria[7].evidence_turns, [3, 5], '«Нет» без доказательства → реплики оператора из checked_range');
  assert.deepEqual(e.score, { final_score: 92.31, critical_flag: false });
  assert.deepEqual(resultsProblems(fileOf([e]), ['c-1']), []);
});

test('a criterion replaced through the UI keeps the code of its position', () => {
  const replaced: EvalChecklist = { ...cl, criteria: cl.criteria.map((k) => (k.id === '07' ? { ...k, id: '09', title: 'Предложение помощи' } : k)) };
  assert.equal(criterionCodes(replaced)[6], 'closure');
  assert.equal(criterionCodes({ ...replaced, criteria: replaced.criteria.map((k) => (k.id === '09' ? { ...k, code: 'closure' } : k)) })[6], 'closure');
});

test('format check catches what the organizers reject', () => {
  const ok = okEntry(conv, cl, draft, 92.31);
  assert.match(resultsProblems(fileOf([ok, ok]), ['c-1']).join(), /повторяются ID: c-1/);
  assert.match(resultsProblems(fileOf([ok]), ['c-1', 'c-2']).join(), /нет записей: c-2/);
  const bad = { ...ok, criteria: ok.criteria.map((c) => (c.criterion_id === 'dialogue' ? { ...c, value: 5 } : c)) };
  assert.match(resultsProblems(fileOf([bad]), ['c-1']).join(), /dialogue — недопустимое значение 5/);
  const flag = { ...ok, score: { final_score: 92.31, critical_flag: true } };
  assert.match(resultsProblems(fileOf([flag]), ['c-1']).join(), /critical_flag не совпадает/);
  const precise = { ...ok, score: { final_score: 92.314, critical_flag: false } };
  assert.match(resultsProblems(fileOf([precise]), ['c-1']).join(), /двумя знаками/);
  const short = { ...ok, criteria: ok.criteria.slice(1) };
  assert.match(resultsProblems(fileOf([short]), ['c-1']).join(), /все 8 критериев/);
  assert.match(resultsProblems({ ...fileOf([ok]), team_name: ' ' }, ['c-1']).join(), /team_name/);
});

test('error entry keeps the ID, empty criteria, null score and the reason', () => {
  const e = errorEntry('c-2', 'Gemini unavailable');
  assert.deepEqual(e, { conversation_id: 'c-2', status: 'error', criteria: [], score: null, error: 'Gemini unavailable' });
  assert.deepEqual(resultsProblems(fileOf([okEntry(conv, cl, draft, 92.31), e]), ['c-1', 'c-2']), []);
  assert.match(resultsProblems(fileOf([{ ...e, error: '' }]), ['c-2']).join(), /текст error/);
});
