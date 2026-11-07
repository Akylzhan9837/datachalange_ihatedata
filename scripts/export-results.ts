import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateConversation, PROMPT_VERSION, type EvalChecklist, type EvaluationDraft } from '../server/evaluate.js';
import { LlmError } from '../server/llm.js';
import { errorEntry, okEntry, resultsProblems, type ResultEntry, type ResultsFile } from '../server/results.js';
import { computeScore } from '../shared/scoring.js';
import type { Conversation, DatasetResponse } from '../shared/types.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const groupArg = flag('--group');
const clPath = flag('--checklist') ?? 'data/checklists/cqa-full.json';
const team = flag('--team') ?? process.env.TEAM_NAME;
const force = args.includes('--force');
const target = args.find((a) => !a.startsWith('--'));

if ((target !== 'dev' && target !== 'prod') || (target === 'prod' && !groupArg) || !team?.trim()) {
  console.error('npx tsx scripts/export-results.ts dev|prod --team "Команда" [--group GROUP_ID] [--checklist file] [--force]');
  console.error('prod требует --group; имя команды — --team или TEAM_NAME в .env');
  process.exit(1);
}
const group = groupArg ?? 'DEV';

async function loadSet(groupId: string): Promise<Conversation[]> {
  const file = path.resolve('data/sets', `${groupId}.json`);
  if (!fs.existsSync(file)) {
    const base = process.env.CQA_API_URL;
    if (!base) throw new Error(`нет ${file} и не задан CQA_API_URL в .env`);
    const url = new URL(base);
    url.searchParams.set('group_id', groupId);
    const res = await fetch(url);
    const body = (await res.json().catch(() => null)) as DatasetResponse | null;
    if (!res.ok || !body?.isSuccess || !Array.isArray(body.data?.records)) {
      throw new Error(`API не отдал набор ${groupId}: HTTP ${res.status} ${body?.error ?? ''}`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(body, null, 2));
  }
  const body = JSON.parse(fs.readFileSync(file, 'utf-8')) as DatasetResponse;
  const records = body.data?.records;
  if (!Array.isArray(records) || records.length === 0) throw new Error(`в ${file} нет диалогов`);
  return records;
}

const cl: EvalChecklist = JSON.parse(fs.readFileSync(clPath, 'utf-8'));
const cacheDir = path.resolve('data/storage/export', target);
const runsDir = path.resolve('data/storage/tl-runs');
fs.mkdirSync(cacheDir, { recursive: true });

function cachedDraft(id: string): EvaluationDraft | null {
  const files = [path.join(cacheDir, `${id}.json`)];
  if (fs.existsSync(runsDir)) {
    files.push(...fs.readdirSync(runsDir).filter((f) => f.startsWith(`${id}.`)).sort().reverse().map((f) => path.join(runsDir, f)));
  }
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const d = JSON.parse(fs.readFileSync(f, 'utf-8')) as EvaluationDraft;
    if (d.conversation_id === id && d.checklist_id === cl.id && d.checklist_version === cl.version && d.prompt_version === PROMPT_VERSION) return d;
  }
  return null;
}

const records = await loadSet(group);
const entries: ResultEntry[] = [];
const models = new Set<string>();
let fresh = 0;
let fromCache = 0;
let llmDown: string | null = null;

for (const conv of records) {
  const id = conv.conversation_id;
  try {
    let draft = force ? null : cachedDraft(id);
    if (draft) fromCache++;
    else {
      if (llmDown) throw new Error(`не оценён: ${llmDown}`);
      draft = await evaluateConversation(conv, cl);
      fs.writeFileSync(path.join(cacheDir, `${id}.json`), JSON.stringify(draft, null, 2));
      fresh++;
    }
    const answers = draft.items.map((it) => ({
      criterion_id: it.criterion_id,
      answer: String(it.answer),
      step: typeof it.answer === 'number' ? it.answer : null,
    }));
    const score = computeScore(cl, answers);
    entries.push(okEntry(conv, cl, draft, score.total));
    for (const m of draft.model.split('+')) models.add(m);
    console.log(`${id}  ok  ${score.total}${score.gross ? '  грубая ошибка' : ''}`);
  } catch (e) {
    const message = (e as Error).message;
    if (e instanceof LlmError && message.startsWith('Gemini unavailable')) llmDown = message;
    entries.push(errorEntry(id, message));
    console.log(`${id}  ОШИБКА  ${message.slice(0, 160)}`);
  }
}

const file: ResultsFile = {
  schema_version: '1.0',
  team_name: team.trim(),
  model: { mode: 'external_api', name: [...models].join(', ') || 'Gemini API' },
  results: entries,
};
const problems = resultsProblems(file, records.map((r) => r.conversation_id));
if (target === 'prod' && records.length !== 10) problems.push(`в prod ожидается ровно 10 записей, в наборе ${records.length}`);

const outFile = path.resolve('results', target, 'results.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');

const errors = entries.filter((e) => e.status === 'error').length;
console.log(`\n${path.relative(process.cwd(), outFile)}: ${entries.length} записей, ok ${entries.length - errors}, ошибок ${errors} · новых оценок ${fresh}, из кэша ${fromCache} · модель: ${file.model.name}`);
if (problems.length) console.log(`ПРОБЛЕМЫ ФОРМАТА:\n- ${problems.join('\n- ')}`);
if (errors) console.log('Есть ошибки: запусти ещё раз позже — готовые оценки возьмутся из кэша, дооценятся только ошибочные.');
process.exit(problems.length || errors ? 1 : 0);
