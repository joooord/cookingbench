import type { Capability, ModelPricing } from '@cookingbench/core';
import { Firewall } from './firewall.js';
import { BudgetExceededError, type Reservation, type ReservationLedger } from './ledger.js';
import { assertVerifiedGrant, type VerifiedGrant } from './permit.js';

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
  /**
   * The item this call is for. When present the permit's cell list is enforced,
   * so a permit for 30 questions cannot quietly answer 184.
   */
  questionId?: string;
  /** Expected cost, reserved against the budget before the call is made. */
  estimateUsd?: number;
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

/**
 * RUN-001. The paid client cannot be constructed without a verified grant.
 *
 * `new OpenRouterClient()` used to be reachable from anywhere, which meant the
 * firewall guarded where artifacts were WRITTEN while the thing that actually
 * spends money was a bare constructor. Deny-by-default has to reach the point
 * of spend or it is a filing convention.
 *
 * Two factories rather than one, because the two capabilities are genuinely
 * different authorisations: a shadow re-analysis may buy judge calls and must
 * not be able to buy candidate calls, and the difference has to be visible at
 * the construction site rather than checked somewhere downstream.
 */
export class OpenRouterClient implements CompletionClient {
  readonly #firewall: Firewall;
  readonly #ledger: ReservationLedger;
  readonly #capability: Capability;

  private constructor(grant: VerifiedGrant, ledger: ReservationLedger, capability: Capability) {
    // Re-checked here because `private constructor` is erased at runtime —
    // `Reflect.construct` reaches it directly.
    assertVerifiedGrant(grant, 'OpenRouterClient construction');
    this.#firewall = Firewall.fromVerifiedPermit(grant);
    this.#firewall.requireCapability(capability, `OpenRouterClient(${capability})`);
    this.#ledger = ledger;
    this.#capability = capability;
  }

  /** Paid candidate inference. Requires `candidate-inference`. */
  static forCandidates(grant: VerifiedGrant, ledger: ReservationLedger): OpenRouterClient {
    return new OpenRouterClient(grant, ledger, 'candidate-inference');
  }

  /** Paid judge inference. Requires `judge-inference`. */
  static forJudging(grant: VerifiedGrant, ledger: ReservationLedger): OpenRouterClient {
    return new OpenRouterClient(grant, ledger, 'judge-inference');
  }

  /**
   * Authorise and reserve, then call, then settle or release.
   *
   * The reservation is taken BEFORE the request and settled with the actual
   * cost after, so a failed call gives its money back rather than leaving the
   * cap permanently depressed, and an in-flight call is already counted against
   * the cap while its neighbours are deciding whether to start.
   */
  async complete(
    modelId: string,
    messages: ChatMessage[],
    opts: CompletionOpts,
  ): Promise<CompletionResult> {
    this.#firewall.requireCapability(this.#capability, `completion for ${modelId}`);
    if (opts.questionId !== undefined) {
      this.#firewall.requireCell(modelId, opts.questionId, `completion for ${modelId}`);
    }
    // Reserve before the call, not after: a check that has not yet been debited
    // is the race BUDGET-001 exists to close.
    const reservation: Reservation = this.#ledger.reserve(modelId, opts.estimateUsd ?? 0);
    try {
      const result = await this.#request(modelId, messages, opts);
      this.#ledger.settle(reservation, result.costUsd);
      return result;
    } catch (e) {
      this.#ledger.release(reservation);
      throw e;
    }
  }

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

  /** The transport. Authorisation and accounting happen in `complete`. */
  async #request(
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
      // A 200 whose body dies mid-transfer used to escape this loop entirely:
      // `res.json()` threw "Unexpected end of JSON input" from outside the try
      // above, so it propagated past every remaining attempt and out of
      // complete(). cmdRun caught it, stored no artifact, and the model was
      // quietly averaged over fewer questions than its peers. It cost four
      // responses in run 2026-07-v2.1 alone. A truncated body is a dropped
      // socket that happened to send headers first — retry it like one.
      let json: {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      };
      try {
        const body = await res.text();
        json = JSON.parse(body);
      } catch (error) {
        lastError = new Error(
          `OpenRouter returned an unreadable body for ${modelId}: ${(error as Error).message}`,
        );
        if (attempt === MAX_ATTEMPTS) break;
        const backoff = 2000 * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
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

/**
 * Fetch the live OpenRouter catalog with per-token pricing.
 *
 * Reclassified from benign during the route audit: it costs nothing, but it is
 * still an outbound request to a third party from a process that is meant to be
 * offline unless authorised, and it leaks which models we are about to run.
 * `catalog-read` is its own capability for exactly that reason.
 */
export async function fetchCatalog(grant: VerifiedGrant): Promise<Map<string, CatalogModel>> {
  Firewall.fromVerifiedPermit(grant).requireCapability('catalog-read', 'fetchCatalog');
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
