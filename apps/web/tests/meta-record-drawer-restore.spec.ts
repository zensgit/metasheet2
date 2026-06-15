/**
 * Slice 3 — MetaRecordDrawer restore affordance (render + emit contract).
 *
 * SCOPE: this is a render/emit component test. It proves the drawer shows a "restore" button for
 * prior, non-delete revisions (never the current version), gates it on canEdit, and emits
 * `restore` with `{ recordId, targetVersion, expectedVersion }`. It does NOT exercise the full
 * browser→workbench-handler→apiClient→backend→DB round trip — that is owned by the workbench
 * handler (onRestoreRecordVersion) + the backend real-DB suite, and needs manual/e2e QA.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaRecordDrawer from '../src/multitable/components/MetaRecordDrawer.vue'
import type { MetaField, MetaRecord, MetaRecordRevision } from '../src/multitable/types'

const FIELDS = [{ id: 'fld_t', name: 'Title', type: 'string', property: {} }] as unknown as MetaField[]
const RECORD = { id: 'rec_1', version: 3, data: { fld_t: 'now' } } as unknown as MetaRecord

function rev(version: number, action: MetaRecordRevision['action']): MetaRecordRevision {
  return {
    id: `r${version}_${action}`, sheetId: 'sheet_1', recordId: 'rec_1', version, action,
    source: 'rest', actorId: null, changedFieldIds: ['fld_t'], createdAt: '2026-06-15T00:00:00Z',
    patch: {}, snapshot: {},
  } as unknown as MetaRecordRevision
}

const flush = async () => { await nextTick(); await Promise.resolve(); await Promise.resolve(); await nextTick() }

function mountDrawer(opts: { canEdit?: boolean; revisions?: MetaRecordRevision[]; onRestore?: (p: unknown) => void } = {}): { container: HTMLElement; app: App } {
  const apiClient = {
    listRecordHistory: vi.fn(async () => opts.revisions ?? [rev(3, 'update'), rev(2, 'update'), rev(1, 'create')]),
    getRecordSubscriptionStatus: vi.fn(async () => ({ subscribed: false, subscription: null })),
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render() {
      return h(MetaRecordDrawer, {
        visible: true,
        record: RECORD,
        fields: FIELDS,
        canEdit: opts.canEdit ?? true,
        canComment: false,
        canDelete: false,
        sheetId: 'sheet_1',
        apiClient: apiClient as never,
        ...(opts.onRestore ? { onRestore: opts.onRestore } : {}),
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

describe('MetaRecordDrawer restore affordance (Slice 3)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('shows a restore button for each prior non-current version, not for the current version', async () => {
    const { container, app } = mountDrawer()
    await openHistory(container)
    const buttons = container.querySelectorAll('[data-test="record-history-restore"]')
    expect(buttons.length).toBe(2) // v2 and v1 — NOT v3 (current = record.version)
    app.unmount()
  })

  it('emits "restore" with { recordId, targetVersion, expectedVersion } on click', async () => {
    const onRestore = vi.fn()
    const { container, app } = mountDrawer({ onRestore })
    await openHistory(container)
    const buttons = container.querySelectorAll<HTMLButtonElement>('[data-test="record-history-restore"]')
    buttons[0].click() // the most-recent prior version (v2)
    await nextTick()
    expect(onRestore).toHaveBeenCalledWith({ recordId: 'rec_1', targetVersion: 2, expectedVersion: 3 })
    app.unmount()
  })

  it('does not show a restore button for a delete revision', async () => {
    const { container, app } = mountDrawer({ revisions: [rev(3, 'update'), rev(2, 'delete')] })
    await openHistory(container)
    // only the non-current, non-delete set is restorable → here that set is empty (v3 current, v2 delete)
    expect(container.querySelectorAll('[data-test="record-history-restore"]').length).toBe(0)
    app.unmount()
  })

  it('hides restore buttons entirely when the user cannot edit', async () => {
    const { container, app } = mountDrawer({ canEdit: false })
    await openHistory(container)
    expect(container.querySelectorAll('[data-test="record-history-restore"]').length).toBe(0)
    app.unmount()
  })
})
