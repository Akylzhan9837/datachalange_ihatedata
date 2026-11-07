import express, { type Request, type Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import {
  getChecklist,
  listChecklists,
  saveChecklist,
  getDataset,
  saveDataset,
  listEvaluations,
  getEvaluation,
  getEvaluationByConversation,
  saveEvaluation,
  listAppeals,
  getAppeal,
  saveAppeal,
} from './store.js';
import type { Checklist, DatasetResponse, Appeal } from '../shared/types.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const CQA_API_URL = process.env.CQA_API_URL || '';

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/sets/:group_id', async (req: Request, res: Response) => {
  const group_id = String(req.params.group_id);

  if (CQA_API_URL) {
    try {
      const url = new URL(CQA_API_URL);
      url.searchParams.set('group_id', group_id);
      const response = await fetch(url.toString(), { method: 'GET' });
      if (response.ok) {
        const data = (await response.json()) as DatasetResponse;
        if (data && data.isSuccess) {
          saveDataset(group_id, data);
          return res.json(data);
        }
      }
    } catch {
    }
  }

  const cached = getDataset(group_id);
  if (cached) {
    return res.json(cached);
  }

  const devFallback = getDataset('DEV');
  if (devFallback) {
    return res.json(devFallback);
  }

  return res.status(404).json({
    error: `Dataset for group ${group_id} not found`,
    isSuccess: false,
    data: null,
  });
});

app.get('/api/checklists', (_req: Request, res: Response) => {
  const checklists = listChecklists();
  res.json(checklists);
});

app.get('/api/checklists/:id', (req: Request, res: Response) => {
  const checklist = getChecklist(String(req.params.id));
  if (!checklist) {
    return res.status(404).json({ error: 'Checklist not found' });
  }
  res.json(checklist);
});

app.post('/api/checklists', (req: Request, res: Response) => {
  const body = req.body as Checklist;
  if (!body || !body.id || !Array.isArray(body.criteria)) {
    return res.status(400).json({ error: 'Invalid checklist data' });
  }
  const saved = saveChecklist(body);
  res.status(201).json(saved);
});

app.get('/api/audio', async (req: Request, res: Response) => {
  const audioPageUrl = req.query.url as string;
  if (!audioPageUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  try {
    const response = await fetch(audioPageUrl);
    if (!response.ok) {
      return res.status(502).json({ error: 'Failed to fetch audio page' });
    }
    const html = await response.text();
    const sourceMatch = html.match(/<source\s+[^>]*src=["']([^"']+)["']/i);
    const mp3Match = html.match(new RegExp('https?:\\/\\/[^"\'\\s]+\\.mp3[^"\'\\s]*', 'i'));
    const src = sourceMatch ? sourceMatch[1] : mp3Match ? mp3Match[0] : null;

    if (!src) {
      return res.status(404).json({ error: 'Direct audio stream URL not found in page' });
    }

    return res.json({ src });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

app.get('/api/evaluations', (_req: Request, res: Response) => {
  res.json(listEvaluations());
});

app.get('/api/evaluations/:id', (req: Request, res: Response) => {
  const evaluation = getEvaluation(String(req.params.id));
  if (!evaluation) {
    return res.status(404).json({ error: 'Evaluation not found' });
  }
  res.json(evaluation);
});

app.get('/api/evaluations/by-conversation/:conversation_id', (req: Request, res: Response) => {
  const evaluation = getEvaluationByConversation(String(req.params.conversation_id));
  if (!evaluation) {
    return res.status(404).json({ error: 'Evaluation not found' });
  }
  res.json(evaluation);
});

app.post('/api/appeals', (req: Request, res: Response) => {
  const { evaluation_id, criterion_id, comment } = req.body;
  if (!evaluation_id || !criterion_id || !comment) {
    return res.status(400).json({ error: 'evaluation_id, criterion_id, and comment are required' });
  }

  const evaluation = getEvaluation(evaluation_id);
  if (!evaluation) {
    return res.status(404).json({ error: 'Evaluation not found' });
  }

  const item = evaluation.items.find((i) => i.criterion_id === criterion_id);
  if (!item) {
    return res.status(404).json({ error: 'Criterion not found in evaluation' });
  }

  const appeal: Appeal = {
    id: crypto.randomUUID(),
    evaluation_id,
    criterion_id,
    comment,
    status: 'pending',
    original_answer: item.answer,
    original_score: evaluation.total_score,
    created_at: new Date().toISOString(),
  };

  saveAppeal(appeal);
  res.status(201).json(appeal);
});

app.get('/api/appeals', (req: Request, res: Response) => {
  const evaluationId = req.query.evaluation_id as string | undefined;
  res.json(listAppeals(evaluationId));
});

app.post('/api/appeals/:id/decide', (req: Request, res: Response) => {
  const { status, reviewer_answer, reviewer_reason } = req.body;
  const appeal = getAppeal(String(req.params.id));

  if (!appeal) {
    return res.status(404).json({ error: 'Appeal not found' });
  }

  if (status !== 'accepted' && status !== 'rejected') {
    return res.status(400).json({ error: 'Status must be accepted or rejected' });
  }

  appeal.status = status;
  appeal.reviewer_reason = reviewer_reason || '';
  appeal.updated_at = new Date().toISOString();

  if (status === 'accepted' && reviewer_answer !== undefined) {
    appeal.reviewer_answer = reviewer_answer;

    const evaluation = getEvaluation(appeal.evaluation_id);
    if (evaluation) {
      const item = evaluation.items.find((i) => i.criterion_id === appeal.criterion_id);
      if (item) {
        item.answer = reviewer_answer;
        saveEvaluation(evaluation);
      }
    }
  }

  saveAppeal(appeal);
  res.json(appeal);
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    process.stdout.write(`Server running on port ${PORT}\n`);
  });
}

export default app;
