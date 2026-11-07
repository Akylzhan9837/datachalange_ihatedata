const params = new URLSearchParams(location.search);
const apiBase = (params.get('api') || 'http://localhost:3000/api').replace(/\/$/, '');
const segment = (value) => encodeURIComponent(value);

class ApiError extends Error {
  constructor(status, message) {
    super(message || 'HTTP ' + status);
    this.status = status;
  }
}

async function request(path, { signal, body } = {}) {
  const options = body === undefined
    ? { signal }
    : { signal, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const response = await fetch(apiBase + path, options);
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

export const getEvaluation = (id, signal) => optional('/evaluations/by-conversation/' + segment(id), signal);
export const getChecklist = (id, signal) => optional('/checklists/' + segment(id), signal);
export const getChecklists = () => request('/checklists');
export const saveChecklist = (body) => request('/checklists', { body });

export async function runEvaluation(conversationId, checklistId) {
  try {
    return await request('/evaluate', { body: { conversation_id: conversationId, checklist_id: checklistId } });
  } catch (error) {
    if (error.status === 404 && error.message === 'HTTP 404') {
      throw new ApiError(404, 'На запущенном сервере нет POST /api/evaluate. Для оценки нужна интеграция ветки b1-backend.');
    }
    throw error;
  }
}

export const getAppeals = (id, signal) => request('/appeals?evaluation_id=' + segment(id), { signal });
export const createAppeal = (body) => request('/appeals', { body });
export const decideAppeal = (id, body) => request('/appeals/' + segment(id) + '/decide', { body });
