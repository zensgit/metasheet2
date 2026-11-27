import * as Y from 'yjs'
import { expect, vi } from 'vitest'
import { db } from '../../src/db/db'
import { poolManager } from '../../src/integration/db/connection-pool'
import { YjsPersistenceAdapter } from '../../src/collab/yjs-persistence-adapter'
import { getYjsRecordOwner, YjsRecordRetiredError } from '../../src/collab/yjs-record-incarnation'
import { YjsSyncService } from '../../src/collab/yjs-sync-service'

type Scope = { tenantId: string; projectNo: string; actor: string }
type Preview = { challengeId: string; verificationCode: string }
type Service = {
  preview(scope: Scope): Promise<Preview>
  confirm(input: Scope & Preview): Promise<unknown>
}

export async function checkProjectDeleteYjs(
  scope: Scope, service: Service, targetId: string, controlId: string, controlSheetId: string,
  recreate: () => Promise<{ sheetId: string }>,
  recycleAndRestore: (recordId: string) => Promise<void>,
) {
  const query = poolManager.get().query.bind(poolManager.get())
  const persistence = new YjsPersistenceAdapter(db)
  // Independent caches simulate a browser's worker holding a document across a deletion from another worker.
  const first = new YjsSyncService(persistence)
  const second = new YjsSyncService(persistence)
  const retrying = new YjsSyncService(persistence)
  const retired = vi.fn()
  first.setRetiredListener(retired)
  const seed = new Y.Doc()
  const control = new Y.Doc()
  const fresh = new Y.Doc()
  const counts = async (id: string) => (await query(
    `SELECT (SELECT count(*)::int FROM meta_record_yjs_states WHERE record_id=$1) AS states,
            (SELECT count(*)::int FROM meta_record_yjs_updates WHERE record_id=$1) AS updates`, [id],
  )).rows[0]
  try {
    seed.getText('field').insert(0, 'old project')
    control.getText('field').insert(0, 'other project')
    for (const [id, doc] of [[targetId, seed], [controlId, control]] as const) {
      await persistence.storeSnapshot(id, doc)
      await persistence.storeUpdate(id, Y.encodeStateAsUpdate(doc))
    }
    const old = await first.getOrCreateDoc(targetId)
    const otherOld = await second.getOrCreateDoc(targetId)
    expect(old.getText('field').toString()).toBe('old project')
    await retrying.getOrCreateDoc(targetId)
    const failOnce = vi.spyOn(persistence, 'purgeRecords').mockRejectedValueOnce(new Error('synthetic transient persistence failure'))
    try {
      await expect(retrying.invalidateDocs([targetId])).rejects.toThrow('synthetic transient persistence failure')
    } finally {
      failOnce.mockRestore()
    }
    const plan = await service.preview(scope)
    await service.confirm({ ...scope, ...plan })
    expect(await counts(targetId)).toEqual({ states: 0, updates: 0 })
    expect(await counts(controlId)).toEqual({ states: 1, updates: 1 })
    await first.releaseDoc(targetId)
    expect(retired).toHaveBeenCalledWith(targetId)
    expect(await counts(targetId)).toEqual({ states: 0, updates: 0 })

    const { sheetId } = await recreate()
    expect(sheetId).not.toBe(controlSheetId)
    await query('INSERT INTO meta_records (id, sheet_id, data) VALUES ($1,$2,$3)', [targetId, sheetId, {}])
    fresh.getText('field').insert(0, 'replacement')
    await persistence.storeSnapshot(targetId, fresh)
    await persistence.storeUpdate(targetId, Y.encodeStateAsUpdate(fresh))
    await expect(persistence.storeUpdate(targetId, Y.encodeStateAsUpdate(otherOld), getYjsRecordOwner(otherOld)))
      .rejects.toBeInstanceOf(YjsRecordRetiredError)
    // Compaction of the old document must neither replace the new snapshot nor delete its update.
    await second.releaseDoc(targetId)
    expect(await counts(targetId)).toEqual({ states: 1, updates: 1 })
    // The business row is still empty. Reconnecting the quarantined replica must preserve
    // the new generation's persisted edit, including its incremental update.
    const [retryA, retryB] = await Promise.all([retrying.getOrCreateDoc(targetId), retrying.getOrCreateDoc(targetId)])
    expect(retryA).toBe(retryB)
    expect(retryA.getText('field').toString()).toBe('replacement')
    expect(await counts(targetId)).toEqual({ states: 1, updates: 1 })
    const reopened = await first.getOrCreateDoc(targetId)
    expect(reopened).not.toBe(otherOld)
    expect(reopened.getText('field').toString()).toBe('replacement')
    const retained = await second.getOrCreateDoc(controlId)
    expect(retained.getText('field').toString()).toBe('other project')
    await recycleAndRestore(controlId)
    const restored = await second.getOrCreateDoc(controlId)
    expect(restored).not.toBe(retained)
    expect(getYjsRecordOwner(restored)).not.toEqual(getYjsRecordOwner(retained))
    expect(restored.getText('field').toString()).toBe('other project')
    expect(await counts(controlId)).toEqual({ states: 1, updates: 1 })
  } finally {
    await first.destroy()
    await second.destroy()
    await retrying.destroy()
    for (const doc of [seed, control, fresh]) doc.destroy()
  }
}
