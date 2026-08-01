import type { Capability, ModelPricing } from '@cookingbench/core';
import { Firewall, FirewallError, type CellKind } from './firewall.js';
import {
  assertLedgerBoundToGrant,
  type Reservation,
  type ReservationLedger,
} from './ledger.js';
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
  /**
   * Where `costUsd` came from.
   *
   * `provider` — the provider priced the call and this is that price.
   * `reserved-unreconciled` — the provider returned no usable cost, so this is
   * the CONSERVATIVE RESERVATION, charged pending reconciliation. It is an
   * upper bound, not a receipt, and anything that totals it for publication
   * must say so.
   *
   * Optional only because `CompletionClient` is also implemented by the mock;
   * absent means "this client did not state a basis", which a consumer must not
   * read as `provider`.
   */
  costBasis?: 'provider' | 'reserved-unreconciled';
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
  /**
   * The caller's expected cost. A FLOOR on the reservation, not the reservation
   * itself: the client prices each attempt from the request that attempt will
   * actually send and takes whichever is larger. See `attemptReservationUsd`.
   */
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

/* -------------------------------------------------------------------------- */
/* BUDGET-001 — pricing an ATTEMPT                                            */
/* -------------------------------------------------------------------------- */

/**
 * Worst-case rates used to price a reservation. NOT a price list.
 *
 * $10 / Mtok prompt and $50 / Mtok completion are the ceiling of the 2026-07
 * roster (Claude Fable 5 at $10/$50; everything else is cheaper), and the same
 * numbers `bench estimate` and `cmdRun` use for their worst case. They exist so
 * a reservation can be recomputed from the REQUEST rather than inherited from
 * whatever the caller estimated the first time.
 *
 * The defect: `cmdRun` retries an empty completion with `maxTokens * 2` while
 * passing the estimate it computed for the original `maxTokens`, and judge.ts
 * escalates `2000 * (attempt + 1)` against one flat `JUDGE_WORST_CASE_PER_CALL_USD`.
 * Both therefore reserved for a smaller request than the one they sent, and the
 * settled cost could exceed both the reservation and the cap. Pricing the
 * attempt here makes the reservation track the token budget automatically,
 * whatever the caller remembers to pass.
 *
 * If a model ever prices above these, the reservation under-states and the cap
 * is enforced late — so these constants are checked against data/models.yaml
 * whenever the roster changes, and the provider-side key limit remains the
 * final external backstop either way.
 */
export const RESERVE_PROMPT_USD_PER_TOKEN = 0.00001;
export const RESERVE_COMPLETION_USD_PER_TOKEN = 0.00005;

/** The same 4-chars-per-token rule the estimator uses. Rough, and deliberately generous. */
const CHARS_PER_TOKEN = 4;

/**
 * What this attempt must reserve.
 *
 * `max` of the caller's declared estimate and the client's own worst case for
 * the exact request about to be sent. Taking the larger is the only safe
 * direction: the caller's number may be stale (a retry with a doubled token
 * budget) and the client's may be optimistic about prompt size, so neither can
 * be trusted to bound the other.
 */
export function attemptReservationUsd(
  messages: ChatMessage[],
  maxTokens: number,
  declaredEstimateUsd: number,
): number {
  const promptTokens = messages.reduce((n, m) => n + m.content.length, 0) / CHARS_PER_TOKEN;
  const worstCase =
    promptTokens * RESERVE_PROMPT_USD_PER_TOKEN + maxTokens * RESERVE_COMPLETION_USD_PER_TOKEN;
  return Math.max(declaredEstimateUsd, worstCase);
}

/**
 * HTTP statuses OpenRouter decides BEFORE any inference runs.
 *
 * Bad request, unauthenticated, out of credit, unknown model, rate limited:
 * none of these reach a model, so none of them can be billed, and refunding
 * them is provably correct rather than optimistic. This list is deliberately
 * short and explicit — everything absent from it is treated as possibly billed.
 *
 * 429 matters most operationally. A new OpenRouter account gets 10 requests per
 * minute on some flagship models, so a batch legitimately collects dozens of
 * them; retaining each one's reservation would exhaust the cap on rate limits
 * alone and abort a run that had spent nothing.
 */
const PRE_GENERATION_STATUS: ReadonlySet<number> = new Set([400, 401, 402, 403, 404, 405, 422, 429]);

/**
 * Network-level failures that prove the request was never delivered.
 *
 * DNS failures, refused connections, an invalid URL and TLS failures all happen
 * before a single byte of the body reaches the provider. Everything else —
 * `ECONNRESET`, `UND_ERR_SOCKET`, undici's bare `terminated`, a read timeout —
 * can occur AFTER the provider has accepted the request and generated (and
 * billed) a completion, so those are conservatively retained.
 *
 * The list is an allowlist, not a denylist, precisely so an unfamiliar errno
 * fails towards "we may have been charged".
 */
const PROVABLY_UNSENT_CAUSES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ERR_INVALID_URL',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
]);

function provablyUnsent(error: unknown): boolean {
  const err = error as { code?: unknown; cause?: { code?: unknown } };
  const code = typeof err?.code === 'string' ? err.code : err?.cause?.code;
  return typeof code === 'string' && PROVABLY_UNSENT_CAUSES.has(code);
}

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
  readonly #grant: VerifiedGrant;
  readonly #firewall: Firewall;
  readonly #ledger: ReservationLedger;
  readonly #capability: Capability;
  readonly #cellKind: CellKind;
  /** Signed execution policy, copied from the verified manifest. */
  readonly #maxAttempts: number;

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
    // A ledger from another permit may have a different cap, journal and run.
    // The TypeScript type cannot prove provenance at runtime, so require the
    // module-private identity recorded by ReservationLedger's constructor.
    assertLedgerBoundToGrant(ledger, grant, 'OpenRouterClient construction');
    this.#grant = grant;
    this.#ledger = ledger;
    this.#capability = capability;
    this.#maxAttempts = grant.maxAttempts;
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
   * Authorise, then reserve and resolve ONE RESERVATION PER BILLABLE ATTEMPT.
   *
   * The defect this shape replaces: a single `reserve()` sat outside the retry
   * loop, so one reservation funded every POST. The cap bound
   * reservations rather than requests, and a run could multiply its ceiling by
   * the retry count with every individual check passing. BUDGET-001 says concurrent
   * requests AND RETRIES cannot exceed the cap; a retry is another chargeable
   * request to the provider, so it is authorised as one.
   *
   * A `BudgetExceededError` from any attempt's reservation propagates out
   * immediately and is never retried. Running out of money is not a transient
   * transport condition.
   */
  async complete(
    modelId: string,
    messages: ChatMessage[],
    opts: GuardedCompletionOpts,
  ): Promise<CompletionResult> {
    const context = `completion for ${modelId}`;
    assertLedgerBoundToGrant(this.#ledger, this.#grant, context);
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
    // The token budget is half of what an attempt costs, so it is priced, and
    // therefore validated. An absent or non-finite `maxTokens` would otherwise
    // reach `attemptReservationUsd` and produce a NaN reservation.
    const maxTokens = (opts as { maxTokens?: unknown }).maxTokens;
    if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens) || maxTokens <= 0) {
      throw new FirewallError(
        `${context} names no usable max_tokens (${JSON.stringify(maxTokens)}). An attempt cannot be priced without the size of the request it will send.`,
        'UNPRICED_CALL',
      );
    }

    // Resolved once, before any money is reserved. Inside the loop a missing
    // key threw from `post()` and was classified as a transport failure, so a
    // configuration error spent every configured backoff pretending to be a network fault.
    const key = apiKey();
    return this.#requestWithAccounting(key, modelId, messages, opts, estimateUsd);
  }

  private post(
    key: string,
    modelId: string,
    messages: ChatMessage[],
    opts: CompletionOpts,
  ): Promise<Response> {
    return fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
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

  /**
   * The transport, with the accounting welded to it.
   *
   * Every path out of every attempt resolves that attempt's reservation exactly
   * once, into an explicit terminal state:
   *
   *   settled               — the provider priced it.
   *   released-uncharged    — it provably never reached the provider.
   *   retained-unreconciled — it reached the provider, or may have, and the cost
   *                           is unknown. Charged in full, pending reconciliation.
   *
   * The old code called `release()` for every failure, which refunded a 200
   * whose body died in transit — a completion that was generated and billed —
   * as though it had certainly cost nothing.
   */
  async #requestWithAccounting(
    key: string,
    modelId: string,
    messages: ChatMessage[],
    opts: CompletionOpts,
    declaredEstimateUsd: number,
  ): Promise<CompletionResult> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      // Recomputed per attempt rather than hoisted, so an attempt that raises
      // the token budget or changes pricing assumptions reserves for the
      // request it is about to send. Deliberately OUTSIDE the try below: a
      // BudgetExceededError must abort the whole call, not be retried as if it
      // were a transport fault.
      const reserveUsd = attemptReservationUsd(messages, opts.maxTokens, declaredEstimateUsd);
      const reservation: Reservation = this.#ledger.reserve(modelId, reserveUsd);

      const start = Date.now();
      let res: Response;
      try {
        res = await this.post(key, modelId, messages, opts);
      } catch (error) {
        // Network-level failures (connection terminated, reset, DNS) are as
        // retryable as a 502 — don't let one dropped socket kill a batch. But
        // only a failure that proves the request was never delivered gives the
        // money back; a socket that died after the body was written may have
        // been billed.
        const message = (error as Error).message;
        if (provablyUnsent(error)) {
          this.#ledger.releaseUncharged(reservation, `request never sent: ${message}`);
        } else {
          this.#ledger.retainUnreconciled(reservation, `transport failed after send, cost unknown: ${message}`);
        }
        lastError = new Error(`OpenRouter network error for ${modelId}: ${message}`);
        if (attempt === this.#maxAttempts) break;
        await sleep(backoffMs(2000, attempt));
        continue;
      }

      if (!res.ok) {
        // Reading the error body can itself fail on a dying socket, and that
        // read used to sit outside any try — a throw there escaped the loop
        // leaving the reservation open and unjournalled.
        let body: string;
        try {
          body = await res.text();
        } catch {
          body = '<error body unreadable>';
        }
        this.#resolveFailedResponse(reservation, res.status, body);
        lastError = new Error(`OpenRouter ${res.status} for ${modelId}: ${body.slice(0, 300)}`);
        if (!RETRYABLE.has(res.status)) throw lastError;
        if (attempt === this.#maxAttempts) break;
        // 429s are per-minute rate limits — a couple of seconds is never enough.
        await sleep(backoffMs(res.status === 429 ? 15000 : 2000, attempt));
        continue;
      }

      // A 200 whose body dies mid-transfer used to escape this loop entirely:
      // `res.json()` threw "Unexpected end of JSON input" from outside the try
      // above, so it propagated past every remaining attempt and out of
      // complete(). cmdRun caught it, stored no artifact, and the model was
      // quietly averaged over fewer questions than its peers. It cost four
      // responses in run 2026-07-v2.1 alone. A truncated body is a dropped
      // socket that happened to send headers first — retry it like one, and
      // charge for it: the completion was generated, and generation is what the
      // provider bills for.
      let json: {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      };
      try {
        const body = await res.text();
        json = JSON.parse(body);
      } catch (error) {
        this.#ledger.retainUnreconciled(
          reservation,
          `HTTP 200 with an unreadable body — the completion was generated and billed, and lost in transit: ${(error as Error).message}`,
        );
        lastError = new Error(
          `OpenRouter returned an unreadable body for ${modelId}: ${(error as Error).message}`,
        );
        if (attempt === this.#maxAttempts) break;
        await sleep(backoffMs(2000, attempt));
        continue;
      }

      const choice = json.choices?.[0];
      const result: CompletionResult = {
        text: choice?.message?.content ?? '',
        raw: json,
        tokensIn: json.usage?.prompt_tokens ?? 0,
        tokensOut: json.usage?.completion_tokens ?? 0,
        costUsd: 0, // replaced below; never left at the `?? 0` that hid missing prices
        latencyMs: Date.now() - start,
        finishReason: choice?.finish_reason,
      };

      const cost = json.usage?.cost;
      if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
        // `costUsd: json.usage?.cost ?? 0` recorded an unpriced call as free.
        // A response we cannot price is not a free response: the reservation is
        // retained in full and the result says its cost is an upper bound.
        this.#ledger.retainUnreconciled(
          reservation,
          `provider returned no usable cost (${JSON.stringify(cost)}); charged at the reservation pending reconciliation`,
        );
        return { ...result, costUsd: reservation.reservedUsd, costBasis: 'reserved-unreconciled' };
      }
      this.#ledger.settle(reservation, cost);
      return { ...result, costUsd: cost, costBasis: 'provider' };
    }
    throw lastError ?? new Error(`OpenRouter request failed for ${modelId}`);
  }

  /**
   * Decide what a non-2xx response did to the money.
   *
   * Split out so the classification is one readable decision rather than a
   * condition buried in the retry loop, and so the reasoning is journalled
   * verbatim — an auditor has to be able to see which judgement was made.
   */
  #resolveFailedResponse(reservation: Reservation, status: number, body: string): void {
    if (PRE_GENERATION_STATUS.has(status)) {
      this.#ledger.releaseUncharged(reservation, `HTTP ${status} rejected before inference: ${body.slice(0, 120)}`);
      return;
    }
    this.#ledger.retainUnreconciled(
      reservation,
      `HTTP ${status} may have followed generation; cost unknown: ${body.slice(0, 120)}`,
    );
  }
}

/** Full jitter around an exponential base, as before. Extracted only for readability. */
function backoffMs(base: number, attempt: number): number {
  return base * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
