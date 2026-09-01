/**
 * GOVERNED AI SERVICE BOUNDARY — the consumer-facing AI surface for new features.
 *
 * SCOPE — stated exactly, because the earlier revision of this header made an
 * unscoped absolute ("the ONE place every AI/LLM call is mediated … NOTHING ELSE
 * reaches a provider") that the code did not back: at the time NOTHING called
 * `suggest()`, and the shipped bulk-fill path called the provider directly with
 * customer record data. Repo doctrine: an absolute claim must be exhaustively
 * falsified or scoped. The true, verifiable claim is:
 *
 *   Within `packages/core-backend/src`, there are exactly TWO provider-call sites
 *   (`grep -rn '\.complete(' packages/core-backend/src`):
 *     1. `GovernedAiService.suggestInner()` — this file, for NEW features; and
 *     2. `runShortcutCore()` in services/ai-bulk-shared.ts — the SHIPPED
 *        multitable-AI path (single-record shortcut, inline bulk-fill, and the
 *        async bulk-job worker all funnel through it).
 *   BOTH pass through the SAME routing choke, `authorizeAiRoute()` in
 *   ai-routing-policy.ts, before any provider call. So the data-class routing
 *   policy governs every provider call in this package.
 *
 *   NOT claimed: that no future code can add a third call site (a new direct
 *   `AiProviderClient` user would bypass this — a contract test in
 *   tests/unit/ai-provider-call-site-census.test.ts pins the census so adding one
 *   turns the suite red); and nothing here governs AI calls made outside this
 *   package (e.g. a plugin or the frontend calling a provider itself).
 *
 * The boundary — not the caller — decides the provider, enforces the platform's
 * AI-safety rules in one spot, and hands back a provenance-stamped, advisory-only
 * envelope.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * CONSUMER INTERFACE (what a feature builds against — pinned by contract tests)
 * ═══════════════════════════════════════════════════════════════════════════════
 *   const ai = new GovernedAiService()            // reuses env-configured provider
 *   const res = await ai.suggest({
 *     feature: 'schema-mapping-copilot',
 *     dataClass: 'business',                      // omitted → 'business' (safest)
 *     prompt: 'Suggest a column mapping for ...',
 *     grounding: [{ id: 'col:7', label: 'Bom_ExAttr1', content: '...' }],
 *   })
 *   if (res.available) {
 *     res.suggestion            // string — ALWAYS AI-generated, ADVISORY ONLY
 *     res.provenance            // { aiGenerated: true, advisory: true, providerTier, ... }
 *     res.citations             // which grounding sources were available / referenced
 *   } else {
 *     res.reason                // machine token; TREAT AS "AI enhancement absent"
 *   }
 *
 * THE SEVEN GUARANTEES this boundary makes, and how:
 *
 *  1. DATA-CLASS ROUTING (ai-routing-policy.ts). Every request is tagged with a
 *     sensitivity class; routing follows the DEPLOY-configured policy. Business
 *     data does not reach a cloud provider: the refusal is the first branch on the
 *     cloud arm, `business` is unexpressible in the policy's cloud allowlist, and
 *     a provider may only be treated as `local` if its host PROVES it is private
 *     (a declaration alone is not evidence). Default-unset = local-only /
 *     most-restrictive; a broken policy file fails closed (data never sent).
 *
 *  2. PLUGGABLE PROVIDERS. The boundary reuses the existing `AiProviderClient`
 *     (anthropic + openai-compatible). A self-hosted OpenAI-compatible server
 *     (vLLM / Ollama serving Qwen or DeepSeek weights) is selected via
 *     MULTITABLE_AI_BASE_URL — and counts as `local` only because such an endpoint
 *     sits on a PRIVATE address. Note the vendors' PUBLIC APIs (api.deepseek.com
 *     and friends) are cloud, and the positive local check treats them as such.
 *     The provider is chosen by config + policy, NOT by the caller.
 *
 *  3. ADVISORY-ONLY. `suggest()` is the ONLY method. It returns a SUGGESTION; it
 *     has no path to commit authoritative data or trigger a side-effect. Every
 *     served result carries provenance `{ aiGenerated: true, advisory: true }` so a
 *     caller / UI can never mix it with source data.
 *
 *  4. GROUNDING / CITATIONS. The request carries grounding sources; the boundary
 *     folds them into the prompt and the envelope carries back which sources were
 *     available and which the model referenced — so features can show citations.
 *
 *  5. FAIL-OPEN. If no provider is ready (the existing aiBlocked condition), the
 *     route refuses, the policy is broken, or ANYTHING throws, `suggest()` returns
 *     `{ available: false, reason }` and NEVER throws. The boundary is NOT a hard
 *     dependency; the platform works fully without it.
 *
 *  6. METERING. An injectable `AiMeteringHook` gets an admission check + a
 *     per-request record — a simple accounting/limit seam (the heavy usage ledger
 *     stays in the bulk path).
 *
 *  7. ONE DOCUMENTED SURFACE. This header + docs/development/
 *     governed-ai-service-boundary-20260901.md are the contract a parallel feature
 *     builds against.
 *
 * WHAT THIS EXTENDS (does NOT duplicate): `resolveAiProviderReadiness` (the
 * aiBlocked / caps gate), `AiProviderClient.complete()` (the provider HTTP,
 * key-in-headers, redaction, timeout), and `redactString` (the unsafe-input scan).
 * The boundary adds the routing gate BEFORE the call and the provenance/citation
 * envelope AFTER it.
 */

import { redactString } from '../multitable/automation-log-redact'
import { AiProviderClient } from './ai-provider-client'
import { resolveAiProviderReadiness, type AiReadinessEnv } from './ai-provider-readiness'
import {
  authorizeAiRoute,
  normalizeDataClass,
  type AiDataClass,
  type AiProviderTier,
} from './ai-routing-policy'

// ─── Consumer-facing request / response contract ────────────────────────────

export interface AiGroundingSource {
  /** Stable id the caller assigns (e.g. a column id / record key). Used for citation. */
  id: string
  /** Optional human label shown alongside a citation. */
  label?: string
  /** The source text/data the model may ground on and cite. */
  content: string
}

export interface AiAdvisoryRequest {
  /** The feature asking — for metering + audit (e.g. 'schema-mapping-copilot'). */
  feature: string
  /**
   * Data-sensitivity class. OMITTED / unknown → 'business' (most restrictive):
   * a request is never treated as less sensitive than it declares.
   */
  dataClass?: AiDataClass
  /** The instruction / question (NON-grounding text). */
  prompt: string
  /** Grounding context the model may use and cite. Optional. */
  grounding?: AiGroundingSource[]
  /** Opaque accounting tag handed to the metering hook. */
  meterKey?: string
}

/**
 * Provenance stamped on EVERY served suggestion. `aiGenerated` and `advisory` are
 * the literal `true` — a caller / UI keys on them to keep AI output out of source
 * data. They are types, not flags to flip.
 */
export interface AiProvenance {
  aiGenerated: true
  advisory: true
  providerTier: AiProviderTier
  provider?: string
  model?: string
}

export interface AiCitation {
  id: string
  label?: string
  /** Best-effort: the model's output referenced this source (by id or label). */
  referenced: boolean
}

export interface AiUsageTokens {
  promptTokens: number
  completionTokens: number
}

export interface AiAdvisoryAvailable {
  available: true
  /** The suggestion. ALWAYS AI-generated and advisory — see `provenance`. */
  suggestion: string
  provenance: AiProvenance
  /** Grounding sources supplied, each flagged whether the model referenced it. */
  citations: AiCitation[]
  usage: AiUsageTokens | null
}

export type AiUnavailableReason =
  | 'provider_not_ready' // readiness ≠ ready (the aiBlocked condition) — fail-open
  | 'routing_policy_invalid' // deploy-file broken — fail-closed (no data sent), fail-open platform
  | 'business_data_cloud_forbidden' // routing refused: business data + cloud-only provider
  | 'class_not_cloud_authorized' // routing refused: class not permitted on a cloud provider
  | 'unsafe_input' // assembled prompt is secret-shaped — not sent
  | 'metered_out' // metering admission declined the call
  | 'provider_error' // the provider call failed
  | 'internal_error' // any unexpected fault — boundary never a hard dependency

export interface AiAdvisoryUnavailable {
  available: false
  reason: AiUnavailableReason
  /** Values-free operator/UI hint. Never carries a key, URL, prompt, or record value. */
  message: string
  /**
   * Provenance is still marked when a provider tier is known (so a UI never
   * mistakes an absent result for data); null when nothing was resolved.
   */
  provenance: AiProvenance | null
}

export type AiAdvisoryResult = AiAdvisoryAvailable | AiAdvisoryUnavailable

// ─── Metering seam ──────────────────────────────────────────────────────────

export interface AiMeteringAdmitContext {
  feature: string
  dataClass: AiDataClass
  meterKey?: string
}

export interface AiMeteringEvent {
  feature: string
  dataClass: AiDataClass
  providerTier: AiProviderTier | null
  outcome: 'served' | 'unavailable'
  reason?: AiUnavailableReason
  meterKey?: string
  usage: AiUsageTokens | null
}

/**
 * The accounting seam. `admit` (optional) can decline a call before any provider
 * work (rate / quota); `record` gets every outcome. Both are best-effort — the
 * boundary guards each call, so a throwing meter can never break fail-open.
 */
export interface AiMeteringHook {
  admit?(ctx: AiMeteringAdmitContext): boolean
  record(event: AiMeteringEvent): void
}

export interface InMemoryAiMeter extends AiMeteringHook {
  snapshot(): { served: number; unavailable: number; admitted: number; declined: number }
}

/**
 * A minimal in-memory meter: counts served / unavailable and (optionally) caps
 * the number of ADMITTED calls. For tests + simple deployments; a real
 * deployment injects its own hook.
 */
export function createInMemoryAiMeter(opts: { maxCalls?: number } = {}): InMemoryAiMeter {
  let served = 0
  let unavailable = 0
  let admitted = 0
  let declined = 0
  const maxCalls = opts.maxCalls
  return {
    admit(): boolean {
      if (typeof maxCalls === 'number' && admitted >= maxCalls) {
        declined += 1
        return false
      }
      admitted += 1
      return true
    },
    record(event: AiMeteringEvent): void {
      if (event.outcome === 'served') served += 1
      else unavailable += 1
    },
    snapshot() {
      return { served, unavailable, admitted, declined }
    },
  }
}

// ─── The boundary ───────────────────────────────────────────────────────────

export interface GovernedAiServiceDeps {
  /** Reused provider client (anthropic / openai-compatible). Tests inject a fetch-spied client. */
  client?: AiProviderClient
  /** Optional accounting seam. */
  meter?: AiMeteringHook
}

/** How many chars of a grounding source ride into the prompt (defense against runaway context). */
const GROUNDING_CONTENT_CHAR_CAP = 4000

export class GovernedAiService {
  private readonly client: AiProviderClient
  private readonly meter?: AiMeteringHook

  constructor(deps: GovernedAiServiceDeps = {}) {
    this.client = deps.client ?? new AiProviderClient()
    this.meter = deps.meter
  }

  /**
   * THE ONLY entry point. Advisory-only, provenance-stamped, fail-open. Never
   * throws for an operational reason (readiness / routing / provider / metering);
   * an unexpected fault is caught and returned as `internal_error`.
   */
  async suggest(request: AiAdvisoryRequest, env: AiReadinessEnv = process.env): Promise<AiAdvisoryResult> {
    // EVERYTHING is inside the try — including the data-class normalize. It used
    // to sit above it, so `suggest(null)` / `suggest(undefined)` REJECTED instead
    // of returning a result, breaking the never-throws invariant this boundary
    // sells (adversarial-review P2). No data could leak that way (it faults before
    // routing), but a caller could mishandle the rejection into a hard dependency —
    // which is exactly what fail-open exists to prevent.
    let dataClass: AiDataClass = 'business'
    try {
      if (!request || typeof request !== 'object') {
        return this.unavailable('internal_error', 'Malformed AI request.', null)
      }
      dataClass = normalizeDataClass(request.dataClass)
      if (typeof request.prompt !== 'string' || request.prompt.length === 0) {
        return this.finishUnavailable(request, dataClass, null, 'internal_error', 'Malformed AI request.')
      }
      return await this.suggestInner(request, dataClass, env)
    } catch (err) {
      // Fail-open keystone: the boundary is NEVER a hard dependency. Any unexpected
      // throw degrades to "AI absent", not a 500 for the caller.
      console.error('[governed-ai] suggest() faulted; failing open (AI absent):', err)
      this.meterRecord({
        feature: typeof request?.feature === 'string' ? request.feature : 'unknown',
        dataClass,
        providerTier: null,
        outcome: 'unavailable',
        reason: 'internal_error',
        ...(typeof request?.meterKey === 'string' ? { meterKey: request.meterKey } : {}),
        usage: null,
      })
      return this.unavailable('internal_error', 'AI is temporarily unavailable.', null)
    }
  }

  private async suggestInner(
    request: AiAdvisoryRequest,
    dataClass: AiDataClass,
    env: AiReadinessEnv,
  ): Promise<AiAdvisoryResult> {
    // (0) Metering admission — before any provider/policy work.
    if (this.meter?.admit) {
      let admitted = true
      try {
        admitted = this.meter.admit({ feature: request.feature, dataClass, meterKey: request.meterKey })
      } catch (err) {
        // A throwing admit must not break fail-open; treat as admitted (the record
        // seam still runs). A deployment that wants hard-closed metering owns that
        // in its hook without throwing.
        console.error('[governed-ai] meter.admit threw; admitting:', err)
      }
      if (!admitted) {
        return this.finishUnavailable(request, dataClass, null, 'metered_out', 'AI request budget exhausted.')
      }
    }

    // (1) Readiness — the aiBlocked gate. Not ready → fail-open unavailable.
    const readiness = resolveAiProviderReadiness(env)
    if (readiness.status !== 'ready' || !readiness.provider || !readiness.model) {
      return this.finishUnavailable(
        request,
        dataClass,
        null,
        'provider_not_ready',
        'AI is not enabled for this deployment.',
      )
    }
    const provider = readiness.provider
    const model = readiness.model

    // (2) THE ROUTING GATE — policy load + tier resolution + decision, via the
    // SHARED choke (`authorizeAiRoute`) that the live shortcut/bulk-fill path also
    // calls. One implementation, so the two consumers can never drift apart. It
    // never throws: a broken deploy-file comes back as `routing_policy_invalid`,
    // fail-closed (no provider called).
    const routing = authorizeAiRoute(provider, dataClass, env)
    // `in`-guard (not `!routing.allowed`): non-strict tsconfig, no boolean-discriminant narrowing.
    if ('reason' in routing) {
      // Tier is unknown/irrelevant on a refusal — a refused request has no serving
      // tier, so provenance stays null rather than asserting one.
      return this.finishUnavailable(request, dataClass, null, routing.reason, routing.message)
    }
    const provenanceBase: AiProvenance = {
      aiGenerated: true,
      advisory: true,
      providerTier: routing.tier,
      provider,
      model,
    }

    // (5) Assemble the grounded prompt + unsafe-input scan (secret-shaped → not sent).
    const assembled = assembleGroundedPrompt(request.prompt, request.grounding)
    if (redactString(assembled) !== assembled) {
      return this.finishUnavailable(
        request,
        dataClass,
        provenanceBase,
        'unsafe_input',
        'The request contains secret-shaped content and was not sent.',
      )
    }

    // (6) Provider call — reuse the existing client (redaction / timeout / key-in-headers).
    const result = await this.client.complete({ prompt: assembled }, env)
    const usage: AiUsageTokens | null = result.usage
      ? { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens }
      : null

    if (result.status === 'blocked') {
      // The env raced between readiness and the call — fail-open.
      return this.finishUnavailable(request, dataClass, provenanceBase, 'provider_not_ready', 'AI is not enabled for this deployment.', usage)
    }
    if (result.status !== 'succeeded' || typeof result.text !== 'string') {
      return this.finishUnavailable(request, dataClass, provenanceBase, 'provider_error', 'The AI provider request failed.', usage)
    }

    // (7) Served — provenance-stamped, advisory-only, with citations.
    const provenance: AiProvenance = {
      aiGenerated: true,
      advisory: true,
      providerTier: routing.tier,
      ...(result.provider ? { provider: result.provider } : { provider }),
      ...(result.model ? { model: result.model } : { model }),
    }
    const citations = buildCitations(request.grounding, result.text)
    this.meterRecord({
      feature: request.feature,
      dataClass,
      providerTier: routing.tier,
      outcome: 'served',
      meterKey: request.meterKey,
      usage,
    })
    return {
      available: true,
      suggestion: result.text,
      provenance,
      citations,
      usage,
    }
  }

  private finishUnavailable(
    request: AiAdvisoryRequest,
    dataClass: AiDataClass,
    provenance: AiProvenance | null,
    reason: AiUnavailableReason,
    message: string,
    usage: AiUsageTokens | null = null,
  ): AiAdvisoryUnavailable {
    this.meterRecord({
      feature: request.feature,
      dataClass,
      providerTier: provenance ? provenance.providerTier : null,
      outcome: 'unavailable',
      reason,
      meterKey: request.meterKey,
      usage,
    })
    return this.unavailable(reason, message, provenance)
  }

  private unavailable(reason: AiUnavailableReason, message: string, provenance: AiProvenance | null): AiAdvisoryUnavailable {
    return { available: false, reason, message, provenance }
  }

  private meterRecord(event: AiMeteringEvent): void {
    if (!this.meter) return
    try {
      this.meter.record(event)
    } catch (err) {
      // Best-effort: metering must never break fail-open.
      console.error('[governed-ai] meter.record threw (ignored):', err)
    }
  }
}

// ─── Grounding / citation helpers ───────────────────────────────────────────

/**
 * Fold grounding sources into the prompt with `[[id]]` markers, and ASK the model
 * to cite them. Content is per-source char-capped so a runaway source cannot blow
 * the context. When there is no grounding the prompt is returned unchanged.
 */
export function assembleGroundedPrompt(prompt: string, grounding?: AiGroundingSource[]): string {
  const sources = (grounding ?? []).filter((s) => s && typeof s.id === 'string' && s.id.length > 0)
  if (sources.length === 0) return prompt
  const lines = sources.map((s) => {
    const label = typeof s.label === 'string' && s.label.trim() ? ` (${s.label.trim()})` : ''
    const content = typeof s.content === 'string' ? s.content.slice(0, GROUNDING_CONTENT_CHAR_CAP) : ''
    return `[[${s.id}]]${label}: ${content}`
  })
  return (
    `${prompt}\n\n` +
    `GROUNDING SOURCES — base your answer only on these and cite each fact with its [[id]]. ` +
    `Do not invent numbers beyond these sources:\n` +
    lines.join('\n')
  )
}

/**
 * Build the citation list the envelope carries back: every supplied source, each
 * flagged whether the model's output REFERENCED it (best-effort — the `[[id]]`
 * marker, or a bare mention of the id / label). The contract guarantees the
 * SUPPLIED set is echoed; `referenced` is a best-effort signal for the UI.
 */
export function buildCitations(grounding: AiGroundingSource[] | undefined, output: string): AiCitation[] {
  const sources = (grounding ?? []).filter((s) => s && typeof s.id === 'string' && s.id.length > 0)
  if (sources.length === 0) return []
  const text = typeof output === 'string' ? output : ''
  return sources.map((s) => {
    const idHit = text.includes(`[[${s.id}]]`) || text.includes(s.id)
    const labelHit = typeof s.label === 'string' && s.label.trim().length > 0 && text.includes(s.label.trim())
    const citation: AiCitation = { id: s.id, referenced: Boolean(idHit || labelHit) }
    if (typeof s.label === 'string' && s.label.trim()) citation.label = s.label.trim()
    return citation
  })
}
