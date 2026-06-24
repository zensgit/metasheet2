/**
 * B-4 MetaAiBulkFillDialog ASYNC-JOB mode — over-cap review-before-write UI.
 * Design lock: B-3 + the B-4 async-job extension
 * (docs/development/multitable-ai-bulk-fill-review-before-write-designlock-20260621.md).
 *
 * THE CENTRAL REQUIREMENT (owner's flagged risk): TRUTHFUL STATUS. These tests
 * lock that the over-cap job UI never misleads the user about what was or wasn't
 * written:
 *  - a generating job shows a progress bar (generated/total) + the already-charged cost;
 *  - quotaPaused renders an explicit "generation paused" banner;
 *  - the review table makes ONLY `generated` rows selectable; skipped / failure /
 *    pending_not_generated are read-only sections with their reasons;
 *  - a terminal (errored / rejected) job still offers a commit of the generated
 *    subset (a cancelled/errored banner, NOT a dead end);
 *  - the job commit summary uses the `committed` vocabulary.
 *
 * The dialog is driven by the REAL useAiBulkFill over a stubbed client, so the
 * full job flow runs through the actual state machine + BARE wire shapes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaAiBulkFillDialog from '../src/multitable/components/MetaAiBulkFillDialog.vue'
import { useAiBulkFill } from '../src/multitable/composables/useAiBulkFill'
import { MultitableApiClient, type AiBulkJobCommitData, type AiBulkJobPoll, type AiBulkJobRow } from '../src/multitable/api/client'
import { useLocale } from '../src/composables/useLocale'

function pollHeader(overrides: Partial<AiBulkJobPoll> = {}): AiBulkJobPoll {
  return {
    jobId: 'aibulkjob_1',
    state: 'suspended',
    suspendReason: 'manual_task',
    total: 3,
    generated: 2,
    skippedCount: 1,
    failuresCount: 1,
    committedCount: 0,
    pendingNotGeneratedCount: 1,
    settledCost: 0.0123,
    quotaPaused: false,
    aggregate: null,
    ...overrides,
  }
}

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

/** Route the fetch to the right handler by URL — one stub for the whole flow. */
function router(handlers: {
  start: () => Response
  poll: (n: number) => Response
  rows: () => Response
  commit?: () => Response
  cancel?: () => Response
}) {
  let pollCount = 0
  return vi.fn(async (input: string) => {
    if (input.endsWith('/bulk-preview')) return handlers.start()
    if (input.includes('/rows')) return handlers.rows()
    if (input.endsWith('/commit')) return (handlers.commit ?? (() => jsonResponse(JOB_COMMIT_WIRE)))()
    if (input.endsWith('/cancel')) return (handlers.cancel ?? (() => jsonResponse({ jobId: 'aibulkjob_1', cancelled: true, state: 'rejected' })))()
    pollCount += 1
    return handlers.poll(pollCount)
  })
}

function mountDialog(fetchFn: (input: string, init?: RequestInit) => Promise<Response>, pollIntervalMs = 2000): {
  app: App
  controller: ReturnType<typeof useAiBulkFill>
} {
  const client = new MultitableApiClient({ fetchFn })
  const controller = useAiBulkFill({ client, sheetId: () => 'sheet_1', pollIntervalMs })
  const app = createApp({
    render() {
      return h(MetaAiBulkFillDialog, {
        visible: true,
        controller,
        fieldId: 'fld_t',
        viewId: 'view_1',
        selectedRecordIds: [],
        fieldName: (id: string) => (id === 'fld_t' ? 'Summary' : id),
        recordName: (id: string) => id,
        isZh: false,
      })
    },
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
  return { app, controller }
}

function q(sel: string): HTMLElement | null {
  return document.body.querySelector(sel)
}
function qa(sel: string): HTMLElement[] {
  return Array.from(document.body.querySelectorAll(sel))
}

// The job flow chains several sequential fetches (start → poll → rows pages),
// each with an `await res.text()` microtask, so flush generously.
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('MetaAiBulkFillDialog — async-job (over-cap) rendering', () => {
  beforeEach(() => {
    useLocale().setLocale('en')
  })
  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('shows a progress bar (generated/total) + already-charged cost while generating', async () => {
    vi.useFakeTimers()
    const fetchFn = router({
      start: () => jsonResponse({ jobId: 'aibulkjob_1' }),
      poll: () => jsonResponse(pollHeader({ state: 'running', generated: 2, total: 3 })),
      rows: () => jsonResponse({ rows: JOB_ROWS, nextCursor: null }),
    })
    const { app } = mountDialog(fetchFn as never, 2000)
    ;(q('[data-test="ai-bulk-generate"]') as HTMLButtonElement).click()
    await flush()

    expect(q('[data-test="ai-bulk-progress"]')).not.toBeNull()
    expect(q('[data-test="ai-bulk-progress-line"]')?.textContent).toContain('2 / 3 generated')
    const bar = q('[data-test="ai-bulk-progress"]')!
    expect(bar.getAttribute('aria-valuenow')).toBe('2')
    expect(bar.getAttribute('aria-valuemax')).toBe('3')
    // The cancel-generation button is available while polling.
    expect(q('[data-test="ai-bulk-job-cancel"]')).not.toBeNull()
    // Cost (already charged) surfaced.
    expect(q('[data-test="ai-bulk-cost"]')?.textContent).toContain('0.0123')
    app.unmount()
  })

  it('a MIXED job review renders generated rows selectable; skipped/failure/pending read-only', async () => {
    const fetchFn = router({
      start: () => jsonResponse({ jobId: 'aibulkjob_1' }),
      poll: () => jsonResponse(pollHeader()),
      rows: () => jsonResponse({ rows: JOB_ROWS, nextCursor: null }),
    })
    const { app } = mountDialog(fetchFn as never)
    ;(q('[data-test="ai-bulk-generate"]') as HTMLButtonElement).click()
    await flush()

    // Generated rows: exactly 2, each selectable + default-checked.
    const rows = qa('[data-test="ai-bulk-job-row"]')
    expect(rows).toHaveLength(2)
    const rowSelects = qa('[data-test="ai-bulk-job-row-select"]') as HTMLInputElement[]
    expect(rowSelects).toHaveLength(2)
    expect(rowSelects.every((c) => c.checked)).toBe(true)

    // Masked generated row distinctly badged.
    expect(q('[data-test="ai-bulk-job-badge-masked"]')?.textContent).toContain('May be incomplete')
    expect(q('[data-test="ai-bulk-job-badge-ready"]')?.textContent).toContain('Ready to write')

    // Skipped / failure / pending — read-only lists (no checkboxes), with reasons.
    const skipped = q('[data-test="ai-bulk-job-skipped"]')
    expect(skipped!.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect(q('[data-test="ai-bulk-job-skipped-item"] .ai-bulk__group-reason')?.textContent).toContain('No write permission')

    const failures = q('[data-test="ai-bulk-job-failures"]')
    expect(failures!.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect(q('[data-test="ai-bulk-job-failure-item"] .ai-bulk__group-reason')?.textContent).toContain('Provider error after charge')

    const pending = q('[data-test="ai-bulk-job-pending"]')
    expect(pending).not.toBeNull()
    expect(pending!.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)

    // Confirm button counts the 2 default-selected generated rows.
    expect((q('[data-test="ai-bulk-job-confirm"]') as HTMLButtonElement).textContent).toContain('(2)')
    app.unmount()
  })

  it('quotaPaused renders the explicit "generation paused" banner in review', async () => {
    const fetchFn = router({
      start: () => jsonResponse({ jobId: 'aibulkjob_1' }),
      poll: () => jsonResponse(pollHeader({ quotaPaused: true })),
      rows: () => jsonResponse({ rows: JOB_ROWS, nextCursor: null }),
    })
    const { app } = mountDialog(fetchFn as never)
    ;(q('[data-test="ai-bulk-generate"]') as HTMLButtonElement).click()
    await flush()
    expect(q('[data-test="ai-bulk-quota-paused"]')?.textContent).toContain('Generation paused')
    app.unmount()
  })

  it('a terminal ERRORED job shows a banner AND still offers a commit of the generated subset', async () => {
    const fetchFn = router({
      start: () => jsonResponse({ jobId: 'aibulkjob_1' }),
      poll: () => jsonResponse(pollHeader({ state: 'errored', suspendReason: null })),
      rows: () => jsonResponse({ rows: JOB_ROWS, nextCursor: null }),
    })
    const { app } = mountDialog(fetchFn as never)
    ;(q('[data-test="ai-bulk-generate"]') as HTMLButtonElement).click()
    await flush()

    expect(q('[data-test="ai-bulk-job-banner"]')?.textContent).toContain('Generation stopped on an error')
    // Generated rows still selectable + a working confirm button.
    expect(qa('[data-test="ai-bulk-job-row"]')).toHaveLength(2)
    const confirm = q('[data-test="ai-bulk-job-confirm"]') as HTMLButtonElement
    expect(confirm).not.toBeNull()
    expect(confirm.disabled).toBe(false)
    app.unmount()
  })

  it('a cancelled job (rejected) shows the cancelled banner with the generated subset still committable', async () => {
    vi.useFakeTimers()
    // After cancel, the post-cancel poll re-read reflects `rejected` (the worker
    // stopped); before cancel it is `running`.
    let cancelled = false
    const fetchFn = router({
      start: () => jsonResponse({ jobId: 'aibulkjob_1' }),
      poll: () =>
        jsonResponse(pollHeader({ state: cancelled ? 'rejected' : 'running', suspendReason: null, generated: 2, total: 4 })),
      rows: () => jsonResponse({ rows: JOB_ROWS, nextCursor: null }),
      cancel: () => {
        cancelled = true
        return jsonResponse({ jobId: 'aibulkjob_1', cancelled: true, state: 'rejected' })
      },
    })
    const { app } = mountDialog(fetchFn as never, 2000)
    ;(q('[data-test="ai-bulk-generate"]') as HTMLButtonElement).click()
    await flush()
    expect(q('[data-test="ai-bulk-progress"]')).not.toBeNull() // generating

    ;(q('[data-test="ai-bulk-job-cancel"]') as HTMLButtonElement).click()
    await flush()

    expect(q('[data-test="ai-bulk-job-banner"]')?.textContent).toContain('cancelled')
    expect(qa('[data-test="ai-bulk-job-row"]')).toHaveLength(2)
    expect(q('[data-test="ai-bulk-job-confirm"]')).not.toBeNull()
    app.unmount()
  })

  it('committing the job renders the commit summary (committed vocabulary) + stale guidance', async () => {
    const fetchFn = router({
      start: () => jsonResponse({ jobId: 'aibulkjob_1' }),
      poll: () => jsonResponse(pollHeader()),
      rows: () => jsonResponse({ rows: JOB_ROWS, nextCursor: null }),
      commit: () => jsonResponse(JOB_COMMIT_WIRE),
    })
    const { app } = mountDialog(fetchFn as never)
    ;(q('[data-test="ai-bulk-generate"]') as HTMLButtonElement).click()
    await flush()
    ;(q('[data-test="ai-bulk-job-confirm"]') as HTMLButtonElement).click()
    await flush()

    const summary = q('[data-test="ai-bulk-job-commit-summary"]')?.textContent ?? ''
    expect(summary).toContain('1 written')
    expect(summary).toContain('1 need re-preview')
    // Stale rows → explicit re-preview guidance.
    expect(q('[data-test="ai-bulk-job-stale-guidance"]')?.textContent).toContain('re-preview')
    // The done button is shown.
    expect(q('[data-test="ai-bulk-job-done"]')?.textContent).toContain('Done')
    app.unmount()
  })

  it('deselecting all generated rows disables the job confirm button', async () => {
    const fetchFn = router({
      start: () => jsonResponse({ jobId: 'aibulkjob_1' }),
      poll: () => jsonResponse(pollHeader()),
      rows: () => jsonResponse({ rows: JOB_ROWS, nextCursor: null }),
    })
    const { app } = mountDialog(fetchFn as never)
    ;(q('[data-test="ai-bulk-generate"]') as HTMLButtonElement).click()
    await flush()

    ;(q('[data-test="ai-bulk-job-select-all"]') as HTMLInputElement).click()
    await nextTick()
    expect((q('[data-test="ai-bulk-job-confirm"]') as HTMLButtonElement).disabled).toBe(true)
    app.unmount()
  })

  it('a page-load failure renders the fail-closed jobLoadError UI (error body + retry, NO commit / NO rows)', async () => {
    const fetchFn = router({
      start: () => jsonResponse({ jobId: 'aibulkjob_1' }),
      poll: () => jsonResponse(pollHeader({ total: 5, generated: 2 })),
      rows: (cursor) => {
        if (cursor === null) return jsonResponse({ rows: JOB_ROWS.slice(0, 2), nextCursor: 1 })
        return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, { status: 500 }) // page 2 fails
      },
    })
    const { app } = mountDialog(fetchFn as never)
    ;(q('[data-test="ai-bulk-generate"]') as HTMLButtonElement).click()
    await flush()

    // Fail-closed UI: error body + retry button, and NO confirmable surface (no commit, no rows).
    expect(q('[data-test="ai-bulk-job-load-error"]')).not.toBeNull()
    expect(q('[data-test="ai-bulk-job-load-retry"]')).not.toBeNull()
    expect(q('[data-test="ai-bulk-job-confirm"]')).toBeNull()
    expect(qa('[data-test="ai-bulk-job-row"]')).toHaveLength(0)
    app.unmount()
  })
})
