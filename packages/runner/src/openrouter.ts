import type { ModelPricing } from '@cookingbench/core';

const API_BASE = 'https://openrouter.ai/api/v1';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionResult {
  text: string;
  raw: unknown;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  finishReason?: string;
}

export interface CompletionOpts {
  temperature: number;
  maxTokens: number;
  /** OpenRouter unified reasoning control (e.g. { effort: 'low' }). */
  reasoning?: { effort?: 'low' | 'medium' | 'high'; enabled?: boolean; max_tokens?: number };
}

export interface CompletionClient {
  complete(
    modelId: string,
    messages: ChatMessage[],
    opts: CompletionOpts,
  ): Promise<CompletionResult>;
}

function apiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set (see .env.example)');
  return key;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;

export class OpenRouterClient implements CompletionClient {
  private post(modelId: string, messages: ChatMessage[], opts: CompletionOpts): Promise<Response> {
    return fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/joooord/cookingbench',
        'X-Title': 'CookingBench',
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
        ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
        usage: { include: true },
      }),
    });
  }

  async complete(
    modelId: string,
    messages: ChatMessage[],
    opts: CompletionOpts,
  ): Promise<CompletionResult> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const start = Date.now();
      let res: Response;
      try {
        res = await this.post(modelId, messages, opts);
      } catch (error) {
        // Network-level failures (connection terminated, reset, DNS) are as
        // retryable as a 502 — don't let one dropped socket kill a batch.
        lastError = new Error(`OpenRouter network error for ${modelId}: ${(error as Error).message}`);
        if (attempt === MAX_ATTEMPTS) break;
        const backoff = 2000 * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      if (!res.ok) {
        const body = await res.text();
        lastError = new Error(`OpenRouter ${res.status} for ${modelId}: ${body.slice(0, 300)}`);
        if (!RETRYABLE.has(res.status)) throw lastError;
        if (attempt === MAX_ATTEMPTS) break;
        // 429s are per-minute rate limits — a couple of seconds is never enough.
        const base = res.status === 429 ? 15000 : 2000;
        const backoff = base * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      };
      const choice = json.choices?.[0];
      return {
        text: choice?.message?.content ?? '',
        raw: json,
        tokensIn: json.usage?.prompt_tokens ?? 0,
        tokensOut: json.usage?.completion_tokens ?? 0,
        costUsd: json.usage?.cost ?? 0,
        latencyMs: Date.now() - start,
        finishReason: choice?.finish_reason,
      };
    }
    throw lastError ?? new Error(`OpenRouter request failed for ${modelId}`);
  }
}

export interface CatalogModel {
  id: string;
  name: string;
  created: number;
  pricing: ModelPricing;
}

/** Fetch the live OpenRouter catalog with per-token pricing. */
export async function fetchCatalog(): Promise<Map<string, CatalogModel>> {
  const res = await fetch(`${API_BASE}/models`);
  if (!res.ok) throw new Error(`Failed to fetch OpenRouter catalog: ${res.status}`);
  const json = (await res.json()) as {
    data: Array<{
      id: string;
      name: string;
      created: number;
      pricing: { prompt: string; completion: string };
    }>;
  };
  const map = new Map<string, CatalogModel>();
  for (const m of json.data) {
    map.set(m.id, {
      id: m.id,
      name: m.name,
      created: m.created,
      pricing: {
        promptUsd: Number(m.pricing.prompt),
        completionUsd: Number(m.pricing.completion),
      },
    });
  }
  return map;
}
