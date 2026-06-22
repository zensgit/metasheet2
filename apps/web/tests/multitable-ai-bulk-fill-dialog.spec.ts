/**
 * B-3 MetaAiBulkFillDialog — review-before-write UI. Design lock:
 * docs/development/multitable-ai-bulk-fill-review-before-write-designlock-20260621.md
 *
 * THE CENTRAL REQUIREMENT (owner's flagged risk): TRUTHFUL STATUS. These tests
 * lock that the user is NEVER misled about what was or wasn't written:
 *  - a MIXED preview (confirmable + masked + skipped + failures) renders each
 *    state DISTINCTLY, and ONLY confirmable rows are selectable;
 *  - failures are shown as CHARGED (consumed quota) yet non-confirmable;
 *  - the cost + quota-consumed note are surfaced;
 *  - a MIXED commit (written / stale_reprev / skipped_no_perm / not_in_cache)
 *    renders the correct per-row status + aggregate counts + re-preview guidance.
 *
 * The dialog is driven by the REAL useAiBulkFill over a stubbed client, so the
 * full flow runs through the actual state machine + wire shapes. Teleport sends
 * the DOM to document.body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaAiBulkFillDialog from '../src/multitable/components/MetaAiBulkFillDialog.vue'
import { useAiBulkFill } from '../src/multitable/composables/useAiBulkFill'
import { MultitableApiClient, type AiBulkCommitData, type AiBulkPreviewData } from '../src/multitable/api/client'
import { useLocale } from '../src/composables/useLocale'

const PREVIEW_WIRE: AiBulkPreviewData = {
  runId: 'aibulk_run1',
  rows: [
    { recordId: 'rec_ok', version: 3, proposed: 'CLEAN OUT', masked: false, writable: true },
    { recordId: 'rec_masked', version: 5, proposed: 'PARTIAL OUT', masked: true, writable: true },
  ],
  skipped: [
    { recordId: 'rec_noperm', reason: 'skipped_no_perm' },
    { recordId: 'rec_rate', reason: 'rate_limited_before_call' },
  ],
  failures: [{ recordId: 'rec_err', reason: 'provider_error_charged' }],
  settledCost: 0.0042,
  capped: false,
}

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

function mountDialog(fetchFn: (input: string, init?: RequestInit) => Promise<Response>): {
  app: App
  controller: ReturnType<typeof useAiBulkFill>
} {
  const client = new MultitableApiClient({ fetchFn })
  const controller = useAiBulkFill({ client, sheetId: () => 'sheet_1' })
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
        currentValueFor: (id: string) => (id === 'rec_ok' ? 'old' : ''),
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

/** Flush the fetch → parseJson (await res.text()) microtask chain + Vue render. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('MetaAiBulkFillDialog — truthful-status rendering', () => {
  beforeEach(() => {
    useLocale().setLocale('en')
  })
  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('scope step shows the quota-consumed note BEFORE generation (cost honesty)', () => {
    const { app } = mountDialog(async () => jsonResponse({ ok: true, data: PREVIEW_WIRE }))
    const note = q('[data-test="ai-bulk-quota-note"]')
    expect(note?.textContent).toContain('consumes AI quota')
    expect(note?.textContent).toContain('does NOT refund')
    app.unmount()
  })

  it('a MIXED preview renders each state distinctly; ONLY confirmable rows are selectable', async () => {
    const { app } = mountDialog(async () => jsonResponse({ ok: true, data: PREVIEW_WIRE }))

    ;(q('[data-test="ai-bulk-generate"]') as HTMLButtonElement).click()
    await flush()

    // Confirmable rows: exactly 2 (clean + masked), each with a selectable checkbox.
    const rows = qa('[data-test="ai-bulk-row"]')
    expect(rows).toHaveLength(2)
    const rowSelects = qa('[data-test="ai-bulk-row-select"]') as HTMLInputElement[]
    expect(rowSelects).toHaveLength(2)
    expect(rowSelects.every((c) => c.checked)).toBe(true) // default: all confirmable selected

    // Masked row distinctly badged "may be incomplete"; clean row badged "ready".
    expect(q('[data-test="ai-bulk-badge-masked"]')?.textContent).toContain('May be incomplete')
    expect(q('[data-test="ai-bulk-badge-ready"]')?.textContent).toContain('Ready to write')

    // Skipped: a NON-selectable list (no checkboxes), with distinct reasons.
    const skipped = q('[data-test="ai-bulk-skipped"]')
    expect(skipped).not.toBeNull()
    expect(skipped!.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    const skippedReasons = qa('[data-test="ai-bulk-skipped-item"] .ai-bulk__group-reason').map((e) => e.textContent)
    expect(skippedReasons).toEqual(['No write permission', 'Rate-limited — re-run to reach it'])

    // Failures: CHARGED, non-selectable, with the consumed-quota note.
    const failures = q('[data-test="ai-bulk-failures"]')
    expect(failures).not.toBeNull()
    expect(failures!.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect(q('[data-test="ai-bulk-failures"] .ai-bulk__group-note')?.textContent).toContain('CONSUMED quota')
    expect(q('[data-test="ai-bulk-failure-item"] .ai-bulk__group-reason')?.textContent).toContain('Provider error after charge')

    // Cost (already charged) + summary surfaced.
    expect(q('[data-test="ai-bulk-cost"]')?.textContent).toContain('already charged')
    expect(q('[data-test="ai-bulk-cost"]')?.textContent).toContain('0.0042')
    expect(q('[data-test="ai-bulk-summary"]')?.textContent).toContain('2 ready')
    expect(q('[data-test="ai-bulk-summary"]')?.textContent).toContain('2 skipped')
    expect(q('[data-test="ai-bulk-summary"]')?.textContent).toContain('1 failed (charged)')
    app.unmount()
  })

  it('capped:true renders the partial-preview notice WITHOUT a count (oracle guard)', async () => {
    const { app } = mountDialog(async () => jsonResponse({ ok: true, data: { ...PREVIEW_WIRE, capped: true } }))
    ;(q('[data-test="ai-bulk-generate"]') as HTMLButtonElement).click()
    await flush()
    const partial = q('[data-test="ai-bulk-partial"]')
    expect(partial?.textContent).toContain('stopped early')
    expect(partial?.textContent).not.toMatch(/\d+ of \d+/) // no row count leak
    app.unmount()
  })

  it('a MIXED commit renders the correct per-row outcome + aggregate counts + re-preview guidance', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: PREVIEW_WIRE }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: COMMIT_WIRE }))
    const { app } = mountDialog(fetchFn as never)

    ;(q('[data-test="ai-bulk-generate"]') as HTMLButtonElement).click()
    await flush()
    ;(q('[data-test="ai-bulk-confirm"]') as HTMLButtonElement).click()
    await flush()

    // Per-row outcome badges keyed by data-outcome.
    const outcomeRows = qa('[data-test="ai-bulk-outcome-row"]')
    expect(outcomeRows).toHaveLength(4)
    const byOutcome = (o: string) => outcomeRows.find((r) => r.getAttribute('data-outcome') === o)
    expect(byOutcome('written')).toBeTruthy()
    expect(byOutcome('stale_reprev')?.querySelector('[data-test="ai-bulk-outcome-badge"]')?.textContent).toContain('Changed since preview')
    expect(byOutcome('not_in_cache')?.querySelector('[data-test="ai-bulk-outcome-badge"]')?.textContent).toContain('Expired')
    expect(byOutcome('skipped_no_perm')?.querySelector('[data-test="ai-bulk-outcome-badge"]')?.textContent).toContain('No write permission')

    // Only the WRITTEN row gets the "ready" badge class; everything else is a warn badge.
    expect(byOutcome('written')?.querySelector('.ai-bulk__badge--ready')).toBeTruthy()
    expect(byOutcome('stale_reprev')?.querySelector('.ai-bulk__badge--warn')).toBeTruthy()

    // Aggregate summary lists every non-zero bucket.
    const summary = q('[data-test="ai-bulk-commit-summary"]')?.textContent ?? ''
    expect(summary).toContain('1 written')
    expect(summary).toContain('1 need re-preview')
    expect(summary).toContain('1 expired/not-cached')
    expect(summary).toContain('1 no-permission')

    // Stale rows → explicit re-preview guidance.
    expect(q('[data-test="ai-bulk-stale-guidance"]')?.textContent).toContain('re-preview')
    app.unmount()
  })

  it('all-not_in_cache commit (expired run) → re-preview prompt, never a blank success', async () => {
    const allExpired: AiBulkCommitData = {
      outcomes: [
        { recordId: 'rec_ok', outcome: 'not_in_cache' },
        { recordId: 'rec_masked', outcome: 'not_in_cache' },
      ],
      counts: { written: 0, stale_reprev: 0, write_conflict: 0, not_in_cache: 2, skipped_no_perm: 0 },
    }
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: PREVIEW_WIRE }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: allExpired }))
    const { app } = mountDialog(fetchFn as never)
    ;(q('[data-test="ai-bulk-generate"]') as HTMLButtonElement).click()
    await flush()
    ;(q('[data-test="ai-bulk-confirm"]') as HTMLButtonElement).click()
    await flush()

    expect(q('[data-test="ai-bulk-all-expired"]')?.textContent).toContain('expired')
    expect(q('[data-test="ai-bulk-commit-summary"]')?.textContent).toContain('0 written')
    app.unmount()
  })

  it('deselecting confirmable rows updates the confirm button count and disables at zero', async () => {
    const { app } = mountDialog(async () => jsonResponse({ ok: true, data: PREVIEW_WIRE }))
    ;(q('[data-test="ai-bulk-generate"]') as HTMLButtonElement).click()
    await flush()

    const confirm = q('[data-test="ai-bulk-confirm"]') as HTMLButtonElement
    expect(confirm.textContent).toContain('(2)')

    // Deselect both confirmable rows via the select-all toggle.
    ;(q('[data-test="ai-bulk-select-all"]') as HTMLInputElement).click()
    await nextTick()
    expect((q('[data-test="ai-bulk-confirm"]') as HTMLButtonElement).disabled).toBe(true)
    app.unmount()
  })

  it('over-cap (BULK_SCOPE_TOO_LARGE 400) renders code-keyed copy and stays on the scope step', async () => {
    const { app } = mountDialog(async () => jsonResponse(
      { ok: false, error: { code: 'BULK_SCOPE_TOO_LARGE', message: 'too many' } },
      { status: 400 },
    ))
    ;(q('[data-test="ai-bulk-generate"]') as HTMLButtonElement).click()
    await flush()

    expect(q('[data-test="ai-bulk-error"]')?.textContent).toContain('Too many rows')
    expect(q('[data-test="ai-bulk-rows"]')).toBeNull() // no review table
    expect(q('[data-test="ai-bulk-generate"]')).not.toBeNull() // still on scope step
    app.unmount()
  })

  it('quota-insufficient (AI_BULK_QUOTA_INSUFFICIENT 429) renders the whole-run refusal copy', async () => {
    const { app } = mountDialog(async () => jsonResponse(
      { ok: false, status: 'quota_exhausted', error: { code: 'AI_BULK_QUOTA_INSUFFICIENT', message: 'no quota' } },
      { status: 429 },
    ))
    ;(q('[data-test="ai-bulk-generate"]') as HTMLButtonElement).click()
    await flush()
    expect(q('[data-test="ai-bulk-error"]')?.textContent).toContain('exceed the remaining AI quota')
    app.unmount()
  })

  it('computed-filter-unsupported (AI_BULK_VIEW_FILTER_UNSUPPORTED 422) renders narrow-the-view copy', async () => {
    const { app } = mountDialog(async () => jsonResponse(
      { ok: false, error: { code: 'AI_BULK_VIEW_FILTER_UNSUPPORTED', message: 'computed filter' } },
      { status: 422 },
    ))
    ;(q('[data-test="ai-bulk-generate"]') as HTMLButtonElement).click()
    await flush()
    expect(q('[data-test="ai-bulk-error"]')?.textContent).toContain('computed')
    app.unmount()
  })

  it('RATE_LIMITED (429 + Retry-After) shows the countdown on the error banner', async () => {
    vi.useFakeTimers()
    const { app } = mountDialog(async () => jsonResponse(
      { ok: false, status: 'rate_limited', error: { code: 'RATE_LIMITED', message: 'slow' } },
      { status: 429, headers: { 'Retry-After': '3' } },
    ))
    ;(q('[data-test="ai-bulk-generate"]') as HTMLButtonElement).click()
    await flush()
    expect(q('[data-test="ai-bulk-error"]')?.textContent).toContain('Too many AI requests')
    expect(q('[data-test="ai-bulk-retry"]')?.textContent).toContain('Retry in 3s')
    vi.useRealTimers()
    app.unmount()
  })
})
