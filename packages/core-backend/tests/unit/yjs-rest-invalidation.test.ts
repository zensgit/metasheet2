/**
 * REST → Yjs consistency tests.
 *
 * Reviewer finding (2026-04-21): the P0 seed fix in `YjsSyncService`
 * seeds from `meta_records.data` only on fresh-doc create (when the
 * persistence adapter returns no state). That left a hole: once a
 * Y.Doc snapshot exists for a record, a later REST write to
 * `meta_records.data` is invisible to the next Yjs opener — the
 * snapshot wins.
 *
 * The fix: after every REST write that touches `meta_records.data`,
 * call `YjsSyncService.invalidateDocs` (composed with
 * `YjsRecordBridge.cancelPending` in `index.ts`) so any persisted
 * Y.Doc state for those records is wiped. Next `getOrCreateDoc`
 * re-seeds from the just-updated DB row.
 */
import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'
import { YjsSyncService } from '../../src/collab/yjs-sync-service'
import { YjsRecordBridge } from '../../src/collab/yjs-record-bridge'

/**
 * In-memory persistence stub that mirrors the real adapter's contract
 * but backs everything with JS maps. Supports the full lifecycle:
 * storeSnapshot / storeUpdate / loadDoc / purgeRecords.
 */
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
    storeSnapshot: vi.fn(async (recordId: string, doc: Y.Doc) => {
      snapshots.set(recordId, Y.encodeStateAsUpdate(doc))
      // Real adapter's compactDoc also clears updates; emulate that
      // so snapshot+updates don't double-apply on next load.
      updates.set(recordId, [])
    }),
    compactDoc: vi.fn(async (recordId: string, doc: Y.Doc) => {
      snapshots.set(recordId, Y.encodeStateAsUpdate(doc))
      updates.set(recordId, [])
    }),
    purgeRecords: vi.fn(async (recordIds: string[]) => {
      for (const id of recordIds) {
        snapshots.delete(id)
        updates.delete(id)
      }
    }),
  }
}

describe('REST → Yjs invalidation', () => {
  it('after Yjs snapshot exists, REST update + invalidate → next open reads the REST value (not the stale snapshot)', async () => {
    const persistence = makePersistence()

    // Mutable row used by the seeder so we can simulate a REST write
    // flipping meta_records.data between opens.
    let row: { fld_title: string } = { fld_title: 'v1' }
    const recordSeed = vi.fn(async () => row)

    const svc = new YjsSyncService(persistence as any, recordSeed)

    // --- Phase 1: first open seeds from meta_records.data = 'v1' -----------
    const doc1 = await svc.getOrCreateDoc('rec_1')
    const text1 = doc1.getMap('fields').get('fld_title') as Y.Text
    expect(text1.toString()).toBe('v1')

    // --- Phase 2: a user edits via Yjs → 'v2' ------------------------------
    text1.delete(0, text1.length)
    text1.insert(0, 'v2')

    // Release the doc (idle cleanup path): writes the snapshot.
    await svc.releaseDoc('rec_1')
    // Snapshot now contains 'v2'; seeder will NOT be consulted on the
    // next open because the persistence adapter returns non-null state.

    // --- Phase 3: REST write updates the DB to 'v3' and invalidates --------
    row = { fld_title: 'v3' }
    await svc.invalidateDocs(['rec_1'])
    expect(persistence.purgeRecords).toHaveBeenCalledWith(['rec_1'])

    // --- Phase 4: next Yjs open must read 'v3', not 'v2' -------------------
    const doc2 = await svc.getOrCreateDoc('rec_1')
    const text2 = doc2.getMap('fields').get('fld_title') as Y.Text
    expect(text2).toBeInstanceOf(Y.Text)
    expect(text2.toString()).toBe('v3')
    expect(text2.toString()).not.toBe('v2')

    await svc.destroy()
  })

  it('invalidateDocs destroys the in-memory Y.Doc without snapshotting it (prevents stale re-materialize)', async () => {
    const persistence = makePersistence()
    let row: { fld_title: string } = { fld_title: 'v1' }
    const svc = new YjsSyncService(persistence as any, async () => row)

    const doc = await svc.getOrCreateDoc('rec_1')
    const text = doc.getMap('fields').get('fld_title') as Y.Text
    text.delete(0, text.length)
    text.insert(0, 'v2-in-memory-only')

    // Before any releaseDoc — snapshot NOT written yet. invalidateDocs
    // must NOT snapshot now (that would persist stale 'v2' after the
    // REST write).
    const snapshotCallsBefore = persistence.storeSnapshot.mock.calls.length
    const compactCallsBefore = persistence.compactDoc.mock.calls.length
    row = { fld_title: 'v3' }
    await svc.invalidateDocs(['rec_1'])
    expect(persistence.storeSnapshot.mock.calls.length).toBe(snapshotCallsBefore)
    expect(persistence.compactDoc.mock.calls.length).toBe(compactCallsBefore)

    // Next open reads 'v3' via fresh seed.
    const doc2 = await svc.getOrCreateDoc('rec_1')
    expect((doc2.getMap('fields').get('fld_title') as Y.Text).toString()).toBe('v3')

    await svc.destroy()
  })

  it('invalidateDocs tolerates records with no persisted state and no in-memory doc (no-op)', async () => {
    const persistence = makePersistence()
    const svc = new YjsSyncService(persistence as any, async () => null)

    await svc.invalidateDocs(['rec_never_opened'])
    // Delete on a non-existent row is a safe no-op.
    expect(persistence.purgeRecords).toHaveBeenCalledWith(['rec_never_opened'])

    await svc.destroy()
  })

  it('invalidateDocs with empty recordIds array does nothing', async () => {
    const persistence = makePersistence()
    const svc = new YjsSyncService(persistence as any, async () => null)

    await svc.invalidateDocs([])
    expect(persistence.purgeRecords).not.toHaveBeenCalled()

    await svc.destroy()
  })

  it('works on a service without a recordSeed — in-memory eviction still happens, next open is empty', async () => {
    const persistence = makePersistence()
    const svc = new YjsSyncService(persistence as any) // no seeder

    // Seed manually so loadDoc returns state on next open without seeder.
    const primer = new Y.Doc()
    const t = new Y.Text()
    t.insert(0, 'v1')
    primer.getMap('fields').set('fld_title', t)
    persistence.store.snapshots.set('rec_1', Y.encodeStateAsUpdate(primer))
    primer.destroy()

    // First open — loads 'v1' from snapshot.
    const doc1 = await svc.getOrCreateDoc('rec_1')
    expect((doc1.getMap('fields').get('fld_title') as Y.Text).toString()).toBe('v1')

    // Invalidate — wipes snapshot.
    await svc.invalidateDocs(['rec_1'])

    // Next open — no snapshot, no seeder → empty Y.Doc.
    const doc2 = await svc.getOrCreateDoc('rec_1')
    expect(doc2.getMap('fields').size).toBe(0)

    await svc.destroy()
  })
})

describe('YjsRecordBridge.cancelPending', () => {
  /**
   * Simulates the full race described in the reviewer finding:
   *   t=0:  Y.Text edit → bridge schedules flush at t=200
   *   t=50: REST write commits, invalidate runs → cancels bridge, purges state
   *   t=200: bridge timer would have fired → MUST be cancelled
   */
  it('cancelPending clears a scheduled flush so a debounce timer does not fire post-invalidate', async () => {
    vi.useFakeTimers()

    const persistence = makePersistence()
    const svc = new YjsSyncService(persistence as any, async () => ({ fld_title: 'seed' }))
    const recordWriteService = {
      patchRecords: vi.fn().mockResolvedValue({ updated: [{ recordId: 'rec_1', version: 2 }] }),
    }

    const bridge = new YjsRecordBridge(
      svc as any,
      recordWriteService as any,
      async () => ({
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
      }),
      { mergeWindowMs: 200, maxDelayMs: 500 },
    )

    const doc = await svc.getOrCreateDoc('rec_1')
    bridge.observe('rec_1', doc)

    // t=0: Y.Text edit — schedules a flush at t=200.
    const text = doc.getMap('fields').get('fld_title') as Y.Text
    text.insert(text.length, ' edited')

    // Pump microtasks so the observer runs and scheduleFlush takes effect.
    await Promise.resolve()
    expect(bridge.getMetrics().pendingWriteCount).toBe(1)

    // t=50: REST write commits → invalidator cancels pending + purges state.
    bridge.cancelPending(['rec_1'])
    await svc.invalidateDocs(['rec_1'])
    expect(bridge.getMetrics().pendingWriteCount).toBe(0)

    // Advance well past the original merge window.
    vi.advanceTimersByTime(500)
    await Promise.resolve()

    // The bridge MUST NOT have flushed after cancellation — if it did,
    // it would have written the stale Yjs-cached value on top of the
    // REST write.
    expect(recordWriteService.patchRecords).not.toHaveBeenCalled()

    bridge.destroy()
    await svc.destroy()
    vi.useRealTimers()
  })

  it('route-level setter accepts and replaces the invalidator', async () => {
    // The direct-SQL PATCH /records/:recordId handler in univer-meta.ts
    // reads a module-level `yjsInvalidator` variable that is wired up by
    // index.ts on boot via `setYjsInvalidatorForRoutes(...)`. The full
    // HTTP-level path is out of scope for a unit test (heavy auth +
    // permission + sheet fixtures), but locking in the setter's
    // existence + shape guards against a future refactor that drops the
    // wiring point.
    const routesModule = await import('../../src/routes/univer-meta')
    expect(typeof routesModule.setYjsInvalidatorForRoutes).toBe('function')

    const first = vi.fn()
    routesModule.setYjsInvalidatorForRoutes(first)
    // Replace with null — safe no-op for Yjs-off deployments.
    routesModule.setYjsInvalidatorForRoutes(null)
    // (Nothing to assert on the stored var directly — it's file-private.
    // The manual staging verification plan step #7 in the verification MD
    // exercises the end-to-end path with a real HTTP PATCH.)
    expect(() => routesModule.setYjsInvalidatorForRoutes(null)).not.toThrow()
  })

  it('cancelPending on records with no pending flush is a no-op', () => {
    const persistence = makePersistence()
    const svc = new YjsSyncService(persistence as any)
    const bridge = new YjsRecordBridge(
      svc as any,
      { patchRecords: vi.fn() } as any,
      async () => null,
    )

    expect(() => bridge.cancelPending(['rec_never_touched'])).not.toThrow()
    expect(bridge.getMetrics().pendingWriteCount).toBe(0)

    bridge.destroy()
  })
})
