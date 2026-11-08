import { getEvaluations } from './api.js';
import { byId, element, number } from './ui.js';

let records = [];
let evaluations = [];
let unavailable = false;

function render() {
  const latest = new Map();
  for (const result of evaluations) {
    const previous = latest.get(result.conversation_id);
    if (!previous || (Date.parse(result.evaluated_at) || 0) >= (Date.parse(previous.evaluated_at) || 0)) latest.set(result.conversation_id, result);
  }
  const checked = records.map((record) => latest.get(record.conversation_id)).filter(Boolean);
  const scored = checked.filter((result) => Number.isFinite(result.total_score));
  byId('stat-reviewed').textContent = unavailable ? '—' : checked.length;
  byId('stat-average').textContent = unavailable || !scored.length ? '—' : number(scored.reduce((sum, result) => sum + result.total_score, 0) / scored.length);
  byId('dashboard-note').textContent = unavailable ? 'Сохранённые оценки недоступны. Откройте диалог, чтобы повторить загрузку.' : 'Показаны последние сохранённые оценки · шкала 0–100';
  byId('recent-dialogues').replaceChildren(...records.slice(0, 5).map((record) => {
    const result = latest.get(record.conversation_id);
    const row = element('button', undefined, 'recent-row');
    row.type = 'button';
    const text = element('span');
    const title = record.transcript.find((message) => message.speaker === 'client')?.text || record.conversation_id;
    text.append(element('strong', title), element('span', record.conversation_id + ' · ' + record.language + ' · ' + record.transcript.length + ' реплик', 'meta'));
    const label = result?.items?.some((item) => item.needs_review) ? 'На проверку' : Number.isFinite(result?.total_score) ? number(result.total_score) + ' / 100' : 'Без оценки';
    row.append(text, element('span', label, 'result-badge'));
    row.addEventListener('click', () => {
      location.hash = 'workspace';
      const search = byId('search');
      byId('channel').value = '';
      byId('language').value = '';
      byId('gross-only').checked = false;
      search.value = record.conversation_id;
      search.dispatchEvent(new Event('input'));
      byId('dialogues').querySelector('button')?.click();
    });
    return row;
  }));
}

document.addEventListener('dataset-loaded', (event) => {
  records = event.detail;
  render();
});
document.addEventListener('evaluation-loaded', (event) => {
  const result = event.detail;
  evaluations = evaluations.filter((item) => item.id !== result.id);
  evaluations.push(result);
  render();
});
getEvaluations().then((items) => {
  evaluations = [...items, ...evaluations];
  document.dispatchEvent(new CustomEvent('evaluation-list-loaded', { detail: evaluations }));
  render();
}).catch(() => {
  unavailable = true;
  render();
});
