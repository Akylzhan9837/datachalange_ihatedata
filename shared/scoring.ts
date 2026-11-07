// Расчёт баллов по чек-листу. Единственное место, где считается итог (RULES §3).
// Модель возвращает ответы по критериям, итог считает только этот файл.

export type CriterionType = 'binary' | 'scale';

export interface Criterion {
  id: string;
  title: string;
  description?: string;
  type: CriterionType;
  /** Ступени шкалы (для type = 'scale'). Верхняя ступень даёт полный вес. */
  steps?: number[];
  na_allowed: boolean;
  na_condition?: string;
  weight: number;
  section?: string;
  /** Грубая ошибка: отдельный флаг, на итог не влияет. «Да» = нарушение выявлено. */
  is_gross?: boolean;
}

export interface Checklist {
  id: string;
  version: number | string;
  title?: string;
  sections?: { id: string; title: string }[];
  criteria: Criterion[];
}

/** Ответ по одному критерию. Для шкалы достаточно step; answer = 'na' даёт N/A. */
export interface CriterionAnswer {
  criterion_id: string;
  answer?: string | null;
  step?: number | null;
}

export interface ScoredItem {
  criterion_id: string;
  section: string | null;
  weight: number;
  applicable: boolean;
  /** Баллы до перераспределения N/A (0…weight). */
  raw_points: number;
  /** Баллы после перераспределения (в сумме дают итог). */
  points: number;
  /** Максимум после перераспределения (в сумме 100). */
  max_points: number;
}

export interface ScoredSection {
  id: string;
  title: string;
  /** Процент внутри секции или null, если применимых критериев нет. */
  score: number | null;
}

export interface ScoreResult {
  /** 0…100 с двумя знаками или null, если применимых критериев с весом нет. */
  total: number | null;
  items: ScoredItem[];
  sections: ScoredSection[];
  gross: boolean;
}

export class ScoringError extends Error {
  constructor(public problems: string[]) {
    super(`Ошибка расчёта баллов: ${problems.join('; ')}`);
    this.name = 'ScoringError';
  }
}

/** Округление до 2 знаков, половина вверх; 1e-9 гасит ошибку двоичной дроби (12.345 → 12.35). */
export function round2(x: number): number {
  return Math.round(x * 100 + 1e-9) / 100;
}

export const isNA = (a: CriterionAnswer): boolean => String(a.answer ?? '').toLowerCase() === 'na';

/** Проверка чек-листа: уникальные id, неотрицательные веса, шкалы. */
export function validateChecklist(checklist: Checklist): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const c of checklist.criteria) {
    if (seen.has(c.id)) problems.push(`критерий ${c.id}: повторяется id`);
    seen.add(c.id);
    if (!Number.isFinite(c.weight) || c.weight < 0) problems.push(`критерий ${c.id}: вес должен быть числом ≥ 0`);
    if (c.type === 'scale') {
      const max = c.steps && c.steps.length ? Math.max(...c.steps) : 0;
      if (!c.steps || c.steps.length < 2 || !(max > 0)) problems.push(`критерий ${c.id}: у шкалы нужно минимум две ступени и максимум > 0`);
    }
  }
  return problems;
}

/** Проверка ответов: все критерии отвечены, N/A только где разрешён, ступень из шкалы. */
export function validateAnswers(checklist: Checklist, answers: CriterionAnswer[]): string[] {
  const problems = validateChecklist(checklist);
  const byId = new Map<string, CriterionAnswer>();
  for (const a of answers) {
    if (byId.has(a.criterion_id)) problems.push(`критерий ${a.criterion_id}: ответ повторяется`);
    byId.set(a.criterion_id, a);
  }
  const known = new Set(checklist.criteria.map((c) => c.id));
  for (const id of byId.keys()) if (!known.has(id)) problems.push(`критерий ${id}: нет в чек-листе`);

  for (const c of checklist.criteria) {
    const a = byId.get(c.id);
    if (!a) {
      problems.push(`критерий ${c.id}: нет ответа`);
      continue;
    }
    if (isNA(a)) {
      if (!c.na_allowed) problems.push(`критерий ${c.id}: N/A не разрешён`);
      continue;
    }
    if (c.type === 'scale') {
      if (typeof a.step !== 'number' || !(c.steps ?? []).includes(a.step)) {
        problems.push(`критерий ${c.id}: ступень ${String(a.step)} не из шкалы [${(c.steps ?? []).join(', ')}]`);
      }
    } else {
      const v = String(a.answer ?? '').toLowerCase();
      if (v !== 'yes' && v !== 'no') problems.push(`критерий ${c.id}: ответ должен быть yes, no или na, получено «${String(a.answer)}»`);
    }
  }
  return problems;
}

/** Баллы критерия до перераспределения. Предполагает уже проверенный ответ. */
function rawPoints(c: Criterion, a: CriterionAnswer): number {
  if (c.type === 'scale') {
    const max = Math.max(...(c.steps as number[]));
    return (c.weight * (a.step as number)) / max;
  }
  return String(a.answer).toLowerCase() === 'yes' ? c.weight : 0;
}

/**
 * Итог по чек-листу.
 * Применимы критерии с весом > 0, не N/A и не грубые. Вес N/A-критериев перераспределяется
 * пропорционально: total = Σ баллов / Σ весов применимых × 100.
 * Бросает ScoringError, если ответы не проходят validateAnswers.
 */
export function computeScore(checklist: Checklist, answers: CriterionAnswer[]): ScoreResult {
  const problems = validateAnswers(checklist, answers);
  if (problems.length) throw new ScoringError(problems);

  const byId = new Map(answers.map((a) => [a.criterion_id, a]));
  const scoring = checklist.criteria.filter((c) => !c.is_gross);

  const applicable = (c: Criterion) => c.weight > 0 && !isNA(byId.get(c.id) as CriterionAnswer);
  const weightSum = scoring.filter(applicable).reduce((s, c) => s + c.weight, 0);

  const items: ScoredItem[] = scoring.map((c) => {
    const a = byId.get(c.id) as CriterionAnswer;
    const ok = applicable(c);
    const raw = ok ? rawPoints(c, a) : 0;
    const k = ok && weightSum > 0 ? 100 / weightSum : 0;
    return {
      criterion_id: c.id,
      section: c.section ?? null,
      weight: c.weight,
      applicable: ok,
      raw_points: round2(raw),
      points: round2(raw * k),
      max_points: round2(ok ? c.weight * k : 0),
    };
  });

  const rawExact = (c: Criterion) => (applicable(c) ? rawPoints(c, byId.get(c.id) as CriterionAnswer) : 0);
  const total = weightSum > 0 ? round2((scoring.reduce((s, c) => s + rawExact(c), 0) / weightSum) * 100) : null;

  const sectionDefs = checklist.sections ?? [];
  const sections: ScoredSection[] = sectionDefs
    .map((s) => {
      const inSection = scoring.filter((c) => c.section === s.id);
      const w = inSection.filter(applicable).reduce((sum, c) => sum + c.weight, 0);
      const p = inSection.reduce((sum, c) => sum + rawExact(c), 0);
      return { id: s.id, title: s.title, score: w > 0 ? round2((p / w) * 100) : null, hasScoring: inSection.length > 0 };
    })
    .filter((s) => s.hasScoring)
    .map(({ id, title, score }) => ({ id, title, score }));

  const gross = checklist.criteria.some(
    (c) => c.is_gross && String(byId.get(c.id)?.answer ?? '').toLowerCase() === 'yes',
  );

  return { total, items, sections, gross };
}
