/**
 * A3 client functions — aiShortcutPreview / aiShortcutRun / aiUsageSummary
 * (docs/development/multitable-ai-shortcut-frontend-a3-design-20260611.md §2.3,
 * matrix legs A3-T2 (client) / A3-T4 (wire parse) / A3-T5 (dual-429)).
 *
 * The wire fixtures mirror the PINNED A2 route responses
 * (packages/core-backend/src/routes/multitable-ai.ts:555-569 +
 * tests/integration/multitable-ai-shortcut-run.test.ts key-set pin).
 */
import { describe, expect, it, vi } from 'vitest'
import { MultitableApiClient } from '../src/multitable/api/client'

type ApiErr = Error & {
  status?: number
  code?: string
  serverVersion?: number
  retryAfterMs?: number
}

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
}

const PREVIEW_WIRE = {
  ok: true,
  data: {
    status: 'succeeded',
    action: 'preview',
    output: 'PREVIEW OUT',
    usage: { promptTokens: 9, completionTokens: 4 },
    estimatedCostUsd: 0.0001,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
  },
}

const RUN_WIRE = {
  ok: true,
  data: {
    status: 'succeeded',
    action: 'run',
    recordId: 'rec_1',
    fieldId: 'fld_t',
    version: 2,
    output: 'AI OUT',
    usage: { promptTokens: 21, completionTokens: 13 },
    estimatedCostUsd: 0.0002,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
  },
}

describe('MultitableApiClient AI shortcut (A3)', () => {
  it('aiShortcutPreview posts inline draft config + recordId and unwraps the data envelope (A3-T2)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(PREVIEW_WIRE))
    const client = new MultitableApiClient({ fetchFn })

    const config = { kind: 'classify' as const, sourceFieldIds: ['fld_src'], params: { options: ['A', 'B'] } }
    const data = await client.aiShortcutPreview('sheet_1', { recordId: 'rec_1', config })

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/multitable/sheets/sheet_1/ai/shortcut/preview')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ recordId: 'rec_1', config })
    expect(data).toEqual(PREVIEW_WIRE.data)
  })

  it('aiShortcutPreview posts a persisted fieldId without a config key (drawer path)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(PREVIEW_WIRE))
    const client = new MultitableApiClient({ fetchFn })

    await client.aiShortcutPreview('sheet_1', { recordId: 'rec_1', fieldId: 'fld_t' })

    const body = JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body))
    expect(body).toEqual({ recordId: 'rec_1', fieldId: 'fld_t' })
    expect('config' in body).toBe(false)
  })

  it('aiShortcutRun posts ONLY {recordId, fieldId} (run rejects inline config server-side) and parses the run wire', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(RUN_WIRE))
    const client = new MultitableApiClient({ fetchFn })

    const data = await client.aiShortcutRun('sheet_1', { recordId: 'rec_1', fieldId: 'fld_t' })

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/multitable/sheets/sheet_1/ai/shortcut/run')
    expect(JSON.parse(String(init.body))).toEqual({ recordId: 'rec_1', fieldId: 'fld_t' })
    expect(data).toEqual(RUN_WIRE.data)
  })

  it('aiShortcutRun keeps version === null intact (adapter must skip the version merge)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ ok: true, data: { ...RUN_WIRE.data, version: null } }))
    const client = new MultitableApiClient({ fetchFn })

    const data = await client.aiShortcutRun('sheet_1', { recordId: 'rec_1', fieldId: 'fld_t' })
    expect(data.version).toBeNull()
  })

  it('aiUsageSummary GETs the admin summary (flat single-object response)', async () => {
    const summary = {
      callerDayTokens: 123,
      callerWeekTokens: 456,
      instanceDayUsd: 7.89,
      caps: { tenantDailyTokenCap: 111000, tenantWeeklyTokenCap: 555000, accountDailyUsdCap: 12 },
    }
    const fetchFn = vi.fn(async () => jsonResponse(summary))
    const client = new MultitableApiClient({ fetchFn })

    const data = await client.aiUsageSummary()
    expect(fetchFn.mock.calls[0][0]).toBe('/api/multitable/ai/usage-summary')
    expect(data).toEqual(summary)
  })

  it('A3-T5 dual-429: RATE_LIMITED carries retryAfterMs from Retry-After; AI_QUOTA_EXHAUSTED has none', async () => {
    const limited = new MultitableApiClient({
      fetchFn: vi.fn(async () => jsonResponse(
        { ok: false, status: 'rate_limited', error: { code: 'RATE_LIMITED', message: 'Too many AI shortcut requests.', retryAfter: 7 } },
        { status: 429, headers: { 'Retry-After': '7' } },
      )),
    })
    const limitedErr = await limited.aiShortcutRun('sheet_1', { recordId: 'rec_1', fieldId: 'fld_t' }).catch((e: ApiErr) => e)
    expect(limitedErr.status).toBe(429)
    expect(limitedErr.code).toBe('RATE_LIMITED')
    expect(limitedErr.retryAfterMs).toBe(7000)

    const quota = new MultitableApiClient({
      fetchFn: vi.fn(async () => jsonResponse(
        { ok: false, status: 'quota_exhausted', error: { code: 'AI_QUOTA_EXHAUSTED', message: 'AI usage quota exhausted (user_daily_tokens).' } },
        { status: 429 }, // quota 429 has NO Retry-After (pinned contract)
      )),
    })
    const quotaErr = await quota.aiShortcutRun('sheet_1', { recordId: 'rec_1', fieldId: 'fld_t' }).catch((e: ApiErr) => e)
    expect(quotaErr.status).toBe(429)
    expect(quotaErr.code).toBe('AI_QUOTA_EXHAUSTED')
    expect(quotaErr.retryAfterMs).toBeUndefined()
  })

  it('A3-T5: 503 AI_BLOCKED / 422 AI_UNSAFE_INPUT / 502 AI_PROVIDER_ERROR / 409 VERSION_CONFLICT codes survive parseJson', async () => {
    const cases: Array<{ status: number; code: string; extra?: Record<string, unknown> }> = [
      { status: 503, code: 'AI_BLOCKED' },
      { status: 422, code: 'AI_UNSAFE_INPUT' },
      { status: 502, code: 'AI_PROVIDER_ERROR' },
      { status: 409, code: 'VERSION_CONFLICT', extra: { serverVersion: 9 } },
    ]
    for (const testCase of cases) {
      const client = new MultitableApiClient({
        fetchFn: vi.fn(async () => jsonResponse(
          { ok: false, error: { code: testCase.code, message: `${testCase.code} happened`, ...(testCase.extra ?? {}) } },
          { status: testCase.status },
        )),
      })
      const err = await client.aiShortcutRun('sheet_1', { recordId: 'rec_1', fieldId: 'fld_t' }).catch((e: ApiErr) => e)
      expect(err.status).toBe(testCase.status)
      expect(err.code).toBe(testCase.code)
      if (testCase.extra?.serverVersion) expect(err.serverVersion).toBe(9)
    }
  })
})
