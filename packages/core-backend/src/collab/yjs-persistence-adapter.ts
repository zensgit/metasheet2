import * as Y from 'yjs'
import { sql, type Kysely } from 'kysely'
import type { Database } from '../db/types'
import { getYjsRecordOwner, YjsRecordRetiredError, type YjsRecordIncarnation } from './yjs-record-incarnation'

export class YjsPersistenceAdapter {
  constructor(private db: Kysely<Database>) {}

  async getRecordIncarnation(recordId: string): Promise<YjsRecordIncarnation | null> {
    const row = await this.db.selectFrom('meta_records')
      .select('yjs_incarnation')
      .where('id', '=', recordId)
      .executeTakeFirst()
    return row ? { recordId, incarnation: row.yjs_incarnation } : null
  }

  private async lockOwner(tx: Kysely<Database>, recordId: string, owner: YjsRecordIncarnation): Promise<void> {
    if (recordId !== owner.recordId) throw new YjsRecordRetiredError()
    const row = await tx.selectFrom('meta_records')
      .select('id')
      .where('id', '=', owner.recordId)
      .where(sql<boolean>`yjs_incarnation IS NOT DISTINCT FROM ${owner.incarnation}::uuid`)
      .forKeyShare()
      .executeTakeFirst()
    if (!row) throw new YjsRecordRetiredError()
  }

  async loadDoc(recordId: string): Promise<Uint8Array | null> {
    // Load snapshot if available
    const snapshot = await this.db
      .selectFrom('meta_record_yjs_states')
      .select('doc_state')
      .where('record_id', '=', recordId)
      .executeTakeFirst()

    // Load incremental updates (may exist even without snapshot — crash recovery)
    const updates = await this.db
      .selectFrom('meta_record_yjs_updates')
      .select('update_data')
      .where('record_id', '=', recordId)
      .orderBy('id', 'asc')
      .execute()

    // Nothing persisted at all
    if (!snapshot && updates.length === 0) return null

    const doc = new Y.Doc()

    // Apply snapshot first if available
    if (snapshot) {
      Y.applyUpdate(doc, new Uint8Array(snapshot.doc_state))
    }

    // Apply incremental updates on top (covers crash recovery when no snapshot exists)
    for (const row of updates) {
      Y.applyUpdate(doc, new Uint8Array(row.update_data))
    }

    const result = Y.encodeStateAsUpdate(doc)
    doc.destroy()
    return result
  }

  async storeUpdate(recordId: string, update: Uint8Array, owner?: YjsRecordIncarnation): Promise<void> {
    const row = { record_id: recordId, update_data: Buffer.from(update) }
    if (!owner) {
      await this.db.insertInto('meta_record_yjs_updates').values(row).execute()
      return
    }
    await this.db.transaction().execute(async (tx) => {
      await this.lockOwner(tx, recordId, owner)
      await tx.insertInto('meta_record_yjs_updates').values(row).execute()
    })
  }

  async storeSnapshot(recordId: string, doc: Y.Doc): Promise<void> {
    const owner = getYjsRecordOwner(doc)
    if (!owner) {
      await this.writeSnapshot(this.db, recordId, doc)
      return
    }
    await this.db.transaction().execute(async (tx) => {
      await this.lockOwner(tx, recordId, owner)
      await this.writeSnapshot(tx, recordId, doc)
    })
  }

  private async writeSnapshot(db: Kysely<Database>, recordId: string, doc: Y.Doc): Promise<void> {
    const values = {
      doc_state: Buffer.from(Y.encodeStateAsUpdate(doc)),
      state_vector: Buffer.from(Y.encodeStateVector(doc)),
      updated_at: new Date(),
    }
    await db.insertInto('meta_record_yjs_states').values({ record_id: recordId, ...values })
      .onConflict((oc) => oc.column('record_id').doUpdateSet(values)).execute()
  }

  /**
   * Find records with accumulated updates exceeding threshold.
   * Used by cleanup job to decide which records need compaction.
   */
  async getRecordsNeedingCompaction(threshold: number = 500): Promise<string[]> {
    const result = await this.db
      .selectFrom('meta_record_yjs_updates')
      .select('record_id')
      .groupBy('record_id')
      .having(this.db.fn.count('id'), '>', threshold)
      .execute()
    return result.map((row) => row.record_id)
  }

  /**
   * Remove Yjs state for records that no longer exist in meta_records.
   * Returns count of orphan records cleaned.
   */
  async cleanupOrphanStates(): Promise<number> {
    const orphanStates = await this.db
      .deleteFrom('meta_record_yjs_states')
      .where('record_id', 'not in',
        this.db.selectFrom('meta_records').select('id'),
      )
      .executeTakeFirst()

    const orphanUpdates = await this.db
      .deleteFrom('meta_record_yjs_updates')
      .where('record_id', 'not in',
        this.db.selectFrom('meta_records').select('id'),
      )
      .executeTakeFirst()

    return Number(orphanStates?.numDeletedRows ?? 0) + Number(orphanUpdates?.numDeletedRows ?? 0)
  }

  /**
   * Wipe all persisted Yjs state for the given records in one round trip.
   *
   * Used by the REST → Yjs invalidation hook: when a REST write changes
   * `meta_records.data`, any snapshot/updates we have for those records
   * are stale. Next `YjsSyncService.getOrCreateDoc` will then re-seed
   * from `meta_records.data`.
   *
   * No-op for record IDs that have no rows. Best-effort — callers do
   * not fail their REST write on purge failure (see `index.ts`).
   */
  async purgeRecords(recordIds: string[]): Promise<void> {
    if (recordIds.length === 0) return
    await this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('meta_record_yjs_states')
        .where('record_id', 'in', recordIds)
        .execute()
      await trx
        .deleteFrom('meta_record_yjs_updates')
        .where('record_id', 'in', recordIds)
        .execute()
    })
  }

  async compactDoc(recordId: string, doc: Y.Doc): Promise<void> {
    const owner = getYjsRecordOwner(doc)
    await this.db.transaction().execute(async (trx) => {
      // A stale compact must also leave the replacement document's incremental rows alone.
      if (owner) await this.lockOwner(trx, recordId, owner)
      await this.writeSnapshot(trx, recordId, doc)
      await trx
        .deleteFrom('meta_record_yjs_updates')
        .where('record_id', '=', recordId)
        .execute()
    })
  }
}
