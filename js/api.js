const params = new URLSearchParams(location.search);
const apiBase = (params.get('api') || 'http://localhost:3000/api').replace(/\/$/, '');
const segment = (value) => encodeURIComponent(value);

class ApiError extends Error {
  constructor(status, message) {
    super(message || 'HTTP ' + status);
    this.status = status;
  }
}

const DEMO_MESSAGE = 'Демо-версия без сервера: это действие работает при локальном запуске (npm run dev, см. README).';
let demo = false;
let snapshotCheck = null;

const snapshotAvailable = () => {
  snapshotCheck ??= fetch('data/evaluations.json', { method: 'HEAD' }).then((response) => response.ok).catch(() => false);
  return snapshotCheck;
};

async function loadSnapshot(file) {
  const response = await fetch(file);
  if (!response.ok) throw new ApiError(404);
  return response.json();
}

async function snapshot(path) {
  const [route, first, second] = new URL(path, location.href).pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (route === 'sets') return loadSnapshot('data/sets/' + segment(first) + '.json');
  if (route === 'checklists') {
    const list = await loadSnapshot('data/checklists.json');
    if (!first) return list;
    const found = list.find((item) => item.id === first);
    if (!found) throw new ApiError(404);
    return found;
  }
  if (route === 'evaluations') {
    const list = await loadSnapshot('data/evaluations.json');
    if (!first) return list;
    const found = first === 'by-conversation' ? list.filter((item) => item.conversation_id === second).at(-1) : list.find((item) => item.id === first);
    if (!found) throw new ApiError(404);
    return found;
  }
  if (route === 'appeals') return [];
  throw new ApiError(503, DEMO_MESSAGE);
}

function enterDemo() {
  if (demo) return;
  demo = true;
  document.documentElement.dataset.demo = '';
  const note = document.createElement('p');
  note.className = 'demo-banner';
  note.textContent = 'Демо-версия без сервера: показаны сохранённые оценки DEV, только просмотр. Оценка, апелляции и редактор чек-листа работают при локальном запуске — см. README.';
  document.body.prepend(note);
}

async function request(path, { signal, body } = {}) {
  if (demo) {
    if (body !== undefined) throw new ApiError(503, DEMO_MESSAGE);
    return snapshot(path);
  }
  const options = body === undefined
    ? { signal }
    : { signal, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  let response;
  try {
    response = await fetch(apiBase + path, options);
  } catch (error) {
    if (signal?.aborted || params.has('api') || !(await snapshotAvailable())) throw error;
    enterDemo();
    return request(path, { signal, body });
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, payload?.error);
  if (payload === null) throw new Error('Сервер вернул ответ без JSON.');
  return payload;
}

async function optional(path, signal) {
  try {
    return await request(path, { signal });
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

export async function getDialogues(groupId) {
  const result = await request('/sets/' + segment(groupId));
  if (!result.isSuccess || !Array.isArray(result.data?.records)) throw new Error('Сервер вернул некорректный набор.');
  if (result.data.dataset_group_id !== groupId) throw new Error('Набор ' + groupId + ' недоступен. Сервер вернул ' + result.data.dataset_group_id + '.');
  return result.data.records;
}

export const getEvaluationById = (id, signal) => optional('/evaluations/' + segment(id), signal);
export const getEvaluation = (id, signal) => optional('/evaluations/by-conversation/' + segment(id), signal);
export const getChecklist = (id, signal) => optional('/checklists/' + segment(id), signal);
export const getChecklists = () => request('/checklists');
export const saveChecklist = (body) => request('/checklists', { body });

export async function runEvaluation(conversationId, checklistId, force = false) {
  try {
    return await request('/evaluate', { body: { conversation_id: conversationId, checklist_id: checklistId, ...(force ? { force: true } : {}) } });
  } catch (error) {
    if (error.status === 404 && error.message === 'HTTP 404') {
      throw new ApiError(404, 'На запущенном сервере нет POST /api/evaluate. Для оценки нужна интеграция ветки b1-backend.');
    }
    throw error;
  }
}

export const getAudioSource = (url) => request('/audio?url=' + encodeURIComponent(url));
export const getAppeals = (id, signal) => request('/appeals?evaluation_id=' + segment(id), { signal });
export const createAppeal = (body) => request('/appeals', { body });
export const decideAppeal = (id, body) => request('/appeals/' + segment(id) + '/decide', { body });

export const getEvaluations = () => request("/evaluations");
