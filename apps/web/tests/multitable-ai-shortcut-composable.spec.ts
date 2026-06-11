/**
 * A3 useAiShortcut composable — matrix legs A3-T4 (run-response adapter against
 * the REAL wire shape) / A3-T4b (local-version drift guard + review-F4
 * own-Yjs-echo carve-out) / A3-T5 (error states keyed on error.code, dual-429
 * semantics) / A3-T5b (reentrancy + review-F3 unified `busy` exposure).
 *
 * Wire fidelity: every test drives the REAL MultitableApiClient.parseJson over
 * route-shaped JSON — the RUN_WIRE fixture key set is PINNED route-level by
 * packages/core-backend/tests/integration/multitable-ai-shortcut-run.test.ts
 * (A2-T5 Object.keys assertion). Zero real provider calls: fetchFn is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MultitableApiClient } from '../src/multitable/api/client'
import {
  adaptAiShortcutRunResult,
  fetchAiUsageSummaryWithProbeCache,
  resetAiUsageSummarySessionCache,
  useAiShortcut,
} from '../src/multitable/composables/useAiShortcut'
import type { PatchResult } from '../src/multitable/types'

// PINNED run wire shape (backend integration A2-T5 key-set assertion mirrors this).
const RUN_WIRE_DATA = {
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
}

const PREVIEW_WIRE_DATA = {
  status: 'succeeded',
  action: 'preview',
  output: 'PREVIEW OUT',
  usage: { promptTokens: 9, completionTokens: 4 },
  estimatedCostUsd: 0.0001,
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
}

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
}

function setup(fetchFn: (input: string, init?: RequestInit) => Promise<Response>) {
  const client = new MultitableApiClient({ fetchFn })
  const applied: PatchResult[] = []
  const versionRef = { current: 1 as number | undefined }
  const ai = useAiShortcut({
    client,
    sheetId: () => 'sheet_1',
    getLocalRecordVersion: () => versionRef.current,
    applyPatchResult: (result) => applied.push(result),
  })
  return { ai, applied, versionRef }
}

describe('adaptAiShortcutRunResult (A3-T4 adapter)', () => {
  it('synthesizes {updated, records} for applyPatchResult from the pinned run wire', () => {
    expect(adaptAiShortcutRunResult(RUN_WIRE_DATA as never)).toEqual({
      updated: [{ recordId: 'rec_1', version: 2 }],
      records: [{ recordId: 'rec_1', data: { fld_t: 'AI OUT' } }],
    })
  })

  it('version === null → skips the version write, still merges the value', () => {
    expect(adaptAiShortcutRunResult({ ...RUN_WIRE_DATA, version: null } as never)).toEqual({
      updated: [],
      records: [{ recordId: 'rec_1', data: { fld_t: 'AI OUT' } }],
    })
  })
})

describe('useAiShortcut', () => {
  beforeEach(() => {
    resetAiUsageSummarySessionCache()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('A3-T4: run feeds the adapter output through applyPatchResult and exposes per-run tokens', async () => {
    const { ai, applied } = setup(async () => jsonResponse({ ok: true, data: RUN_WIRE_DATA }))

    await ai.run('rec_1', 'fld_t')

    expect(applied).toEqual([{
      updated: [{ recordId: 'rec_1', version: 2 }],
      records: [{ recordId: 'rec_1', data: { fld_t: 'AI OUT' } }],
    }])
    expect(ai.state.result).toMatchObject({
      kind: 'run',
      recordId: 'rec_1',
      fieldId: 'fld_t',
      output: 'AI OUT',
      promptTokens: 21,
      completionTokens: 13,
      totalTokens: 34,
      merged: true,
      refreshHint: false,
    })
    expect(ai.state.error).toBeNull()
    expect(ai.state.pending).toBeNull()
  })

  it('A3-T4: version === null on the wire → merge value only (no version entry)', async () => {
    const { ai, applied } = setup(async () => jsonResponse({ ok: true, data: { ...RUN_WIRE_DATA, version: null } }))

    await ai.run('rec_1', 'fld_t')
    expect(applied[0].updated).toEqual([])
    expect(applied[0].records).toEqual([{ recordId: 'rec_1', data: { fld_t: 'AI OUT' } }])
  })

  it('A3-T4b: genuine drift (local version ≠ captured AND ≠ response) → skip merge + refresh hint', async () => {
    let bump: (() => void) | null = null
    const { ai, applied, versionRef } = setup(async () => {
      bump?.()
      return jsonResponse({ ok: true, data: RUN_WIRE_DATA })
    })
    versionRef.current = 1
    bump = () => { versionRef.current = 5 } // collaborator edit lands mid-flight (5 ≠ captured 1, ≠ response 2)

    await ai.run('rec_1', 'fld_t')

    expect(applied).toEqual([]) // merge skipped entirely — no silent overwrite
    expect(ai.state.result).toMatchObject({ merged: false, refreshHint: true })
  })

  it('review F4: own Yjs echo (local version bumped to the RESPONSE version mid-flight) → success, NO refresh warning', async () => {
    let bump: (() => void) | null = null
    const { ai, applied, versionRef } = setup(async () => {
      bump?.()
      return jsonResponse({ ok: true, data: RUN_WIRE_DATA })
    })
    versionRef.current = 1
    // The run's OWN write echoes back through the live Yjs session before the
    // HTTP response lands: local version === response version (2).
    bump = () => { versionRef.current = RUN_WIRE_DATA.version }

    await ai.run('rec_1', 'fld_t')

    expect(applied).toEqual([]) // already applied by the echo — redundant merge skipped silently
    expect(ai.state.result).toMatchObject({
      kind: 'run',
      output: 'AI OUT',
      totalTokens: 34, // tokens still shown
      merged: true, // the output IS reflected locally
      refreshHint: false, // and no false '记录已被他人更新' alarm
    })
    expect(ai.state.error).toBeNull()
  })

  it('A3-T5b: reentrancy — pending run blocks a second request (single fetch)', async () => {
    let resolveFetch: ((res: Response) => void) | null = null
    const fetchFn = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve }))
    const { ai } = setup(fetchFn as never)

    const first = ai.run('rec_1', 'fld_t')
    expect(ai.state.pending).toEqual({ kind: 'run', recordId: 'rec_1', fieldId: 'fld_t' })
    await ai.run('rec_1', 'fld_t') // second entry while pending → no-op
    await ai.preview('rec_1', 'fld_t') // any entry shares the guard
    expect(fetchFn).toHaveBeenCalledTimes(1)

    resolveFetch!(jsonResponse({ ok: true, data: RUN_WIRE_DATA }))
    await first
    expect(ai.state.pending).toBeNull()
  })

  it('A3-T5: RATE_LIMITED → error code + retryAfterMs countdown that gates new requests', async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn(async () => jsonResponse(
      { ok: false, status: 'rate_limited', error: { code: 'RATE_LIMITED', message: 'slow down', retryAfter: 3 } },
      { status: 429, headers: { 'Retry-After': '3' } },
    ))
    const { ai } = setup(fetchFn as never)

    await ai.run('rec_1', 'fld_t')
    expect(ai.state.error?.code).toBe('RATE_LIMITED')
    expect(ai.state.retryRemainingMs).toBe(3000)

    await ai.run('rec_1', 'fld_t') // countdown gates all entries
    expect(fetchFn).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(4000)
    expect(ai.state.retryRemainingMs).toBeNull()
  })

  it('review F3: `busy` mirrors the begin() guard — true while pending AND while the countdown runs', async () => {
    vi.useFakeTimers()
    let resolveFetch: ((res: Response) => void) | null = null
    const fetchFn = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve }))
    const { ai } = setup(fetchFn as never)
    expect(ai.busy.value).toBe(false)

    const first = ai.run('rec_1', 'fld_t')
    expect(ai.busy.value).toBe(true) // in-flight

    resolveFetch!(jsonResponse(
      { ok: false, status: 'rate_limited', error: { code: 'RATE_LIMITED', message: 'slow down', retryAfter: 3 } },
      { status: 429, headers: { 'Retry-After': '3' } },
    ))
    await first
    expect(ai.state.pending).toBeNull()
    expect(ai.busy.value).toBe(true) // countdown active — every surface stays disabled

    await vi.advanceTimersByTimeAsync(4000)
    expect(ai.busy.value).toBe(false) // countdown expired — surfaces re-enable
  })

  it('A3-T5: AI_QUOTA_EXHAUSTED (429 WITHOUT Retry-After) → no countdown', async () => {
    const { ai } = setup(async () => jsonResponse(
      { ok: false, status: 'quota_exhausted', error: { code: 'AI_QUOTA_EXHAUSTED', message: 'quota' } },
      { status: 429 },
    ))
    await ai.run('rec_1', 'fld_t')
    expect(ai.state.error?.code).toBe('AI_QUOTA_EXHAUSTED')
    expect(ai.state.retryRemainingMs).toBeNull()
  })

  it('A3-T5: AI_BLOCKED (503) keeps its own code — never collapsed into a generic 5xx bucket', async () => {
    const { ai } = setup(async () => jsonResponse(
      { ok: false, status: 'blocked', error: { code: 'AI_BLOCKED', message: 'not enabled' } },
      { status: 503 },
    ))
    await ai.run('rec_1', 'fld_t')
    expect(ai.state.error?.code).toBe('AI_BLOCKED')
    expect(ai.state.error?.status).toBe(503)
  })

  it('A3-T5: AI_UNSAFE_INPUT (422) / AI_PROVIDER_ERROR (502) / VERSION_CONFLICT (409) map by error.code', async () => {
    const cases = [
      { status: 422, code: 'AI_UNSAFE_INPUT' },
      { status: 502, code: 'AI_PROVIDER_ERROR' },
      { status: 409, code: 'VERSION_CONFLICT' },
    ]
    for (const testCase of cases) {
      const { ai, applied } = setup(async () => jsonResponse(
        { ok: false, error: { code: testCase.code, message: 'x' } },
        { status: testCase.status },
      ))
      await ai.run('rec_1', 'fld_t')
      expect(ai.state.error?.code).toBe(testCase.code)
      expect(applied).toEqual([]) // failed runs never merge
    }
  })

  it('preview (persisted fieldId) records a preview result with tokens and no merge', async () => {
    const { ai, applied } = setup(async () => jsonResponse({ ok: true, data: PREVIEW_WIRE_DATA }))
    const data = await ai.preview('rec_1', 'fld_t')
    expect(data?.output).toBe('PREVIEW OUT')
    expect(applied).toEqual([])
    expect(ai.state.result).toMatchObject({ kind: 'preview', totalTokens: 13, merged: false })
  })

  it('previewWithConfig posts the inline draft config and returns the outcome inline (manager path)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ ok: true, data: PREVIEW_WIRE_DATA }))
    const { ai } = setup(fetchFn as never)

    const config = { kind: 'summarize' as const, sourceFieldIds: ['fld_src'] }
    const outcome = await ai.previewWithConfig('rec_cur', config)

    const body = JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body))
    expect(body).toEqual({ recordId: 'rec_cur', config })
    expect(outcome && 'data' in outcome && outcome.data.output).toBe('PREVIEW OUT')
  })

  it('previewWithConfig surfaces errors inline (server config rejection keeps its code/message)', async () => {
    const { ai } = setup(async () => jsonResponse(
      { ok: false, error: { code: 'VALIDATION_ERROR', message: 'aiShortcut.kind must be one of...' } },
      { status: 400 },
    ))
    const outcome = await ai.previewWithConfig('rec_cur', { kind: 'summarize', sourceFieldIds: ['fld_src'] })
    expect(outcome && 'error' in outcome && outcome.error.code).toBe('VALIDATION_ERROR')
    expect(outcome && 'error' in outcome && outcome.error.message).toContain('aiShortcut.kind')
  })
})

describe('fetchAiUsageSummaryWithProbeCache (A3-T7 FE 403 session cache)', () => {
  beforeEach(() => {
    resetAiUsageSummarySessionCache()
  })

  it('403 probe is cached per session — the fetch fn is never re-invoked', async () => {
    const forbidden = Object.assign(new Error('Insufficient permissions'), { status: 403 })
    const fn = vi.fn(async () => { throw forbidden })

    expect(await fetchAiUsageSummaryWithProbeCache(fn)).toBeNull()
    expect(await fetchAiUsageSummaryWithProbeCache(fn)).toBeNull()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('success returns the summary; non-403 failures are NOT cached', async () => {
    const summary = {
      callerDayTokens: 1, callerWeekTokens: 2, instanceDayUsd: 0.3,
      caps: { tenantDailyTokenCap: 10, tenantWeeklyTokenCap: 20, accountDailyUsdCap: 5 },
    }
    const flaky = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }))
      .mockResolvedValue(summary)

    await expect(fetchAiUsageSummaryWithProbeCache(flaky as never)).rejects.toThrow('boom')
    expect(await fetchAiUsageSummaryWithProbeCache(flaky as never)).toEqual(summary)
    expect(flaky).toHaveBeenCalledTimes(2)
  })
})
