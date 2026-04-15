import * as Y from 'yjs'
import type { Kysely } from 'kysely'

export class YjsPersistenceAdapter {
  constructor(private db: Kysely<any>) {}

  async loadDoc(recordId: string): Promise<Uint8Array | null> {
    // First try full snapshot
    const snapshot = await this.db
      .selectFrom('meta_record_yjs_states')
      .select('doc_state')
      .where('record_id', '=', recordId)
      .executeTakeFirst()

    if (!snapshot) return null

    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(snapshot.doc_state))

    // Apply any incremental updates on top
    const updates = await this.db
      .selectFrom('meta_record_yjs_updates')
      .select('update_data')
      .where('record_id', '=', recordId)
      .orderBy('id', 'asc')
      .execute()

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
}
