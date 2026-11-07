import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { analyzeTranscript, crossCheck, type Utterance } from './rules.ts';

const u = (speaker: Utterance['speaker'], text: string): Utterance => ({ timestamp: '00:00', speaker, text });

test('приветствие бота не засчитывается: первая реплика оператора', () => {
  const h = analyzeTranscript([u('bot', 'Здравствуйте! Я AIM'), u('system', 'Эскалация на оператора.'), u('operator', 'Откройте меню.')], 'RU');
  assert.equal(h.firstOperatorIndex, 2);
  assert.equal(h.greeting.found, false);
});
test('RU/KZ/EN: приветствие и имя', () => {
  assert.deepEqual(
    [['Здравствуйте, меня зовут Дина.', 'RU'], ['Сәлеметсіз бе, мен Айбекпін.', 'KZ'], ['Hi, I’m Maya from support.', 'EN']].map(([t, l]) => {
      const h = analyzeTranscript([u('operator', t)], l);
      return [h.greeting.lang, h.introduction];
    }),
    [['RU', true], ['KZ', true], ['EN', true]],
  );
});
test('«Привет, где ищете?» — приветствие без имени', () => {
  const h = analyzeTranscript([u('operator', 'Привет, где именно ищете?')], 'RU');
  assert.equal(h.greeting.found, true);
  assert.equal(h.introduction, false);
});
test('«Сәлем.» без имени и «Я не могу» — не представление', () => {
  assert.equal(analyzeTranscript([u('operator', 'Сәлем. Қай сайтқа кірдіңіз?')], 'KZ').introduction, false);
  assert.equal(analyzeTranscript([u('operator', 'Здравствуйте. Я не могу назвать комиссию.')], 'RU').introduction, false);
});
test('прощание RU/KZ/EN и его отсутствие', () => {
  for (const t of ['До свидания!', 'Сау болыңыз!', 'Have a good day!', 'Хорошего вечера!', 'Take care!']) {
    assert.equal(analyzeTranscript([u('client', 'ok'), u('operator', t)]).farewell.found, true, t);
  }
  assert.equal(analyzeTranscript([u('operator', 'Тогда не знаю.')]).farewell.found, false);
  assert.equal(analyzeTranscript([u('operator', 'Спасибо за обращение.')]).farewell.found, false);
});
test('закрытие чата: три вида', () => {
  const k = (t: string) => analyzeTranscript([u('operator', 'x'), u('system', t)]).closing.kind;
  assert.equal(k('Оператор закрыл чат.'), 'operator_closed');
  assert.equal(k('Клиент покинул чат.'), 'client_left');
  assert.equal(k('Connection to customer lost.'), 'connection_lost');
  assert.equal(k('Эскалация на оператора.'), null);
});
test('crossCheck 01: «Да» без приветствия, язык не тот', () => {
  const noGreet = analyzeTranscript([u('operator', 'Откройте меню.')], 'RU');
  assert.equal(crossCheck(noGreet, [{ criterion_id: '01', answer: 'yes' }]).length, 1);
  const wrongLang = analyzeTranscript([u('operator', 'Здравствуйте, я Тимур.')], 'KZ');
  assert.match(crossCheck(wrongLang, [{ criterion_id: '01', answer: 'yes' }])[0].message, /клиент пишет на KZ/);
  const good = analyzeTranscript([u('operator', 'Здравствуйте, я Тимур.')], 'RU');
  assert.equal(crossCheck(good, [{ criterion_id: '01', answer: 'yes' }]).length, 0);
  assert.equal(crossCheck(good, [{ criterion_id: '01', answer: 'no' }]).length, 1);
});
test('crossCheck 07 и 03', () => {
  const closed = analyzeTranscript([u('operator', 'Тогда не знаю.'), u('system', 'Оператор закрыл чат.')]);
  assert.equal(crossCheck(closed, [{ criterion_id: '07', answer: 'no' }]).length, 0);
  assert.equal(crossCheck(closed, [{ criterion_id: '07', answer: 'na' }]).length, 1);
  assert.equal(crossCheck(closed, [{ criterion_id: '07', answer: 'yes' }]).length, 1);
  const left = analyzeTranscript([u('operator', 'С чем помочь?'), u('system', 'Клиент покинул чат.')]);
  assert.equal(crossCheck(left, [{ criterion_id: '07', answer: 'no' }]).length, 1);
  assert.equal(crossCheck(left, [{ criterion_id: '07', answer: 'na' }]).length, 0);
  const ver = analyzeTranscript([u('system', 'Личность клиента подтверждена.'), u('operator', 'ok')]);
  assert.equal(crossCheck(ver, [{ criterion_id: '03', answer: 'na' }]).length, 1);
});

// Проверка на реальных данных DEV (data/sets/ не в Git: без файла тест пропускается).
const dev = new URL('../data/sets/DEV.json', import.meta.url);
test('DEV: у всех 60 чатов найден оператор; известные случаи', { skip: !existsSync(dev) }, () => {
  const recs = JSON.parse(readFileSync(dev, 'utf8')).data.records as { conversation_id: string; channel: string; language: string; transcript: Utterance[] }[];
  const h = (id: string) => { const r = recs.find((x) => x.conversation_id === id)!; return analyzeTranscript(r.transcript, r.language); };
  for (const r of recs.filter((x) => x.channel === 'agent chat')) assert.notEqual(analyzeTranscript(r.transcript, r.language).firstOperatorIndex, null, r.conversation_id);
  assert.equal(h('p1-ru-001').greeting.found && h('p1-ru-001').introduction && h('p1-ru-001').farewell.found, true);
  assert.equal(h('p1-ru-014').introduction, false);
  assert.equal(h('p1-en-015').greeting.found, false);
  assert.equal(h('p1-ru-018').closing.kind, 'operator_closed');
  assert.equal(h('p1-ru-018').farewell.found, false);
  assert.equal(h('p1-ru-025').closing.kind, 'client_left');
  assert.equal(h('p1-en-009').closing.kind, 'connection_lost');
  assert.equal(h('p1-en-006').identityVerified.found, true);
  assert.equal(h('p1-kz-008').farewell.found, false);
});
