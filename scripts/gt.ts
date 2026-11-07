// Помощник разметки эталона (Б2). Эталон размечают люди; скрипт только показывает диалоги и проверяет файл.
//   npm run gt -- list                 список диалогов и что уже размечено
//   npm run gt -- plan                 с каких 20 диалогов начать (по структуре, не по оценкам)
//   npm run gt -- show p1-ru-001       диалог с номерами реплик (--hints: ещё и подсказки правил)
//   npm run gt -- stub p1-ru-001       заготовка записи для data/gt/dev_gt.json
//   npm run gt -- check                проверка файла эталона и прогресс по целям T+5 (10) и T+9 (20)
import { existsSync } from 'node:fs';
import { analyzeTranscript, type ClosingKind } from '../server/rules.ts';
import { loadChecklist, loadDataset, readJson, toToken, type Dialog, type GtFile } from './lib.ts';

const GT = 'data/gt/dev_gt.json', SET = 'data/sets/DEV.json', CL = 'data/checklists/default.json';
const [cmd, arg, ...rest] = process.argv.slice(2);
const dialogs = loadDataset(SET);
const gt: GtFile = existsSync(GT) ? readJson<GtFile>(GT) : {};

const clock = (ts: string) => (/^\d{4}-/.test(ts) ? ts.slice(11, 19) : ts); // только показ; в данных метки не меняем
function show(d: Dialog, hints: boolean) {
  console.log(`# ${d.conversation_id} · ${d.channel} · ${d.language} · реплик ${d.transcript.length}${d.audio_url ? ' · есть запись' : ''}`);
  d.transcript.forEach((u, i) => console.log(`[${String(i).padStart(3)}] ${clock(u.timestamp)} ${u.speaker.padEnd(8)} ${u.text}`));
  if (hints) {
    const h = analyzeTranscript(d.transcript, d.language);
    console.log('\n-- подсказки правил (смотри ПОСЛЕ своей разметки) --');
    console.log(`первая реплика оператора: ${h.firstOperatorIndex} · приветствие: ${h.greeting.lang ?? 'нет'} · представился: ${h.introduction ? 'да' : 'нет'}`);
    console.log(`прощание: ${h.farewell.found ? `да (реплика ${h.farewell.index})` : 'нет'} · закрытие: ${h.closing.kind ?? '—'} · «личность подтверждена»: ${h.identityVerified.found ? 'да' : 'нет'}`);
  }
}

function plan(): string[] {
  const picked: string[] = [];
  const add = (ids: string[], max: number) => { let n = 0; for (const id of ids) if (n < max && !picked.includes(id)) { picked.push(id); n++; } };
  const info = dialogs.map((d) => ({ d, h: analyzeTranscript(d.transcript, d.language) }));
  const chats = info.filter((x) => x.d.channel !== 'voice call');
  const byKind = (k: ClosingKind) => chats.filter((x) => x.h.closing.kind === k).map((x) => x.d.conversation_id);
  const interleave = (ids: string[]) => { // по одному на язык по кругу, чтобы покрыть RU/KZ/EN
    const g: Record<string, string[]> = {};
    for (const id of ids) (g[dialogs.find((d) => d.conversation_id === id)!.language] ??= []).push(id);
    const out: string[] = []; for (let i = 0; Object.values(g).some((a) => i < a.length); i++) for (const a of Object.values(g)) if (a[i]) out.push(a[i]);
    return out;
  };
  // Сначала чаты (так просил ТЛ), звонки в конце: они длинные и тяжёлые для разметки.
  add(interleave(byKind('operator_closed')), 4); // чат закрыл оператор: «Завершение», возможные грубые ошибки
  add(interleave([...byKind('client_left'), ...byKind('connection_lost')]), 4); // оборванные: N/A у 04 и 07
  add(interleave(chats.filter((x) => x.h.identityVerified.found).map((x) => x.d.conversation_id)), 3); // идентификация
  add(interleave(chats.filter((x) => !x.h.greeting.found || !x.h.introduction).map((x) => x.d.conversation_id)), 3); // 01
  add([...chats].sort((a, b) => b.d.transcript.length - a.d.transcript.length).map((x) => x.d.conversation_id), 15 - picked.length); // длинные
  add(info.filter((x) => x.d.channel === 'voice call').map((x) => x.d.conversation_id), 5); // все звонки
  return picked.slice(0, 20);
}

if (cmd === 'list') {
  for (const d of dialogs) console.log(`${gt[d.conversation_id] ? '✔' : ' '} ${d.conversation_id.padEnd(10)} ${d.channel.padEnd(10)} ${d.language} ${String(d.transcript.length).padStart(4)} реплик`);
} else if (cmd === 'plan') {
  const p = plan();
  console.log('Порядок разметки: сначала 15 чатов, затем 5 звонков (10 к T+5, 20 к T+9). Выбор по структуре диалога, не по оценкам:\n');
  p.forEach((id, i) => { const d = dialogs.find((x) => x.conversation_id === id)!; console.log(`${String(i + 1).padStart(2)}. ${gt[id] ? '✔' : ' '} ${id.padEnd(10)} ${d.channel.padEnd(10)} ${d.language}`); });
} else if (cmd === 'show' && arg) {
  const d = dialogs.find((x) => x.conversation_id === arg);
  if (!d) { console.error(`Нет диалога ${arg}`); process.exit(1); }
  show(d, rest.includes('--hints') || arg === '--hints');
} else if (cmd === 'stub' && arg) {
  const cl = loadChecklist(CL);
  const o: Record<string, string | null> = {};
  for (const c of cl.criteria) o[c.id] = null;
  o._note = '';
  console.log(JSON.stringify({ [arg]: o }, null, 2));
} else if (cmd === 'check') {
  const cl = loadChecklist(CL);
  const byId = new Map(dialogs.map((d) => [d.conversation_id, d]));
  const problems: string[] = [];
  for (const [id, rec] of Object.entries(gt)) {
    if (!byId.has(id)) { problems.push(`${id}: нет в наборе DEV`); continue; }
    for (const c of cl.criteria) {
      const t = toToken(rec[c.id]);
      if (t === null) { problems.push(`${id} · ${c.id}: нет ответа`); continue; }
      if (t === 'na' && !c.na_allowed) problems.push(`${id} · ${c.id}: N/A не разрешён`);
      else if (c.type === 'scale' && t !== 'na' && !(c.steps ?? []).includes(t as number)) problems.push(`${id} · ${c.id}: ступень ${t} не из шкалы`);
      else if (c.type === 'binary' && t !== 'na' && t !== 'yes' && t !== 'no') problems.push(`${id} · ${c.id}: ожидалось yes/no${c.na_allowed ? '/na' : ''}`);
    }
    for (const k of Object.keys(rec)) if (k !== '_note' && !cl.criteria.some((c) => c.id === k)) problems.push(`${id}: лишний ключ ${k}`);
  }
  const ids = Object.keys(gt).filter((id) => byId.has(id));
  const cnt = (f: (d: Dialog) => boolean) => ids.filter((id) => f(byId.get(id)!)).length;
  console.log(`Размечено: ${ids.length} из 65 (цель: 10 к T+5, 20 к T+9)`);
  console.log(`RU ${cnt((d) => d.language === 'RU' && d.channel !== 'voice call')} · KZ ${cnt((d) => d.language === 'KZ')} · EN ${cnt((d) => d.language === 'EN')} · звонки ${cnt((d) => d.channel === 'voice call')} из 5`);
  const naCount = ids.filter((id) => Object.entries(gt[id]).some(([k, v]) => k !== '_note' && toToken(v) === 'na')).length;
  console.log(`С хотя бы одним N/A: ${naCount} · с грубой ошибкой: ${ids.filter((id) => toToken(gt[id]['08']) === 'yes').length}`);
  console.log(problems.length ? `\nПроблемы (${problems.length}):\n` + problems.map((p) => '- ' + p).join('\n') : '\nОшибок формата нет.');
  process.exit(problems.length ? 1 : 0);
} else {
  console.log('Команды: list | plan | show <id> [--hints] | stub <id> | check');
}
