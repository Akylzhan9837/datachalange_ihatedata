import type { Conversation } from '../shared/types.js';
import type { EvalChecklist, EvalItem, EvaluationDraft } from './evaluate.js';

export const RESULT_CODES = ['contact', 'discovery', 'identification', 'consultation', 'empathy', 'dialogue', 'closure', 'critical'];

const CODE_BY_ID: Record<string, string> = {
  '01': 'contact',
  '02': 'discovery',
  '03': 'identification',
  '04': 'consultation',
  '05': 'empathy',
  '06': 'dialogue',
  '07': 'closure',
  '08': 'critical',
};

const bool = (v: unknown) => typeof v === 'boolean';
const ALLOWED: Record<string, (v: unknown) => boolean> = {
  contact: bool,
  discovery: (v) => v === null || bool(v),
  identification: (v) => v === null || bool(v),
  consultation: (v) => v === null || [0, 5, 10, 15, 20].includes(v as number),
  empathy: bool,
  dialogue: (v) => [0, 4, 7, 10].includes(v as number),
  closure: (v) => v === null || bool(v),
  critical: bool,
};

export type ResultValue = boolean | number | null;

export interface ResultCriterion {
  criterion_id: string;
  value: ResultValue;
  rationale: string;
  evidence_turns: number[];
}

export interface OkEntry {
  conversation_id: string;
  status: 'ok';
  criteria: ResultCriterion[];
  score: { final_score: number | null; critical_flag: boolean };
}

export interface ErrorEntry {
  conversation_id: string;
  status: 'error';
  criteria: [];
  score: null;
  error: string;
}

export type ResultEntry = OkEntry | ErrorEntry;

export interface ResultsFile {
  schema_version: '1.0';
  team_name: string;
  model: { mode: 'local' | 'external_api' | 'hybrid'; name: string };
  results: ResultEntry[];
}

export function criterionCodes(cl: EvalChecklist): string[] {
  return cl.criteria.map((k, i) => k.code ?? CODE_BY_ID[k.id] ?? RESULT_CODES[i]);
}

const toValue = (a: EvalItem['answer']): ResultValue => (a === 'yes' ? true : a === 'no' ? false : a === 'na' ? null : a);

function evidenceTurns(item: EvalItem, conv: Conversation): number[] {
  if (item.evidence.length || !item.checked_range) return item.evidence;
  const [from, to] = item.checked_range;
  const range = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const operator = range.filter((n) => conv.transcript[n - 1]?.speaker === 'operator');
  return operator.length ? operator : range;
}

export function okEntry(conv: Conversation, cl: EvalChecklist, draft: EvaluationDraft, finalScore: number | null): OkEntry {
  const codes = criterionCodes(cl);
  const criteria = cl.criteria.map((k, i) => {
    const item = draft.items.find((it) => it.criterion_id === k.id);
    if (!item) throw new Error(`в оценке нет критерия ${k.id}`);
    return { criterion_id: codes[i], value: toValue(item.answer), rationale: item.reason, evidence_turns: evidenceTurns(item, conv) };
  });
  const critical = criteria.find((c) => c.criterion_id === 'critical');
  return {
    conversation_id: conv.conversation_id,
    status: 'ok',
    criteria,
    score: { final_score: finalScore, critical_flag: critical?.value === true },
  };
}

export function errorEntry(conversationId: string, error: string): ErrorEntry {
  return { conversation_id: conversationId, status: 'error', criteria: [], score: null, error };
}

export function resultsProblems(file: ResultsFile, expectedIds: string[]): string[] {
  const problems: string[] = [];
  if (file.schema_version !== '1.0') problems.push('schema_version должен быть "1.0"');
  if (!file.team_name?.trim()) problems.push('пустой team_name');
  if (!['local', 'external_api', 'hybrid'].includes(file.model?.mode)) problems.push('model.mode: local, external_api или hybrid');
  if (!file.model?.name?.trim()) problems.push('пустой model.name');

  const ids = file.results.map((r) => r.conversation_id);
  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (duplicates.length) problems.push(`повторяются ID: ${duplicates.join(', ')}`);
  const missing = expectedIds.filter((id) => !ids.includes(id));
  if (missing.length) problems.push(`нет записей: ${missing.join(', ')}`);
  const extra = ids.filter((id) => !expectedIds.includes(id));
  if (extra.length) problems.push(`лишние ID: ${extra.join(', ')}`);

  for (const r of file.results) {
    if (r.status === 'error') {
      if (r.criteria.length || r.score !== null || !r.error?.trim()) problems.push(`${r.conversation_id}: у ошибки должны быть пустой criteria, score = null и текст error`);
      continue;
    }
    const codes = r.criteria.map((c) => c.criterion_id);
    if (codes.length !== RESULT_CODES.length || RESULT_CODES.some((code) => codes.filter((c) => c === code).length !== 1)) {
      problems.push(`${r.conversation_id}: нужны все 8 критериев ровно по разу, сейчас: ${codes.join(', ')}`);
    }
    for (const c of r.criteria) {
      if (!ALLOWED[c.criterion_id]?.(c.value)) problems.push(`${r.conversation_id}: ${c.criterion_id} — недопустимое значение ${JSON.stringify(c.value)}`);
      if (!c.evidence_turns.every((n) => Number.isInteger(n) && n >= 1)) problems.push(`${r.conversation_id}: ${c.criterion_id} — номера реплик должны быть целыми с 1`);
      if (!c.rationale?.trim()) problems.push(`${r.conversation_id}: ${c.criterion_id} — пустой rationale`);
    }
    const critical = r.criteria.find((c) => c.criterion_id === 'critical');
    if (critical && r.score.critical_flag !== critical.value) problems.push(`${r.conversation_id}: critical_flag не совпадает с critical`);
    const s = r.score.final_score;
    if (s !== null && !(Number.isFinite(s) && s >= 0 && s <= 100 && Math.abs(Math.round(s * 100) - s * 100) < 1e-6)) {
      problems.push(`${r.conversation_id}: final_score должен быть 0–100 с двумя знаками, сейчас ${s}`);
    }
  }
  return problems;
}
