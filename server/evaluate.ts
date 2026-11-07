import fs from 'node:fs';
import path from 'node:path';
import type { Checklist, ChecklistCriterion, Conversation } from '../shared/types.js';
import { geminiCall, type LlmCall, type LlmUsage } from './llm.js';

export const PROMPT_VERSION = 'v1';

export interface EvalCriterion extends ChecklistCriterion {
  na_condition?: string;
  step_desc?: Record<string, string>;
  guidance?: string[];
  code?: string;
}
export interface EvalChecklist extends Checklist {
  criteria: EvalCriterion[];
  guidelines?: string[];
}

export type Answer = 'yes' | 'no' | 'na' | number;

export interface EvalItem {
  criterion_id: string;
  analysis: string;
  answer: Answer;
  evidence: number[];
  checked_range: [number, number] | null;
  reason: string;
  na_reason: string | null;
  needs_review: boolean;
  review_reason: string | null;
}

export interface EvaluationDraft {
  conversation_id: string;
  checklist_id: string;
  checklist_version: number;
  prompt_version: string;
  model: string;
  votes: number;
  usage: LlmUsage & { calls: number };
  cost_usd: number;
  duration_ms: number;
  created_at: string;
  items: EvalItem[];
}

export class EvaluationError extends Error {}

const ROLE: Record<string, string> = { client: 'КЛИЕНТ', operator: 'ОПЕРАТОР', bot: 'БОТ', system: 'СИСТЕМА' };

const isoMs = (ts: string) => Date.parse(ts.replace(/(\.\d{3})\d+/, '$1'));
const mmss = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

export function renderTranscript(conv: Conversation): string {
  const t0 = isoMs(conv.transcript[0]?.timestamp ?? '');
  const lines = conv.transcript.map((m, i) => {
    const ms = isoMs(String(m.timestamp ?? ''));
    const time = Number.isNaN(ms) || Number.isNaN(t0) ? m.timestamp : mmss(Math.max(0, (ms - t0) / 1000));
    return `[#${i + 1} ${ROLE[m.speaker] ?? String(m.speaker).toUpperCase()} ${time}] ${String(m.text ?? '').replace(/\s*\n\s*/g, ' ')}`;
  });
  return `ДИАЛОГ ${conv.conversation_id}\nКанал: ${conv.channel} · Язык: ${conv.language} · Реплик: ${conv.transcript.length}\n\n${lines.join('\n')}`;
}

function renderCriterion(k: EvalCriterion): string {
  const out = [`КРИТЕРИЙ ${k.id}. ${k.title}`, `Секция: ${k.section}`];
  if (k.is_gross) out.push('Это флаг грубого нарушения: "yes" — нарушение найдено, "no" — не найдено. На баллы не влияет.');
  out.push(`Что оценивается: ${k.description}`);
  const na = k.na_allowed ? ' или "na" (N/A)' : '';
  if (k.type === 'scale') {
    const steps = k.steps ?? [];
    out.push(`Ответ: одна ступень из ${steps.join(', ')}${na}.`);
    const desc = [...steps].reverse().map((s) => `- ${s}${k.step_desc?.[String(s)] ? ` — ${k.step_desc[String(s)]}` : ''}`);
    out.push('Ступени:', ...desc);
  } else {
    out.push(`Ответ: "yes" (Да) или "no" (Нет)${na}.`);
  }
  out.push(k.na_allowed ? `N/A разрешён ТОЛЬКО если: ${k.na_condition ?? 'условие не задано — ставь N/A только при явной неприменимости'}` : 'N/A для этого критерия запрещён.');
  if (k.guidance?.length) out.push('Уточнения:', ...k.guidance.map((g) => `- ${g}`));
  return out.join('\n');
}

export function renderChecklist(cl: EvalChecklist): string {
  const parts = [`ЧЕК-ЛИСТ: ${cl.title} (версия ${cl.version})`];
  if (cl.guidelines?.length) parts.push('ПРАВИЛА ЭТОГО ЧЕК-ЛИСТА', ...cl.guidelines.map((g) => `- ${g}`));
  parts.push('', ...cl.criteria.map(renderCriterion).flatMap((c) => [c, '']));
  return parts.join('\n').trimEnd();
}

export function checklistProblems(cl: EvalChecklist): string[] {
  if (!Array.isArray(cl?.criteria) || cl.criteria.length === 0) return ['в чек-листе нет критериев'];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const k of cl.criteria) {
    const id = typeof k?.id === 'string' ? k.id.trim() : '';
    if (!id) { problems.push('у критерия нет id'); continue; }
    if (seen.has(id)) problems.push(`критерий ${id}: id повторяется`);
    seen.add(id);
    if (!k.title?.trim() && !k.description?.trim()) problems.push(`критерий ${id}: нет ни названия, ни описания`);
    if (k.type === 'scale') {
      const steps = k.steps ?? [];
      if (steps.length < 2 || !steps.every((s) => Number.isFinite(s))) problems.push(`критерий ${id}: у шкалы нужно минимум 2 числовые ступени в steps`);
    } else if (k.type !== 'binary') {
      problems.push(`критерий ${id}: type должен быть binary или scale`);
    }
  }
  return problems;
}

export function buildSchema(cl: EvalChecklist): object {
  const answers = new Set<string>(['yes', 'no', 'na']);
  for (const k of cl.criteria) if (k.type === 'scale') for (const s of k.steps ?? []) answers.add(String(s));
  const n = cl.criteria.length;
  return {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        minItems: n,
        maxItems: n,
        items: {
          type: 'object',
          properties: {
            criterion_id: { type: 'string', enum: cl.criteria.map((k) => k.id) },
            analysis: { type: 'string' },
            answer: { type: 'string', enum: [...answers] },
            evidence: { type: 'array', items: { type: 'integer' } },
            checked_range: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 },
            reason: { type: 'string' },
            na_reason: { type: 'string' },
          },
          required: ['criterion_id', 'analysis', 'answer', 'evidence', 'reason'],
        },
      },
    },
    required: ['items'],
  };
}

let systemCache: string | null = null;
function systemPrompt(): string {
  systemCache ??= fs.readFileSync(path.resolve(process.cwd(), 'prompts', 'system.md'), 'utf-8');
  return systemCache;
}

export function buildPrompt(cl: EvalChecklist, conv: Conversation) {
  return { system: `${systemPrompt()}\n\n${renderChecklist(cl)}`, user: renderTranscript(conv), schema: buildSchema(cl) };
}

interface Checked { items: EvalItem[]; hard: string[] }

export function checkAnswer(cl: EvalChecklist, conv: Conversation, text: string): Checked {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch {
    return { items: [], hard: ['ответ не является JSON'] };
  }
  const raw = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(raw)) return { items: [], hard: ['нет массива items'] };

  const n = conv.transcript.length;
  const hard: string[] = [];
  const items: EvalItem[] = [];
  for (const k of cl.criteria) {
    const found = raw.filter((r) => r?.criterion_id === k.id);
    if (found.length !== 1) { hard.push(`критерий ${k.id}: ожидался ровно 1 ответ, получено ${found.length}`); continue; }
    const r = found[0];
    const a = String(r.answer);
    let answer: Answer;
    if (a === 'na') {
      if (!k.na_allowed) { hard.push(`критерий ${k.id}: N/A запрещён`); continue; }
      answer = 'na';
    } else if (k.type === 'scale') {
      const step = Number(a);
      if (!(k.steps ?? []).includes(step) || a.trim() === '') { hard.push(`критерий ${k.id}: ступень должна быть одной из ${(k.steps ?? []).join('/')}`); continue; }
      answer = step;
    } else if (a === 'yes' || a === 'no') {
      answer = a;
    } else { hard.push(`критерий ${k.id}: ожидалось yes/no${k.na_allowed ? '/na' : ''}`); continue; }

    const soft: string[] = [];
    const nums: number[] = Array.isArray(r.evidence) ? r.evidence.filter((x: unknown) => Number.isInteger(x)) : [];
    const outside = nums.filter((x) => x < 1 || x > n);
    if (outside.length) soft.push(`номер реплики вне диапазона 1–${n}: ${outside.join(', ')}`);
    const evidence = [...new Set(nums.filter((x) => x >= 1 && x <= n))].sort((x, y) => x - y);
    let cr: [number, number] | null = null;
    if (r.checked_range != null) {
      const c = r.checked_range;
      if (Array.isArray(c) && c.length === 2 && c.every((x: unknown) => Number.isInteger(x)) && c[0] >= 1 && c[0] <= c[1] && c[1] <= n) cr = [c[0], c[1]];
      else soft.push('некорректный checked_range');
    }
    if (answer === 'no' && !cr && evidence.length === 0) soft.push('для «Нет» нет ни доказательства, ни проверенного участка');
    if (answer !== 'no' && answer !== 'na' && evidence.length === 0) soft.push('нет реплики-доказательства');
    const naReason = typeof r.na_reason === 'string' && r.na_reason.trim() ? r.na_reason.trim() : null;
    if (answer === 'na' && !naReason) soft.push('для N/A нет причины');
    const reason = typeof r.reason === 'string' ? r.reason.trim() : '';
    if (!reason) soft.push('нет обоснования');

    items.push({
      criterion_id: k.id,
      analysis: typeof r.analysis === 'string' ? r.analysis : '',
      answer,
      evidence,
      checked_range: cr,
      reason,
      na_reason: answer === 'na' ? naReason : null,
      needs_review: soft.length > 0,
      review_reason: soft.length ? soft.join('; ') : null,
    });
  }
  return { items, hard };
}

interface Run { items: EvalItem[]; model: string; usage: LlmUsage & { calls: number } }

async function runOnce(conv: Conversation, cl: EvalChecklist, llm: LlmCall): Promise<Run> {
  const prompt = buildPrompt(cl, conv);
  const usage = { calls: 0, input_tokens: 0, output_tokens: 0 };
  let user = prompt.user;
  for (let attempt = 1; ; attempt++) {
    const res = await llm({ ...prompt, user });
    usage.calls++;
    usage.input_tokens += res.usage.input_tokens;
    usage.output_tokens += res.usage.output_tokens;
    const { items, hard } = checkAnswer(cl, conv, res.text);
    if (hard.length === 0) return { items, model: res.model, usage };
    if (attempt === 2) throw new EvaluationError(`ответ модели не прошёл проверку после повтора: ${hard.join('; ')}`);
    user = `${prompt.user}\n\nПРЕДЫДУЩИЙ ОТВЕТ НЕ ПРОШЁЛ ПРОВЕРКУ:\n${hard.map((h) => `- ${h}`).join('\n')}\nВерни полный ответ заново, по одному на каждый критерий, только разрешёнными значениями.`;
  }
}

function combineVotes(cl: EvalChecklist, runs: EvalItem[][]): EvalItem[] {
  return cl.criteria.map((k) => {
    const options = runs.map((items) => items.find((i) => i.criterion_id === k.id)!);
    if (options.length === 1) return options[0];
    const counts = new Map<string, number>();
    for (const o of options) counts.set(String(o.answer), (counts.get(String(o.answer)) ?? 0) + 1);
    const top = Math.max(...counts.values());
    const leaders = [...counts].filter(([, c]) => c === top).map(([a]) => a);
    let chosen = options.find((o) => leaders.includes(String(o.answer)))!;
    if (leaders.length > 1 && options.every((o) => typeof o.answer === 'number')) {
      const sorted = [...options].sort((x, y) => (x.answer as number) - (y.answer as number));
      chosen = sorted[Math.floor((sorted.length - 1) / 2)];
    }
    if (counts.size === 1) return chosen;
    const spread = [...counts].map(([a, c]) => `${a}×${c}`).join(', ');
    return { ...chosen, needs_review: true, review_reason: [chosen.review_reason, `прогоны разошлись: ${spread}`].filter(Boolean).join('; ') };
  });
}

export async function evaluateConversation(
  conv: Conversation,
  cl: EvalChecklist,
  llm: LlmCall = geminiCall(),
  votes = Math.max(1, Math.floor(Number(process.env.CQA_VOTES) || 1)),
): Promise<EvaluationDraft> {
  if (!conv?.transcript?.length) throw new EvaluationError('пустой транскрипт');
  const problems = checklistProblems(cl);
  if (problems.length) throw new EvaluationError(`чек-лист некорректен: ${problems.join('; ')}`);
  const started = Date.now();
  const runs: Run[] = [];
  for (let v = 0; v < votes; v++) runs.push(await runOnce(conv, cl, llm));
  return {
    conversation_id: conv.conversation_id,
    checklist_id: cl.id,
    checklist_version: cl.version,
    prompt_version: PROMPT_VERSION,
    model: [...new Set(runs.map((r) => r.model))].join('+'),
    votes,
    usage: runs.reduce((u, r) => ({
      calls: u.calls + r.usage.calls,
      input_tokens: u.input_tokens + r.usage.input_tokens,
      output_tokens: u.output_tokens + r.usage.output_tokens,
    }), { calls: 0, input_tokens: 0, output_tokens: 0 }),
    cost_usd: 0,
    duration_ms: Date.now() - started,
    created_at: new Date().toISOString(),
    items: combineVotes(cl, runs.map((r) => r.items)),
  };
}
