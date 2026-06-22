/**
 * B-3 useAiBulkFill composable + client wire fidelity — review-before-write AI
 * bulk/whole-column fill. Design lock:
 * docs/development/multitable-ai-bulk-fill-review-before-write-designlock-20260621.md
 *
 * THE CENTRAL REQUIREMENT (owner's flagged risk): TRUTHFUL STATUS. These tests
 * lock that every distinct preview state (confirmable / masked / skipped /
 * failures) and commit outcome (written / stale_reprev / write_conflict /
 * not_in_cache / skipped_no_perm) survives the REAL wire and is kept distinct in
 * the composable — and that ONLY confirmable rows are ever selectable.
 *
 * Wire fidelity: every test drives the REAL MultitableApiClient.parseJson over
 * route-shaped JSON mirroring the B-1 bulk-preview return (multitable-ai.ts
 * ~1084) + B-2 bulk-commit return (~1307). Zero real provider calls: fetchFn is
 * stubbed. A fixture-drift assertion fails if the consumed key set changes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MultitableApiClient, type AiBulkCommitData, type AiBulkPreviewData } from '../src/multitable/api/client'
import { useAiBulkFill } from '../src/multitable/composables/useAiBulkFill'

// PINNED bulk-preview wire (B-1 return, multitable-ai.ts ~1084). A MIXED preview:
//  - 2 confirmable rows (one masked), both writable:true
//  - 1 skipped (skipped_no_perm — UNCHARGED, not writable)
//  - 1 failure (provider_error_charged — CHARGED, non-confirmable)
const PREVIEW_WIRE: AiBulkPreviewData = {
  runId: 'aibulk_run1',
  rows: [
    { recordId: 'rec_ok', version: 3, currentValue: 'old', proposed: 'CLEAN OUT', masked: false, writable: true },
    { recordId: 'rec_masked', version: 5, currentValue: null, proposed: 'PARTIAL OUT', masked: true, writable: true },
  ],
  skipped: [{ recordId: 'rec_noperm', reason: 'skipped_no_perm' }],
  failures: [{ recordId: 'rec_err', reason: 'provider_error_charged' }],
  settledCost: 0.0042,
  capped: false,
}

// PINNED bulk-commit wire (B-2 return, multitable-ai.ts ~1307). MIXED outcomes.
const COMMIT_WIRE: AiBulkCommitData = {
  outcomes: [
    { recordId: 'rec_ok', outcome: 'written' },
    { recordId: 'rec_masked', outcome: 'stale_reprev' },
    { recordId: 'rec_noperm', outcome: 'skipped_no_perm' },
    { recordId: 'rec_gone', outcome: 'not_in_cache' },
  ],
  counts: { written: 1, stale_reprev: 1, write_conflict: 0, not_in_cache: 1, skipped_no_perm: 1 },
}

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
}

function setup(fetchFn: (input: string, init?: RequestInit) => Promise<Response>) {
  const client = new MultitableApiClient({ fetchFn })
  const bulk = useAiBulkFill({ client, sheetId: () => 'sheet_1' })
  return { bulk, client }
}

const previewInput = { fieldId: 'fld_t', scope: 'view' as const, viewId: 'view_1' }

describe('aiBulkPreview / aiBulkCommit client wire shape', () => {
  it('aiBulkPreview posts the exact body and returns the route shape verbatim (every distinct bucket)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ ok: true, data: PREVIEW_WIRE }))
    const { client } = setup(fetchFn as never)

    const data = await client.aiBulkPreview('sheet_1', { fieldId: 'fld_t', scope: 'view', viewId: 'view_1', recordIds: ['rec_ok'] })

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/multitable/sheets/sheet_1/ai/shortcut/bulk-preview')
    expect(JSON.parse(String(init.body))).toEqual({ fieldId: 'fld_t', scope: 'view', viewId: 'view_1', recordIds: ['rec_ok'] })

    // FIXTURE-DRIFT GUARD: the top-level key set the FE consumes must not drift.
    expect(Object.keys(data).sort()).toEqual(['capped', 'failures', 'rows', 'runId', 'settledCost', 'skipped'])
    expect(Object.keys(data.rows[0]).sort()).toEqual(['currentValue', 'masked', 'proposed', 'recordId', 'version', 'writable'])
    expect(Object.keys(data.skipped[0]).sort()).toEqual(['reason', 'recordId'])
    expect(Object.keys(data.failures[0]).sort()).toEqual(['reason', 'recordId'])
    expect(data.rows[1].masked).toBe(true)
    expect(data.failures[0].reason).toBe('provider_error_charged')
  })

  it('aiBulkPreview omits recordIds when not provided (scope:view full set)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ ok: true, data: PREVIEW_WIRE }))
    const { client } = setup(fetchFn as never)
    await client.aiBulkPreview('sheet_1', previewInput)
    expect(JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ fieldId: 'fld_t', scope: 'view', viewId: 'view_1' })
  })

  it('aiBulkCommit posts {runId, recordIds} and returns outcomes + counts verbatim', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ ok: true, data: COMMIT_WIRE }))
    const { client } = setup(fetchFn as never)

    const data = await client.aiBulkCommit('sheet_1', { runId: 'aibulk_run1', recordIds: ['rec_ok', 'rec_masked'] })

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/multitable/sheets/sheet_1/ai/shortcut/bulk-commit')
    expect(JSON.parse(String(init.body))).toEqual({ runId: 'aibulk_run1', recordIds: ['rec_ok', 'rec_masked'] })
    expect(Object.keys(data).sort()).toEqual(['counts', 'outcomes'])
    expect(Object.keys(data.outcomes[0]).sort()).toEqual(['outcome', 'recordId'])
    expect(Object.keys(data.counts).sort()).toEqual(['not_in_cache', 'skipped_no_perm', 'stale_reprev', 'write_conflict', 'written'])
  })
})

describe('useAiBulkFill — truthful-status state machine', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('preview keeps the distinct buckets distinct and defaults selection to ALL confirmable (masked included)', async () => {
    const { bulk } = setup(async () => jsonResponse({ ok: true, data: PREVIEW_WIRE }))

    await bulk.preview(previewInput)

    expect(bulk.state.phase).toBe('review')
    // Confirmable rows = rows[] only (2: clean + masked). Masked is a CONFIRMABLE row, not an exclusion.
    expect(bulk.rows.value.map((r) => r.recordId)).toEqual(['rec_ok', 'rec_masked'])
    expect(bulk.confirmableCount.value).toBe(2)
    // skipped + failures kept separate — never folded into rows.
    expect(bulk.skipped.value).toEqual([{ recordId: 'rec_noperm', reason: 'skipped_no_perm' }])
    expect(bulk.failures.value).toEqual([{ recordId: 'rec_err', reason: 'provider_error_charged' }])
    // Default selection = ALL confirmable, including the masked row.
    expect([...bulk.selected.value].sort()).toEqual(['rec_masked', 'rec_ok'])
    expect(bulk.settledCost.value).toBe(0.0042)
    expect(bulk.partial.value).toBe(false)
  })

  it('ONLY confirmable rows are selectable — toggling a skipped/failure recordId is a no-op', async () => {
    const { bulk } = setup(async () => jsonResponse({ ok: true, data: PREVIEW_WIRE }))
    await bulk.preview(previewInput)

    bulk.clearSelection()
    expect(bulk.selected.value.size).toBe(0)

    bulk.toggleRow('rec_noperm') // skipped — cannot be selected
    bulk.toggleRow('rec_err') // failure (charged) — cannot be selected
    expect(bulk.selected.value.size).toBe(0)

    bulk.toggleRow('rec_masked') // confirmable masked row — CAN be selected
    expect([...bulk.selected.value]).toEqual(['rec_masked'])
  })

  it('capped:true → partial preview flagged (incomplete), independent of bucket contents', async () => {
    const { bulk } = setup(async () => jsonResponse({ ok: true, data: { ...PREVIEW_WIRE, capped: true } }))
    await bulk.preview(previewInput)
    expect(bulk.partial.value).toBe(true)
  })

  it('commit posts only the SELECTED confirmable rows and exposes the per-row outcomes + counts', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: PREVIEW_WIRE }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: COMMIT_WIRE }))
    const { bulk } = setup(fetchFn as never)

    await bulk.preview(previewInput)
    // Deselect the masked row → only rec_ok is confirmed.
    bulk.toggleRow('rec_masked')
    await bulk.commit()

    const commitBody = JSON.parse(String((fetchFn.mock.calls[1] as [string, RequestInit])[1].body))
    expect(commitBody).toEqual({ runId: 'aibulk_run1', recordIds: ['rec_ok'] })

    expect(bulk.state.phase).toBe('done')
    expect(bulk.state.commit?.outcomes).toEqual(COMMIT_WIRE.outcomes)
    expect(bulk.state.commit?.counts.written).toBe(1)
    expect(bulk.state.commit?.counts.stale_reprev).toBe(1)
  })

  it('commit with an empty selection is a guarded no-op (no fetch, stays in review)', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: PREVIEW_WIRE }))
    const { bulk } = setup(fetchFn as never)
    await bulk.preview(previewInput)
    bulk.clearSelection()

    const result = await bulk.commit()
    expect(result).toBeNull()
    expect(fetchFn).toHaveBeenCalledTimes(1) // preview only — commit never fired
    expect(bulk.state.phase).toBe('review')
  })

  it('RATE_LIMITED (burst limiter, 429 + Retry-After) → countdown that gates new sends', async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn(async () => jsonResponse(
      { ok: false, status: 'rate_limited', error: { code: 'RATE_LIMITED', message: 'slow down' } },
      { status: 429, headers: { 'Retry-After': '3' } },
    ))
    const { bulk } = setup(fetchFn as never)

    await bulk.preview(previewInput)
    expect(bulk.state.error?.code).toBe('RATE_LIMITED')
    expect(bulk.state.retryRemainingMs).toBe(3000)
    expect(bulk.busy.value).toBe(true)

    await bulk.preview(previewInput) // countdown gates the retry
    expect(fetchFn).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(4000)
    expect(bulk.state.retryRemainingMs).toBeNull()
    expect(bulk.busy.value).toBe(false)
  })

  it('AI_BULK_QUOTA_INSUFFICIENT (429 WITHOUT Retry-After) → whole-run refusal, NO countdown', async () => {
    const { bulk } = setup(async () => jsonResponse(
      { ok: false, status: 'quota_exhausted', error: { code: 'AI_BULK_QUOTA_INSUFFICIENT', message: 'needs more tokens' } },
      { status: 429 },
    ))
    await bulk.preview(previewInput)
    expect(bulk.state.error?.code).toBe('AI_BULK_QUOTA_INSUFFICIENT')
    expect(bulk.state.retryRemainingMs).toBeNull()
    expect(bulk.state.phase).toBe('idle') // refused — no review
  })

  it('BULK_SCOPE_TOO_LARGE (400) and AI_BULK_VIEW_FILTER_UNSUPPORTED (422) surface by code, no review', async () => {
    for (const c of [
      { status: 400, code: 'BULK_SCOPE_TOO_LARGE' },
      { status: 422, code: 'AI_BULK_VIEW_FILTER_UNSUPPORTED' },
    ]) {
      const { bulk } = setup(async () => jsonResponse({ ok: false, error: { code: c.code, message: 'x' } }, { status: c.status }))
      await bulk.preview(previewInput)
      expect(bulk.state.error?.code).toBe(c.code)
      expect(bulk.state.phase).toBe('idle')
      expect(bulk.state.preview).toBeNull()
    }
  })

  it('AI_BLOCKED (503) keeps its own code', async () => {
    const { bulk } = setup(async () => jsonResponse({ ok: false, error: { code: 'AI_BLOCKED', message: 'not ready' } }, { status: 503 }))
    await bulk.preview(previewInput)
    expect(bulk.state.error?.code).toBe('AI_BLOCKED')
    expect(bulk.state.error?.status).toBe(503)
  })

  it('reset clears preview/commit/selection/error/countdown back to idle', async () => {
    const { bulk } = setup(async () => jsonResponse({ ok: true, data: PREVIEW_WIRE }))
    await bulk.preview(previewInput)
    expect(bulk.state.phase).toBe('review')
    bulk.reset()
    expect(bulk.state.phase).toBe('idle')
    expect(bulk.state.preview).toBeNull()
    expect(bulk.selected.value.size).toBe(0)
  })
})
