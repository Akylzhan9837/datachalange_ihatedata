// Gemini generateContent over REST (no SDK dependency). Owner: ТЛ.
// Docs: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=...

export interface LlmRequest {
  system: string;
  user: string;
  schema: object; // JSON Schema for the answer (responseJsonSchema)
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number; // answer + thinking tokens
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

export function geminiCall(opts: {
  apiKey?: string;
  model?: string;
  thinkingLevel?: string;
  maxAttempts?: number;
} = {}): LlmCall {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
  // shortcut: default model from the docs list on 2026-11-07; confirm its free-tier limits in AI Studio.
  const model = opts.model ?? process.env.GEMINI_MODEL ?? 'gemini-3.8-flash';
  const thinkingLevel = opts.thinkingLevel ?? process.env.GEMINI_THINKING_LEVEL; // MINIMAL | LOW | MEDIUM | HIGH, Gemini 3+
  const maxAttempts = opts.maxAttempts ?? 4;

  return async (req) => {
    if (!apiKey) throw new LlmError('GEMINI_API_KEY is not set (.env)');
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.user }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 16384,
        responseMimeType: 'application/json',
        responseJsonSchema: req.schema,
        ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
      },
    };
    // The key goes in the query string (documented); never put the URL into errors or logs.
    const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
      if (res.ok) return parseResponse((await res.json()) as GeminiBody, model);
      const detail = (await res.text()).slice(0, 300);
      if (!RETRYABLE.has(res.status) || attempt >= maxAttempts) {
        throw new LlmError(`Gemini HTTP ${res.status}: ${detail}`);
      }
      await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1))); // 2s, 4s, 8s
    }
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
