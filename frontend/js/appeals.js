import { createAppeal, decideAppeal, getAppeals } from './api.js';
import { answerLabel, byId, button, element, errorText, fillOptions, label, number, setStatus } from './ui.js';

const dialog = byId('appeal-dialog');
const panel = byId('appeals');
const submit = byId('send-appeal');
let target;
let sending = false;
let historyRequest;

export function clearAppeals() {
  historyRequest?.abort();
  panel.hidden = true;
  panel.replaceChildren();
}

export function openAppeal(evaluationId, criterionId, title, onSaved) {
  target = { evaluationId, criterionId, onSaved };
  byId('appeal-criterion').textContent = title;
  byId('appeal-form').reset();
  setStatus(byId('appeal-status'), '');
  dialog.showModal();
}

byId('close-appeal').addEventListener('click', () => {
  if (!sending) dialog.close();
});
dialog.addEventListener('cancel', (event) => {
  if (sending) event.preventDefault();
});
byId('appeal-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (sending) return;
  const comment = byId('appeal-comment').value.trim();
  const status = byId('appeal-status');
  if (!comment) {
    setStatus(status, 'Укажите причину апелляции.');
    return;
  }
  sending = true;
  submit.disabled = true;
  try {
    await createAppeal({ evaluation_id: target.evaluationId, criterion_id: target.criterionId, comment });
    dialog.close();
    target.onSaved();
  } catch (error) {
    setStatus(status, errorText(error));
  } finally {
    sending = false;
    submit.disabled = false;
  }
});

function scoreLabel(value) {
  return Number.isFinite(value) ? number(value) + ' / 100' : '—';
}

function timelineItem(title, value, detail) {
  const node = element('div');
  node.append(element('small', title), element('strong', value), element('span', detail));
  return node;
}

function reviewForm(appeal, criterion, onDecision) {
  const form = element('form', undefined, 'decision-form');
  const decision = element('select');
  fillOptions(decision, [['rejected', 'Подтвердить оценку'], ['accepted', 'Изменить оценку']]);
  if (!criterion) decision.options[1].disabled = true;
  const answers = criterion?.type === 'scale' ? [...(criterion.steps ?? [])] : ['yes', 'no'];
  if (criterion?.na_allowed) answers.push('na');
  const answer = element('select');
  fillOptions(answer, answers.map((value, index) => [index, answerLabel(value)]));
  const answerField = label('Новый ответ', answer);
  answerField.hidden = true;
  decision.addEventListener('change', () => { answerField.hidden = decision.value !== 'accepted'; });
  const reason = element('textarea');
  reason.rows = 2;
  reason.required = true;
  const status = element('p', undefined, 'meta');
  status.setAttribute('role', 'status');
  const save = element('button', 'Сохранить решение', 'action');
  save.type = 'submit';
  form.append(label('Решение', decision), answerField, label('Обоснование', reason), save, status);
  if (!criterion) form.append(element('p', 'Изменение ответа доступно, когда загружена исходная версия критерия.', 'meta'));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (save.disabled) return;
    if (!reason.value.trim()) {
      setStatus(status, 'Заполните обоснование.');
      return;
    }
    save.disabled = true;
    try {
      const body = { status: decision.value, reviewer_reason: reason.value.trim() };
      if (body.status === 'accepted') body.reviewer_answer = answers[Number(answer.value)];
      await decideAppeal(appeal.id, body);
      await onDecision();
    } catch (error) {
      setStatus(status, errorText(error));
    } finally {
      save.disabled = false;
    }
  });
  return form;
}

export async function renderAppeals(result, checklist, reviewer, { onDecision, onEvidence }) {
  clearAppeals();
  if (!result?.id) return;
  const controller = new AbortController();
  historyRequest = controller;
  if (reviewer) {
    panel.hidden = false;
    panel.append(element('h3', 'Апелляции'), element('p', 'Загружаем историю…', 'meta'));
  }
  try {
    const appeals = await getAppeals(result.id, controller.signal);
    if (controller.signal.aborted) return;
    if (!appeals.length && !reviewer) return;
    const criteria = new Map(checklist?.criteria.map((criterion) => [criterion.id, criterion]));
    panel.replaceChildren(element('h3', 'Апелляции'));
    panel.hidden = false;
    if (!appeals.length) panel.append(element('p', 'К этой оценке пока нет апелляций.', 'meta'));
    for (const appeal of appeals) {
      const row = element('article', undefined, 'appeal-card');
      const criterion = criteria.get(appeal.criterion_id);
      const status = { pending: 'На рассмотрении', accepted: 'Оценка изменена', rejected: 'Оценка подтверждена' }[appeal.status];
      const finalScore = appeal.final_score;
      const finalAnswer = appeal.status === 'accepted' ? appeal.reviewer_answer : appeal.original_answer;
      row.append(element('strong', criterion?.title ?? 'Критерий ' + appeal.criterion_id), element('p', appeal.comment, 'meta'));
      const timeline = element('div', undefined, 'timeline');
      timeline.append(
        timelineItem('Было', answerLabel(appeal.original_answer), scoreLabel(appeal.original_score)),
        timelineItem('Решение', status || '—', ''),
        timelineItem('Итог', appeal.status === 'pending' ? '—' : answerLabel(finalAnswer), scoreLabel(finalScore))
      );
      row.append(timeline);
      if (appeal.reviewer_reason) row.append(element('p', appeal.reviewer_reason, 'meta'));
      const item = result.items.find((entry) => entry.criterion_id === appeal.criterion_id);
      const first = item?.evidence?.find((value) => Number.isInteger(value) && value > 0);
      const [start, end] = Number.isInteger(first) ? [first, first] : item?.checked_range ?? [];
      if (Number.isInteger(start) && Number.isInteger(end)) row.append(button('К доказательству', () => onEvidence(start, end)));
      if (reviewer && appeal.status === 'pending') row.append(reviewForm(appeal, criterion, onDecision));
      panel.append(row);
    }
  } catch (error) {
    if (!controller.signal.aborted && reviewer) panel.replaceChildren(element('p', errorText(error), 'meta'));
  }
}
