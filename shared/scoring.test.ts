import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeScore, round2, ScoringError, validateAnswers, type Checklist, type CriterionAnswer } from './scoring.js';

const cl = JSON.parse(readFileSync(new URL('./scoring.fixture.json', import.meta.url), 'utf8')) as Checklist;
const base: CriterionAnswer[] = [
  { criterion_id: '01', answer: 'yes' }, { criterion_id: '02', answer: 'yes' }, { criterion_id: '03', answer: 'yes' },
  { criterion_id: '04', step: 20 }, { criterion_id: '05', answer: 'yes' }, { criterion_id: '06', step: 10 },
  { criterion_id: '07', answer: 'yes' }, { criterion_id: '08', answer: 'no' },
];
const with_ = (o: Record<string, Partial<CriterionAnswer>>) => base.map((a) => ({ ...a, ...(o[a.criterion_id] ?? {}) }));

test('всё идеально = 100', () => assert.equal(computeScore(cl, base).total, 100));
test('всё «Нет» и нулевые ступени = 0', () => {
  const a = with_({ '01': { answer: 'no' }, '02': { answer: 'no' }, '03': { answer: 'no' }, '04': { step: 0 }, '05': { answer: 'no' }, '06': { step: 0 }, '07': { answer: 'no' } });
  assert.equal(computeScore(cl, a).total, 0);
});
test('шкалы: 04=15 даёт 15 из 20, 06=7 даёт 10.5 из 15', () => {
  const r = computeScore(cl, with_({ '04': { step: 15 }, '06': { step: 7 } }));
  assert.equal(r.items.find((i) => i.criterion_id === '04')!.raw_points, 15);
  assert.equal(r.items.find((i) => i.criterion_id === '06')!.raw_points, 10.5);
  assert.equal(r.total, 90.5);
});
test('N/A 03 и 07: вес 75, набранное ×100/75', () => {
  // 01 нет (0), остальное идеально: набрано 65 из 75 = 86.67
  const r = computeScore(cl, with_({ '01': { answer: 'no' }, '03': { answer: 'na' }, '07': { answer: 'na' } }));
  assert.equal(r.total, 86.67);
  assert.equal(r.items.find((i) => i.criterion_id === '03')!.applicable, false);
  assert.equal(r.items.find((i) => i.criterion_id === '02')!.effective_weight, 20);
});
test('N/A у шкального критерия 04', () => {
  const r = computeScore(cl, with_({ '04': { answer: 'na', step: null } }));
  assert.equal(r.total, 100);
});
test('сверка от ТЛ: 03 = N/A, применимый вес 80, 26 баллов дают 32.50', () => {
  const r = computeScore(cl, with_({ '02': { answer: 'no' }, '03': { answer: 'na' }, '04': { step: 10 }, '05': { answer: 'no' }, '06': { step: 4 }, '07': { answer: 'no' } }));
  assert.equal(r.items.reduce((s, i) => s + i.raw_points, 0), 26);
  assert.equal(r.items.filter((i) => i.applicable).reduce((s, i) => s + i.weight, 0), 80);
  assert.equal(r.total, 32.5);
});
test('модель отдаёт число прямо в answer (шкала) — работает без step', () => {
  const r = computeScore(cl, base.map((a) => (a.criterion_id === '04' ? { criterion_id: '04', answer: 15 } : a.criterion_id === '06' ? { criterion_id: '06', answer: '7' } : a)));
  assert.equal(r.total, 90.5);
});
test('после перераспределения «баллы из effective_weight» (у 04 было бы 25 при весе 20)', () => {
  const r = computeScore(cl, with_({ '03': { answer: 'na' }, '07': { answer: 'na' } }));
  const i04 = r.items.find((i) => i.criterion_id === '04')!;
  assert.equal(i04.points, 26.67);
  assert.equal(i04.effective_weight, 26.67);
  assert.equal(i04.weight, 20);
  assert.equal(i04.max_points, i04.effective_weight); // старое имя пока живо для server/index.ts
});
test('нет применимых критериев → null', () => {
  const small: Checklist = { id: 'x', version: 1, criteria: [{ id: 'a', title: 'a', type: 'binary', weight: 10, na_allowed: true }] };
  assert.equal(computeScore(small, [{ criterion_id: 'a', answer: 'na' }]).total, null);
});
test('критерии с весом 0 не применимы', () => {
  const c: Checklist = { id: 'x', version: 1, criteria: [{ id: 'a', title: 'a', type: 'binary', weight: 0, na_allowed: false }] };
  assert.equal(computeScore(c, [{ criterion_id: 'a', answer: 'yes' }]).total, null);
});
test('грубая ошибка: флаг, итог не меняется', () => {
  const r = computeScore(cl, with_({ '08': { answer: 'yes' } }));
  assert.equal(r.gross, true);
  assert.equal(r.total, 100);
  assert.equal(computeScore(cl, base).gross, false);
});
test('округление до двух знаков, половина вверх', () => {
  assert.equal(round2(12.345), 12.35);
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(86.666666), 86.67);
});
test('секции: процент внутри секции, null если все N/A', () => {
  const r = computeScore(cl, with_({ '01': { answer: 'no' } }));
  assert.equal(r.sections.find((s) => s.id === 'start')!.score, 60); // 15 из 25
  const r2 = computeScore(cl, with_({ '03': { answer: 'na' }, '04': { answer: 'na', step: null } }));
  assert.equal(r2.sections.find((s) => s.id === 'security')!.score, null);
  assert.equal(r.sections.some((s) => s.id === 'gross'), false);
});
test('новый критерий и другой вес работают без правки кода', () => {
  const c2: Checklist = { ...cl, criteria: [...cl.criteria, { id: '09', title: 'Новый', type: 'binary', weight: 25, na_allowed: false, section: 'dialog' }] };
  const r = computeScore(c2, [...base, { criterion_id: '09', answer: 'no' }]);
  assert.equal(r.total, 80); // 100 из 125
});
test('валидация: N/A не разрешён, ступень вне шкалы, пропуск, лишний id', () => {
  const p = validateAnswers(cl, [...with_({ '01': { answer: 'na' }, '04': { step: 12 } }).filter((a) => a.criterion_id !== '07'), { criterion_id: '99', answer: 'yes' }]);
  assert.ok(p.some((s) => s.includes('01') && s.includes('N/A')));
  assert.ok(p.some((s) => s.includes('04') && s.includes('ступень')));
  assert.ok(p.some((s) => s.includes('07') && s.includes('нет ответа')));
  assert.ok(p.some((s) => s.includes('99')));
  assert.throws(() => computeScore(cl, [{ criterion_id: '01', answer: 'yes' }]), ScoringError);
});

test('секции-строки (как в data/checklists/default.json у ТЛ) и max_step', () => {
  const tl: Checklist = {
    id: 'default', version: 7, sections: ['Начало', 'Конец', 'Грубые'],
    criteria: [
      { id: '01', section: 'Начало', title: 'a', type: 'binary', weight: 10, na_allowed: false },
      { id: '04', section: 'Начало', title: 'b', type: 'scale', steps: [0, 5, 10, 15, 20], max_step: 20, weight: 20, na_allowed: true },
      { id: '07', section: 'Конец', title: 'c', type: 'binary', weight: 5, na_allowed: true },
      { id: '08', section: 'Грубые', title: 'd', type: 'binary', weight: 0, na_allowed: false, is_gross: true },
    ],
  };
  const r = computeScore(tl, [{ criterion_id: '01', answer: 'yes' }, { criterion_id: '04', answer: 10 }, { criterion_id: '07', answer: 'na' }, { criterion_id: '08', answer: 'yes' }]);
  assert.equal(r.total, 66.67);
  assert.deepEqual(r.sections.map((x) => [x.id, x.score]), [['Начало', 66.67], ['Конец', null]]);
  assert.equal(r.gross, true);
});
