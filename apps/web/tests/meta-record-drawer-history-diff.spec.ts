/**
 * Arc1·S1 — MetaRecordDrawer history value-diff (before→after per field).
 *
 * SCOPE: render test for the per-field diff in the History tab. The diff iterates item.changedFieldIds
 * and reads only item.snapshot / item.patch — all THREE are already permission-masked server-side
 * (redactRecordRevisionEntry / maskStoredRecordFieldIds), so the diff is leak-safe by construction.
 * The leak-lock test below pins the FE half of that property: a field present in snapshot but NOT in
 * changedFieldIds must never render.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import MetaRecordDrawer from '../src/multitable/components/MetaRecordDrawer.vue'
import type { MetaField, MetaRecord, MetaRecordRevision } from '../src/multitable/types'

const FIELDS = [
  { id: 'fld_t', name: 'Title', type: 'string', property: {} },
  { id: 'fld_s', name: 'Secret', type: 'string', property: {} },
] as unknown as MetaField[]
const RECORD = { id: 'rec_1', version: 3, data: { fld_t: 'v3title' } } as unknown as MetaRecord

function rev(version: number, action: MetaRecordRevision['action'], over: Partial<MetaRecordRevision> = {}): MetaRecordRevision {
  return {
    id: `r${version}_${action}`, sheetId: 'sheet_1', recordId: 'rec_1', version, action,
    source: 'rest', actorId: null, changedFieldIds: ['fld_t'], createdAt: '2026-06-15T00:00:00Z',
    patch: {}, snapshot: {}, ...over,
  } as unknown as MetaRecordRevision
}

const flush = async () => { await nextTick(); await Promise.resolve(); await Promise.resolve(); await nextTick() }

function mountDrawer(revisions: MetaRecordRevision[], onRestore?: (p: unknown) => void): { container: HTMLElement; app: App } {
  const apiClient = {
    listRecordHistory: vi.fn(async () => revisions),
    getRecordSubscriptionStatus: vi.fn(async () => ({ subscribed: false, subscription: null })),
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render() {
      return h(MetaRecordDrawer, {
        visible: true, record: RECORD, fields: FIELDS, canEdit: true, canComment: false,
        canDelete: false, sheetId: 'sheet_1', apiClient: apiClient as never,
        ...(onRestore ? { onRestore } : {}),
      })
    },
  })
  app.mount(container)
  return { container, app }
}

async function openHistory(container: HTMLElement): Promise<void> {
  const tabs = container.querySelectorAll<HTMLButtonElement>('.meta-record-drawer__tab')
  tabs[1].click() // [0]=details, [1]=history
  await flush()
}

// desc-sorted (as the API returns): v3 → v2 → v1(create). Title changes each version.
const REVS = [
  rev(3, 'update', { changedFieldIds: ['fld_t'], snapshot: { fld_t: 'v3title' }, patch: { fld_t: 'v3title' } }),
  rev(2, 'update', { changedFieldIds: ['fld_t'], snapshot: { fld_t: 'v2title' }, patch: { fld_t: 'v2title' } }),
  rev(1, 'create', { changedFieldIds: ['fld_t'], snapshot: { fld_t: 'v1title' }, patch: {} }),
]

describe('MetaRecordDrawer history value-diff (Arc1·S1)', () => {
  let mounted: { container: HTMLElement; app: App } | null = null
  afterEach(() => { if (mounted) { mounted.app.unmount(); mounted.container.remove(); mounted = null } })

  it('renders before→after for a field changed against a prior snapshot', async () => {
    mounted = mountDrawer(REVS)
    await openHistory(mounted.container)
    const rows = mounted.container.querySelectorAll<HTMLElement>('[data-test="history-field-diff"]')
    // one diff row per revision (each changed only fld_t)
    expect(rows.length).toBe(3)
    // v3 row: before = v2's snapshot value, after = v3's
    const v3 = rows[0]
    expect(v3.querySelector('.meta-record-drawer__history-diff-label')?.textContent).toContain('Title')
    expect(v3.querySelector('.meta-record-drawer__history-diff-before')?.textContent).toContain('v2title')
    expect(v3.querySelector('.meta-record-drawer__history-diff-arrow')).not.toBeNull()
    expect(v3.querySelector('.meta-record-drawer__history-diff-after')?.textContent).toContain('v3title')
  })

  it('shows the create revision with no "before" (no prior snapshot)', async () => {
    mounted = mountDrawer(REVS)
    await openHistory(mounted.container)
    const rows = mounted.container.querySelectorAll<HTMLElement>('[data-test="history-field-diff"]')
    const createRow = rows[2] // v1 create
    expect(createRow.querySelector('.meta-record-drawer__history-diff-after')?.textContent).toContain('v1title')
    expect(createRow.querySelector('.meta-record-drawer__history-diff-before')).toBeNull()
    expect(createRow.querySelector('.meta-record-drawer__history-diff-arrow')).toBeNull()
  })

  it('LEAK-LOCK: a field present in snapshot but absent from changedFieldIds never renders', async () => {
    // Defends the FE half of the masking contract: even if a snapshot carried a value for a field the
    // actor cannot see (it won't post-redaction, but be defensive), the diff iterates changedFieldIds
    // only — so it must not surface fld_s here.
    const sneaky = [
      rev(3, 'update', { changedFieldIds: ['fld_t'], snapshot: { fld_t: 'v3title', fld_s: 'TOP_SECRET' }, patch: { fld_t: 'v3title' } }),
      rev(2, 'update', { changedFieldIds: ['fld_t'], snapshot: { fld_t: 'v2title', fld_s: 'TOP_SECRET' }, patch: { fld_t: 'v2title' } }),
    ]
    mounted = mountDrawer(sneaky)
    await openHistory(mounted.container)
    const html = mounted.container.innerHTML
    expect(html).not.toContain('TOP_SECRET')
    expect(html).not.toContain('Secret')
    // and only the changed field rendered a diff row
    const labels = [...mounted.container.querySelectorAll('.meta-record-drawer__history-diff-label')].map((e) => e.textContent)
    expect(labels.every((l) => l?.includes('Title'))).toBe(true)
  })
})

describe('MetaRecordDrawer per-field restore selection (Arc1·S2)', () => {
  let mounted: { container: HTMLElement; app: App } | null = null
  afterEach(() => { if (mounted) { mounted.app.unmount(); mounted.container.remove(); mounted = null } })

  // v2 < record v3 → restorable; changed TWO visible fields → two selectable checkboxes.
  const TWO_FIELD_REVS = [
    rev(2, 'update', { changedFieldIds: ['fld_t', 'fld_s'], snapshot: { fld_t: 'old title', fld_s: 'old status' }, patch: { fld_t: 'old title', fld_s: 'old status' } }),
    rev(1, 'create', { changedFieldIds: ['fld_t', 'fld_s'], snapshot: { fld_t: 'init', fld_s: 'init' }, patch: {} }),
  ]

  it('emits a FULL restore (no fieldIds) when all changed fields stay checked', async () => {
    const onRestore = vi.fn()
    mounted = mountDrawer(TWO_FIELD_REVS, onRestore)
    await openHistory(mounted.container)
    const btn = mounted.container.querySelector<HTMLButtonElement>('[data-test="record-history-restore"]')!
    expect(btn.disabled).toBe(false)
    btn.click(); await flush()
    expect(onRestore).toHaveBeenCalledTimes(1)
    expect(onRestore.mock.calls[0][0]).toEqual({ recordId: 'rec_1', targetVersion: 2, expectedVersion: 3 })
  })

  it('emits fieldIds for the checked SUBSET after unchecking a field', async () => {
    const onRestore = vi.fn()
    mounted = mountDrawer(TWO_FIELD_REVS, onRestore)
    await openHistory(mounted.container)
    // checkboxes: [v2.fld_t, v2.fld_s, v1.fld_t, v1.fld_s] — uncheck v2.fld_s (index 1)
    const checks = mounted.container.querySelectorAll<HTMLInputElement>('[data-test="history-field-select"]')
    checks[1].click(); await flush()
    const btn = mounted.container.querySelector<HTMLButtonElement>('[data-test="record-history-restore"]')!
    btn.click(); await flush()
    expect(onRestore).toHaveBeenCalledTimes(1)
    expect(onRestore.mock.calls[0][0]).toEqual({ recordId: 'rec_1', targetVersion: 2, expectedVersion: 3, fieldIds: ['fld_t'] })
  })

  it('disables restore when ALL fields are unchecked (no all-fields ambiguity)', async () => {
    const onRestore = vi.fn()
    mounted = mountDrawer(TWO_FIELD_REVS, onRestore)
    await openHistory(mounted.container)
    const checks = mounted.container.querySelectorAll<HTMLInputElement>('[data-test="history-field-select"]')
    checks[0].click(); await flush() // uncheck v2.fld_t
    checks[1].click(); await flush() // uncheck v2.fld_s
    const btn = mounted.container.querySelector<HTMLButtonElement>('[data-test="record-history-restore"]')!
    expect(btn.disabled).toBe(true)
    btn.click(); await flush()
    expect(onRestore).not.toHaveBeenCalled()
  })
})
