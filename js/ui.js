export const byId = (id) => document.getElementById(id);
export const formatNumber = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
export const number = (value) => Number.isFinite(value) ? formatNumber.format(value) : '—';
export const answerLabel = (value) => ({ yes: 'Да', no: 'Нет', na: 'N/A' })[value] ?? number(value);

export function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}

export function button(value, action, className = 'action') {
  const node = element('button', value, className);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

export function label(title, control) {
  const node = element('label');
  control.setAttribute('aria-label', title);
  node.append(title, control);
  return node;
}

export function setStatus(node, message) {
  node.textContent = message;
  node.hidden = !message;
}

export function fillOptions(select, values) {
  select.replaceChildren(...values.map(([id, title]) => new Option(title, id)));
}

export function errorText(error) {
  return error instanceof TypeError ? 'Нет связи с сервером. Проверьте, что API запущен.' : error.message;
}
