import * as Y from 'yjs'
import type { Kysely } from 'kysely'

export class YjsPersistenceAdapter {
  constructor(private db: Kysely<any>) {}

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

  async storeUpdate(recordId: string, update: Uint8Array): Promise<void> {
    await this.db
      .insertInto('meta_record_yjs_updates')
      .values({
        record_id: recordId,
        update_data: Buffer.from(update),
      })
      .execute()
  }

  async storeSnapshot(recordId: string, doc: Y.Doc): Promise<void> {
    const state = Y.encodeStateAsUpdate(doc)
    const stateVector = Y.encodeStateVector(doc)

    await this.db
      .insertInto('meta_record_yjs_states')
      .values({
        record_id: recordId,
        doc_state: Buffer.from(state),
        state_vector: Buffer.from(stateVector),
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc.column('record_id').doUpdateSet({
          doc_state: Buffer.from(state),
          state_vector: Buffer.from(stateVector),
          updated_at: new Date(),
        }),
      )
      .execute()
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
    const state = Y.encodeStateAsUpdate(doc)
    const stateVector = Y.encodeStateVector(doc)
    const updatedAt = new Date()

    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('meta_record_yjs_states')
        .values({
          record_id: recordId,
          doc_state: Buffer.from(state),
          state_vector: Buffer.from(stateVector),
          updated_at: updatedAt,
        })
        .onConflict((oc) =>
          oc.column('record_id').doUpdateSet({
            doc_state: Buffer.from(state),
            state_vector: Buffer.from(stateVector),
            updated_at: updatedAt,
          }),
        )
        .execute()

      await trx
        .deleteFrom('meta_record_yjs_updates')
        .where('record_id', '=', recordId)
        .execute()
    })
  }
}
