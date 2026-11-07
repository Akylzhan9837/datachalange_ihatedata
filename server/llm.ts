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
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_MODELS = 'gemini-3.5-flash,gemini-3.8-flash,gemini-2.5-flash';
const MAX_WAIT_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isLegacy = (model: string) => /^gemini-[12]\./.test(model);

function waitBeforeRetry(body: string, attempt: number): number | null {
  const hint = body.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/);
  if (hint) {
    const ms = Number(hint[1]) * 1000;
    return ms <= MAX_WAIT_MS ? ms : null;
  }
  return Math.min(2000 * 2 ** (attempt - 1) + Math.random() * 1000, MAX_WAIT_MS);
}

function requestBody(req: LlmRequest, model: string, thinkingLevel?: string): string {
  const legacy = isLegacy(model);
  return JSON.stringify({
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: 'user', parts: [{ text: req.user }] }],
    generationConfig: {
      ...(legacy ? { temperature: 0 } : {}),
      maxOutputTokens: 16384,
      responseMimeType: 'application/json',
      responseJsonSchema: req.schema,
      ...(thinkingLevel && !legacy ? { thinkingConfig: { thinkingLevel } } : {}),
    },
  });
}

export function geminiCall(opts: {
  apiKey?: string;
  model?: string;
  thinkingLevel?: string;
  maxAttempts?: number;
} = {}): LlmCall {
  const keys = (opts.apiKey ?? process.env.GEMINI_API_KEY ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  const models = (opts.model ?? process.env.GEMINI_MODEL ?? DEFAULT_MODELS).split(',').map((m) => m.trim()).filter(Boolean);
  const thinkingLevel = opts.thinkingLevel ?? process.env.GEMINI_THINKING_LEVEL;
  const maxAttempts = opts.maxAttempts ?? 3;
  const exhausted = new Set<string>();
  const badKeys = new Set<number>();

  return async (req) => {
    if (!keys.length) throw new LlmError('GEMINI_API_KEY is not set (.env)');
    const failures: string[] = [];

    for (const model of models) {
      for (const [k, apiKey] of keys.entries()) {
        const slot = `${k}|${model}`;
        if (badKeys.has(k) || exhausted.has(slot)) continue;
        const label = keys.length > 1 ? `${model} key#${k + 1}` : model;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          let res: Response | null = null;
          let detail = '';
          try {
            res = await fetch(`${API_BASE}/${encodeURIComponent(model)}:generateContent`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
              body: requestBody(req, model, thinkingLevel),
              signal: AbortSignal.timeout(180_000),
            });
          } catch (e) {
            detail = (e as Error).message;
          }
          if (res?.ok) return parseResponse((await res.json()) as GeminiBody, model);
          if (res) {
            detail = await res.text();
            const keyProblem = res.status === 401 || res.status === 403 || /API_KEY_INVALID/.test(detail);
            if (keyProblem && keys.length > 1) {
              badKeys.add(k);
              failures.push(`${label} HTTP ${res.status} (ключ пропущен)`);
              break;
            }
            if (!RETRYABLE.has(res.status)) throw new LlmError(`Gemini ${label} HTTP ${res.status}: ${detail.slice(0, 300)}`);
          }
          failures.push(`${label} ${res ? `HTTP ${res.status}` : `network: ${detail.slice(0, 80)}`}`);
          const hint = waitBeforeRetry(detail, attempt);
          if (res?.status === 429 && hint === null) exhausted.add(slot);
          const wait = attempt < maxAttempts ? hint : null;
          if (wait === null) break;
          await sleep(wait);
        }
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
