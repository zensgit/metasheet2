/**
 * YjsRecordBridge — scalar (non-text) field sync.
 *
 * String fields bind to Y.Text (char-level merge). Scalar fields (number/currency/
 * percent/rating/duration/select/multiSelect/date/dateTime/boolean) are atomic, so
 * the correct realtime semantic is last-write-wins via the Y.Map: a plain value set
 * under the field key. This test locks that the bridge collects those plain values
 * and flushes them through the SAME validated patch path as Y.Text — while still
 * handling Y.Text strings and ignoring nested Yjs shared types (Y.Map/Y.Array).
 */
import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'
import { YjsSyncService } from '../../src/collab/yjs-sync-service'
import { YjsRecordBridge } from '../../src/collab/yjs-record-bridge'

function makePersistence() {
  const snapshots = new Map<string, Uint8Array>()
  const updates = new Map<string, Uint8Array[]>()
  return {
    store: { snapshots, updates },
    loadDoc: vi.fn(async (recordId: string): Promise<Uint8Array | null> => {
      const snap = snapshots.get(recordId)
      const ups = updates.get(recordId) ?? []
      if (!snap && ups.length === 0) return null
      const doc = new Y.Doc()
      if (snap) Y.applyUpdate(doc, snap)
      for (const u of ups) Y.applyUpdate(doc, u)
      const out = Y.encodeStateAsUpdate(doc)
      doc.destroy()
      return out
    }),
    storeUpdate: vi.fn(async (recordId: string, update: Uint8Array) => {
      const list = updates.get(recordId) ?? []
      list.push(update)
      updates.set(recordId, list)
    }),
    storeSnapshot: vi.fn(async () => {}),
    compactDoc: vi.fn(async () => {}),
    purgeRecords: vi.fn(async () => {}),
  }
}

function makeBridge() {
  const persistence = makePersistence()
  const svc = new YjsSyncService(persistence as any, async () => ({}))
  const captured: { patch: Record<string, unknown> | null } = { patch: null }
  const recordWriteService = {
    patchRecords: vi.fn().mockResolvedValue({ updated: [{ recordId: 'rec_1', version: 2 }] }),
  }
  const bridge = new YjsRecordBridge(
    svc as any,
    recordWriteService as any,
    async (_recordId: string, patch: Record<string, unknown>) => {
      captured.patch = patch
      return {
        sheetId: 'sh_1',
        changesByRecord: new Map(),
        actorId: 'user_1',
        fields: [],
        visiblePropertyFields: [],
        visiblePropertyFieldIds: new Set(),
        attachmentFields: [],
        fieldById: new Map(),
        capabilities: {} as any,
        access: { userId: 'user_1', permissions: [], isAdminRole: false },
      }
    },
    { mergeWindowMs: 200, maxDelayMs: 500 },
  )
  return { svc, bridge, recordWriteService, captured }
}

describe('YjsRecordBridge — scalar (non-text) field sync', () => {
  it('collects plain scalar Y.Map values (number/select/boolean) and flushes them via the patch path', async () => {
    vi.useFakeTimers()
    const { svc, bridge, recordWriteService, captured } = makeBridge()
    const doc = await svc.getOrCreateDoc('rec_1')
    bridge.observe('rec_1', doc)

    const fields = doc.getMap('fields')
    fields.set('fld_num', 42)
    fields.set('fld_sel', 'optA')
    fields.set('fld_bool', true)

    await Promise.resolve()
    vi.advanceTimersByTime(200)
    await Promise.resolve()
    await Promise.resolve()

    expect(recordWriteService.patchRecords).toHaveBeenCalledTimes(1)
    // LWW: the plain values reach the validated patch path with their native types.
    expect(captured.patch).toMatchObject({ fld_num: 42, fld_sel: 'optA', fld_bool: true })
    vi.useRealTimers()
  })

  it('still collects Y.Text strings (regression) and ignores nested Yjs shared types', async () => {
    vi.useFakeTimers()
    const { svc, bridge, captured } = makeBridge()
    const doc = await svc.getOrCreateDoc('rec_1')
    bridge.observe('rec_1', doc)

    const fields = doc.getMap('fields')
    const title = new Y.Text()
    fields.set('fld_title', title)
    title.insert(0, 'hello')
    fields.set('fld_num', 7) // scalar → collected
    fields.set('fld_nested', new Y.Map()) // a nested shared type → must NOT be collected as a scalar

    await Promise.resolve()
    vi.advanceTimersByTime(200)
    await Promise.resolve()
    await Promise.resolve()

    expect(captured.patch).toMatchObject({ fld_title: 'hello', fld_num: 7 })
    expect(captured.patch).not.toHaveProperty('fld_nested')
    vi.useRealTimers()
  })
})
