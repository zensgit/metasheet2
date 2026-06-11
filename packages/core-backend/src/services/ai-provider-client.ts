/**
 * Multitable AI provider client (A2) — anthropic messages + openai chat
 * completions behind ONE narrow `complete()` surface.
 *
 * Design lock: docs/development/multitable-ai-shortcut-backend-a2-design-20260611.md §2.3.
 *
 *  - Caps (timeout / max output tokens) come from the A1 readiness resolver.
 *  - fetchFn is injected at CONSTRUCTION (webhook-service precedent) — tests
 *    spy through the SAME seam production uses; no real provider HTTP anywhere.
 *  - Double-confirm gate: readiness `ready` AND
 *    MULTITABLE_AI_CONFIRM_LIVE_REQUESTS === '1'; otherwise `blocked` with
 *    ZERO outbound calls.
 *  - Usage is normalized to { promptTokens, completionTokens } (anthropic
 *    input_tokens/output_tokens ↔ openai prompt_tokens/completion_tokens).
 *  - Per-provider×model price constants are 估算 (estimates for quota
 *    accounting — NOT billing truth). A model missing from the table is a
 *    CONFIG error → `blocked`, never a silent $0 (deep defense behind the A1
 *    model allowlist).
 *  - Leak policy: the API key travels in request headers only; every message
 *    that could embed upstream text passes through the shared redactor AND a
 *    URL-userinfo strip (review-fix F2 — the redactor's userinfo coverage is
 *    postgres/mysql-scheme-only, so a credentialed base URL needs its own scrub).
 */

import { redactString } from '../multitable/automation-log-redact'
import {
  AI_API_KEY_ENV,
  AI_BASE_URL_ENV,
  AI_CONFIRM_LIVE_REQUESTS_ENV,
  resolveAiProviderReadiness,
  type AiProvider,
  type AiProviderCaps,
  type AiReadinessEnv,
} from './ai-provider-readiness'

/**
 * Review-fix F2: scrub URL userinfo (`scheme://user:pass@host`) anywhere a URL
 * can ride into an error/message string. The shared redactor covers userinfo
 * only for postgres/mysql conn-string schemes, so a credentialed
 * MULTITABLE_AI_BASE_URL (e.g. https basic-auth to a proxy) surfacing in a
 * provider error would otherwise leak into the response + ledger `error`.
 *
 * NIT-NEW-1: the userinfo run is `[^/\s]*` (greedy, allows '@'), so a password
 * with an UNENCODED '@' (e.g. `user:p@ss`) is redacted through the LAST '@'
 * before the host — RFC 3986 puts the authority's userinfo entirely before the
 * first '/'. A prior `[^@/\s]+` stopped at the FIRST '@' and leaked the tail
 * (`<redacted>@ss@host`). Stopping at '/' (and whitespace) keeps a bare '@' that
 * appears only in a path/query (`host/users@me`) untouched, and a string with no
 * `scheme://…@` before its first '/' never matches (no userinfo → no change).
 */
export function stripUrlUserinfo(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/gi, '$1<redacted>@')
}

export interface AiUsage {
  promptTokens: number
  completionTokens: number
}

export interface AiModelPrice {
  inputUsdPerMTok: number
  outputUsdPerMTok: number
}

/**
 * 估算 price table (USD per 1M tokens) for quota accounting only — NOT a
 * billing source of truth. Keys are `${provider}:${model}`; extend by PR in
 * lockstep with AI_MODEL_ALLOWLISTS (ai-provider-readiness.ts). A unit test
 * asserts every allowlisted provider×model has an entry.
 */
export const AI_MODEL_PRICES_USD_PER_MTOKEN: Record<string, AiModelPrice> = {
  'anthropic:claude-fable-5': { inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
  'anthropic:claude-opus-4-8': { inputUsdPerMTok: 15, outputUsdPerMTok: 75 },
  'anthropic:claude-opus-4-7': { inputUsdPerMTok: 15, outputUsdPerMTok: 75 },
  'anthropic:claude-opus-4-6': { inputUsdPerMTok: 15, outputUsdPerMTok: 75 },
  'anthropic:claude-sonnet-4-6': { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  'anthropic:claude-haiku-4-5': { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
  'openai:gpt-4o': { inputUsdPerMTok: 2.5, outputUsdPerMTok: 10 },
  'openai:gpt-4o-mini': { inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.6 },
  'openai:gpt-4.1': { inputUsdPerMTok: 2, outputUsdPerMTok: 8 },
  'openai:gpt-4.1-mini': { inputUsdPerMTok: 0.4, outputUsdPerMTok: 1.6 },
}

export function estimateAiCostUsd(price: AiModelPrice, usage: AiUsage): number {
  return (usage.promptTokens * price.inputUsdPerMTok + usage.completionTokens * price.outputUsdPerMTok) / 1_000_000
}

export interface AiCompletionResult {
  /** 'succeeded' | 'blocked' (zero outbound) | 'provider_error' */
  status: 'succeeded' | 'blocked' | 'provider_error'
  ok: boolean
  /** Present on success only. */
  text?: string
  /** Normalized usage whenever the provider returned it — even on failure. */
  usage: AiUsage | null
  /** 估算 cost for the returned usage (0 when no usage). */
  estimatedCostUsd: number
  durationMs: number
  provider?: AiProvider
  model?: string
  /** Redacted reason for blocked / provider_error. */
  message?: string
}

const DEFAULT_BASE_URLS: Record<AiProvider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
}

const ANTHROPIC_VERSION = '2023-06-01'

function normalizeUsage(raw: unknown): AiUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const usage = raw as Record<string, unknown>
  const prompt = usage.input_tokens ?? usage.prompt_tokens
  const completion = usage.output_tokens ?? usage.completion_tokens
  const promptTokens = Number(prompt)
  const completionTokens = Number(completion)
  if (!Number.isFinite(promptTokens) && !Number.isFinite(completionTokens)) return null
  return {
    promptTokens: Number.isFinite(promptTokens) && promptTokens > 0 ? Math.round(promptTokens) : 0,
    completionTokens: Number.isFinite(completionTokens) && completionTokens > 0 ? Math.round(completionTokens) : 0,
  }
}

function extractUsageFromBody(body: unknown): AiUsage | null {
  if (!body || typeof body !== 'object') return null
  return normalizeUsage((body as Record<string, unknown>).usage)
}

function extractText(provider: AiProvider, body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  if (provider === 'anthropic') {
    const content = record.content
    if (!Array.isArray(content)) return null
    const parts = content
      .filter((part): part is { type?: unknown; text?: unknown } => !!part && typeof part === 'object')
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .filter((text) => text.length > 0)
    return parts.length > 0 ? parts.join('') : null
  }
  const choices = record.choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const message = (choices[0] as { message?: { content?: unknown } } | undefined)?.message
  return typeof message?.content === 'string' ? message.content : null
}

export interface AiPreflightReady {
  ok: true
  provider: AiProvider
  model: string
  caps: AiProviderCaps
  price: AiModelPrice
}

export interface AiPreflightBlocked {
  ok: false
  message: string
  provider?: AiProvider
  model?: string
}

export type AiPreflightResult = AiPreflightReady | AiPreflightBlocked

export class AiProviderClient {
  private fetchFn: typeof fetch
  private priceTable: Record<string, AiModelPrice>

  constructor(options: { fetchFn?: typeof fetch; priceTable?: Record<string, AiModelPrice> } = {}) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch
    this.priceTable = options.priceTable ?? AI_MODEL_PRICES_USD_PER_MTOKEN
  }

  /**
   * The blocked-or-ready gate set (readiness / E-12 double-confirm / price
   * table), extracted so the route can resolve `blocked` BEFORE the burst
   * limiter and the quota reserve (review-fix F1 gate order) and size the
   * reservation from `caps`/`price`. `complete()` re-runs the same gates
   * internally (defense in depth) — semantics are identical.
   */
  preflight(env: AiReadinessEnv = process.env): AiPreflightResult {
    const readiness = resolveAiProviderReadiness(env)
    if (readiness.status !== 'ready' || !readiness.provider || !readiness.model) {
      return { ok: false, message: `AI provider readiness is '${readiness.status}'; no request was sent.` }
    }
    const provider = readiness.provider
    const model = readiness.model

    // Double-confirm gate (E-12): readiness alone never authorizes spend.
    const confirm = typeof env[AI_CONFIRM_LIVE_REQUESTS_ENV] === 'string' ? env[AI_CONFIRM_LIVE_REQUESTS_ENV]!.trim() : ''
    if (confirm !== '1') {
      return {
        ok: false,
        message: `${AI_CONFIRM_LIVE_REQUESTS_ENV} is not '1'; live AI requests are not confirmed for this deployment.`,
        provider,
        model,
      }
    }

    const price = this.priceTable[`${provider}:${model}`]
    if (!price) {
      return {
        ok: false,
        message: `Model '${model}' has no entry in the ${provider} price table; refusing to spend unaccounted tokens.`,
        provider,
        model,
      }
    }

    return { ok: true, provider, model, caps: readiness.caps, price }
  }

  async complete(input: { prompt: string }, env: AiReadinessEnv = process.env): Promise<AiCompletionResult> {
    const startedAt = Date.now()
    const blocked = (message: string, provider?: AiProvider, model?: string): AiCompletionResult => ({
      status: 'blocked',
      ok: false,
      usage: null,
      estimatedCostUsd: 0,
      durationMs: Date.now() - startedAt,
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      message,
    })

    const pre = this.preflight(env)
    // `in`-guard (not `!pre.ok`): non-strict tsconfig, no boolean-discriminant narrowing.
    if ('message' in pre) {
      return blocked(pre.message, pre.provider, pre.model)
    }
    const { provider, model, price, caps } = pre

    const apiKey = typeof env[AI_API_KEY_ENV] === 'string' ? env[AI_API_KEY_ENV]!.trim() : ''
    const baseUrlRaw = typeof env[AI_BASE_URL_ENV] === 'string' ? env[AI_BASE_URL_ENV]!.trim() : ''
    const baseUrl = (baseUrlRaw || DEFAULT_BASE_URLS[provider]).replace(/\/+$/, '')

    const url = provider === 'anthropic' ? `${baseUrl}/v1/messages` : `${baseUrl}/v1/chat/completions`
    const headers: Record<string, string> =
      provider === 'anthropic'
        ? { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }
        : { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
    // Same body shape for both providers (anthropic messages and openai chat
    // completions both take model + max_tokens + a user message array).
    const body = {
      model,
      max_tokens: caps.maxOutputTokens,
      messages: [{ role: 'user', content: input.prompt }],
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), caps.requestTimeoutMs)

    // F2: strip URL userinfo BEFORE the shared redactor — an upstream error
    // can embed the (possibly credentialed) base URL verbatim.
    const providerError = (message: string, usage: AiUsage | null): AiCompletionResult => ({
      status: 'provider_error',
      ok: false,
      usage,
      estimatedCostUsd: usage ? estimateAiCostUsd(price, usage) : 0,
      durationMs: Date.now() - startedAt,
      provider,
      model,
      message: redactString(stripUrlUserinfo(message)),
    })

    try {
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      let parsedBody: unknown = null
      try {
        parsedBody = await response.json()
      } catch {
        parsedBody = null
      }
      const usage = extractUsageFromBody(parsedBody)

      if (!response.ok) {
        return providerError(`Provider responded HTTP ${response.status}.`, usage)
      }

      const text = extractText(provider, parsedBody)
      if (text === null) {
        return providerError('Provider response had no parseable completion text.', usage)
      }

      return {
        status: 'succeeded',
        ok: true,
        text,
        usage,
        estimatedCostUsd: usage ? estimateAiCostUsd(price, usage) : 0,
        durationMs: Date.now() - startedAt,
        provider,
        model,
      }
    } catch (err) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      return providerError(`Provider request failed (${reason}).`, null)
    } finally {
      clearTimeout(timeout)
    }
  }
}
