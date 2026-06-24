/**
 * B-4 useAiBulkFill ASYNC-JOB mode + client wire fidelity — over-cap bulk fill.
 * Design lock: B-3 review-before-write + the B-4 async-job extension
 * (docs/development/multitable-ai-bulk-fill-review-before-write-designlock-20260621.md).
 *
 * THE CENTRAL REQUIREMENT (owner's flagged risk): TRUTHFUL STATUS. These tests
 * lock that the over-cap async flow keeps every distinct state distinct through
 * the REAL wire: an over-cap start returns { jobId } (job mode); polling reaches
 * a committable status; the diff rows accumulate across nextCursor; ONLY
 * `generated` rows are selectable; commit sends the selected recordIds ONCE; and
 * a terminal (errored/rejected) job still offers a commit of the generated subset.
 *
 * Wire fidelity: every job-route fixture is the BARE body the routes actually
 * emit (multitable-ai.ts: poll/rows/commit/cancel return `res.json({...})` with
 * NO { ok, data } envelope, and the over-cap start returns a bare { jobId }).
 * parseJson passes a bare body through verbatim, so a fixture in the wrong
 * (enveloped) shape would fail loudly. Zero real provider calls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MultitableApiClient,
  isAiBulkJobStart,
  type AiBulkJobCommitData,
  type AiBulkJobPoll,
  type AiBulkJobRow,
} from '../src/multitable/api/client'
import { useAiBulkFill } from '../src/multitable/composables/useAiBulkFill'

// BARE poll header (BJ-3 return). `suspended` = generation done, awaiting review.
function pollHeader(overrides: Partial<AiBulkJobPoll> = {}): AiBulkJobPoll {
  return {
    jobId: 'aibulkjob_1',
    state: 'suspended',
    suspendReason: 'manual_task',
    total: 3,
    generated: 2,
    skippedCount: 1,
    failuresCount: 0,
    committedCount: 0,
    pendingNotGeneratedCount: 0,
    settledCost: 0.0123,
    quotaPaused: false,
    aggregate: null,
    ...overrides,
  }
}

// BARE review rows (BJ-9). A MIXED set: 2 generated (one masked), 1 skipped, 1
// failure, 1 pending_not_generated — only the `generated` rows are confirmable.
const JOB_ROWS: AiBulkJobRow[] = [
  { recordId: 'rec_g1', ordinal: 0, state: 'generated', currentValue: 'old1', proposed: 'NEW1', masked: false, reason: null },
  { recordId: 'rec_g2', ordinal: 1, state: 'generated', currentValue: null, proposed: 'NEW2', masked: true, reason: null },
  { recordId: 'rec_sk', ordinal: 2, state: 'skipped', currentValue: null, proposed: null, masked: false, reason: 'skipped_no_perm' },
  { recordId: 'rec_fl', ordinal: 3, state: 'failure', currentValue: null, proposed: null, masked: false, reason: 'provider_error_charged' },
  { recordId: 'rec_png', ordinal: 4, state: 'pending_not_generated', currentValue: null, proposed: null, masked: false, reason: null },
]

const JOB_COMMIT_WIRE: AiBulkJobCommitData = {
  jobId: 'aibulkjob_1',
  state: 'resolved',
  counts: { committed: 1, stale_reprev: 1, write_conflict: 0, skipped_no_perm: 0 },
  attempted: 2,
}

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
}

function setup(fetchFn: (input: string, init?: RequestInit) => Promise<Response>, pollIntervalMs = 2000) {
  const client = new MultitableApiClient({ fetchFn })
  const bulk = useAiBulkFill({ client, sheetId: () => 'sheet_1', pollIntervalMs })
  return { bulk, client }
}

const previewInput = { fieldId: 'fld_t', scope: 'view' as const, viewId: 'view_1' }

describe('AI bulk JOB client wire shape (bare bodies)', () => {
  it('an over-cap start returns a bare { jobId } that isAiBulkJobStart detects', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ jobId: 'aibulkjob_1' }))
    const { client } = setup(fetchFn as never)

    const start = await client.aiBulkPreview('sheet_1', previewInput)
    expect(isAiBulkJobStart(start)).toBe(true)
    if (isAiBulkJobStart(start)) expect(start.jobId).toBe('aibulkjob_1')
  })

  it('getBulkJob returns the bare poll header verbatim (no envelope, key set pinned)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(pollHeader()))
    const { client } = setup(fetchFn as never)

    const header = await client.getBulkJob('sheet_1', 'aibulkjob_1')
    const [url] = fetchFn.mock.calls[0] as [string]
    expect(url).toBe('/api/multitable/sheets/sheet_1/ai/shortcut/bulk-job/aibulkjob_1')
    // FIXTURE-DRIFT GUARD: the header key set the FE consumes must not drift.
    expect(Object.keys(header).sort()).toEqual([
      'aggregate', 'committedCount', 'failuresCount', 'generated', 'jobId',
      'pendingNotGeneratedCount', 'quotaPaused', 'settledCost', 'skippedCount',
      'state', 'suspendReason', 'total',
    ])
  })

  it('getBulkJobRows passes the cursor and returns { rows, nextCursor } verbatim', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ rows: JOB_ROWS.slice(0, 2), nextCursor: 1 }))
    const { client } = setup(fetchFn as never)

    const page = await client.getBulkJobRows('sheet_1', 'aibulkjob_1', 5)
    const [url] = fetchFn.mock.calls[0] as [string]
    expect(url).toBe('/api/multitable/sheets/sheet_1/ai/shortcut/bulk-job/aibulkjob_1/rows?cursor=5')
    expect(page.nextCursor).toBe(1)
    expect(Object.keys(page.rows[0]).sort()).toEqual(['currentValue', 'masked', 'ordinal', 'proposed', 'reason', 'recordId', 'state'])
  })

  it('getBulkJobRows omits the cursor on the first page', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ rows: [], nextCursor: null }))
    const { client } = setup(fetchFn as never)
    await client.getBulkJobRows('sheet_1', 'aibulkjob_1')
    const [url] = fetchFn.mock.calls[0] as [string]
    expect(url).toBe('/api/multitable/sheets/sheet_1/ai/shortcut/bulk-job/aibulkjob_1/rows')
  })

  it('commitBulkJob posts { recordIds } ONCE and returns the bare commit result', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(JOB_COMMIT_WIRE))
    const { client } = setup(fetchFn as never)

    const data = await client.commitBulkJob('sheet_1', 'aibulkjob_1', ['rec_g1', 'rec_g2'])
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/multitable/sheets/sheet_1/ai/shortcut/bulk-job/aibulkjob_1/commit')
    expect(JSON.parse(String(init.body))).toEqual({ recordIds: ['rec_g1', 'rec_g2'] })
    expect(data.state).toBe('resolved')
    // DIVERGENCE GUARD: job outcome counts use `committed`, not `written`, and have no `not_in_cache`.
    expect(Object.keys(data.counts).sort()).toEqual(['committed', 'skipped_no_perm', 'stale_reprev', 'write_conflict'])
  })

  it('cancelBulkJob POSTs and returns the bare cancel result', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ jobId: 'aibulkjob_1', cancelled: true, state: 'rejected' }))
    const { client } = setup(fetchFn as never)
    const data = await client.cancelBulkJob('sheet_1', 'aibulkjob_1')
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/multitable/sheets/sheet_1/ai/shortcut/bulk-job/aibulkjob_1/cancel')
    expect(init.method).toBe('POST')
    expect(data).toEqual({ jobId: 'aibulkjob_1', cancelled: true, state: 'rejected' })
  })
})

describe('useAiBulkFill — async-job state machine', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Route the fetch to the right handler by URL — one stub for the whole flow. */
  function router(handlers: {
    start: () => Response
    poll: (n: number) => Response
    rows: (cursor: string | null) => Response
    commit?: () => Response
    cancel?: () => Response
  }) {
    let pollCount = 0
    return vi.fn(async (input: string) => {
      if (input.endsWith('/bulk-preview')) return handlers.start()
      if (input.includes('/rows')) {
        const m = input.match(/cursor=(\d+)/)
        return handlers.rows(m ? m[1]! : null)
      }
      if (input.endsWith('/commit')) return (handlers.commit ?? (() => jsonResponse(JOB_COMMIT_WIRE)))()
      if (input.endsWith('/cancel')) return (handlers.cancel ?? (() => jsonResponse({ jobId: 'aibulkjob_1', cancelled: true, state: 'rejected' })))()
      // bulk-job poll
      pollCount += 1
      return handlers.poll(pollCount)
    })
  }

  it('an over-cap start enters job mode, polls to suspended, and loads ALL review rows', async () => {
    const fetchFn = router({
      start: () => jsonResponse({ jobId: 'aibulkjob_1' }),
      poll: () => jsonResponse(pollHeader()),
      rows: () => jsonResponse({ rows: JOB_ROWS, nextCursor: null }),
    })
    const { bulk } = setup(fetchFn as never)

    const result = await bulk.preview(previewInput)
    expect(result).toBeNull() // job mode → no inline preview returned

    expect(bulk.isJob.value).toBe(true)
    expect(bulk.state.jobId).toBe('aibulkjob_1')
    expect(bulk.state.phase).toBe('jobReview')
    expect(bulk.state.job?.state).toBe('suspended')
    // All 5 rows accumulated; buckets kept distinct.
    expect(bulk.state.jobRows).toHaveLength(5)
    expect(bulk.jobGeneratedRows.value.map((r) => r.recordId)).toEqual(['rec_g1', 'rec_g2'])
    expect(bulk.jobSkippedRows.value.map((r) => r.recordId)).toEqual(['rec_sk'])
    expect(bulk.jobFailureRows.value.map((r) => r.recordId)).toEqual(['rec_fl'])
    expect(bulk.jobPendingNotGeneratedRows.value.map((r) => r.recordId)).toEqual(['rec_png'])
    // Default selection = ALL generated rows (masked included).
    expect([...bulk.selected.value].sort()).toEqual(['rec_g1', 'rec_g2'])
    // Progress + cost surfaced from the poll header.
    expect(bulk.settledCost.value).toBe(0.0123)
  })

  it('polls across multiple ticks (queued → running → suspended) before review', async () => {
    vi.useFakeTimers()
    const states: Array<AiBulkJobPoll['state']> = ['queued', 'running', 'suspended']
    const fetchFn = router({
      start: () => jsonResponse({ jobId: 'aibulkjob_1' }),
      poll: (n) => jsonResponse(pollHeader({ state: states[Math.min(n - 1, states.length - 1)]!, generated: n })),
      rows: () => jsonResponse({ rows: JOB_ROWS, nextCursor: null }),
    })
    const { bulk } = setup(fetchFn as never, 2000)

    await bulk.preview(previewInput) // first poll fires immediately → queued
    expect(bulk.state.phase).toBe('polling')
    expect(bulk.state.job?.state).toBe('queued')

    await vi.advanceTimersByTimeAsync(2000) // second poll → running
    expect(bulk.state.phase).toBe('polling')
    expect(bulk.state.job?.state).toBe('running')

    await vi.advanceTimersByTimeAsync(2000) // third poll → suspended → review
    expect(bulk.state.phase).toBe('jobReview')
    expect(bulk.state.jobRows).toHaveLength(5)
  })

  it('accumulates review rows across nextCursor pages (paginated review)', async () => {
    const pages: Record<string, Response> = {}
    const fetchFn = router({
      start: () => jsonResponse({ jobId: 'aibulkjob_1' }),
      poll: () => jsonResponse(pollHeader({ total: 5, generated: 2 })),
      rows: (cursor) => {
        // page 1 (no cursor) → first 2 + nextCursor 1; page 2 (cursor=1) → next 2 + nextCursor 3; page 3 (cursor=3) → last 1 + null
        if (cursor === null) return jsonResponse({ rows: JOB_ROWS.slice(0, 2), nextCursor: 1 })
        if (cursor === '1') return jsonResponse({ rows: JOB_ROWS.slice(2, 4), nextCursor: 3 })
        return jsonResponse({ rows: JOB_ROWS.slice(4), nextCursor: null })
      },
    })
    void pages
    const { bulk } = setup(fetchFn as never)

    await bulk.preview(previewInput)
    expect(bulk.state.jobRows.map((r) => r.recordId)).toEqual(['rec_g1', 'rec_g2', 'rec_sk', 'rec_fl', 'rec_png'])
    // 1 start + 1 poll + 3 row pages = 5 fetches
    expect(fetchFn).toHaveBeenCalledTimes(5)
  })

  it('ONLY generated rows are selectable — toggling a skipped/failure/pending id is a no-op', async () => {
    const fetchFn = router({
      start: () => jsonResponse({ jobId: 'aibulkjob_1' }),
      poll: () => jsonResponse(pollHeader()),
      rows: () => jsonResponse({ rows: JOB_ROWS, nextCursor: null }),
    })
    const { bulk } = setup(fetchFn as never)
    await bulk.preview(previewInput)

    bulk.clearSelection()
    bulk.toggleRow('rec_sk') // skipped
    bulk.toggleRow('rec_fl') // failure
    bulk.toggleRow('rec_png') // pending_not_generated
    expect(bulk.selected.value.size).toBe(0)

    bulk.toggleRow('rec_g2') // generated masked row — CAN be selected
    expect([...bulk.selected.value]).toEqual(['rec_g2'])
  })

  it('commit posts ONLY the selected generated rows ONCE and resolves to jobDone', async () => {
    const fetchFn = router({
      start: () => jsonResponse({ jobId: 'aibulkjob_1' }),
      poll: () => jsonResponse(pollHeader()),
      rows: () => jsonResponse({ rows: JOB_ROWS, nextCursor: null }),
      commit: () => jsonResponse(JOB_COMMIT_WIRE),
    })
    const { bulk } = setup(fetchFn as never)
    await bulk.preview(previewInput)

    // Deselect the masked row → only rec_g1 confirmed.
    bulk.toggleRow('rec_g2')
    const data = await bulk.commitJob()

    const commitCall = (fetchFn.mock.calls as Array<[string, RequestInit]>).find(([u]) => u.endsWith('/commit'))!
    expect(JSON.parse(String(commitCall[1].body))).toEqual({ recordIds: ['rec_g1'] })
    // Exactly one commit fetch — the FE never loops (backend chunks).
    expect((fetchFn.mock.calls as Array<[string]>).filter(([u]) => u.endsWith('/commit'))).toHaveLength(1)
    expect(bulk.state.phase).toBe('jobDone')
    expect(data?.counts.committed).toBe(1)
    expect(data?.counts.stale_reprev).toBe(1)
  })

  it('commit with an empty selection is a guarded no-op (no commit fetch, stays in jobReview)', async () => {
    const fetchFn = router({
      start: () => jsonResponse({ jobId: 'aibulkjob_1' }),
      poll: () => jsonResponse(pollHeader()),
      rows: () => jsonResponse({ rows: JOB_ROWS, nextCursor: null }),
    })
    const { bulk } = setup(fetchFn as never)
    await bulk.preview(previewInput)
    bulk.clearSelection()

    const result = await bulk.commitJob()
    expect(result).toBeNull()
    expect((fetchFn.mock.calls as Array<[string]>).some(([u]) => u.endsWith('/commit'))).toBe(false)
    expect(bulk.state.phase).toBe('jobReview')
  })

  it('a terminal ERRORED job is still committable (review of the generated subset)', async () => {
    const fetchFn = router({
      start: () => jsonResponse({ jobId: 'aibulkjob_1' }),
      poll: () => jsonResponse(pollHeader({ state: 'errored', suspendReason: null, generated: 2, total: 4 })),
      rows: () => jsonResponse({ rows: JOB_ROWS, nextCursor: null }),
    })
    const { bulk } = setup(fetchFn as never)
    await bulk.preview(previewInput)

    expect(bulk.state.job?.state).toBe('errored')
    expect(bulk.state.phase).toBe('jobReview') // committable, NOT a dead end
    expect(bulk.jobGeneratedRows.value).toHaveLength(2)
    expect([...bulk.selected.value].sort()).toEqual(['rec_g1', 'rec_g2'])
  })

  it('cancel stops polling and transitions INTO review with the already-generated rows', async () => {
    vi.useFakeTimers()
    const fetchFn = router({
      start: () => jsonResponse({ jobId: 'aibulkjob_1' }),
      poll: () => jsonResponse(pollHeader({ state: 'running', generated: 2, total: 4 })),
      rows: () => jsonResponse({ rows: JOB_ROWS, nextCursor: null }),
      cancel: () => jsonResponse({ jobId: 'aibulkjob_1', cancelled: true, state: 'rejected' }),
    })
    const { bulk } = setup(fetchFn as never, 2000)

    await bulk.preview(previewInput) // first poll → running, still polling
    expect(bulk.state.phase).toBe('polling')

    const ok = await bulk.cancelJob()
    expect(ok).toBe(true)
    expect(bulk.state.phase).toBe('jobReview')
    // already-generated rows are committable.
    expect(bulk.jobGeneratedRows.value).toHaveLength(2)
    expect([...bulk.selected.value].sort()).toEqual(['rec_g1', 'rec_g2'])

    // No further polling after cancel (the loop was stopped).
    const callsBefore = fetchFn.mock.calls.length
    await vi.advanceTimersByTimeAsync(6000)
    expect(fetchFn.mock.calls.length).toBe(callsBefore)
  })

  it('quotaPaused is surfaced for the progress banner', async () => {
    const fetchFn = router({
      start: () => jsonResponse({ jobId: 'aibulkjob_1' }),
      poll: () => jsonResponse(pollHeader({ quotaPaused: true })),
      rows: () => jsonResponse({ rows: JOB_ROWS, nextCursor: null }),
    })
    const { bulk } = setup(fetchFn as never)
    await bulk.preview(previewInput)
    expect(bulk.quotaPaused.value).toBe(true)
  })

  it('a poll error surfaces by code and stops the loop (no infinite retry)', async () => {
    vi.useFakeTimers()
    let polls = 0
    const fetchFn = vi.fn(async (input: string) => {
      if (input.endsWith('/bulk-preview')) return jsonResponse({ jobId: 'aibulkjob_1' })
      polls += 1
      return jsonResponse({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } }, { status: 500 })
    })
    const { bulk } = setup(fetchFn as never, 2000)

    await bulk.preview(previewInput)
    expect(bulk.state.error?.code).toBe('INTERNAL_ERROR')
    expect(bulk.state.phase).toBe('idle')

    await vi.advanceTimersByTimeAsync(8000)
    expect(polls).toBe(1) // stopped after the first failed poll — no reschedule
  })

  it('reset clears job state + stops polling; a late poll cannot resurrect the loop', async () => {
    vi.useFakeTimers()
    const fetchFn = router({
      start: () => jsonResponse({ jobId: 'aibulkjob_1' }),
      poll: () => jsonResponse(pollHeader({ state: 'running' })),
      rows: () => jsonResponse({ rows: JOB_ROWS, nextCursor: null }),
    })
    const { bulk } = setup(fetchFn as never, 2000)
    await bulk.preview(previewInput)
    expect(bulk.state.phase).toBe('polling')

    bulk.reset()
    expect(bulk.state.phase).toBe('idle')
    expect(bulk.state.jobId).toBeNull()
    expect(bulk.state.job).toBeNull()
    expect(bulk.state.jobRows).toHaveLength(0)

    const callsBefore = fetchFn.mock.calls.length
    await vi.advanceTimersByTimeAsync(6000)
    expect(fetchFn.mock.calls.length).toBe(callsBefore) // no further polls
    expect(bulk.state.phase).toBe('idle') // not resurrected
  })

  // ── Pagination-completeness FAIL-CLOSED (BJ-9: review-before-write must show the COMPLETE diff) ──
  // Each incomplete-load path must NOT enter the confirmable `jobReview` (else the user could
  // commit what they think is the whole batch but is only the loaded prefix).

  it('FAIL-CLOSED: a page-2 load error does NOT enter review (no truncated diff, no selection)', async () => {
    const fetchFn = router({
      start: () => jsonResponse({ jobId: 'aibulkjob_1' }),
      poll: () => jsonResponse(pollHeader({ total: 5, generated: 2 })),
      rows: (cursor) => {
        if (cursor === null) return jsonResponse({ rows: JOB_ROWS.slice(0, 2), nextCursor: 1 })
        return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, { status: 500 }) // page 2 fails
      },
    })
    const { bulk } = setup(fetchFn as never)

    await bulk.preview(previewInput)

    expect(bulk.state.phase).toBe('jobLoadError') // NOT jobReview
    expect(bulk.state.jobRows).toHaveLength(0) // no truncated diff retained
    expect(bulk.selected.value.size).toBe(0) // no committable selection
    expect(bulk.state.error).not.toBeNull() // the page error is surfaced
  })

  it('FAIL-CLOSED: a non-advancing cursor does NOT enter review', async () => {
    const fetchFn = router({
      start: () => jsonResponse({ jobId: 'aibulkjob_1' }),
      poll: () => jsonResponse(pollHeader({ total: 5, generated: 2 })),
      rows: (cursor) => {
        if (cursor === null) return jsonResponse({ rows: JOB_ROWS.slice(0, 2), nextCursor: 1 })
        return jsonResponse({ rows: JOB_ROWS.slice(2, 4), nextCursor: 1 }) // SAME cursor → non-advancing
      },
    })
    const { bulk } = setup(fetchFn as never)

    await bulk.preview(previewInput)

    expect(bulk.state.phase).toBe('jobLoadError')
    expect(bulk.state.jobRows).toHaveLength(0)
    expect(bulk.selected.value.size).toBe(0)
  })

  it('FAIL-CLOSED: MAX_ROW_PAGES exhaustion does NOT enter review', async () => {
    // Always advance the cursor and never return null → the loader exhausts the page cap.
    const fetchFn = router({
      start: () => jsonResponse({ jobId: 'aibulkjob_1' }),
      poll: () => jsonResponse(pollHeader({ total: 5, generated: 2 })),
      rows: (cursor) => {
        const next = (cursor === null ? 0 : Number(cursor)) + 1
        return jsonResponse({ rows: [JOB_ROWS[0]], nextCursor: next })
      },
    })
    const { bulk } = setup(fetchFn as never)

    await bulk.preview(previewInput)

    expect(bulk.state.phase).toBe('jobLoadError')
    expect(bulk.state.jobRows).toHaveLength(0)
    expect(bulk.selected.value.size).toBe(0)
  })

  it('retryJobLoad re-runs the fail-closed loader: transient page error → jobLoadError → retry → jobReview', async () => {
    let page2Attempts = 0
    const fetchFn = router({
      start: () => jsonResponse({ jobId: 'aibulkjob_1' }),
      poll: () => jsonResponse(pollHeader({ total: 5, generated: 2 })),
      rows: (cursor) => {
        if (cursor === null) return jsonResponse({ rows: JOB_ROWS.slice(0, 2), nextCursor: 1 })
        page2Attempts += 1
        if (page2Attempts === 1) return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, { status: 500 })
        return jsonResponse({ rows: JOB_ROWS.slice(2), nextCursor: null }) // retry: page 2 succeeds → complete
      },
    })
    const { bulk } = setup(fetchFn as never)

    await bulk.preview(previewInput)
    expect(bulk.state.phase).toBe('jobLoadError')

    await bulk.retryJobLoad()
    expect(bulk.state.phase).toBe('jobReview') // now complete → confirmable
    expect(bulk.state.jobRows).toHaveLength(5)
    expect([...bulk.selected.value].sort()).toEqual(['rec_g1', 'rec_g2']) // default-select generated
    expect(bulk.state.error).toBeNull() // cleared on retry
  })
})
