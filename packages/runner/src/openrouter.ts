import type { Capability, ModelPricing } from '@cookingbench/core';
import { Firewall, FirewallError, type CellKind } from './firewall.js';
import { type Reservation, type ReservationLedger } from './ledger.js';
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

/** Transport knobs. Nothing here authorises anything or costs anything. */
export interface CompletionOpts {
  temperature: number;
  maxTokens: number;
  /** OpenRouter unified reasoning control (e.g. { effort: 'low' }). */
  reasoning?: { effort?: 'low' | 'medium' | 'high'; enabled?: boolean; max_tokens?: number };
}

/**
 * What a call has to declare before anyone will make it for money.
 *
 * Both fields were OPTIONAL, and the consequences were worse than untidy: with
 * `questionId` absent the cell check was SKIPPED entirely, and with
 * `estimateUsd` absent the ledger reserved `?? 0`, so a caller that forgot
 * either one got an unauthorised call charged against a cap it never touched.
 * That is opt-in enforcement, which firewall.ts's own header warns against — a
 * firewall you have to remember to call is not a firewall — and it is the exact
 * shape of the bug it warns about, sitting inside the module that warns.
 *
 * Required, therefore, and re-checked at runtime because the type is erased.
 */
export interface GuardedCompletionOpts extends CompletionOpts {
  /**
   * Which authorised cell this call consumes.
   *
   * `modelId` names the CANDIDATE, never the judge seat — see `InferenceCell`
   * in firewall.ts. For a candidate call it must equal the model being called;
   * for a judge call it is the model whose answer is being scored, and the seat
   * is the first argument to `complete`.
   */
  cell: { modelId: string; questionId: string };
  /** Expected cost, reserved against the budget before the call is made. */
  estimateUsd: number;
}

/**
 * The shared client contract, mock and paid alike.
 *
 * It takes the GUARDED options deliberately. A caller holding a
 * `CompletionClient` does not know whether it is holding a mock or a paid
 * client, so the contract has to be the strict one — otherwise the enforcement
 * disappears at exactly the call sites that switch between the two, which is
 * every call site in the pipeline.
 */
export interface CompletionClient {
  complete(
    modelId: string,
    messages: ChatMessage[],
    opts: GuardedCompletionOpts,
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
  readonly #cellKind: CellKind;

  private constructor(
    grant: VerifiedGrant,
    ledger: ReservationLedger,
    capability: Capability,
    cellKind: CellKind,
  ) {
    // Re-checked here because `private constructor` is erased at runtime —
    // `Reflect.construct` reaches it directly.
    assertVerifiedGrant(grant, 'OpenRouterClient construction');
    this.#firewall = Firewall.fromVerifiedPermit(grant);
    this.#firewall.requireCapability(capability, `OpenRouterClient(${capability})`);
    this.#ledger = ledger;
    this.#capability = capability;
    // Fixed at construction, never taken from the call. A client built for
    // judging cannot be talked into spending a candidate cell by an argument.
    this.#cellKind = cellKind;
  }

  /** Paid candidate inference. Requires `candidate-inference`. */
  static forCandidates(grant: VerifiedGrant, ledger: ReservationLedger): OpenRouterClient {
    return new OpenRouterClient(grant, ledger, 'candidate-inference', 'candidate');
  }

  /** Paid judge inference. Requires `judge-inference`. */
  static forJudging(grant: VerifiedGrant, ledger: ReservationLedger): OpenRouterClient {
    return new OpenRouterClient(grant, ledger, 'judge-inference', 'judge');
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
    opts: GuardedCompletionOpts,
  ): Promise<CompletionResult> {
    const context = `completion for ${modelId}`;
    this.#firewall.requireCapability(this.#capability, context);

    // The two fields are typed as required; the type is erased, so they are
    // also CHECKED. Absent means refuse — never "assume no cell" and never
    // "reserve zero", which is how the optional version let an unauthorised,
    // unbudgeted call through while looking guarded.
    const cell = (opts as { cell?: { modelId?: unknown; questionId?: unknown } }).cell;
    if (typeof cell !== 'object' || cell === null) {
      throw new FirewallError(
        `${context} did not name the cell it consumes. Every paid call states its (candidate, item) cell — an unnamed call cannot be checked against the permit (RUN-001).`,
        'CELL_NOT_AUTHORISED',
      );
    }
    // For a candidate call the subject IS the model being called, so a cell
    // naming a different one is either a swapped argument or an attempt to
    // spend one model's authorisation on another. Judge calls are the case
    // where the two legitimately differ: the seat is `modelId`, the subject is
    // the candidate whose answer is being scored.
    if (this.#cellKind === 'candidate' && cell.modelId !== modelId) {
      throw new FirewallError(
        `${context} names candidate cell ${JSON.stringify(cell.modelId)}, which is not the model being called. A candidate call answers for itself.`,
        'CELL_NOT_AUTHORISED',
      );
    }
    this.#firewall.requireCell(
      { kind: this.#cellKind, modelId: cell.modelId as string, questionId: cell.questionId as string },
      context,
    );

    const estimateUsd = (opts as { estimateUsd?: unknown }).estimateUsd;
    if (typeof estimateUsd !== 'number' || !Number.isFinite(estimateUsd) || estimateUsd < 0) {
      throw new FirewallError(
        `${context} carries no usable cost estimate (${JSON.stringify(estimateUsd)}). Reserving zero for an unpriced call makes the budget cap advisory (BUDGET-001).`,
        'UNPRICED_CALL',
      );
    }

    // Reserve before the call, not after: a check that has not yet been debited
    // is the race BUDGET-001 exists to close. The reservation is against the
    // model actually being BILLED, which for a judge call is the seat.
    const reservation: Reservation = this.#ledger.reserve(modelId, estimateUsd);
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
