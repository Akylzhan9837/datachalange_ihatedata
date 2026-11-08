import { getEvaluations } from './api.js';
import { byId, element, number } from './ui.js';

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const dates = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const dayLength = 86400000;
const metrics = new Map();
const period = byId('trend-period');
let records = null;
let evaluations = null;
let unavailable = false;

function metric(id, value, decimals = 0, replay = false) {
  const node = byId(id);
  const previous = metrics.get(id);
  if (!replay && previous?.target === value) return;
  for (const animation of previous?.animations ?? []) animation.cancel();
  const current = { target: value, animations: [] };
  metrics.set(id, current);
  const label = value === null ? '—' : number(value);
  node.replaceChildren();
  node.setAttribute('aria-label', label);
  if (value === null || reducedMotion.matches || document.hidden || node.closest('[hidden]')) {
    node.textContent = label;
    return;
  }
  const visual = element('span', undefined, 'rolling-number');
  visual.setAttribute('aria-hidden', 'true');
  let column = 0;
  for (const character of label) {
    if (!/[0-9]/.test(character)) {
      visual.append(element('span', character, 'rolling-separator'));
      continue;
    }
    const window = element('span', undefined, 'digit-window');
    const reel = element('span', undefined, 'digit-reel');
    const stop = 20 + Number(character);
    for (let step = 0; step <= stop; step++) reel.append(element('span', String(step % 10)));
    window.append(reel);
    visual.append(window);
    const animation = reel.animate([
      { transform: 'translateY(0)' },
      { transform: 'translateY(-' + stop + 'em)' }
    ], { duration: 1150 + column * 110, delay: column * 65, easing: 'cubic-bezier(.16, .75, .18, 1)', fill: 'both' });
    current.animations.push(animation);
    column++;
  }
  node.append(visual);
  Promise.all(current.animations.map((animation) => animation.finished)).then(() => {
    if (metrics.get(id) === current) node.textContent = label;
  }).catch(() => {});
}

window.addEventListener('hashchange', () => {
  if (location.hash === '#workspace') return;
  requestAnimationFrame(() => {
    for (const [id, state] of metrics) metric(id, state.target, 0, true);
  });
});

reducedMotion.addEventListener('change', () => {
  if (!reducedMotion.matches) return;
  for (const [id, state] of metrics) metric(id, state.target, 0, true);
});

function reviewedAt(result) {
  return Date.parse(result.evaluated_at) || 0;
}

function openConversation(record) {
  location.hash = 'workspace';
  const search = byId('search');
  byId('channel').value = '';
  byId('language').value = '';
  byId('gross-only').checked = false;
  search.value = record.conversation_id;
  search.dispatchEvent(new Event('input'));
  byId('dialogues').querySelector('button')?.click();
}

function row(record, result) {
  const button = element('button', undefined, 'overview-row');
  button.type = 'button';
  const content = element('span');
  const title = record.transcript.find((message) => message.speaker === 'client')?.text || record.conversation_id;
  const metadata = [record.conversation_id, record.language];
  if (record.operator_name) metadata.push(record.operator_name);
  if (result && reviewedAt(result)) metadata.push(dates.format(reviewedAt(result)));
  content.append(element('strong', title), element('small', metadata.join(' · ')));
  const score = Number.isFinite(result.total_score) ? number(result.total_score) : '—';
  const status = result.gross_violation ? 'Грубая ошибка' : result.items?.some((item) => item.needs_review) ? 'На проверку' : 'Проверено';
  const badge = element('span', status, 'overview-tag' + (status === 'Проверено' ? '' : ' alert'));
  button.append(content, element('span', score, 'luxe-row-score'), badge);
  button.addEventListener('click', () => openConversation(record));
  return button;
}

function chartElement(tag, attributes = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function renderTrend(results) {
  const container = byId('quality-trend');
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const first = new Date(end);
  const span = Number(period.value) - 1;
  first.setDate(first.getDate() - span);
  const points = new Map();
  for (const result of results) {
    const day = new Date(reviewedAt(result));
    day.setHours(0, 0, 0, 0);
    if (day < first || day > end || !Number.isFinite(result.total_score)) continue;
    const key = day.getTime();
    const scores = points.get(key) ?? [];
    scores.push(result.total_score);
    points.set(key, scores);
  }
  const chart = chartElement('svg', { viewBox: '0 0 620 184', role: 'img', 'aria-label': 'Средние оценки за выбранный период' });
  for (const tick of [100, 75, 50, 25, 0]) {
    const y = 10 + (100 - tick) * 1.42;
    chart.append(chartElement('line', { x1: 35, x2: 610, y1: y, y2: y, class: 'trend-grid' }));
    const label = chartElement('text', { x: 26, y: y + 4, 'text-anchor': 'end' });
    label.textContent = tick;
    chart.append(label);
  }
  for (const [x, date, anchor] of [[35, first, 'start'], [610, end, 'end']]) {
    const label = chartElement('text', { x, y: 177, 'text-anchor': anchor });
    label.textContent = dates.format(date);
    chart.append(label);
  }
  const daily = [...points].sort(([a], [b]) => a - b).map(([day, scores]) => {
    const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    return { day, average, x: 35 + Math.round((day - first) / dayLength) / span * 575, y: 10 + (100 - average) * 1.42 };
  });
  if (daily.length > 1) {
    const path = daily.map(({ x, y }) => x + ',' + y).join(' ');
    chart.append(chartElement('polygon', { points: path + ' ' + daily.at(-1).x + ',152 ' + daily[0].x + ',152', class: 'trend-fill' }));
    chart.append(chartElement('polyline', { points: path, class: 'trend-line' }));
  }
  for (const { x, y, day, average } of daily) {
    const dot = chartElement('circle', { cx: x, cy: y, r: 4, class: 'trend-point' });
    const label = chartElement('title');
    label.textContent = dates.format(day) + ': ' + number(average) + ' / 100';
    dot.append(label);
    chart.append(dot);
  }
  container.replaceChildren(chart);
  if (!daily.length) {
    const message = unavailable ? 'Оценки недоступны' : evaluations === null || records === null ? 'Загружаем оценки…' : 'За этот период оценок пока нет';
    const empty = element('div', undefined, 'trend-empty');
    empty.append(element('span', '◌'), element('strong', message));
    if (!unavailable && evaluations !== null && records !== null) empty.append(element('p', 'Динамика появится после сохранения оценок.'));
    container.append(empty);
  }
}

function renderDistribution(scored) {
  const container = byId('score-distribution');
  if (!scored?.length) {
    const copy = unavailable ? 'Оценки недоступны' : scored ? 'Пока нет баллов для сравнения' : 'Загружаем оценки…';
    container.replaceChildren(element('p', copy, 'luxe-distribution-empty'));
    return;
  }
  const ranges = [[0, 49], [50, 69], [70, 89], [90, 100]];
  container.replaceChildren(...ranges.map(([min, max]) => {
    const count = scored.filter(({ total_score }) => total_score >= min && (max === 100 ? total_score <= max : total_score < max + 1)).length;
    const row = element('div', undefined, 'luxe-distribution-row');
    const track = element('progress');
    track.max = scored.length;
    track.value = count;
    track.setAttribute('aria-label', min + '–' + max + ' баллов');
    row.append(element('span', min + '–' + max), track, element('strong', number(count)));
    return row;
  }));
}

function render() {
  const latest = new Map();
  const recordIds = new Set((records ?? []).map((record) => record.conversation_id));
  const history = (evaluations ?? []).filter((result) => recordIds.has(result.conversation_id));
  for (const result of history) {
    const previous = latest.get(result.conversation_id);
    if (!previous || reviewedAt(result) >= reviewedAt(previous)) latest.set(result.conversation_id, result);
  }
  const checked = (records ?? []).filter((record) => latest.has(record.conversation_id));
  checked.sort((a, b) => reviewedAt(latest.get(b.conversation_id)) - reviewedAt(latest.get(a.conversation_id)));
  const scored = [...latest.values()].filter((result) => Number.isFinite(result.total_score));
  const critical = checked.filter((record) => latest.get(record.conversation_id).gross_violation === true);
  const ready = evaluations !== null && records !== null;
  metric('stat-total', records?.length ?? null);
  metric('stat-reviewed', ready ? checked.length : null);
  metric('stat-average', ready && scored.length ? scored.reduce((sum, result) => sum + result.total_score, 0) / scored.length : null, 1);
  metric('stat-critical', ready ? critical.length : null);
  const coverage = ready && records.length ? 100 * checked.length / records.length : null;
  byId('coverage-progress').value = coverage ?? 0;
  byId('coverage-label').textContent = coverage === null ? 'Охват проверки' : number(coverage) + '% набора проверено';
  byId('dashboard-note').textContent = unavailable ? 'Не удалось загрузить историю оценок.' : '';
  const empty = unavailable ? 'Сохранённые оценки недоступны.' : 'Загружаем данные…';
  renderDistribution(ready ? scored : null);
  byId('recent-dialogues').replaceChildren(...(checked.length
    ? checked.slice(0, 4).map((record) => row(record, latest.get(record.conversation_id)))
    : [element('p', ready ? 'Здесь появятся диалоги после первой сохранённой оценки.' : empty, 'overview-empty')]));
  renderTrend(history);
}

document.addEventListener('dataset-loaded', (event) => {
  records = event.detail;
  render();
});
const updates = new Map();
document.addEventListener('evaluation-loaded', (event) => {
  const result = event.detail;
  updates.set(result.id, result);
  if (evaluations !== null) {
    evaluations = evaluations.filter((item) => item.id !== result.id);
    evaluations.push(result);
  }
  render();
});
getEvaluations().then((items) => {
  evaluations = [...items.filter((item) => !updates.has(item.id)), ...updates.values()];
  document.dispatchEvent(new CustomEvent('evaluation-list-loaded', { detail: evaluations }));
  render();
}).catch(() => {
  unavailable = true;
  render();
});
render();

period.addEventListener('change', render);
