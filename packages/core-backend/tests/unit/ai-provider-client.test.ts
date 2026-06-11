/**
 * A2 provider client — unit legs of A2-T1 (double-confirm gate), A2-T8
 * (provider error classification + unknown-model price), A2-T10 (leak
 * sentinel) per docs/development/multitable-ai-shortcut-backend-a2-design-20260611.md §2.3.
 *
 * HARD RULE: no real provider HTTP anywhere — every test injects fetchFn at
 * CONSTRUCTION (the same seam production uses; webhook-service precedent).
 */
import { describe, expect, it, vi } from 'vitest'

import {
  AiProviderClient,
  AI_MODEL_PRICES_USD_PER_MTOKEN,
  estimateAiCostUsd,
  stripUrlUserinfo,
} from '../../src/services/ai-provider-client'
import { AI_MODEL_ALLOWLISTS, AI_PROVIDER_ALLOWLIST } from '../../src/services/ai-provider-readiness'

const KEY_SENTINEL = `sk-${'clientleak'.repeat(3)}`

function readyEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    MULTITABLE_AI_ENABLED: '1',
    MULTITABLE_AI_PROVIDER: 'anthropic',
    MULTITABLE_AI_API_KEY: KEY_SENTINEL,
    MULTITABLE_AI_MODEL: 'claude-sonnet-4-6',
    MULTITABLE_AI_CONFIRM_LIVE_REQUESTS: '1',
    ...overrides,
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('AiProviderClient gates (A2-T1)', () => {
  it('readiness ≠ ready → blocked with ZERO outbound calls', async () => {
    const fetchSpy = vi.fn()
    const client = new AiProviderClient({ fetchFn: fetchSpy as unknown as typeof fetch })
    const result = await client.complete({ prompt: 'hello' }, { MULTITABLE_AI_ENABLED: '0' })
    expect(result.status).toBe('blocked')
    expect(result.ok).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('ready but MULTITABLE_AI_CONFIRM_LIVE_REQUESTS ≠ 1 → blocked with ZERO outbound (double-confirm)', async () => {
    const fetchSpy = vi.fn()
    const client = new AiProviderClient({ fetchFn: fetchSpy as unknown as typeof fetch })
    const result = await client.complete({ prompt: 'hello' }, readyEnv({ MULTITABLE_AI_CONFIRM_LIVE_REQUESTS: undefined }))
    expect(result.status).toBe('blocked')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('model missing from the price table → blocked, never silent $0 (deep defense)', async () => {
    const fetchSpy = vi.fn()
    const client = new AiProviderClient({
      fetchFn: fetchSpy as unknown as typeof fetch,
      priceTable: {}, // simulate a future allowlisted model not yet priced
    })
    const result = await client.complete({ prompt: 'hello' }, readyEnv())
    expect(result.status).toBe('blocked')
    expect(result.message).toContain('price')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('AiProviderClient usage normalization (§2.3 gap)', () => {
  it('anthropic messages: input_tokens/output_tokens → promptTokens/completionTokens', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse(200, {
        content: [{ type: 'text', text: 'OUT' }],
        usage: { input_tokens: 11, output_tokens: 7 },
      }),
    )
    const client = new AiProviderClient({ fetchFn: fetchSpy as unknown as typeof fetch })
    const result = await client.complete({ prompt: 'hello' }, readyEnv())
    expect(result.status).toBe('succeeded')
    expect(result.text).toBe('OUT')
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 7 })
    expect(result.estimatedCostUsd).toBeGreaterThan(0)
    // request body carries the prompt; key travels in headers only
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain('/v1/messages')
    expect(String(init.body)).toContain('hello')
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(KEY_SENTINEL)
  })

  it('openai chat completions: prompt_tokens/completion_tokens → promptTokens/completionTokens', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse(200, {
        choices: [{ message: { role: 'assistant', content: 'OUT-OAI' } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
    )
    const client = new AiProviderClient({ fetchFn: fetchSpy as unknown as typeof fetch })
    const result = await client.complete(
      { prompt: 'hello' },
      readyEnv({ MULTITABLE_AI_PROVIDER: 'openai', MULTITABLE_AI_MODEL: 'gpt-4o-mini' }),
    )
    expect(result.status).toBe('succeeded')
    expect(result.text).toBe('OUT-OAI')
    expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 3 })
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain('/v1/chat/completions')
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY_SENTINEL}`)
  })

  it('every allowlisted provider×model has a price entry (the table can never silently lag the allowlist)', () => {
    for (const provider of AI_PROVIDER_ALLOWLIST) {
      for (const model of AI_MODEL_ALLOWLISTS[provider]) {
        expect(AI_MODEL_PRICES_USD_PER_MTOKEN[`${provider}:${model}`], `${provider}:${model}`).toBeDefined()
      }
    }
  })

  it('estimateAiCostUsd computes per-MTok pricing', () => {
    expect(estimateAiCostUsd({ inputUsdPerMTok: 3, outputUsdPerMTok: 15 }, { promptTokens: 1_000_000, completionTokens: 0 })).toBeCloseTo(3)
    expect(estimateAiCostUsd({ inputUsdPerMTok: 3, outputUsdPerMTok: 15 }, { promptTokens: 0, completionTokens: 100_000 })).toBeCloseTo(1.5)
  })
})

describe('AiProviderClient error classification (A2-T8) + leak sentinel (A2-T10)', () => {
  it('HTTP 5xx → provider_error with a redacted message; usage still surfaced when the body carries it', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse(500, {
        error: { message: `boom ${KEY_SENTINEL}` },
        usage: { input_tokens: 4, output_tokens: 0 },
      }),
    )
    const client = new AiProviderClient({ fetchFn: fetchSpy as unknown as typeof fetch })
    const result = await client.complete({ prompt: 'hello' }, readyEnv())
    expect(result.status).toBe('provider_error')
    expect(result.usage).toEqual({ promptTokens: 4, completionTokens: 0 })
    expect(JSON.stringify(result)).not.toContain(KEY_SENTINEL)
  })

  it('network failure → provider_error, message redacted', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error(`ECONNREFUSED via Bearer ${KEY_SENTINEL}`)
    })
    const client = new AiProviderClient({ fetchFn: fetchSpy as unknown as typeof fetch })
    const result = await client.complete({ prompt: 'hello' }, readyEnv())
    expect(result.status).toBe('provider_error')
    expect(result.usage).toBeNull()
    expect(JSON.stringify(result)).not.toContain(KEY_SENTINEL)
  })

  it('timeout (caps.requestTimeoutMs) aborts via AbortController → provider_error', async () => {
    const fetchSpy = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const client = new AiProviderClient({ fetchFn: fetchSpy as unknown as typeof fetch })
    const result = await client.complete(
      { prompt: 'hello' },
      readyEnv({ MULTITABLE_AI_REQUEST_TIMEOUT_MS: '1000' }), // approved minimum
    )
    expect(result.status).toBe('provider_error')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  }, 10_000)

  it('2xx with unparseable shape → provider_error, never a fabricated success', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(200, { unexpected: true }))
    const client = new AiProviderClient({ fetchFn: fetchSpy as unknown as typeof fetch })
    const result = await client.complete({ prompt: 'hello' }, readyEnv())
    expect(result.status).toBe('provider_error')
  })
})

describe('URL userinfo strip (review-fix F2)', () => {
  const URL_SECRET = 'hunter2basicauthsecret'

  it('stripUrlUserinfo scrubs credentials in any scheme://user:pass@host shape', () => {
    expect(stripUrlUserinfo(`connect to https://svc:${URL_SECRET}@proxy.internal/v1 failed`)).toBe(
      'connect to https://<redacted>@proxy.internal/v1 failed',
    )
    expect(stripUrlUserinfo(`odbc://sa:${URL_SECRET}@db.internal;Database=x`)).toBe('odbc://<redacted>@db.internal;Database=x')
    // no userinfo → untouched
    expect(stripUrlUserinfo('see https://proxy.internal/v1/messages')).toBe('see https://proxy.internal/v1/messages')
  })

  it('redacts through the LAST @ when the password embeds an unencoded @ (multi-@ tail leak)', () => {
    // NIT-NEW-1: a password with a literal '@' (e.g. user:p@ss) puts a second '@'
    // BEFORE the host. Stopping at the FIRST '@' leaked the tail ('ss@host').
    expect(stripUrlUserinfo(`https://user:p${URL_SECRET}@ss@proxy.internal/v1`)).toBe(
      'https://<redacted>@proxy.internal/v1',
    )
    // Three '@' in the userinfo — still redacted through the last one before the host.
    expect(stripUrlUserinfo(`odbc://sa:a@b@${URL_SECRET}@db.internal;Database=x`)).toBe(
      'odbc://<redacted>@db.internal;Database=x',
    )
    // The secret must not survive anywhere in the output.
    expect(stripUrlUserinfo(`https://user:p${URL_SECRET}@ss@proxy.internal/v1`)).not.toContain(URL_SECRET)
  })

  it('does not treat an @ that appears AFTER the path as userinfo', () => {
    // A bare '@' inside a path/query (no scheme://...@ before the first '/') stays put —
    // the greedy userinfo run must stop at the first '/'.
    expect(stripUrlUserinfo('see https://proxy.internal/v1/users@me')).toBe(
      'see https://proxy.internal/v1/users@me',
    )
  })

  it('a credentialed MULTITABLE_AI_BASE_URL surfacing in a network error never reaches the provider_error message', async () => {
    const credentialedBase = `https://svc:${URL_SECRET}@proxy.internal`
    const fetchSpy = vi.fn(async (url: unknown) => {
      // probe-proven leak shape: an upstream error embedding the raw URL verbatim
      throw new Error(`getaddrinfo ENOTFOUND for ${String(url)}`)
    })
    const client = new AiProviderClient({ fetchFn: fetchSpy as unknown as typeof fetch })
    const result = await client.complete({ prompt: 'hello' }, readyEnv({ MULTITABLE_AI_BASE_URL: credentialedBase }))
    expect(result.status).toBe('provider_error')
    expect(result.message).toContain('proxy.internal') // host context preserved for diagnosis
    expect(JSON.stringify(result)).not.toContain(URL_SECRET) // password never surfaces
  })
})

describe('preflight (review-fix F1 gate-order seam)', () => {
  it('mirrors complete()-blocked semantics and exposes caps + price when fully confirmed', () => {
    const client = new AiProviderClient({ fetchFn: vi.fn() as unknown as typeof fetch })

    const notReady = client.preflight({ MULTITABLE_AI_ENABLED: '0' })
    expect('message' in notReady && notReady.message).toContain('readiness')

    const unconfirmed = client.preflight(readyEnv({ MULTITABLE_AI_CONFIRM_LIVE_REQUESTS: undefined }))
    expect('message' in unconfirmed && unconfirmed.message).toContain('MULTITABLE_AI_CONFIRM_LIVE_REQUESTS')

    const ready = client.preflight(readyEnv())
    expect('caps' in ready).toBe(true)
    if ('caps' in ready) {
      expect(ready.provider).toBe('anthropic')
      expect(ready.model).toBe('claude-sonnet-4-6')
      expect(ready.caps.maxOutputTokens).toBeGreaterThan(0)
      expect(ready.price.inputUsdPerMTok).toBeGreaterThan(0)
    }
  })
})
