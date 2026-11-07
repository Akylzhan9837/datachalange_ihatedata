// Общие загрузчики для eval.ts и gt.ts (файлы Б2).
import { existsSync, readFileSync } from 'node:fs';
import type { Checklist, CriterionAnswer } from '../shared/scoring.ts';
import type { Utterance } from '../server/rules.ts';

export interface Dialog { conversation_id: string; channel: string; language: string; transcript: Utterance[]; audio_url: string | null }
/** Эталон: { "<conversation_id>": { "01": "yes", "04": 20, ..., "_note": "..." } } — формат из docs/06. */
export type GtFile = Record<string, Record<string, string | number | null>>;
/** Сжатое значение ответа: yes | no | na | число (ступень шкалы). */
export type Token = 'yes' | 'no' | 'na' | number;

export function readJson<T>(path: string): T {
  if (!existsSync(path)) throw new Error(`Нет файла ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function loadDataset(path: string): Dialog[] {
  const j = readJson<{ data?: { records?: Dialog[] } } | Dialog[]>(path);
  return Array.isArray(j) ? j : (j.data?.records ?? []);
}

export const loadChecklist = (path: string) => readJson<Checklist>(path);

/** Значение из эталона или результата → Token. Неизвестное → null. */
export function toToken(v: unknown, step?: unknown): Token | null {
  if (typeof step === 'number') return step;
  if (typeof v === 'number') return v;
  const s = String(v ?? '').toLowerCase().trim();
  if (s === 'yes' || s === 'no' || s === 'na') return s;
  if (s === 'n/a') return 'na';
  if (/^\d+$/.test(s)) return Number(s);
  return null;
}

export function tokenToAnswer(id: string, t: Token): CriterionAnswer {
  return typeof t === 'number' ? { criterion_id: id, answer: 'scale', step: t } : { criterion_id: id, answer: t };
}

export const tokenStr = (t: Token | null | undefined) => (t === null || t === undefined ? '—' : String(t));
