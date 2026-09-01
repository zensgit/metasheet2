/**
 * Shared AI shortcut generation + commit primitives (B-1 / B-2 / B-4).
 *
 * Extracted from `routes/multitable-ai.ts` so the inline bulk path (≤ the inline
 * cap) AND the B-4 async job worker call the SAME generation/charge code — there
 * is exactly ONE reserve-then-settle core, never a forked second copy. The
 * inline route keeps its behaviour byte-identical: it imports `runShortcutCore`
 * from here and calls it exactly as before (the only change is `aiClient` is a
 * parameter instead of a closure capture).
 *
 * This module owns NO `res` / Express coupling and NO route-level gate sequence;
 * callers (the route or the worker) own gating + scope resolution and feed each
 * gated, provider-bound row's assembled prompt to `runShortcutCore`. The
 * per-charge invariants (charge-on-generation, never-release, reserve-then-
 * settle, the unsafe-input scan) live here unchanged.
 *
 * GOVERNED-AI WIRING: `runShortcutCore` is the SINGLE provider-call choke for the
 * shipped multitable-AI features (single-record shortcut, inline bulk-fill, and
 * the async bulk job worker all funnel through it). It therefore carries the
 * data-class routing gate — `authorizeAiRoute(provider, 'business')` — so the
 * deploy-configured routing policy actually governs the live path that handles
 * customer record data. See the gate-order note on `runShortcutCore`.
 */

import { redactString } from '../multitable/automation-log-redact'
import {
  AiProviderClient,
  estimateAiCostUsd,
  type AiCompletionResult,
  type AiUsage,
} from './ai-provider-client'
import { authorizeAiRoute, type AiDataClass } from './ai-routing-policy'
import {
  AI_USAGE_RESERVATION_GRACE_MS,
  conservativePromptTokenEstimate,
  insertAiUsageLedgerEntry,
  reserveAiUsage,
  settleAiUsageReservation,
  type AiUsageAction,
  type AiUsageLedgerEntry,
  type AiUsageLedgerStatus,
  type AiUsageQueryFn,
  type AiUsageReservationResult,
} from './ai-usage-ledger'
import type { ConnectionPool, QueryFn } from '../multitable/record-write-service'

export type PoolLike = ConnectionPool & { query: QueryFn }

/**
 * The data-sensitivity class of EVERY prompt on this path. Fixed, not a
 * parameter: these prompts are assembled from customer record content, so the
 * class is a property of the feature, not of the caller. Making it an argument
 * would let a caller declare its way around the routing policy — the exact
 * "an argument is an unlock surface" failure the outbound-write gate calls out.
 */
export const AI_SHORTCUT_DATA_CLASS: AiDataClass = 'business'

export interface ShortcutRequestContext {
  pool: PoolLike
  sheetId: string
  /** null for sheet-scoped attempts (M4 suggest: NL→formula is field-authoring, not a record read). */
  recordId: string | null
  fieldId: string | null
  action: AiUsageAction
  userId: string
}

/**
 * Res-free per-attempt outcome of `runShortcutCore` (B-1). The discriminant is
 * the charge boundary: only `charged` consumed the provider (and the quota);
 * every other variant is provider-never-reached → UNCHARGED. `settle` is
 * present only on `charged` so a caller can re-settle the STATUS keeping usage
 * (e.g. a downstream write conflict) without re-charging.
 */
export type ShortcutCoreOutcome =
  | { kind: 'unsafe_input'; message: string }
  | { kind: 'blocked'; message: string }
  | { kind: 'reserve_failed'; message: string }
  | { kind: 'quota_exhausted'; reason: string }
  | { kind: 'generation_failed_before_usage'; httpStatus: number; code: string; message: string }
  | {
      kind: 'charged'
      result: AiCompletionResult
      usage: AiUsage
      settle: (status: AiUsageLedgerStatus, error?: string | null) => Promise<void>
    }

async function insertLedgerBestEffort(query: AiUsageQueryFn, entry: AiUsageLedgerEntry): Promise<void> {
  try {
    await insertAiUsageLedgerEntry(query, entry)
  } catch (err) {
    // Best-effort policy (§2.5): a committed write / an already-sent response
    // must never be rolled back or failed because the ledger insert failed.
    console.error('[multitable-ai] usage ledger insert failed (best effort):', err)
  }
}

/**
 * RES-FREE reserve-then-settle CORE (review-fix F1) — the unit the inline bulk
 * path AND the B-4 worker reuse per row WITHOUT touching `res`. Behaviour is
 * IDENTICAL to the prior in-route closure; `aiClient` is now an explicit
 * parameter (the inline route passes its constructed client, the worker passes
 * one built with the SAME injected fetchFn — both keep CI zero-real-call).
 *
 * Gate order from "prompt assembled" onward: unsafe scan → double-confirm/
 * readiness preflight (blocked: zero-token row, NO lock) → DATA-CLASS ROUTING
 * GATE (blocked: zero-token row, NO lock, zero outbound — business data never
 * reaches a cloud provider) → quota RESERVE (one SHORT advisory-locked tx) →
 * provider call (NO lock held) → SETTLE the reservation to actual usage. Settles
 * are best-effort (§2.5); a failing reserve fails closed.
 *
 * Returns a discriminated per-row outcome (see {@link ShortcutCoreOutcome}).
 */
export async function runShortcutCore(
  aiClient: AiProviderClient,
  ctx: ShortcutRequestContext,
  prompt: string,
): Promise<ShortcutCoreOutcome> {
  const baseEntry = {
    subjectKey: ctx.userId,
    userId: ctx.userId,
    sheetId: ctx.sheetId,
    fieldId: ctx.fieldId,
    recordId: ctx.recordId,
    action: ctx.action,
  } as const
  const zeroUsage = { promptTokens: 0, completionTokens: 0 }
  const query = ctx.pool.query.bind(ctx.pool) as AiUsageQueryFn

  // unsafe_input pre-send scan (§2.4): the backend redactor exposes no
  // detection surface, so detection derives from replace-and-compare — any
  // rewrite means the assembled prompt carries secret-shaped content.
  if (redactString(prompt) !== prompt) {
    await insertLedgerBestEffort(query, {
      ...baseEntry,
      ...zeroUsage,
      estimatedCostUsd: 0,
      status: 'unsafe_input',
    })
    return {
      kind: 'unsafe_input',
      message: 'The assembled prompt contains secret-shaped content; the request was not sent.',
    }
  }

  // Double-confirm / readiness / price preflight — `blocked` resolves BEFORE
  // the reserve (zero-token row, no lock, zero outbound).
  // complete() re-runs the same gates internally (defense in depth).
  const pre = aiClient.preflight()
  // `in`-guard (not `!pre.ok`): non-strict tsconfig, no boolean-discriminant narrowing.
  if ('message' in pre) {
    await insertLedgerBestEffort(query, {
      ...baseEntry,
      ...zeroUsage,
      estimatedCostUsd: 0,
      provider: pre.provider ?? null,
      model: pre.model ?? null,
      status: 'blocked',
      error: pre.message,
    })
    return { kind: 'blocked', message: pre.message }
  }

  // ── DATA-CLASS ROUTING GATE (governed AI boundary) ────────────────────────
  // Every prompt on this path is assembled from CUSTOMER RECORD CONTENT
  // (assembleMaskedPrompt in routes/multitable-ai.ts folds the record's captured
  // field data into the prompt), so this path is unconditionally `business`
  // class. Before this gate existed, `complete()` below sent that content to
  // whatever MULTITABLE_AI_BASE_URL pointed at — defaulting to api.anthropic.com
  // / api.openai.com, i.e. the public cloud — with NO routing policy consulted.
  // A deployment could have a perfectly-configured policy and still leak BOM /
  // record data through bulk-fill.
  //
  // Placed AFTER preflight (so provider identity is known) and BEFORE the quota
  // reserve, so a refusal costs no reservation and is UNCHARGED with zero
  // outbound. It resolves to the EXISTING `blocked` outcome — the vocabulary all
  // three callers (single-record route, inline bulk-fill, async worker) already
  // handle — so the response shape, the zero-token ledger row, redaction, the
  // double-confirm gate and the quota discipline are all unchanged. This inserts
  // the routing gate; it does not rewrite the feature.
  const routing = authorizeAiRoute(pre.provider, AI_SHORTCUT_DATA_CLASS)
  // `in`-guard (not `!routing.allowed`): non-strict tsconfig, no boolean-discriminant narrowing.
  if ('reason' in routing) {
    await insertLedgerBestEffort(query, {
      ...baseEntry,
      ...zeroUsage,
      estimatedCostUsd: 0,
      provider: pre.provider,
      model: pre.model,
      status: 'blocked',
      error: routing.message,
    })
    return { kind: 'blocked', message: routing.message }
  }

  // Quota RESERVE — the advisory locks wrap ONLY this short check+insert
  // transaction (F1: never across the provider call).
  let reservation: AiUsageReservationResult
  try {
    const estimatedUsage: AiUsage = {
      promptTokens: conservativePromptTokenEstimate(prompt),
      completionTokens: pre.caps.maxOutputTokens,
    }
    reservation = await reserveAiUsage(ctx.pool, {
      ...baseEntry,
      provider: pre.provider,
      model: pre.model,
      estimatedPromptTokens: estimatedUsage.promptTokens,
      estimatedCompletionTokens: estimatedUsage.completionTokens,
      estimatedCostUsd: estimateAiCostUsd(pre.price, estimatedUsage),
      caps: {
        tenantDailyTokenCap: pre.caps.tenantDailyTokenCap,
        tenantWeeklyTokenCap: pre.caps.tenantWeeklyTokenCap,
        accountDailyUsdCap: pre.caps.accountDailyUsdCap,
      },
      staleAfterMs: pre.caps.requestTimeoutMs + AI_USAGE_RESERVATION_GRACE_MS,
    })
  } catch (err) {
    // Quota-reserve-time ledger unavailability → fail closed (§2.5).
    console.error('[multitable-ai] quota reserve failed; failing closed:', err)
    return { kind: 'reserve_failed', message: 'AI usage ledger is unavailable; request blocked (fail-closed).' }
  }
  if ('reason' in reservation) {
    return { kind: 'quota_exhausted', reason: reservation.reason }
  }
  const reservationId = reservation.reservationId

  // Provider call — NO lock held; a crash from here until settle leaves an
  // in_flight row that a later reserve sweeps to zero-usage 'abandoned'.
  const result = await aiClient.complete({ prompt })
  const usage: AiUsage = result.usage ?? zeroUsage

  // SETTLE (best-effort — never 500 a committed write / an already-sent
  // response over a ledger UPDATE).
  const settle = async (status: AiUsageLedgerStatus, error?: string | null): Promise<void> => {
    try {
      await settleAiUsageReservation(query, reservationId, {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        estimatedCostUsd: result.estimatedCostUsd,
        provider: result.provider ?? null,
        model: result.model ?? null,
        durationMs: result.durationMs,
        status,
        error: error ?? null,
      })
    } catch (err) {
      console.error('[multitable-ai] usage ledger settle failed (best effort):', err)
    }
  }

  if (result.status === 'blocked') {
    // Post-reserve blocked = the env raced between preflight and the call —
    // settle to zero usage. The provider never produced output → UNCHARGED.
    await settle('blocked', result.message ?? null)
    return { kind: 'generation_failed_before_usage', httpStatus: 503, code: 'AI_BLOCKED', message: result.message ?? 'AI requests are not enabled for this deployment.' }
  }

  if (result.status === 'provider_error') {
    // Charge invariant (§2.5): tokens are recorded WHENEVER the provider
    // returned usage — the money is spent. A provider error with NO usage =
    // generation_failed_before_usage (UNCHARGED); WITH usage settles the ACTUAL
    // tokens (CHARGED) — the output was produced even though the call errored.
    await settle('provider_error', result.message ?? null)
    if (result.usage) {
      return { kind: 'charged', result: result as AiCompletionResult, usage, settle }
    }
    return { kind: 'generation_failed_before_usage', httpStatus: 502, code: 'AI_PROVIDER_ERROR', message: result.message ?? 'AI provider request failed.' }
  }

  // Settle to actual usage BEFORE any downstream write. The provider was called
  // and produced OUTPUT → CHARGED (a 200 with no usage object is still a success
  // → CHARGED at zero tokens; the discriminator is "output produced?").
  await settle('succeeded')
  return { kind: 'charged', result: result as AiCompletionResult & { ok: true }, usage, settle }
}
