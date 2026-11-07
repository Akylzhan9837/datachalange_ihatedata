import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateConversation, type EvalChecklist } from '../server/evaluate.js';
import { geminiCall } from '../server/llm.js';
import type { Conversation } from '../shared/types.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const setPath = flag('--set') ?? 'data/sets/DEV.json';
const clPath = flag('--checklist') ?? 'data/checklists/cqa-full.json';
const ids = args.filter((a) => !a.startsWith('--'));

if (!ids.length) {
  console.error('npx tsx scripts/try.ts <conversation_id>... [--set file] [--checklist file]');
  process.exit(1);
}

const cl: EvalChecklist = JSON.parse(fs.readFileSync(clPath, 'utf-8'));
const records: Conversation[] = JSON.parse(fs.readFileSync(setPath, 'utf-8')).data.records;
const llm = geminiCall();
const outDir = path.resolve('data/storage/tl-runs');
fs.mkdirSync(outDir, { recursive: true });

for (const id of ids) {
  const conv = records.find((r) => r.conversation_id === id);
  if (!conv) {
    console.error(`${id}: нет в ${setPath}`);
    continue;
  }
  try {
    const r = await evaluateConversation(conv, cl, llm);
    const votes = r.votes > 1 ? ` · голосов ${r.votes}` : '';
    const file = path.join(outDir, `${id}.${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(r, null, 2));
    console.log(`\n${id} · ${r.model} · вызовов ${r.usage.calls}${votes} · токены ${r.usage.input_tokens}/${r.usage.output_tokens} · ${r.duration_ms} мс`);
    for (const i of r.items) {
      const ev = i.evidence.map((n) => `#${n}`).join(',') || '—';
      const rng = i.checked_range ? ` [#${i.checked_range[0]}–#${i.checked_range[1]}]` : '';
      const flagText = i.needs_review ? ` ⚠ ${i.review_reason}` : '';
      console.log(`  ${i.criterion_id}  ${String(i.answer).padEnd(4)} ${ev}${rng}  ${i.reason}${flagText}`);
    }
    console.log(`  → ${path.relative(process.cwd(), file)}`);
  } catch (e) {
    console.error(`${id}: ${(e as Error).message}`);
  }
}
