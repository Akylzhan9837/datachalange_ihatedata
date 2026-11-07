// npm run eval -- --label "промпт v1"
// Сравнивает результаты системы с эталоном (data/gt/dev_gt.json) и печатает метрики и список ошибок.
// Результаты: { meta?: {...}, results: [{ conversation_id, items: [{ criterion_id, answer, step?, reason?, evidence? }] }] }
// (допустим и просто массив results; items можно назвать criteria).
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { computeScore, type Checklist, type Criterion } from '../shared/scoring.ts';
import { analyzeTranscript, crossCheck } from '../server/rules.ts';
import { loadChecklist, loadDataset, readJson, toToken, tokenStr, tokenToAnswer, type Dialog, type GtFile, type Token } from './lib.ts';

interface ResultItem { criterion_id: string; answer?: string | null; step?: number | null; reason?: string | null; evidence?: number[] }
interface ResultRow { conversation_id: string; items?: ResultItem[]; criteria?: ResultItem[] }
interface ResultsFile {
  meta?: { model?: string; prompt_version?: string; checklist_version?: string | number; invalid_json?: number; retries?: number; cost_usd?: number; time_ms?: number; calls?: number };
  results: ResultRow[];
}

const { values: o } = parseArgs({
  options: {
    gt: { type: 'string', default: 'data/gt/dev_gt.json' },
    results: { type: 'string', default: 'data/results/latest.json' },
    checklist: { type: 'string', default: 'data/checklists/default.json' },
    dataset: { type: 'string', default: 'data/sets/DEV.json' },
    label: { type: 'string', default: 'run' },
    out: { type: 'string', default: '' },
  },
});

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : '—');
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const f2 = (x: number | null) => (x === null ? '—' : x.toFixed(2));

const checklist: Checklist = loadChecklist(o.checklist!);
const gt = readJson<GtFile>(o.gt!);
const rf = readJson<ResultsFile | ResultRow[]>(o.results!);
const results = Array.isArray(rf) ? rf : rf.results;
const meta = Array.isArray(rf) ? {} : (rf.meta ?? {});
let dialogs = new Map<string, Dialog>();
try { dialogs = new Map(loadDataset(o.dataset!).map((d) => [d.conversation_id, d])); } catch { /* срезы и правила недоступны без набора */ }

const resById = new Map(results.map((r) => [r.conversation_id, r]));
const ids = Object.keys(gt).filter((id) => resById.has(id));
const missingInResults = Object.keys(gt).filter((id) => !resById.has(id));

interface Err { id: string; crit: Criterion; gt: Token; model: Token | null; reason: string; note: string; kind: string }
const errors: Err[] = [];
const per = new Map<string, { n: number; ok: number; within1: number; nScale: number }>();
const na = { gtNa: 0, missed: 0, extra: 0, naCrit: 0 };
const gross = { tp: 0, fp: 0, fn: 0 };
const slice = new Map<string, { n: number; ok: number }>();
const bump = (key: string, ok: boolean) => { const s = slice.get(key) ?? { n: 0, ok: 0 }; s.n++; if (ok) s.ok++; slice.set(key, s); };
const maeAbs: number[] = [], maeSigned: number[] = [];
let scoreSkipped = 0, flagsTotal = 0, flagsOnWrong = 0;

for (const id of ids) {
  const g = gt[id]; const row = resById.get(id)!;
  const items = row.items ?? row.criteria ?? [];
  const byCrit = new Map(items.map((i) => [i.criterion_id, i]));
  const gtAns = [], modelAns = [];
  const wrongHere = new Set<string>();

  for (const c of checklist.criteria) {
    const gv = toToken(g[c.id]);
    if (gv === null) continue; // критерий не размечен в эталоне
    const it = byCrit.get(c.id);
    const mv = it ? toToken(it.answer, it.step) : null;
    const ok = mv !== null && mv === gv;
    const p = per.get(c.id) ?? { n: 0, ok: 0, within1: 0, nScale: 0 };
    p.n++; if (ok) p.ok++;
    if (c.type === 'scale' && typeof gv === 'number') {
      p.nScale++;
      const steps = [...(c.steps ?? [])].sort((a, b) => a - b);
      if (typeof mv === 'number' && Math.abs(steps.indexOf(mv) - steps.indexOf(gv)) <= 1) p.within1++;
    }
    per.set(c.id, p);
    const d = dialogs.get(id);
    if (d) { bump(`язык ${d.language}`, ok); bump(`канал ${d.channel}`, ok); }

    if (c.na_allowed) { na.naCrit++; if (gv === 'na') na.gtNa++; if (gv === 'na' && mv !== 'na') na.missed++; if (gv !== 'na' && mv === 'na') na.extra++; }
    if (c.is_gross) { if (gv === 'yes' && mv === 'yes') gross.tp++; if (gv !== 'yes' && mv === 'yes') gross.fp++; if (gv === 'yes' && mv !== 'yes') gross.fn++; }
    if (!ok) {
      wrongHere.add(c.id);
      const kind = mv === null ? 'нет ответа' : gv === 'na' ? 'лишний ответ вместо N/A' : mv === 'na' ? 'пропущен: модель дала N/A' : typeof gv === 'number' ? 'другая ступень' : 'другой ответ';
      errors.push({ id, crit: c, gt: gv, model: mv, reason: (it?.reason ?? '').toString(), note: String(g._note ?? ''), kind });
    }
    gtAns.push(tokenToAnswer(c.id, gv));
    if (mv !== null) modelAns.push(tokenToAnswer(c.id, mv));
  }

  // MAE итога: оба итога считает shared/scoring.ts
  try {
    const a = computeScore(checklist, gtAns).total, b = computeScore(checklist, modelAns).total;
    if (a === null || b === null) scoreSkipped++; else { maeAbs.push(Math.abs(a - b)); maeSigned.push(b - a); }
  } catch { scoreSkipped++; }

  // Правила-подсказки: сколько флагов «проверить» указали на реальную ошибку модели
  const d = dialogs.get(id);
  if (d) {
    const flags = crossCheck(analyzeTranscript(d.transcript, d.language), items);
    flagsTotal += flags.length; flagsOnWrong += flags.filter((f) => wrongHere.has(f.criterion_id)).length;
  }
}

// ---- вывод ----
const L: string[] = [];
const total = [...per.values()].reduce((s, p) => ({ n: s.n + p.n, ok: s.ok + p.ok }), { n: 0, ok: 0 });
L.push(`# Прогон «${o.label}»`, '', `Диалогов в эталоне: ${Object.keys(gt).length}, сравнено: ${ids.length}${missingInResults.length ? `, нет в результатах: ${missingInResults.join(', ')}` : ''}`,
  `Чек-лист: ${checklist.id} v${checklist.version}${meta.model ? ` · модель ${meta.model}` : ''}${meta.prompt_version ? ` · промпт ${meta.prompt_version}` : ''}`, '');
L.push('## Точность по критериям (точное совпадение)', '', '| критерий | n | совпало | % | ±1 ступень |', '|---|---|---|---|---|');
for (const c of checklist.criteria) {
  const p = per.get(c.id); if (!p) continue;
  L.push(`| ${c.id} ${c.title} | ${p.n} | ${p.ok} | ${pct(p.ok, p.n)} | ${p.nScale ? pct(p.within1, p.nScale) : ''} |`);
}
L.push(`| **все** | ${total.n} | ${total.ok} | ${pct(total.ok, total.n)} | |`, '');
L.push('## Итоговый балл', '', `MAE: **${f2(mean(maeAbs))}** (модель − эталон в среднем: ${f2(mean(maeSigned))}; считано по ${maeAbs.length} диалогам${scoreSkipped ? `, пропущено ${scoreSkipped}` : ''})`, '');
L.push('## N/A', '', `В эталоне N/A: ${na.gtNa} из ${na.naCrit} возможных. Модель не дала N/A там, где он в эталоне: **${na.missed}**. Лишний N/A у модели: **${na.extra}**.`, '');
L.push('## Грубые ошибки', '', `TP ${gross.tp} · FP ${gross.fp} · FN ${gross.fn} · precision ${pct(gross.tp, gross.tp + gross.fp)} · recall ${pct(gross.tp, gross.tp + gross.fn)}`, '');
if (slice.size) { L.push('## Срезы (доля совпавших ответов)', '', '| срез | n | % |', '|---|---|---|'); for (const [k, v] of [...slice].sort()) L.push(`| ${k} | ${v.n} | ${pct(v.ok, v.n)} |`); L.push(''); }
L.push('## Система', '', `Невалидный JSON: ${meta.invalid_json ?? '—'} · ретраев: ${meta.retries ?? '—'} · стоимость, $: ${meta.cost_usd ?? '—'} · время, мс: ${meta.time_ms ?? '—'}`,
  `Флаги правил «проверить»: ${flagsTotal}, из них указали на реальную ошибку модели: ${flagsOnWrong}`, '');
L.push(`## Ошибки (${errors.length})`, '', 'диалог · критерий · эталон → модель · тип · почему');
const order = new Map(checklist.criteria.map((c, i) => [c.id, i]));
errors.sort((a, b) => a.id.localeCompare(b.id) || order.get(a.crit.id)! - order.get(b.crit.id)!);
for (const e of errors) L.push(`- ${e.id} · ${e.crit.id} ${e.crit.title} · эталон ${tokenStr(e.gt)} → модель ${tokenStr(e.model)} · ${e.kind}${e.reason ? ` · модель: «${e.reason.slice(0, 160)}»` : ''}${e.note ? ` · эталон: «${e.note.slice(0, 120)}»` : ''}`);
L.push('', '## Строка для журнала docs/06', '');
const cols = checklist.criteria.map((c) => { const p = per.get(c.id); return p ? pct(p.ok, p.n) : ''; });
L.push(`| E-?? | ${new Date().toISOString().slice(0, 16).replace('T', ' ')} | ${o.label} | ${cols.join(' | ')} | ${f2(mean(maeAbs))} | |`);

const text = L.join('\n');
console.log(text);
const out = o.out || `data/results/${o.label.replace(/[^\p{L}\p{N}]+/gu, '_')}.report.md`;
mkdirSync('data/results', { recursive: true });
writeFileSync(out, text + '\n');
console.error(`\nОтчёт сохранён: ${out}`);
