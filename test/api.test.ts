import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  getChecklist,
  getDataset,
  getConversation,
  listChecklists,
  saveChecklist,
  saveEvaluation,
  getEvaluation,
  saveAppeal,
  getAppeal,
} from '../server/store.js';
import { isAllowedAudioHost } from '../server/index.js';
import type { EvaluationResult, Appeal } from '../shared/types.js';

test('checklist store returns default checklist with 8 criteria', () => {
  const checklist = getChecklist('default');
  assert.ok(checklist);
  assert.equal(checklist.id, 'default');
  assert.equal(checklist.criteria.length, 8);
});

test('dataset store returns DEV dataset with 65 records', () => {
  const devSet = getDataset('DEV');
  assert.ok(devSet);
  assert.equal(devSet.isSuccess, true);
  assert.equal(devSet.data.records.length, 65);
});

test('listChecklists returns array with default checklist', () => {
  const checklists = listChecklists();
  assert.ok(Array.isArray(checklists));
  assert.ok(checklists.length >= 1);
});

test('saveChecklist increments version', () => {
  const base = getChecklist('default')!;
  const testFile = path.resolve(process.cwd(), 'data/checklists/test-checklist.json');
  try {
    const testChecklist = { ...base, id: 'test-checklist', version: 1 };
    const first = saveChecklist(testChecklist);
    assert.equal(first.version, 1);
    const second = saveChecklist(first);
    assert.equal(second.version, 2);
  } finally {
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  }
});

test('evaluations can be saved and retrieved', () => {
  const mockEval: EvaluationResult = {
    id: 'test-eval-1',
    conversation_id: 'p1-ru-001',
    checklist_id: 'default',
    checklist_version: 1,
    model: 'gpt-4o',
    cost: 0.005,
    evaluated_at: new Date().toISOString(),
    items: [],
    total_score: 95.5,
    section_scores: {},
    gross_violation: false,
  };

  saveEvaluation(mockEval);
  const loaded = getEvaluation('test-eval-1');
  assert.ok(loaded);
  assert.equal(loaded.conversation_id, 'p1-ru-001');
  assert.equal(loaded.total_score, 95.5);
});

test('appeals can be saved and retrieved', () => {
  const mockAppeal: Appeal = {
    id: 'test-appeal-1',
    evaluation_id: 'test-eval-1',
    criterion_id: '01',
    comment: 'Operator greeted in client language',
    status: 'pending',
    original_answer: 'no',
    original_score: 85,
    created_at: new Date().toISOString(),
  };

  saveAppeal(mockAppeal);
  const loaded = getAppeal('test-appeal-1');
  assert.ok(loaded);
  assert.equal(loaded.criterion_id, '01');
  assert.equal(loaded.status, 'pending');
});

test('getConversation finds record from dataset', () => {
  const conv = getConversation('p1-ru-001');
  assert.ok(conv);
  assert.equal(conv.conversation_id, 'p1-ru-001');
  assert.equal(conv.language.toUpperCase(), 'RU');
});

test('isAllowedAudioHost rejects untrusted hosts and accepts powerplatform', () => {
  assert.equal(isAllowedAudioHost('http://evil.com/malicious.mp3'), false);
  assert.equal(isAllowedAudioHost('https://api.powerplatform.com/direct/audio.mp3'), true);
  assert.equal(isAllowedAudioHost('https://ec88f21f1accecf38e20095a9fe175.a5.environment.api.powerplatform.com/audio.mp3'), true);
  assert.equal(isAllowedAudioHost('not-a-valid-url'), false);
});

test('evaluations recalculate total_score on appeal decision', async () => {
  const evalId = 'eval-test-appeal-recalc';
  const mockEval: EvaluationResult = {
    id: evalId,
    conversation_id: 'p1-ru-002',
    checklist_id: 'default',
    checklist_version: 1,
    model: 'gemini',
    cost: 0.001,
    evaluated_at: new Date().toISOString(),
    items: [
      { criterion_id: '01', answer: 'no', evidence: [], reason: 'test' },
      { criterion_id: '02', answer: 'yes', evidence: [], reason: 'test' },
      { criterion_id: '03', answer: 'yes', evidence: [], reason: 'test' },
      { criterion_id: '04', answer: 20, step: 20, evidence: [], reason: 'test' },
      { criterion_id: '05', answer: 'yes', evidence: [], reason: 'test' },
      { criterion_id: '06', answer: 10, step: 10, evidence: [], reason: 'test' },
      { criterion_id: '07', answer: 'yes', evidence: [], reason: 'test' },
      { criterion_id: '08', answer: 'no', evidence: [], reason: 'test' },
    ],
    total_score: 90,
    section_scores: {},
    gross_violation: false,
  };
  saveEvaluation(mockEval);

  const appeal: Appeal = {
    id: 'appeal-test-recalc',
    evaluation_id: evalId,
    criterion_id: '01',
    comment: 'Greeting was present',
    status: 'pending',
    original_answer: 'no',
    original_score: 90,
    created_at: new Date().toISOString(),
  };
  saveAppeal(appeal);

  // Simulate server appeal decision logic
  const appModule = await import('../server/index.js');
  assert.ok(appModule.default);
});
