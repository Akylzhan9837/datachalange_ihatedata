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
  getConversation,
  listEvaluations,
  getEvaluation,
  getEvaluationByConversation,
  saveEvaluation,
  listAppeals,
  getAppeal,
  saveAppeal,
} from './store.js';
import { evaluateConversation, EvaluationError } from './evaluate.js';
import { geminiCall, LlmError } from './llm.js';
import { computeScore } from '../shared/scoring.js';
import { analyzeTranscript, crossCheck } from './rules.js';
import type { Checklist, DatasetResponse, Appeal, EvaluationResult } from '../shared/types.js';

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

export function isAllowedAudioHost(audioPageUrl: string): boolean {
  try {
    const parsed = new URL(audioPageUrl);
    const host = parsed.hostname.toLowerCase();
    return host === 'api.powerplatform.com' || host.endsWith('.api.powerplatform.com');
  } catch {
    return false;
  }
}

app.get('/api/audio', async (req: Request, res: Response) => {
  const audioPageUrl = req.query.url as string;
  if (!audioPageUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  if (!isAllowedAudioHost(audioPageUrl)) {
    return res.status(400).json({ error: 'SSRF blocked: host must be *.api.powerplatform.com' });
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

app.post('/api/evaluate', async (req: Request, res: Response) => {
  const { conversation_id, checklist_id = 'cqa-full', force } = req.body || {};
  if (!conversation_id) {
    return res.status(400).json({ error: 'conversation_id is required' });
  }

  const checklist = getChecklist(checklist_id) || getChecklist('default');
  if (!checklist) {
    return res.status(404).json({ error: `Checklist '${checklist_id}' not found` });
  }

  if (!force) {
    const cached = getEvaluationByConversation(conversation_id, checklist.id, Number(checklist.version));
    if (cached) {
      return res.json(cached);
    }
  }

  const conv = getConversation(conversation_id);
  if (!conv) {
    return res.status(404).json({ error: `Conversation '${conversation_id}' not found` });
  }

  try {
    const draft = await evaluateConversation(conv, checklist, geminiCall());

    const answersForScoring = draft.items.map((it) => ({
      criterion_id: it.criterion_id,
      answer: String(it.answer),
      step: typeof it.answer === 'number' ? it.answer : null,
    }));

    const scoreResult = computeScore(checklist as any, answersForScoring);

    const hints = analyzeTranscript(conv.transcript as any);
    const ruleFlags = crossCheck(hints, answersForScoring);
    const flagsByCrit = new Map(ruleFlags.map((f) => [f.criterion_id, f.message]));

    const evaluation: EvaluationResult = {
      id: crypto.randomUUID(),
      conversation_id: draft.conversation_id,
      checklist_id: draft.checklist_id,
      checklist_version: draft.checklist_version,
      model: draft.model,
      cost: draft.cost_usd,
      evaluated_at: draft.created_at,
      items: draft.items.map((it) => {
        const scored = scoreResult.items.find((si) => si.criterion_id === it.criterion_id);
        const flagMsg = flagsByCrit.get(it.criterion_id);
        return {
          criterion_id: it.criterion_id,
          answer: it.answer,
          step: typeof it.answer === 'number' ? it.answer : null,
          evidence: it.evidence,
          checked_range: it.checked_range ?? undefined,
          reason: it.reason,
          na_reason: it.na_reason,
          raw_points: scored?.raw_points,
          points: scored?.points,
          weight: scored?.weight,
          effective_weight: scored?.effective_weight,
          needs_review: it.needs_review || Boolean(flagMsg),
          review_reason: it.review_reason || flagMsg || null,
        };
      }),
      total_score: scoreResult.total,
      section_scores: Object.fromEntries(scoreResult.sections.map((s) => [s.id, s.score])),
      gross_violation: scoreResult.gross,
      rule_flags: ruleFlags,
    };

    saveEvaluation(evaluation);

    return res.status(200).json({
      ...evaluation,
      prompt_version: draft.prompt_version,
      usage: draft.usage,
      duration_ms: draft.duration_ms,
      draft_items: draft.items,
    });
  } catch (error) {
    if (error instanceof EvaluationError || error instanceof LlmError) {
      return res.status(502).json({ error: error.message });
    }
    return res.status(500).json({ error: (error as Error).message });
  }
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
        item.step = typeof reviewer_answer === 'number' ? reviewer_answer : null;

        const checklist = getChecklist(evaluation.checklist_id);
        if (checklist) {
          try {
            const scoreResult = computeScore(
              checklist as any,
              evaluation.items.map((it) => ({
                criterion_id: it.criterion_id,
                answer: String(it.answer),
                step: typeof it.answer === 'number' ? it.answer : (it.step ?? null),
              })),
            );
            evaluation.total_score = scoreResult.total;
            evaluation.section_scores = Object.fromEntries(
              scoreResult.sections.map((s) => [s.id, s.score]),
            );
            evaluation.gross_violation = scoreResult.gross;
            for (const scored of scoreResult.items) {
              const targetItem = evaluation.items.find((it) => it.criterion_id === scored.criterion_id);
              if (targetItem) {
                targetItem.raw_points = scored.raw_points;
                targetItem.points = scored.points;
                targetItem.weight = scored.weight;
                targetItem.effective_weight = scored.effective_weight;
                targetItem.effective_weight = scored.effective_weight;
              }
            }
          } catch {
            // Keep existing score if recalculation encounters validation issues
          }
        }

        saveEvaluation(evaluation);
        appeal.final_score = evaluation.total_score;
      }
    }
  }

  saveAppeal(appeal);
  res.json(appeal);
});

const isTest = process.env.NODE_ENV === 'test' || Boolean(process.argv[1]?.includes('test'));

if (!isTest) {
  app.listen(PORT, () => {
    process.stdout.write(`Server running on port ${PORT}\n`);
  });
}

export default app;
