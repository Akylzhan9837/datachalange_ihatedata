import { getAudioSource, getChecklist, getChecklists, getDialogues, getEvaluation, getEvaluationById, runEvaluation } from './api.js';
import './dashboard.js';
import { clearAppeals, openAppeal, renderAppeals } from './appeals.js';
import { openEditor } from './editor.js';
import { answerLabel, byId, button, element, errorText, fillOptions, number, setStatus } from './ui.js';

const dialogues = byId('dialogues');
const transcript = byId('transcript');
const evaluation = byId('evaluation');
const listStatus = byId('list-status');
const transcriptStatus = byId('transcript-status');
const evaluationStatus = byId('evaluation-status');
const retry = byId('retry');
const search = byId('search');
const channel = byId('channel');
const language = byId('language');
const grossOnly = byId('gross-only');
const latestEvaluations = new Map();
let records = [];
let activeId;
let checklists = [];
let groupId = 'DEV';
let loading = false;
let job;
let activeResult;
const sessionResults = new Map();
const picker = byId('checklist-picker');
const batchButton = byId('run-batch');
const singleButton = byId('run-single');
const rerunButton = byId('rerun-single');
const editorButton = byId('open-editor');
const reviewer = byId('reviewer');
const roles = { client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' };
const clockTime = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
let selection;

function channelName(channel) {
  if (channel === 'voice call') return 'Звонок';
  if (channel === 'agent chat') return 'Чат';
  return channel;
}

function renderTranscript(record) {
  byId('conversation-meta').textContent = record.conversation_id + ' · ' + channelName(record.channel) + ' · ' + record.language + ' · ' + record.transcript.length + ' репл.';
  const recording = byId('recording');
  byId('recording-player').hidden = true;
  recording.pause();
  recording.removeAttribute('src');
  recording.load();
  if (typeof record.audio_url === 'string' && /^https?:\/\//i.test(record.audio_url)) {
    getAudioSource(record.audio_url).then(({ src }) => { if (activeId === record.conversation_id && src) recording.src = src; }).catch(() => {});
    byId('recording-player').hidden = false;
  }

  transcript.replaceChildren(...record.transcript.map((message, index) => {
    const speaker = Object.hasOwn(roles, message.speaker) ? message.speaker : 'other';
    const item = element('li', undefined, 'message ' + speaker);
    item.id = 'message-' + (index + 1);
    item.tabIndex = -1;
    const header = element('div', undefined, 'message-header');
    const stamp = /^\d{4}-\d\d-\d\dT/.test(message.timestamp) && Number.isFinite(Date.parse(message.timestamp)) ? clockTime.format(Date.parse(message.timestamp)) : message.timestamp;
    const time = element('span', stamp);
    time.title = message.timestamp;
    header.append(element('strong', '#' + (index + 1) + ' · ' + (roles[speaker] ?? message.speaker)), time);
    item.append(header, element('p', message.text));
    return item;
  }));
  setStatus(transcriptStatus, record.transcript.length ? '' : 'Транскрипт пуст.');
}

function showEvidence(start, end = start) {
  for (const item of transcript.children) {
    const index = Number(item.id.slice('message-'.length));
    item.classList.toggle('highlight', index >= start && index <= end);
  }
  const first = byId('message-' + start);
  if (!first) return;
  const panel = transcript.getBoundingClientRect();
  const message = first.getBoundingClientRect();
  if (message.top < panel.top || message.bottom > panel.bottom) {
    transcript.scrollTop += message.top - panel.top - 12;
  }
  if (panel.top >= window.innerHeight || panel.bottom <= 0) transcript.scrollIntoView({ block: 'nearest' });
  first.focus({ preventScroll: true });
}

function evidenceButton(label, start, end = start) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > transcript.children.length) return null;
  const button = element('button', label, 'action');
  button.type = 'button';
  button.addEventListener('click', () => showEvidence(start, end));
  return button;
}

function renderEvaluation(result, checklist) {
  const source = checklist ?? checklists.find((item) => item.id === result.checklist_id);
  const titles = new Map(source?.criteria.map((criterion) => [criterion.id, criterion.title]));
  const grossIds = new Set(source?.criteria.filter((criterion) => criterion.is_gross).map((criterion) => criterion.id));
  const summary = element('div', undefined, 'summary');
  summary.append(
    element('span', 'Итоговый балл'),
    element('strong', !Number.isFinite(result.total_score) ? 'Не рассчитан' : number(result.total_score) + ' / 100'),
    element('p', result.gross_violation === undefined ? 'Данные о нарушениях отсутствуют' : result.gross_violation ? 'Обнаружена грубая ошибка' : 'Грубых ошибок нет', result.gross_violation ? 'violation' : '')
  );

  if (Number.isFinite(result.total_score)) {
    const meter = element('meter');
    meter.min = 0;
    meter.max = 100;
    meter.value = result.total_score;
    meter.setAttribute('aria-label', 'Итоговый балл');
    summary.append(meter);
  }
  const details = element('details', undefined, 'quiet-score-details');
  const metadata = element('div', undefined, 'quiet-detail');
  metadata.append(
    element('p', 'Модель · ' + (result.model || '—')),
    element('p', 'Чек-лист · v' + result.checklist_version + ' · Промпт · ' + (result.prompt_version || '—'))
  );
  for (const [section, score] of Object.entries(result.section_scores ?? {})) {
    metadata.append(element('p', section + ': ' + number(score)));
  }
  details.append(element('summary', 'Подробности оценки'), metadata);
  summary.append(details);

  const criteria = result.items.map((item) => {
    const row = element('details', undefined, 'criterion');
    row.name = 'evaluation-criteria';
    row.open = Boolean(result.gross_violation && String(item.criterion_id).padStart(2, '0') === '08');
    const body = element('div', undefined, 'quiet-detail');
    const heading = element('summary');
    const gross = grossIds.has(item.criterion_id);
    const share = Number.isFinite(item.points) && item.max_points > 0 ? item.points / item.max_points : null;
    const scaleTone = share === null ? 'scale' : share >= 0.75 ? 'yes' : share <= 0.25 ? 'no' : 'scale';
    const tone = item.answer === 'na' ? 'na' : typeof item.answer === 'number' ? scaleTone : (item.answer === 'yes') !== gross ? 'yes' : 'no';
    const points = gross ? 'флаг' : (Number.isFinite(item.points) ? number(item.points) : '—') + (Number.isFinite(item.max_points) ? ' / ' + number(item.max_points) : '');
    heading.append(
      element('span', String(item.criterion_id).padStart(2, '0'), 'criterion-num'),
      element('h3', titles.get(item.criterion_id) ?? 'Критерий ' + item.criterion_id),
      element('span', answerLabel(item.answer) + (item.needs_review ? ' · ⚠' : ''), 'answer-pill ' + tone),
      element('span', points, 'criterion-points')
    );
    row.append(heading, body);
    body.append(element('p', 'Баллы: ' + number(item.points) + (Number.isFinite(item.max_points) ? ' / ' + number(item.max_points) : '') + ' · Вес: ' + number(item.weight), 'meta'));
    if (item.needs_review) body.append(element('p', '⚠️ На проверку' + (item.review_reason ? ' · ' + item.review_reason : ''), 'review-flag'));
    if (item.reason) body.append(element('p', item.reason));
    if (item.answer === 'na' && item.na_reason && item.na_reason !== item.reason) body.append(element('p', item.na_reason));
    const evidence = element('div', undefined, 'evidence');
    for (const index of new Set(item.evidence ?? [])) {
      const button = evidenceButton('Реплика #' + index, index);
      if (button) evidence.append(button);
    }
    if (Array.isArray(item.checked_range) && item.checked_range.length === 2) {
      const [start, end] = item.checked_range;
      const button = evidenceButton('Участок #' + start + '–' + end, start, end);
      if (button) evidence.append(button);
    }
    if (evidence.childElementCount) body.append(evidence);
    if (result.id) {
      body.append(button('Оспорить', () => openAppeal(result.id, item.criterion_id,
        titles.get(item.criterion_id) ?? 'Критерий ' + item.criterion_id,
        () => renderHistory(result, checklist)), 'action appeal-link'));
    }
    return row;
  });
  evaluation.replaceChildren(summary, ...criteria);
}

function selectedChecklist() {
  return checklists.find((checklist) => checklist.id === picker.value);
}

function syncActions() {
  const blocked = Boolean(job) || loading;
  const hasChecklist = Boolean(selectedChecklist());
  batchButton.disabled = blocked || !records.length || !hasChecklist;
  singleButton.disabled = blocked || !activeId || !hasChecklist;
  rerunButton.disabled = singleButton.disabled;
  editorButton.disabled = blocked || !hasChecklist;
  byId('nav-editor').disabled = editorButton.disabled;
  picker.disabled = blocked || !checklists.length;
  byId('group').disabled = blocked;
  byId('dataset-form').querySelector('button').disabled = blocked;
}

function updateChecklists(items, preferred) {
  checklists = items;
  fillOptions(picker, items.map((item) => [item.id, item.title + ' · v' + item.version]));
  if (items.some((item) => item.id === preferred)) picker.value = preferred;
  if (!items.length) fillOptions(picker, [['', 'Нет доступных чек-листов']]);
  syncActions();
}

function renderHistory(result, checklist) {
  return renderAppeals(result, checklist, reviewer.checked, {
    onEvidence: showEvidence,
    onDecision: async () => {
      if (activeResult?.id !== result.id) return;
      const refreshed = await getEvaluationById(result.id);
      if (activeResult?.id !== result.id || refreshed?.id !== result.id) return;
      displayEvaluation(remember(refreshed), checklist);
    }
  });
}

function remember(result) {
  if (!result.id) return result;
  const known = sessionResults.get(result.id);
  const merged = { ...known, ...result };
  sessionResults.set(result.id, merged);
  return merged;
}

function displayEvaluation(result, checklist) {
  if (!Array.isArray(result.items)) throw new Error('В оценке нет результатов по критериям.');
  activeResult = result;
  document.dispatchEvent(new CustomEvent('evaluation-loaded', { detail: result }));
  renderEvaluation(result, checklist);
  setStatus(evaluationStatus, '');
  void renderHistory(result, checklist);
}

async function present(result, signal) {
  const known = checklists.find((item) => item.id === result.checklist_id && item.version === result.checklist_version);
  const checklist = known ?? await getChecklist(result.checklist_id, signal).catch(() => null);
  if (!signal.aborted) displayEvaluation(remember(result), checklist?.version === result.checklist_version ? checklist : null);
}

async function selectDialogue(record, selectedButton) {
  activeId = record.conversation_id;
  activeResult = null;
  selection?.abort();
  const controller = new AbortController();
  selection = controller;
  const { signal } = controller;
  dialogues.querySelector('[aria-current]')?.removeAttribute('aria-current');
  selectedButton.setAttribute('aria-current', 'true');
  renderTranscript(record);
  transcript.scrollTop = 0;
  evaluation.replaceChildren();
  clearAppeals();
  syncActions();
  setStatus(evaluationStatus, 'Загружаем сохранённую оценку…');
  try {
    const savedId = latestEvaluations.get(record.conversation_id)?.id;
    const saved = savedId ? await getEvaluationById(savedId, signal) : null;
    const result = saved ?? await getEvaluation(record.conversation_id, signal);
    if (signal.aborted) return;
    if (result) await present(result, signal);
    else setStatus(evaluationStatus, 'Оценки пока нет. Выберите чек-лист и нажмите «Оценить».');
  } catch (error) {
    if (!signal.aborted) setStatus(evaluationStatus, errorText(error));
  }
}

function updateDialogueResult(badge, result) {
  const score = Number.isFinite(result?.total_score) ? number(result.total_score) + ' / 100' : '';
  badge.replaceChildren();
  if (score) badge.append(element('span', score, 'dialogue-score'));
  if (result?.gross_violation === true) badge.append(element('span', 'Грубая ошибка', 'dialogue-gross'));
  badge.hidden = !badge.childElementCount;
}

function rememberLatestEvaluation(result) {
  const id = result.conversation_id;
  const previous = latestEvaluations.get(id);
  if (previous && (Date.parse(previous.evaluated_at) || 0) > (Date.parse(result.evaluated_at) || 0)) return;
  latestEvaluations.set(id, result);
  const badge = Array.from(dialogues.querySelectorAll('[data-evaluation-for]')).find((node) => node.dataset.evaluationFor === id);
  if (grossOnly.checked && Boolean(previous?.gross_violation) !== Boolean(result.gross_violation)) renderDialogues();
  else if (badge) updateDialogueResult(badge, result);
}

function renderDialogues() {
  for (const name of ['channel', 'language']) {
    const value = byId(name).value;
    for (const control of document.querySelectorAll('[data-' + name + ']')) {
      control.setAttribute('aria-pressed', String(control.dataset[name] === value));
    }
  }
  byId('language-label').textContent = language.value || 'Все языки';
  const query = search.value.trim().toLocaleLowerCase('ru');
  const visible = records.filter((record) => {
    if (channel.value && record.channel !== channel.value) return false;
    if (language.value && record.language !== language.value) return false;
    if (grossOnly.checked && latestEvaluations.get(record.conversation_id)?.gross_violation !== true) return false;
    return !query || record.conversation_id.toLowerCase().includes(query) ||
      record.transcript.some((message) => message.text.toLocaleLowerCase('ru').includes(query));
  });
  const count = byId('count');
  count.textContent = visible.length === records.length ? records.length : visible.length + ' / ' + records.length;
  dialogues.replaceChildren(...visible.map((record) => {
    const item = element('li');
    const preview = record.transcript.find((message) => message.speaker === 'client' && message.text.trim())?.text.trim();
    const trigger = button('', () => selectDialogue(record, trigger), 'dialogue');
    if (record.conversation_id === activeId) trigger.setAttribute('aria-current', 'true');
    trigger.append(element('strong', preview || record.conversation_id));
    trigger.append(element('span', record.conversation_id + ' · ' + record.language + ' · ' + channelName(record.channel), 'meta'));
    const badge = element('span', undefined, 'dialogue-result');
    badge.dataset.evaluationFor = record.conversation_id;
    updateDialogueResult(badge, latestEvaluations.get(record.conversation_id));
    trigger.append(badge);
    item.append(trigger);
    return item;
  }));
  setStatus(listStatus, visible.length ? '' : records.length ? 'По этим фильтрам диалогов нет.' : 'В наборе пока нет диалогов.');
}

async function loadDialogues(requested) {
  if (loading || job) return;
  loading = true;
  syncActions();
  retry.hidden = true;
  setStatus(listStatus, 'Загружаем диалоги…');
  try {
    const incoming = await getDialogues(requested);
    selection?.abort();
    records = incoming;
    document.dispatchEvent(new CustomEvent('dataset-loaded', { detail: records }));
    groupId = requested;
    byId('group-label').textContent = groupId;
    activeId = undefined;
    activeResult = null;
    search.value = '';
    channel.value = '';
    language.value = '';
    grossOnly.checked = false;
    byId('conversation-meta').textContent = '';
    byId('recording').hidden = true;
    transcript.replaceChildren();
    evaluation.replaceChildren();
    clearAppeals();
    setStatus(transcriptStatus, 'Выберите диалог.');
    setStatus(evaluationStatus, 'Выберите диалог.');
    byId('batch-status').hidden = true;
    byId('count').hidden = false;
    byId('filters').hidden = !records.length;
    renderDialogues();
    dialogues.scrollTop = 0;
    dialogues.querySelector('button')?.click();
  } catch (error) {
    setStatus(listStatus, errorText(error));
    retry.hidden = false;
  } finally {
    loading = false;
    syncActions();
  }
}

async function loadChecklists() {
  try {
    updateChecklists(await getChecklists(), 'cqa-full');
  } catch {
    updateChecklists([]);
    fillOptions(picker, [['', 'Ошибка загрузки чек-листов']]);
  }
}

async function evaluateOne(id, checklist, force = false) {
  const result = await runEvaluation(id, checklist.id, force);
  if (result.conversation_id !== id || result.checklist_id !== checklist.id || result.checklist_version !== checklist.version || !Array.isArray(result.items)) {
    const error = new Error('Сервер вернул оценку для другой версии чек-листа или другого диалога.');
    error.stop = true;
    throw error;
  }
  const saved = remember(result);
  if (activeId !== id) document.dispatchEvent(new CustomEvent('evaluation-loaded', { detail: saved }));
  if (activeId === id) {
    selection?.abort();
    displayEvaluation(saved, checklist);
  }
}

async function evaluateSelected(force) {
  const id = activeId;
  const checklist = selectedChecklist();
  if (job || !id || !checklist) return;
  job = { type: 'single' };
  syncActions();
  setStatus(evaluationStatus, force ? 'Запускаем новую оценку…' : 'Оценка выполняется…');
  try {
    await evaluateOne(id, checklist, force);
  } catch (error) {
    if (activeId === id) setStatus(evaluationStatus, errorText(error));
  } finally {
    job = undefined;
    syncActions();
  }
}

singleButton.addEventListener('click', () => evaluateSelected(false));
rerunButton.addEventListener('click', () => evaluateSelected(true));

batchButton.addEventListener('click', async () => {
  const checklist = selectedChecklist();
  if (job || !checklist || !records.length) return;
  job = { type: 'batch', stop: false };
  syncActions();
  const progress = byId('batch-progress');
  const message = byId('batch-text');
  const stop = byId('stop-batch');
  const total = records.length;
  let completed = 0;
  let failed = 0;
  let lastError = '';
  progress.value = 0;
  progress.max = total;
  byId('batch-status').hidden = false;
  stop.hidden = false;
  stop.disabled = false;
  try {
    for (const record of records) {
      if (job.stop) break;
      setStatus(message, groupId + ' · ' + completed + '/' + total + ' · ' + record.conversation_id);
      try {
        await evaluateOne(record.conversation_id, checklist);
      } catch (error) {
        failed += 1;
        lastError = errorText(error);
        if (error.stop || error instanceof TypeError || (error.status === 404 && error.message.includes('POST /api/evaluate'))) job.stop = true;
      }
      progress.value = ++completed;
    }
    setStatus(message, (job.stop ? 'Остановлено' : 'Готово') + ' · Успешно ' + (completed - failed) + '/' + total +
      (failed ? ' · Ошибок: ' + failed + ' · ' + lastError : ''));
  } finally {
    job = undefined;
    stop.hidden = true;
    syncActions();
  }
});

byId('stop-batch').addEventListener('click', () => {
  if (job?.type === 'batch') {
    job.stop = true;
    byId('stop-batch').disabled = true;
    setStatus(byId('batch-text'), 'Остановим после текущего диалога…');
  }
});

editorButton.addEventListener('click', () => {
  const checklist = selectedChecklist();
  if (!checklist) return;
  openEditor(checklist, (saved) => {
    updateChecklists(checklists.map((item) => item.id === saved.id ? saved : item), saved.id);
    if (activeResult) {
      const matching = checklists.find((item) => item.id === activeResult.checklist_id && item.version === activeResult.checklist_version);
      displayEvaluation(activeResult, matching);
    }
  });
});

reviewer.addEventListener('change', () => {
  if (!activeResult) return;
  const matching = checklists.find((item) => item.id === activeResult.checklist_id && item.version === activeResult.checklist_version);
  void renderHistory(activeResult, matching);
});

byId('dataset-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void loadDialogues(byId('group').value.trim());
});
retry.addEventListener('click', () => {
  void loadDialogues(byId('group').value.trim());
  if (!checklists.length) void loadChecklists();
});
search.addEventListener('input', renderDialogues);
channel.addEventListener('change', renderDialogues);
language.addEventListener('change', renderDialogues);
grossOnly.addEventListener('change', renderDialogues);
document.addEventListener('evaluation-list-loaded', ({ detail }) => {
  for (const result of detail) rememberLatestEvaluation(result);
  grossOnly.disabled = false;
});
document.addEventListener('evaluation-loaded', ({ detail }) => rememberLatestEvaluation(detail));
void loadDialogues(groupId);
void loadChecklists();

const recordingAudio = byId('recording');
const recordingToggle = byId('recording-toggle');
const recordingProgress = byId('recording-progress');
const recordingTime = byId('recording-time');
const recordingClock = (seconds) => Number.isFinite(seconds) ? Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0') : '0:00';
recordingToggle.addEventListener('click', () => {
  delete recordingToggle.dataset.error;
  if (recordingAudio.paused) recordingAudio.play().catch(() => { recordingToggle.dataset.error = ''; recordingToggle.setAttribute('aria-label', 'Запись недоступна'); });
  else recordingAudio.pause();
});
recordingAudio.addEventListener('play', () => { recordingToggle.dataset.playing = ''; recordingToggle.setAttribute('aria-label', 'Пауза'); });
recordingAudio.addEventListener('pause', () => { delete recordingToggle.dataset.playing; recordingToggle.setAttribute('aria-label', 'Воспроизвести запись'); });
recordingAudio.addEventListener('timeupdate', () => {
  recordingProgress.value = recordingAudio.duration ? Math.round(1000 * recordingAudio.currentTime / recordingAudio.duration) : 0;
  recordingTime.textContent = recordingClock(recordingAudio.currentTime) + ' / ' + recordingClock(recordingAudio.duration);
});
recordingAudio.addEventListener('loadedmetadata', () => { recordingTime.textContent = '0:00 / ' + recordingClock(recordingAudio.duration); });
recordingProgress.addEventListener('input', () => { if (recordingAudio.duration) recordingAudio.currentTime = recordingAudio.duration * Number(recordingProgress.value) / 1000; });
