import { saveChecklist } from './api.js';
import { byId, button, element, errorText, fillOptions, label, setStatus } from './ui.js';

const dialog = byId('editor');
const list = byId('editor-fields');
const status = byId('editor-status');
const save = byId('save-checklist');
let draft;
let onSave;
let saving = false;
let rows = [];

function field(value, required = false, tag = 'input') {
  const input = element(tag);
  input.value = value ?? '';
  input.required = required;
  if (tag === 'textarea') input.rows = 3;
  return input;
}

function check(value) {
  const input = element('input');
  input.type = 'checkbox';
  input.checked = Boolean(value);
  return input;
}

function lines(value) {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}

function appendCriterion(criterion, expanded = false) {
  const details = element('details', undefined, 'criterion-editor');
  details.open = expanded;
  const heading = element('summary', criterion.id + ' · ' + (criterion.title || 'Новый критерий'));
  const form = element('div', undefined, 'edit-grid');
  const id = field(criterion.id, true);
  id.pattern = '[A-Za-z0-9_\\-]{1,64}';
  const title = field(criterion.title, true);
  const description = field(criterion.description, true, 'textarea');
  const section = element('select');
  fillOptions(section, draft.sections.map((name) => [name, name]));
  section.value = criterion.section;
  const type = element('select');
  fillOptions(type, [['binary', 'Да / Нет'], ['scale', 'Шкала']]);
  type.value = criterion.type;
  const weight = field(criterion.weight, true);
  weight.type = 'number';
  weight.min = '0';
  weight.step = 'any';
  const steps = field(criterion.steps?.join(', '));
  const descriptions = field(Object.entries(criterion.step_desc ?? {}).map(([step, text]) => step + ' | ' + text).join('\n'), false, 'textarea');
  const allowNa = check(criterion.na_allowed);
  const gross = check(criterion.is_gross);
  const condition = field(criterion.na_condition, false, 'textarea');
  const guidance = field(Array.isArray(criterion.guidance) ? criterion.guidance.join('\n') : criterion.guidance, false, 'textarea');
  const stepField = label('Ступени через запятую', steps);
  const descriptionsField = label('Описание ступеней · число | текст', descriptions);
  const conditionField = label('Условие N/A', condition);

  function sync() {
    heading.textContent = (id.value || '—') + ' · ' + (title.value || 'Новый критерий');
    stepField.hidden = type.value !== 'scale';
    descriptionsField.hidden = stepField.hidden;
    steps.required = !stepField.hidden;
    conditionField.hidden = !allowNa.checked;
    weight.disabled = gross.checked;
  }

  const row = {
    details,
    read() {
      const name = id.value.trim();
      if (!name || !title.value.trim() || !description.value.trim()) throw new Error('Заполните ID, название и описание каждого критерия.');
      const updated = {
        ...criterion, id: name, title: title.value.trim(), section: section.value, description: description.value.trim(),
        type: type.value, weight: gross.checked ? 0 : weight.valueAsNumber, is_gross: gross.checked,
        na_allowed: allowNa.checked, na_condition: condition.value.trim(), guidance: lines(guidance.value)
      };
      if (gross.checked && type.value !== 'binary') throw new Error('Критерий ' + name + ': грубое нарушение должно быть флагом Да / Нет.');
      if (type.value === 'scale') {
        const tokens = steps.value.split(',').map((step) => step.trim());
        const values = tokens.map(Number);
        if (tokens.some((step) => !step) || values.length < 2 || values.some((value, index) => !Number.isFinite(value) || value < 0 || (index && value <= values[index - 1])) || values.at(-1) <= 0) {
          throw new Error('Критерий ' + name + ': укажите минимум две возрастающие ступени.');
        }
        updated.steps = values;
        updated.max_step = values.at(-1);
        updated.step_desc = {};
        for (const line of lines(descriptions.value)) {
          const separator = line.indexOf('|');
          const step = line.slice(0, separator).trim();
          const text = line.slice(separator + 1).trim();
          if (separator < 1 || !values.includes(Number(step)) || !text) throw new Error('Критерий ' + name + ': используйте формат «ступень | текст».');
          updated.step_desc[String(Number(step))] = text;
        }
      } else {
        delete updated.steps;
        delete updated.max_step;
        delete updated.step_desc;
      }
      return updated;
    }
  };
  form.append(
    label('ID критерия', id), label('Название', title), label('Секция', section), label('Тип ответа', type),
    label('Вес', weight), label('Флаг грубого нарушения', gross), label('Разрешить N/A', allowNa),
    stepField, descriptionsField, label('Что оценивается', description), conditionField,
    label('Guidance · одно уточнение на строку', guidance),
    button('Удалить критерий', () => {
      rows = rows.filter((item) => item !== row);
      details.remove();
    }, 'action danger')
  );
  form.addEventListener('input', sync);
  details.append(heading, form);
  list.append(details);
  rows.push(row);
  sync();
}

export function openEditor(checklist, callback) {
  draft = checklist;
  onSave = callback;
  rows = [];
  list.replaceChildren();
  byId('editor-version').textContent = checklist.title + ' · версия ' + checklist.version;
  setStatus(status, '');
  checklist.criteria.forEach((criterion) => appendCriterion(criterion));
  dialog.showModal();
}

byId('add-criterion').addEventListener('click', () => appendCriterion({
  id: '', title: '', section: draft.sections[0], type: 'binary', weight: 0, na_allowed: false
}, true));

byId('close-editor').addEventListener('click', () => {
  if (!saving) dialog.close();
});
dialog.addEventListener('cancel', (event) => {
  if (saving) event.preventDefault();
});
byId('editor-form').addEventListener('invalid', (event) => {
  const details = event.target.closest('details');
  if (details) details.open = true;
}, true);

byId('editor-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (saving) return;
  try {
    const criteria = rows.map((row) => {
      try {
        return row.read();
      } catch (error) {
        row.details.open = true;
        throw error;
      }
    });
    if (!criteria.length) throw new Error('Добавьте хотя бы один критерий.');
    if (new Set(criteria.map((criterion) => criterion.id)).size !== criteria.length) throw new Error('ID критериев должны быть уникальны.');
    saving = true;
    save.disabled = true;
    setStatus(status, 'Сохраняем…');
    const saved = await saveChecklist({ ...draft, criteria });
    onSave(saved);
    dialog.close();
  } catch (error) {
    setStatus(status, errorText(error));
  } finally {
    saving = false;
    save.disabled = false;
  }
});
