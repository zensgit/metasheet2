/**
 * W2 S2 (design-lock: docs/development/multitable-w2-unified-record-inspector-design-lock-20260714.md
 * §7 S2, §8.2): MetaRecordHistoryPanel.vue standalone coverage. This is the NEW component-level safety
 * net for the panel extracted from MetaRecordDrawer.vue's `history` tab body — the pre-existing drawer
 * specs (meta-record-drawer-history-diff.spec.ts, meta-record-drawer-restore.spec.ts) already
 * re-verify byte-for-byte behavior equivalence through the drawer (frozen-baseline discipline, the
 * P2-2a / S1 pattern) and stay green UNMODIFIED. This file instead pins the panel's OWN public
 * contract in isolation: revision-list rendering, the field-mask invariant (§4.4 — leak-safe by
 * construction), per-field restore-selection emits with exact payloads, and HI-1 (the panel calls
 * ONLY the existing gated `apiClient.listRecordHistory` read — nothing else, no direct-restore path).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import MetaRecordHistoryPanel from '../src/multitable/components/MetaRecordHistoryPanel.vue'
import type { MetaField, MetaRecord, MetaRecordRevision, MetaRowActions } from '../src/multitable/types'

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

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

function mockApiClient(overrides: { listRecordHistory?: (...args: unknown[]) => unknown } = {}) {
  // Every method below is a spy so the HI-1 test can prove the panel calls ONLY listRecordHistory —
  // never restoreRecordVersion (no direct-restore path, OD-W2-4=a), never any other read/write.
  return {
    listRecordHistory: vi.fn(overrides.listRecordHistory ?? (async () => [] as MetaRecordRevision[])),
    restoreRecordVersion: vi.fn(async () => { throw new Error('MUST NOT be called by the history panel — restore is relayed, not executed') }),
    getRecordSubscriptionStatus: vi.fn(async () => { throw new Error('MUST NOT be called by the history panel') }),
    patchRecord: vi.fn(async () => { throw new Error('MUST NOT be called by the history panel') }),
    deleteRecord: vi.fn(async () => { throw new Error('MUST NOT be called by the history panel') }),
  }
}

interface HarnessOptions {
  record?: MetaRecord | null
  fields?: MetaField[]
  canEdit?: boolean
  rowActions?: MetaRowActions | null
  revisions?: MetaRecordRevision[]
  apiClient?: ReturnType<typeof mockApiClient>
  onRestore?: (payload: unknown) => void
}

function mountPanel(options: HarnessOptions = {}): { container: HTMLElement; app: App; apiClient: ReturnType<typeof mockApiClient> } {
  const apiClient = options.apiClient ?? mockApiClient({
    listRecordHistory: async () => options.revisions ?? [rev(3, 'update'), rev(2, 'update'), rev(1, 'create')],
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render() {
      return h(MetaRecordHistoryPanel, {
        record: 'record' in options ? options.record : RECORD,
        fields: options.fields ?? FIELDS,
        canEdit: options.canEdit ?? true,
        rowActions: options.rowActions,
        sheetId: 'sheet_1',
        apiClient: apiClient as never,
        ...(options.onRestore ? { onRestore: options.onRestore } : {}),
      })
    },
  })
  app.mount(container)
  return { container, app, apiClient }
}

describe('MetaRecordHistoryPanel (W2 S2 extraction)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  describe('revision-list rendering', () => {
    it('fetches via apiClient.listRecordHistory on mount and renders the timeline', async () => {
      const { container, apiClient, app } = mountPanel()
      await flushUi()
      expect(apiClient.listRecordHistory).toHaveBeenCalledWith('sheet_1', 'rec_1', { limit: 50 })
      const items = container.querySelectorAll('.meta-record-drawer__history-item')
      expect(items.length).toBe(3)
      app.unmount()
    })

    it('shows the loading state before the fetch resolves, then the list', async () => {
      let resolveFetch!: (items: MetaRecordRevision[]) => void
      const pending = new Promise<MetaRecordRevision[]>((resolve) => { resolveFetch = resolve })
      const apiClient = mockApiClient({ listRecordHistory: () => pending })
      const { container, app } = mountPanel({ apiClient })
      await nextTick()
      expect(container.querySelector('.meta-record-drawer__history-state')?.textContent).toBeTruthy()
      expect(container.querySelector('.meta-record-drawer__history-list')).toBeNull()
      resolveFetch([rev(1, 'create')])
      await flushUi()
      expect(container.querySelectorAll('.meta-record-drawer__history-item').length).toBe(1)
      app.unmount()
    })

    it('shows the empty state when there are no revisions', async () => {
      const { container, app } = mountPanel({ revisions: [] })
      await flushUi()
      expect(container.querySelector('.meta-record-drawer__history-list')).toBeNull()
      expect(container.querySelector('.meta-record-drawer__history-state')).not.toBeNull()
      app.unmount()
    })

    it('shows the unavailable state when apiClient/sheetId/record are missing (no fetch attempted)', async () => {
      const apiClient = mockApiClient()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const app = createApp({
        render() {
          return h(MetaRecordHistoryPanel, {
            record: null,
            fields: FIELDS,
            canEdit: true,
            sheetId: 'sheet_1',
            apiClient: apiClient as never,
          })
        },
      })
      app.mount(container)
      await flushUi()
      expect(apiClient.listRecordHistory).not.toHaveBeenCalled()
      expect(container.querySelector('.meta-record-drawer__history-state')?.textContent).toBeTruthy()
      app.unmount()
    })

    it('shows the create revision with no "before" (no prior snapshot)', async () => {
      const revs = [
        rev(3, 'update', { changedFieldIds: ['fld_t'], snapshot: { fld_t: 'v3title' }, patch: { fld_t: 'v3title' } }),
        rev(1, 'create', { changedFieldIds: ['fld_t'], snapshot: { fld_t: 'v1title' }, patch: {} }),
      ]
      const { container, app } = mountPanel({ revisions: revs })
      await flushUi()
      const rows = container.querySelectorAll<HTMLElement>('[data-test="history-field-diff"]')
      const createRow = rows[1]
      expect(createRow.querySelector('.meta-record-drawer__history-diff-after')?.textContent).toContain('v1title')
      expect(createRow.querySelector('.meta-record-drawer__history-diff-before')).toBeNull()
      app.unmount()
    })
  })

  describe('field-mask invariant (lock §4.4 — leak-safe by construction)', () => {
    it('LEAK-LOCK: a field present in snapshot but absent from changedFieldIds never renders', async () => {
      // The diff iterates ONLY item.changedFieldIds and reads ONLY item.patch/item.snapshot — moved
      // VERBATIM from the drawer. This is the frontend half of the server's field-mask contract
      // (redactRecordRevisionEntry / maskStoredRecordFieldIds already strip unauthorized fields from
      // changedFieldIds AND patch AND snapshot before the wire) — defensive here in case a snapshot
      // ever carried a value for a field this actor cannot see.
      const sneaky = [
        rev(3, 'update', { changedFieldIds: ['fld_t'], snapshot: { fld_t: 'v3title', fld_s: 'TOP_SECRET' }, patch: { fld_t: 'v3title' } }),
        rev(2, 'update', { changedFieldIds: ['fld_t'], snapshot: { fld_t: 'v2title', fld_s: 'TOP_SECRET' }, patch: { fld_t: 'v2title' } }),
      ]
      const { container, app } = mountPanel({ revisions: sneaky })
      await flushUi()
      const html = container.innerHTML
      expect(html).not.toContain('TOP_SECRET')
      expect(html).not.toContain('Secret')
      const labels = [...container.querySelectorAll('.meta-record-drawer__history-diff-label')].map((e) => e.textContent)
      expect(labels.every((l) => l?.includes('Title'))).toBe(true)
      app.unmount()
    })
  })

  describe('restore-selection emits — exact payloads, relayed unchanged (OD-W2-4=a)', () => {
    const TWO_FIELD_REVS = [
      rev(2, 'update', { changedFieldIds: ['fld_t', 'fld_s'], snapshot: { fld_t: 'old title', fld_s: 'old status' }, patch: { fld_t: 'old title', fld_s: 'old status' } }),
      rev(1, 'create', { changedFieldIds: ['fld_t', 'fld_s'], snapshot: { fld_t: 'init', fld_s: 'init' }, patch: {} }),
    ]

    it('emits a FULL restore (no fieldIds) when all changed fields stay checked', async () => {
      const onRestore = vi.fn()
      const { container, app } = mountPanel({ revisions: TWO_FIELD_REVS, onRestore })
      await flushUi()
      const btn = container.querySelector<HTMLButtonElement>('[data-test="record-history-restore"]')!
      expect(btn.disabled).toBe(false)
      btn.click(); await flushUi()
      expect(onRestore).toHaveBeenCalledTimes(1)
      expect(onRestore.mock.calls[0][0]).toEqual({ recordId: 'rec_1', targetVersion: 2, expectedVersion: 3 })
      app.unmount()
    })

    it('emits fieldIds for the checked SUBSET after unchecking a field', async () => {
      const onRestore = vi.fn()
      const { container, app } = mountPanel({ revisions: TWO_FIELD_REVS, onRestore })
      await flushUi()
      const checks = container.querySelectorAll<HTMLInputElement>('[data-test="history-field-select"]')
      checks[1].click(); await flushUi() // uncheck v2.fld_s
      const btn = container.querySelector<HTMLButtonElement>('[data-test="record-history-restore"]')!
      btn.click(); await flushUi()
      expect(onRestore).toHaveBeenCalledTimes(1)
      expect(onRestore.mock.calls[0][0]).toEqual({ recordId: 'rec_1', targetVersion: 2, expectedVersion: 3, fieldIds: ['fld_t'] })
      app.unmount()
    })

    it('disables restore when ALL fields are unchecked (no all-fields ambiguity)', async () => {
      const onRestore = vi.fn()
      const { container, app } = mountPanel({ revisions: TWO_FIELD_REVS, onRestore })
      await flushUi()
      const checks = container.querySelectorAll<HTMLInputElement>('[data-test="history-field-select"]')
      checks[0].click(); await flushUi()
      checks[1].click(); await flushUi()
      const btn = container.querySelector<HTMLButtonElement>('[data-test="record-history-restore"]')!
      expect(btn.disabled).toBe(true)
      btn.click(); await flushUi()
      expect(onRestore).not.toHaveBeenCalled()
      app.unmount()
    })

    it('shows no restore button for the current version, a delete revision, or when canEdit is false', async () => {
      const { container, app } = mountPanel({
        revisions: [rev(3, 'update'), rev(2, 'delete')], // v3 = current (record.version), v2 = delete
      })
      await flushUi()
      expect(container.querySelectorAll('[data-test="record-history-restore"]').length).toBe(0)
      app.unmount()

      const { container: c2, app: a2 } = mountPanel({ canEdit: false })
      await flushUi()
      expect(c2.querySelectorAll('[data-test="record-history-restore"]').length).toBe(0)
      a2.unmount()
    })

    it('reloads the timeline when record.version changes while mounted (post-restore refresh)', async () => {
      const recordRef = ref({ id: 'rec_1', version: 3, data: { fld_t: 'now' } } as unknown as MetaRecord)
      const apiClient = mockApiClient({ listRecordHistory: async () => [rev(3, 'update'), rev(2, 'update')] })
      const container = document.createElement('div')
      document.body.appendChild(container)
      const app = createApp({
        render() {
          return h(MetaRecordHistoryPanel, {
            record: recordRef.value, fields: FIELDS, canEdit: true,
            sheetId: 'sheet_1', apiClient: apiClient as never,
          })
        },
      })
      app.mount(container)
      await flushUi()
      expect(apiClient.listRecordHistory).toHaveBeenCalledTimes(1)
      recordRef.value = { id: 'rec_1', version: 4, data: { fld_t: 'restored' } } as unknown as MetaRecord
      await flushUi()
      expect(apiClient.listRecordHistory).toHaveBeenCalledTimes(2)
      app.unmount()
    })
  })

  describe('HI-1 — the panel calls ONLY apiClient.listRecordHistory; no direct-restore path', () => {
    it('interacting with the panel (view + select + click restore) never calls restoreRecordVersion or any other apiClient method, and never calls fetch directly', async () => {
      const originalFetch = (globalThis as any).fetch
      const fetchCalls: unknown[] = []
      ;(globalThis as any).fetch = (...args: unknown[]) => {
        fetchCalls.push(args)
        return Promise.reject(new Error('unexpected raw fetch in MetaRecordHistoryPanel'))
      }
      const onRestore = vi.fn()
      const { container, apiClient, app } = mountPanel({
        revisions: [rev(2, 'update'), rev(1, 'create')],
        onRestore,
      })
      await flushUi()
      // Field-select checkboxes render (proving the selection UI is present) but are left checked —
      // unchecking the sole changed field would disable the restore button, which is a UI-state
      // detail already covered by the restore-selection describe above; this test's only concern is
      // which apiClient methods a restore click reaches.
      expect(container.querySelectorAll('[data-test="history-field-select"]').length).toBeGreaterThan(0)
      const btn = container.querySelector<HTMLButtonElement>('[data-test="record-history-restore"]')
      btn?.click()
      await flushUi()

      // The restore intent was emitted upward (relayed unchanged) — proving the click did something —
      // but the panel itself never executed it.
      expect(onRestore).toHaveBeenCalledTimes(1)
      expect(apiClient.listRecordHistory).toHaveBeenCalled()
      expect(apiClient.restoreRecordVersion).not.toHaveBeenCalled()
      expect(apiClient.getRecordSubscriptionStatus).not.toHaveBeenCalled()
      expect(apiClient.patchRecord).not.toHaveBeenCalled()
      expect(apiClient.deleteRecord).not.toHaveBeenCalled()
      expect(fetchCalls).toHaveLength(0)

      ;(globalThis as any).fetch = originalFetch
      app.unmount()
    })
  })

  describe('OD-W2-5a R11 restored-from badge', () => {
    it('renders the badge for a revision carrying restoredFromVersion (keyed on the version, not source)', async () => {
      const { container, app } = mountPanel({
        revisions: [rev(4, 'update', { source: 'restore', restoredFromVersion: 2 }), rev(1, 'create')],
      })
      await flushUi()
      const badge = container.querySelector('[data-test="record-history-restored-from"]')
      expect(badge).not.toBeNull()
      expect(badge!.textContent).toContain('v2')
      app.unmount()
    })

    it('NEG (owner Medium): source=restore but restoredFromVersion=null → NO badge (badge never keys on source)', async () => {
      const { container, app } = mountPanel({
        // A `source='restore'` write with a NULL back-reference (PIT-resurrect / reset / lossy-retype-revert
        // shape). The badge must key on `restoredFromVersion != null`, NEVER on `source === 'restore'`.
        revisions: [rev(4, 'update', { source: 'restore', restoredFromVersion: null }), rev(1, 'create')],
      })
      await flushUi()
      expect(container.querySelector('[data-test="record-history-restored-from"]')).toBeNull()
      app.unmount()
    })
  })
})
