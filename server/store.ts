import fs from 'node:fs';
import path from 'node:path';
import type { Checklist, EvaluationResult, Appeal, DatasetResponse, Conversation } from '../shared/types.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CHECKLISTS_DIR = path.join(DATA_DIR, 'checklists');
const SETS_DIR = path.join(DATA_DIR, 'sets');
const STORAGE_DIR = path.join(DATA_DIR, 'storage');

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

ensureDir(CHECKLISTS_DIR);
ensureDir(SETS_DIR);
ensureDir(STORAGE_DIR);

const EVALUATIONS_FILE = path.join(STORAGE_DIR, 'evaluations.json');
const APPEALS_FILE = path.join(STORAGE_DIR, 'appeals.json');

function readJsonFile<T>(filePath: string, defaultValue: T): T {
  try {
    if (!fs.existsSync(filePath)) {
      return defaultValue;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return defaultValue;
  }
}

function writeJsonFile<T>(filePath: string, data: T): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export function listChecklists(): Checklist[] {
  const files = fs.readdirSync(CHECKLISTS_DIR).filter((f) => f.endsWith('.json'));
  return files.map((file) => {
    const content = fs.readFileSync(path.join(CHECKLISTS_DIR, file), 'utf-8');
    return JSON.parse(content) as Checklist;
  });
}

export function getChecklist(id = 'default'): Checklist | null {
  const filePath = path.join(CHECKLISTS_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as Checklist;
}

export function saveChecklist(checklist: Checklist): Checklist {
  const existing = getChecklist(checklist.id);
  const version = existing ? existing.version + 1 : (checklist.version || 1);
  const updatedChecklist: Checklist = {
    ...checklist,
    version,
  };
  const filePath = path.join(CHECKLISTS_DIR, `${checklist.id}.json`);
  writeJsonFile(filePath, updatedChecklist);
  return updatedChecklist;
}

export function getDataset(groupId: string): DatasetResponse | null {
  const filePath = path.join(SETS_DIR, `${groupId}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return readJsonFile<DatasetResponse | null>(filePath, null);
}

export function saveDataset(groupId: string, data: DatasetResponse): void {
  const filePath = path.join(SETS_DIR, `${groupId}.json`);
  writeJsonFile(filePath, data);
}

export function getConversation(id: string): Conversation | null {
  const setsFiles = fs.readdirSync(SETS_DIR).filter((f) => f.endsWith('.json'));
  for (const file of setsFiles) {
    const dataset = readJsonFile<DatasetResponse | null>(path.join(SETS_DIR, file), null);
    if (dataset?.data?.records) {
      const found = dataset.data.records.find((r) => r.conversation_id === id);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

export function listEvaluations(): EvaluationResult[] {
  return readJsonFile<EvaluationResult[]>(EVALUATIONS_FILE, []);
}

export function getEvaluation(id: string): EvaluationResult | null {
  const evals = listEvaluations();
  return evals.find((e) => e.id === id) || null;
}

export function getEvaluationByConversation(conversationId: string): EvaluationResult | null {
  const evals = listEvaluations();
  return evals.find((e) => e.conversation_id === conversationId) || null;
}

export function saveEvaluation(evaluation: EvaluationResult): EvaluationResult {
  const evals = listEvaluations();
  const index = evals.findIndex((e) => e.id === evaluation.id);
  if (index >= 0) {
    evals[index] = evaluation;
  } else {
    evals.push(evaluation);
  }
  writeJsonFile(EVALUATIONS_FILE, evals);
  return evaluation;
}

export function listAppeals(evaluationId?: string): Appeal[] {
  const appeals = readJsonFile<Appeal[]>(APPEALS_FILE, []);
  if (evaluationId) {
    return appeals.filter((a) => a.evaluation_id === evaluationId);
  }
  return appeals;
}

export function getAppeal(id: string): Appeal | null {
  const appeals = listAppeals();
  return appeals.find((a) => a.id === id) || null;
}

export function saveAppeal(appeal: Appeal): Appeal {
  const appeals = listAppeals();
  const index = appeals.findIndex((a) => a.id === appeal.id);
  if (index >= 0) {
    appeals[index] = appeal;
  } else {
    appeals.push(appeal);
  }
  writeJsonFile(APPEALS_FILE, appeals);
  return appeal;
}
