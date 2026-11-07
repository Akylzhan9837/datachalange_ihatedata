export interface LlmRequest {
  system: string;
  user: string;
  schema: object;
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface LlmResponse {
  text: string;
  model: string;
  usage: LlmUsage;
}

export type LlmCall = (req: LlmRequest) => Promise<LlmResponse>;

export class LlmError extends Error {}

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MODELS = 'gemini-3.5-flash,gemini-3.8-flash,gemini-2.5-flash';

export function geminiCall(opts: {
  apiKey?: string;
  model?: string;
  thinkingLevel?: string;
  maxAttempts?: number;
} = {}): LlmCall {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
  const models = (opts.model ?? process.env.GEMINI_MODEL ?? DEFAULT_MODELS).split(',').map((m) => m.trim()).filter(Boolean);
  const thinkingLevel = opts.thinkingLevel ?? process.env.GEMINI_THINKING_LEVEL;
  const maxAttempts = opts.maxAttempts ?? 3;

  return async (req) => {
    if (!apiKey) throw new LlmError('GEMINI_API_KEY is not set (.env)');
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.user }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 16384,
        responseMimeType: 'application/json',
        responseJsonSchema: req.schema,
        ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
      },
    });
    const failures: string[] = [];

    for (const model of models) {
      const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(180_000),
        });
        if (res.ok) return parseResponse((await res.json()) as GeminiBody, model);
        const detail = (await res.text()).slice(0, 300);
        if (!RETRYABLE.has(res.status)) throw new LlmError(`Gemini ${model} HTTP ${res.status}: ${detail}`);
        failures.push(`${model} HTTP ${res.status}`);
        if (res.status === 429 || attempt === maxAttempts) break;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
      }
    }
    throw new LlmError(`Gemini unavailable: ${failures.join('; ')}`);
  };
}

interface GeminiPart { text?: string; thought?: boolean }
interface GeminiBody {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string;
}

export function parseResponse(json: GeminiBody, model: string): LlmResponse {
  if (json.promptFeedback?.blockReason) throw new LlmError(`Gemini blocked the prompt: ${json.promptFeedback.blockReason}`);
  const cand = json.candidates?.[0];
  if (!cand) throw new LlmError('Gemini returned no candidates');
  if (cand.finishReason && cand.finishReason !== 'STOP') throw new LlmError(`Gemini finishReason: ${cand.finishReason}`);
  const text = (cand.content?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join('');
  const u = json.usageMetadata ?? {};
  return {
    text,
    model: json.modelVersion ?? model,
    usage: {
      input_tokens: u.promptTokenCount ?? 0,
      output_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    },
  };
}
