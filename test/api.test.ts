import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getChecklist,
  getDataset,
  listChecklists,
  saveChecklist,
  saveEvaluation,
  getEvaluation,
  saveAppeal,
  getAppeal,
} from '../server/store.js';
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
  const updated = saveChecklist({ ...base, title: 'Updated Title' });
  assert.equal(updated.version, base.version + 1);

  saveChecklist({ ...base, version: 1, title: 'Базовый чек-лист контроля качества' });
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
