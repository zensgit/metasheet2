/**
 * Record inspector v3 PR-B2 (docs/development/multitable-record-inspector-v3-design-20260905.md §1.3
 * "Field-anchored server errors", §3 "B2", §4 item 11). Three layers pinned here, each in isolation:
 *
 *   1. composable — `useMultitableGrid.patchCell` RETURNS its own `GridPatchFailure` (round 2: per call;
 *      null on success and on the local row-action refusal): a rejected `patchRecords` returns
 *      status / code / fieldErrors / message AND still sets `error.value` AND still rolls the optimistic
 *      write back (the two pre-existing behaviours the brief says must not move). Plus: two in-flight
 *      calls settling in one flush each get their own (no shared slot).
 *   2. routing — `resolvePatchFailureRoute`, the one pure rule the workbench applies (fieldErrors non-empty
 *      / HTTP 422 / code VALIDATION_ERROR → field; VERSION_CONFLICT → conflict; everything else — incl. a
 *      plain 400 with any other code — → toast). Code-keyed, not status-keyed (round 2).
 *   3. MetaRecordFieldsPanel — rejected value stays in the control (per-field draft), `role="alert"`
 *      under it with `data-test="drawer-field-error"`, `aria-invalid="true"`, `aria-describedby`
 *      resolving to that alert, cleared after a successful patch of the same field and on record
 *      change, other fields unaffected. And MetaRecordInspector's `fieldErrors` pass-through to it.
 *   3c. MetaRecordInspector.canAnchorFieldError — the exposed predicate the workbench asks BEFORE writing
 *      an entry: true only when visible, on THAT record, details tab active, and the panel renders a row
 *      for the field (round 2: an entry written while it is false has NO node in the DOM — demonstrated).
 *
 * The WORKBENCH half of B2 (onDrawerPatch routing: 422 → no toast + inline, 400 FORBIDDEN → toast, 403 →
 * toast, VERSION_CONFLICT → banner + marker + toast, not-anchorable → toast, per-call failure under
 * concurrency, origin-tagged conflict clear, record-change clearing) lives in
 * multitable-workbench-view.spec.ts beside the existing conflict-banner pin, because it needs that
 * file's workbench harness (MetaRecordInspector is stubbed there; the stub's `canAnchorFieldError`
 * plays the answer this file pins for the real component).
 *
 * Backend pre-check (stated in the PR body, restated here so the fixtures are read honestly): on this
 * head `POST /api/multitable/patch` never emits a `fieldErrors` object on ANY status — its value-
 * validation path is `400 { ok:false, error:{ code:'VALIDATION_ERROR' | <err.code>, message } }`
 * (first failure wins, no field id). The 422 + `fieldErrors` fixtures below therefore exercise the
 * client-side normalisation contract (`client.ts` normalizeFieldErrors, which the form-submit and
 * record-create routes DO feed today), not a shape /patch produces; the 400 / VALIDATION_ERROR fixture
 * is the shape /patch actually sends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import { useMultitableGrid, type GridPatchFailure } from '../src/multitable/composables/useMultitableGrid'
import { MultitableApiClient } from '../src/multitable/api/client'
import { fieldAnchoredPatchMessage, resolvePatchFailureRoute } from '../src/multitable/utils/patch-failure-routing'
import MetaRecordFieldsPanel from '../src/multitable/components/MetaRecordFieldsPanel.vue'
import MetaRecordInspector from '../src/multitable/components/MetaRecordInspector.vue'
import { useLocale } from '../src/composables/useLocale'
import type { MetaField, MetaRecord } from '../src/multitable/types'

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

// ---------------------------------------------------------------------------------------------------
// 1. composable — patchCell returns its own GridPatchFailure, additive to rollback + error.value
// ---------------------------------------------------------------------------------------------------

function rejectingPatchFetch(status: number, body: unknown) {
  return vi.fn(async (input: string) => {
    if (!input.startsWith('/api/multitable/patch')) throw new Error(`Unexpected request: ${input}`)
    return new Response(JSON.stringify(body), { status })
  })
}

function successPatchFetch() {
  return vi.fn(async (input: string) => {
    if (!input.startsWith('/api/multitable/patch')) throw new Error(`Unexpected request: ${input}`)
    return new Response(JSON.stringify({
      ok: true,
      data: { updated: [{ recordId: 'r1', version: 2 }], records: [{ recordId: 'r1', data: { f1: 'patched' } }] },
    }), { status: 200 })
  })
}

function gridWith(fetchFn: ReturnType<typeof vi.fn>) {
  const grid = useMultitableGrid({ sheetId: ref(''), viewId: ref(''), client: new MultitableApiClient({ fetchFn }) })
  grid.fields.value = [{ id: 'f1', name: 'Title', type: 'string' }, { id: 'f2', name: 'Notes', type: 'string' }]
  grid.rows.value = [{ id: 'r1', version: 1, data: { f1: 'before', f2: 'keep' } }]
  return grid
}

describe('useMultitableGrid.patchCell — returns its own GridPatchFailure (PR-B2 §1.3, additive)', () => {
  beforeEach(() => {
    useLocale().setLocale('en')
  })

  it('a 422 with fieldErrors RETURNS the failure AND still sets error.value AND still rolls back', async () => {
    const grid = gridWith(rejectingPatchFetch(422, {
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed', fieldErrors: { f1: 'Title is too long' } },
    }))

    const failure = await grid.patchCell('r1', 'f1', 'way too long', 1)

    // Pre-existing behaviour #1 — rollback of the optimistic write (unchanged).
    expect(grid.rows.value[0].data.f1).toBe('before')
    expect(grid.rows.value[0].data.f2).toBe('keep')
    // Pre-existing behaviour #2 — error.value still set (client.ts surfaces the FIRST field error as the message).
    expect(grid.error.value).toBe('Title is too long')
    // No conflict for a non-VERSION_CONFLICT code (unchanged).
    expect(grid.conflict.value).toBeNull()
    // NEW — the structured failure the workbench routes on, returned to THIS caller.
    expect(failure).toEqual<GridPatchFailure>({
      recordId: 'r1',
      fieldId: 'f1',
      attemptedValue: 'way too long',
      status: 422,
      code: 'VALIDATION_ERROR',
      message: 'Title is too long',
      fieldErrors: { f1: 'Title is too long' },
    })
  })

  it('the shape /patch ACTUALLY sends today — 400 VALIDATION_ERROR with no fieldErrors — returns status+code and no map', async () => {
    const grid = gridWith(rejectingPatchFetch(400, {
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Select value must be string: f1' },
    }))

    const failure = await grid.patchCell('r1', 'f1', 42, 1)

    expect(grid.rows.value[0].data.f1).toBe('before')
    expect(grid.error.value).toBe('Select value must be string: f1')
    expect(failure).toEqual<GridPatchFailure>({
      recordId: 'r1',
      fieldId: 'f1',
      attemptedValue: 42,
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Select value must be string: f1',
      fieldErrors: undefined,
    })
  })

  it('a 403 FORBIDDEN returns status/code with fieldErrors undefined (still rolls back, still sets error.value)', async () => {
    const grid = gridWith(rejectingPatchFetch(403, { ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } }))

    const failure = await grid.patchCell('r1', 'f1', 'nope', 1)

    expect(grid.rows.value[0].data.f1).toBe('before')
    expect(grid.error.value).toBe('Insufficient permissions')
    expect(failure).toMatchObject({ recordId: 'r1', fieldId: 'f1', status: 403, code: 'FORBIDDEN' })
    expect(failure?.fieldErrors).toBeUndefined()
  })

  it('a VERSION_CONFLICT still sets conflict.value exactly as before AND returns the failure with code/status', async () => {
    const grid = gridWith(rejectingPatchFetch(409, {
      ok: false,
      error: { code: 'VERSION_CONFLICT', message: 'Row changed elsewhere', serverVersion: 8 },
    }))

    const failure = await grid.patchCell('r1', 'f1', 'patched', 1)

    expect(grid.rows.value[0].data.f1).toBe('before')
    expect(grid.error.value).toBe('Row changed elsewhere')
    // Byte-for-byte the pre-B2 conflict shape (pinned in multitable-grid.spec.ts too).
    expect(grid.conflict.value).toEqual({
      recordId: 'r1',
      fieldId: 'f1',
      attemptedValue: 'patched',
      message: 'Row changed elsewhere',
      serverVersion: 8,
      previousLinkSummaries: undefined,
      nextLinkSummaries: undefined,
    })
    expect(failure).toMatchObject({ recordId: 'r1', fieldId: 'f1', status: 409, code: 'VERSION_CONFLICT', message: 'Row changed elsewhere' })
  })

  it('returns null on a success (row updated, error.value null); a rejection after it returns its own failure; a success after that returns null again', async () => {
    const rejecting = rejectingPatchFetch(422, { ok: false, error: { code: 'VALIDATION_ERROR', message: 'bad', fieldErrors: { f1: 'bad' } } })
    const succeeding = successPatchFetch()
    let active: ReturnType<typeof vi.fn> = succeeding
    const grid = gridWith(vi.fn((input: string) => active(input)))

    expect(await grid.patchCell('r1', 'f1', 'patched', 1)).toBeNull()
    expect(grid.error.value).toBeNull()
    expect(grid.rows.value[0].data.f1).toBe('patched')

    active = rejecting
    const failure = await grid.patchCell('r1', 'f1', 'x', 2)
    expect(failure).toMatchObject({ recordId: 'r1', fieldId: 'f1', attemptedValue: 'x', status: 422 })
    expect(grid.rows.value[0].data.f1).toBe('patched') // rolled back to the last accepted value

    active = succeeding
    expect(await grid.patchCell('r1', 'f1', 'patched', 2)).toBeNull()
    expect(grid.error.value).toBeNull()
  })

  it('the LOCAL row-action refusal (no server call) sets error.value as before and returns null (no structured failure)', async () => {
    const fetchFn = successPatchFetch()
    const grid = gridWith(fetchFn)
    grid.rowActions.value = { canEdit: false, canDelete: true, canComment: true }

    const failure = await grid.patchCell('r1', 'f1', 'patched', 1)

    expect(fetchFn).not.toHaveBeenCalled()
    expect(grid.error.value).toBe('Record editing is not allowed for this row.')
    expect(failure).toBeNull()
  })

  it('two in-flight patchCell calls whose rejections settle in the SAME flush each return THEIR OWN failure (per call — not a shared slot read after await)', async () => {
    const settlers: Array<{ body: string; resolve: (response: Response) => void }> = []
    const fetchFn = vi.fn((input: string, init?: RequestInit) => {
      if (!input.startsWith('/api/multitable/patch')) throw new Error(`Unexpected request: ${input}`)
      return new Promise<Response>((resolve) => { settlers.push({ body: String(init?.body ?? ''), resolve }) })
    })
    const grid = gridWith(fetchFn)

    const first = grid.patchCell('r1', 'f1', 'way too long', 1)
    const second = grid.patchCell('r1', 'f2', 'nope', 1)
    await Promise.resolve()
    expect(settlers).toHaveLength(2)
    expect(settlers[0].body).toContain('"fieldId":"f1"')
    expect(settlers[1].body).toContain('"fieldId":"f2"')

    // Both responses land in one flush: f1 → 400 VALIDATION_ERROR, f2 → 403 FORBIDDEN.
    settlers[0].resolve(new Response(JSON.stringify({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Title is too long' } }), { status: 400 }))
    settlers[1].resolve(new Response(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } }), { status: 403 }))
    const [firstFailure, secondFailure] = await Promise.all([first, second])

    expect(firstFailure).toMatchObject({ recordId: 'r1', fieldId: 'f1', attemptedValue: 'way too long', status: 400, code: 'VALIDATION_ERROR', message: 'Title is too long' })
    expect(secondFailure).toMatchObject({ recordId: 'r1', fieldId: 'f2', attemptedValue: 'nope', status: 403, code: 'FORBIDDEN', message: 'Insufficient permissions' })
    // Both rolled back; the shared `error.value` holds whichever landed last (pre-existing single slot —
    // exactly why the workbench must route on the RETURNED failure, not on shared state).
    expect(grid.rows.value[0].data).toEqual({ f1: 'before', f2: 'keep' })
    expect(['Title is too long', 'Insufficient permissions']).toContain(grid.error.value)
  })
})

// ---------------------------------------------------------------------------------------------------
// 2. routing — the one rule the workbench applies
// ---------------------------------------------------------------------------------------------------

function failure(overrides: Partial<GridPatchFailure>): GridPatchFailure {
  return { recordId: 'r1', fieldId: 'f1', attemptedValue: 'x', message: 'msg', ...overrides }
}

describe('resolvePatchFailureRoute (PR-B2 §1.3 / §4 item 11 matrix — code-keyed, round 2)', () => {
  it('routes fieldErrors (non-empty) / HTTP 422 / code VALIDATION_ERROR to the field', () => {
    expect(resolvePatchFailureRoute(failure({ status: 500, code: 'INTERNAL_ERROR', fieldErrors: { f1: 'x' } }))).toBe('field')
    expect(resolvePatchFailureRoute(failure({ status: 400, code: 'VALIDATION_ERROR' }))).toBe('field') // the shape /patch sends for value validation
    expect(resolvePatchFailureRoute(failure({ status: 422, code: 'UNPROCESSABLE' }))).toBe('field')
    expect(resolvePatchFailureRoute(failure({ status: undefined, code: 'VALIDATION_ERROR' }))).toBe('field')
  })

  it('a plain HTTP 400 with any OTHER code is NOT a field validation error → toast (record-lock refusal ships as 400 FORBIDDEN)', () => {
    expect(resolvePatchFailureRoute(failure({ status: 400, code: 'FORBIDDEN' }))).toBe('toast')
    expect(resolvePatchFailureRoute(failure({ status: 400, code: 'RECORD_LOCKED' }))).toBe('toast')
    expect(resolvePatchFailureRoute(failure({ status: 400, code: undefined }))).toBe('toast')
  })

  it('routes VERSION_CONFLICT to the conflict banner + marker (before any fieldErrors/status leg)', () => {
    expect(resolvePatchFailureRoute(failure({ status: 409, code: 'VERSION_CONFLICT' }))).toBe('conflict')
    expect(resolvePatchFailureRoute(failure({ status: 409, code: 'VERSION_CONFLICT', fieldErrors: { f1: 'x' } }))).toBe('conflict')
  })

  it('keeps every other code/status on the toast, including a null failure (local refusal)', () => {
    expect(resolvePatchFailureRoute(failure({ status: 403, code: 'FORBIDDEN' }))).toBe('toast')
    expect(resolvePatchFailureRoute(failure({ status: 404, code: 'NOT_FOUND' }))).toBe('toast')
    expect(resolvePatchFailureRoute(failure({ status: 409, code: 'CONFLICT' }))).toBe('toast')
    expect(resolvePatchFailureRoute(failure({ status: 500, code: 'INTERNAL_ERROR' }))).toBe('toast')
    expect(resolvePatchFailureRoute(failure({ status: 503, code: 'DB_NOT_READY' }))).toBe('toast')
    expect(resolvePatchFailureRoute(failure({ status: undefined, code: undefined }))).toBe('toast') // network failure: no status, no code
    expect(resolvePatchFailureRoute(failure({ fieldErrors: {} }))).toBe('toast') // empty map is not an anchor
    expect(resolvePatchFailureRoute(null)).toBe('toast')
    expect(resolvePatchFailureRoute(undefined)).toBe('toast')
  })

  it('fieldAnchoredPatchMessage prefers a NON-EMPTY server message for THAT field, else the top-level message, and yields \'\' only when both are empty', () => {
    expect(fieldAnchoredPatchMessage(failure({ fieldErrors: { f1: 'per-field', f2: 'other' } }))).toBe('per-field')
    expect(fieldAnchoredPatchMessage(failure({ fieldErrors: { f2: 'other' }, message: 'top' }))).toBe('top')
    expect(fieldAnchoredPatchMessage(failure({ message: 'top' }))).toBe('top')
    expect(fieldAnchoredPatchMessage(failure({ fieldErrors: { f1: '' }, message: 'top' }))).toBe('top') // empty per-field text is not an anchor
    expect(fieldAnchoredPatchMessage(failure({ fieldErrors: { f1: '' }, message: '' }))).toBe('') // the workbench toasts a generic label in this case
  })
})

// ---------------------------------------------------------------------------------------------------
// 3. MetaRecordFieldsPanel — draft kept, alert + aria, clearing edges
// ---------------------------------------------------------------------------------------------------

const TITLE_FIELD = { id: 'fld_title', name: 'Title', type: 'string' } as unknown as MetaField
const NOTES_FIELD = { id: 'fld_notes', name: 'Notes', type: 'longText' } as unknown as MetaField
const FIELDS = [TITLE_FIELD, NOTES_FIELD]
const REC_1 = { id: 'rec_1', version: 1, data: { fld_title: 'Alpha', fld_notes: 'n1' } } as unknown as MetaRecord

const mountedApps: App[] = []

/** Reactive harness: the test plays the workbench — it owns `record` (what the composable's rollback
 *  leaves in place) and `fieldErrors` (what onDrawerPatch would write), and the panel only sees props. */
function mountPanel() {
  const record = ref<MetaRecord>(REC_1)
  const fieldErrors = ref<Record<string, string> | null>(null)
  const patchSpy = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render() {
      return h(MetaRecordFieldsPanel, {
        record: record.value,
        fields: FIELDS,
        canEdit: true,
        canComment: false,
        fieldErrors: fieldErrors.value,
        onPatch: patchSpy,
      })
    },
  })
  app.mount(container)
  mountedApps.push(app)
  return { container, record, fieldErrors, patchSpy }
}

function titleInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('#drawer_field_fld_title')!
}
function notesTextarea(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>('#drawer_field_fld_notes')!
}
function alerts(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-test="drawer-field-error"]'))
}

/** User types into the control and commits (blur → change); the panel emits `patch(fieldId, value)`. */
function commitValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  el.value = value
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('MetaRecordFieldsPanel — field-anchored server errors (PR-B2 §1.3)', () => {
  beforeEach(() => {
    useLocale().setLocale('en')
  })
  afterEach(() => {
    while (mountedApps.length) mountedApps.pop()!.unmount()
    document.body.innerHTML = ''
  })

  it('rejected value stays in the control; role=alert under it; aria-invalid="true"; aria-describedby resolves to the alert', async () => {
    const { container, fieldErrors, patchSpy } = mountPanel()
    await flushUi()
    expect(titleInput(container).value).toBe('Alpha')

    commitValue(titleInput(container), 'Beta')
    await flushUi()
    // Emit contract unchanged (the fields-panel spec pins the same shape).
    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy).toHaveBeenCalledWith('fld_title', 'Beta')

    // Server rejects: the composable rolled record.data back (still 'Alpha' here), WB writes the error.
    fieldErrors.value = { fld_title: 'Title is too long' }
    await flushUi()

    const input = titleInput(container)
    expect(input.value).toBe('Beta') // draft held — NOT snapped back to 'Alpha'
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const alert = alerts(container)
    expect(alert).toHaveLength(1)
    expect(alert[0].getAttribute('role')).toBe('alert')
    expect(alert[0].getAttribute('data-field-id')).toBe('fld_title')
    expect(alert[0].textContent).toBe('Title is too long')
    // aria-describedby must RESOLVE to that alert node, not merely be a non-empty string.
    const describedBy = input.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)).toBe(alert[0])
    // The alert sits inside the same field block as its control.
    expect(input.closest('.meta-record-drawer__field')).toBe(alert[0].closest('.meta-record-drawer__field'))
  })

  it('other fields are unaffected: no alert, no aria-invalid, value untouched', async () => {
    const { container, fieldErrors } = mountPanel()
    await flushUi()
    commitValue(titleInput(container), 'Beta')
    fieldErrors.value = { fld_title: 'Title is too long' }
    await flushUi()

    const notes = notesTextarea(container)
    expect(notes.value).toBe('n1')
    expect(notes.hasAttribute('aria-invalid')).toBe(false)
    expect(notes.hasAttribute('aria-describedby')).toBe(false)
    expect(container.querySelectorAll('[data-test="drawer-field-error"][data-field-id="fld_notes"]')).toHaveLength(0)
    expect(alerts(container)).toHaveLength(1)
  })

  it('no error → no aria-invalid / aria-describedby attributes at all (absent, not "false")', async () => {
    const { container } = mountPanel()
    await flushUi()
    expect(titleInput(container).hasAttribute('aria-invalid')).toBe(false)
    expect(titleInput(container).hasAttribute('aria-describedby')).toBe(false)
    expect(alerts(container)).toHaveLength(0)
  })

  it('cleared after a successful patch of the SAME field: control shows the new record value, alert + aria gone, other field\'s error kept', async () => {
    const { container, record, fieldErrors } = mountPanel()
    await flushUi()
    // Two rejected fields.
    commitValue(titleInput(container), 'Beta')
    commitValue(notesTextarea(container), 'n2')
    fieldErrors.value = { fld_title: 'Title is too long', fld_notes: 'Notes rejected' }
    await flushUi()
    expect(titleInput(container).value).toBe('Beta')
    expect(notesTextarea(container).value).toBe('n2')
    expect(alerts(container)).toHaveLength(2)

    // User fixes the title; server accepts: record.data carries the new value, WB deletes ONLY that key.
    commitValue(titleInput(container), 'Gamma')
    record.value = { ...REC_1, version: 2, data: { ...REC_1.data, fld_title: 'Gamma' } } as MetaRecord
    fieldErrors.value = { fld_notes: 'Notes rejected' }
    await flushUi()

    const input = titleInput(container)
    expect(input.value).toBe('Gamma')
    expect(input.hasAttribute('aria-invalid')).toBe(false)
    expect(input.hasAttribute('aria-describedby')).toBe(false)
    expect(container.querySelectorAll('[data-test="drawer-field-error"][data-field-id="fld_title"]')).toHaveLength(0)
    // The other field's rejection is untouched: draft still shown, alert still present.
    expect(notesTextarea(container).value).toBe('n2')
    expect(notesTextarea(container).getAttribute('aria-invalid')).toBe('true')
    expect(container.querySelectorAll('[data-test="drawer-field-error"][data-field-id="fld_notes"]')).toHaveLength(1)
  })

  it('after a cleared error the control follows the record value again (no stale draft on the next prop change)', async () => {
    const { container, record, fieldErrors } = mountPanel()
    await flushUi()
    commitValue(titleInput(container), 'Beta')
    fieldErrors.value = { fld_title: 'Title is too long' }
    await flushUi()
    fieldErrors.value = {}
    await flushUi()
    expect(titleInput(container).value).toBe('Alpha') // back on the record value
    record.value = { ...REC_1, version: 3, data: { ...REC_1.data, fld_title: 'Delta' } } as MetaRecord
    await flushUi()
    expect(titleInput(container).value).toBe('Delta') // and it keeps following it
  })

  it('cleared on record change: the draft is dropped even if the parent\'s error map is still stale for one tick', async () => {
    const { container, record, fieldErrors } = mountPanel()
    await flushUi()
    commitValue(titleInput(container), 'Beta')
    fieldErrors.value = { fld_title: 'Title is too long' }
    await flushUi()
    expect(titleInput(container).value).toBe('Beta')

    // Navigate to another record. The workbench clears its map on the same edge; here it is left STALE
    // on purpose so this test discriminates the panel's OWN record-change clearing (delete the
    // `watch(() => props.record?.id …)` and 'Beta' would leak into rec_2's control).
    record.value = { id: 'rec_2', version: 1, data: { fld_title: 'Zeta', fld_notes: 'z' } } as unknown as MetaRecord
    await flushUi()
    expect(titleInput(container).value).toBe('Zeta')

    // …and once the parent's map is cleared too (what WB actually does), nothing is left over.
    fieldErrors.value = {}
    await flushUi()
    expect(alerts(container)).toHaveLength(0)
    expect(titleInput(container).hasAttribute('aria-invalid')).toBe(false)
  })

  it('a rejection with no draft in this panel (e.g. raised from the header title input) shows the alert over the record value', async () => {
    const { container, fieldErrors } = mountPanel()
    await flushUi()
    // No commit here — the patch came from somewhere else; WB still anchors it to the field.
    fieldErrors.value = { fld_title: 'Title is too long' }
    await flushUi()
    expect(titleInput(container).value).toBe('Alpha')
    expect(titleInput(container).getAttribute('aria-invalid')).toBe('true')
    expect(alerts(container)).toHaveLength(1)
  })

  it('an in-flight draft survives an UNRELATED field\'s error clearing before its own rejection lands', async () => {
    const { container, fieldErrors } = mountPanel()
    await flushUi()
    fieldErrors.value = { fld_notes: 'Notes rejected' }
    await flushUi()
    commitValue(titleInput(container), 'Beta') // title patch in flight
    fieldErrors.value = {} // notes fixed elsewhere first
    await flushUi()
    fieldErrors.value = { fld_title: 'Title is too long' } // now the title rejection lands
    await flushUi()
    expect(titleInput(container).value).toBe('Beta') // draft was not pruned by the unrelated clear
  })
})

// ---------------------------------------------------------------------------------------------------
// 3b. MetaRecordInspector — fieldErrors pass-through to the details tab panel
// ---------------------------------------------------------------------------------------------------

function fakeApiClient() {
  return {
    getRecordSubscriptionStatus: vi.fn().mockResolvedValue({ subscribed: false, subscription: null }),
    subscribeRecord: vi.fn().mockResolvedValue({ subscribed: true, subscription: null }),
    unsubscribeRecord: vi.fn().mockResolvedValue({ subscribed: false, subscription: null }),
  }
}

describe('MetaRecordInspector — fieldErrors prop reaches MetaRecordFieldsPanel (PR-B2 §3 B2 "INS (fieldErrors prop)")', () => {
  afterEach(() => {
    while (mountedApps.length) mountedApps.pop()!.unmount()
    document.body.innerHTML = ''
  })

  it('renders the details-tab alert for the keyed field and nothing for the others; absent prop → no alert', async () => {
    const fieldErrors = ref<Record<string, string> | null>(null)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      render() {
        return h(MetaRecordInspector, {
          visible: true,
          record: REC_1,
          fields: FIELDS,
          canEdit: true,
          canComment: false,
          canDelete: false,
          recordIds: ['rec_1'],
          sheetId: 'sheet_1',
          apiClient: fakeApiClient() as any,
          fieldErrors: fieldErrors.value,
        })
      },
    })
    app.mount(container)
    mountedApps.push(app)
    await flushUi()
    expect(container.querySelectorAll('[data-test="drawer-field-error"]')).toHaveLength(0)

    fieldErrors.value = { fld_notes: 'Notes rejected' }
    await flushUi()
    const alert = container.querySelectorAll<HTMLElement>('[data-test="drawer-field-error"]')
    expect(alert).toHaveLength(1)
    expect(alert[0].getAttribute('data-field-id')).toBe('fld_notes')
    expect(alert[0].textContent).toBe('Notes rejected')
    // The details-tab textarea (not the header title input) is what carries the aria wiring.
    const notes = container.querySelector<HTMLTextAreaElement>('#drawer_field_fld_notes')!
    expect(notes.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(notes.getAttribute('aria-describedby')!)).toBe(alert[0])
    // The header title input keeps its PR-A contract — no aria-invalid, even when the PRIMARY field is keyed.
    fieldErrors.value = { fld_title: 'Title is too long' }
    await flushUi()
    const title = container.querySelector<HTMLInputElement>('.meta-record-drawer__title-input')!
    expect(title.hasAttribute('aria-invalid')).toBe(false)
    expect(container.querySelectorAll('[data-test="drawer-field-error"][data-field-id="fld_title"]')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------------------------------
// 3c. MetaRecordInspector.canAnchorFieldError — can the details-tab alert RENDER right now? (round 2)
// ---------------------------------------------------------------------------------------------------

describe('MetaRecordInspector.canAnchorFieldError (PR-B2 round 2: the alert must be able to render, else the workbench toasts)', () => {
  afterEach(() => {
    while (mountedApps.length) mountedApps.pop()!.unmount()
    document.body.innerHTML = ''
  })

  type InspectorHandle = { canAnchorFieldError: (recordId: string, fieldId: string) => boolean }

  function mountInspector(opts: { fieldPermissions?: Record<string, { visible?: boolean }> } = {}) {
    const fieldErrors = ref<Record<string, string> | null>(null)
    const visible = ref(true)
    const insRef = ref<InspectorHandle | null>(null)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      render() {
        return h(MetaRecordInspector, {
          ref: insRef,
          visible: visible.value,
          record: REC_1,
          fields: FIELDS,
          fieldPermissions: opts.fieldPermissions ?? null,
          canEdit: true,
          canComment: false,
          canDelete: false,
          recordIds: ['rec_1'],
          sheetId: 'sheet_1',
          apiClient: fakeApiClient() as any,
          fieldErrors: fieldErrors.value,
        })
      },
    })
    app.mount(container)
    mountedApps.push(app)
    return { container, fieldErrors, visible, insRef }
  }
  function tabButton(container: HTMLElement, tab: 'details' | 'attachments'): HTMLButtonElement {
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    const match = buttons.find((button) => button.getAttribute('aria-controls')?.endsWith(`-panel-${tab}`))
    expect(match, `tab button for ${tab}`).toBeTruthy()
    return match!
  }
  function alertsIn(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>('[data-test="drawer-field-error"]'))
  }

  it('details tab (default): true for a rendered field; false for an unknown field and for another record', async () => {
    const { container, insRef } = mountInspector()
    await flushUi()
    expect(tabButton(container, 'details').getAttribute('aria-selected')).toBe('true')
    expect(insRef.value!.canAnchorFieldError('rec_1', 'fld_title')).toBe(true)
    expect(insRef.value!.canAnchorFieldError('rec_1', 'fld_notes')).toBe(true)
    expect(insRef.value!.canAnchorFieldError('rec_1', 'fld_missing')).toBe(false)
    expect(insRef.value!.canAnchorFieldError('rec_2', 'fld_title')).toBe(false) // not the record being shown
  })

  it('a permission-hidden field has NO row in the details panel → false (the same `visibleRecordFields` rule the panel renders by)', async () => {
    const { container, insRef } = mountInspector({ fieldPermissions: { fld_notes: { visible: false } } })
    await flushUi()
    expect(container.querySelector('#drawer_field_fld_title')).toBeTruthy()
    expect(container.querySelector('#drawer_field_fld_notes')).toBeNull() // panel renders no row for it
    expect(insRef.value!.canAnchorFieldError('rec_1', 'fld_title')).toBe(true)
    expect(insRef.value!.canAnchorFieldError('rec_1', 'fld_notes')).toBe(false)
  })

  it('attachments tab active: false for every field — an entry written anyway has NO alert node (the orphan the predicate prevents); back on details → true, and the entry shows once', async () => {
    const { container, fieldErrors, insRef } = mountInspector()
    await flushUi()
    tabButton(container, 'attachments').click()
    await flushUi()
    expect(tabButton(container, 'attachments').getAttribute('aria-selected')).toBe('true')
    expect(insRef.value!.canAnchorFieldError('rec_1', 'fld_title')).toBe(false)
    expect(insRef.value!.canAnchorFieldError('rec_1', 'fld_notes')).toBe(false)

    // What round 1 did on an attachments-tab rejection: write the entry regardless. Nothing renders — the
    // details tabpanel is `v-if`, so there is no alert node for sighted users or AT. (The workbench now
    // asks first and toasts instead; this pins WHY.)
    fieldErrors.value = { fld_title: 'Attachment id too long' }
    await flushUi()
    expect(alertsIn(container)).toHaveLength(0)

    tabButton(container, 'details').click()
    await flushUi()
    expect(insRef.value!.canAnchorFieldError('rec_1', 'fld_title')).toBe(true)
    expect(alertsIn(container)).toHaveLength(1) // an entry that IS anchored renders exactly once
  })

  it('not visible → false for every field (a rejection landing after the inspector closed must toast)', async () => {
    const { visible, insRef } = mountInspector()
    await flushUi()
    expect(insRef.value!.canAnchorFieldError('rec_1', 'fld_title')).toBe(true)
    visible.value = false
    await flushUi()
    expect(insRef.value!.canAnchorFieldError('rec_1', 'fld_title')).toBe(false)
  })
})
