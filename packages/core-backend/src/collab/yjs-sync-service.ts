import * as Y from 'yjs'
import type { YjsPersistenceAdapter } from './yjs-persistence-adapter'

/**
 * Seeds a fresh Y.Doc's `fields` Y.Map from the record's current value in
 * `meta_records.data`. Only invoked when there's no persisted Yjs state
 * yet (no snapshot, no incremental updates).
 *
 * Seeding rule:
 *   - For each field whose current value is a string, create a Y.Text
 *     pre-populated with that string and put it in the fields map under
 *     the fieldId key.
 *   - Non-string values are left out of the fields map. The frontend
 *     `useYjsTextField` only binds to Y.Text entries, so non-string
 *     fields continue to go through the existing REST edit path.
 *
 * Returning null (e.g. record was deleted) leaves the Y.Doc empty;
 * `useYjsTextField` will then decline to activate for that cell and the
 * caller falls back to REST.
 */
export type YjsRecordSeedFn = (
  recordId: string,
) => Promise<Record<string, unknown> | null>

export class YjsSyncService {
  private docs = new Map<string, { doc: Y.Doc; lastAccess: number }>()
  private persistence: YjsPersistenceAdapter
  private cleanupTimer: NodeJS.Timeout
  private recordSeed: YjsRecordSeedFn | null

  constructor(persistence: YjsPersistenceAdapter, recordSeed?: YjsRecordSeedFn) {
    this.persistence = persistence
    this.recordSeed = recordSeed ?? null
    // Cleanup idle docs every 30 seconds
    this.cleanupTimer = setInterval(() => this.cleanupIdleDocs(), 30_000)
    this.cleanupTimer.unref()
  }

  private async persistSnapshot(recordId: string, doc: Y.Doc): Promise<void> {
    if (typeof (this.persistence as YjsPersistenceAdapter & { compactDoc?: (recordId: string, doc: Y.Doc) => Promise<void> }).compactDoc === 'function') {
      await (this.persistence as YjsPersistenceAdapter & { compactDoc: (recordId: string, doc: Y.Doc) => Promise<void> }).compactDoc(recordId, doc)
      return
    }
    await this.persistence.storeSnapshot(recordId, doc)
  }

  private async seedFreshDoc(recordId: string, doc: Y.Doc): Promise<void> {
    if (!this.recordSeed) return
    let data: Record<string, unknown> | null = null
    try {
      data = await this.recordSeed(recordId)
    } catch (err) {
      console.error(`[yjs] recordSeed threw for ${recordId}:`, err)
      return
    }
    if (!data) return

    const fields = doc.getMap('fields')
    // Use 'seed' as the transaction origin so the persistence listener
    // skips this initial seed — otherwise we'd write a bootstrap update
    // to the DB on every fresh doc, bloating meta_record_yjs_updates.
    doc.transact(() => {
      for (const [fieldId, value] of Object.entries(data!)) {
        if (typeof value !== 'string') continue
        // Don't overwrite anything that already exists in fields (defense
        // in depth — persistence.loadDoc returning null SHOULD mean an
        // empty Y.Doc, but if future refactors change that, we'd rather
        // no-op than clobber).
        if (fields.has(fieldId)) continue
        const yText = new Y.Text()
        yText.insert(0, value)
        fields.set(fieldId, yText)
      }
    }, 'seed')
  }

  async getOrCreateDoc(recordId: string): Promise<Y.Doc> {
    const existing = this.docs.get(recordId)
    if (existing) {
      existing.lastAccess = Date.now()
      return existing.doc
    }

    const doc = new Y.Doc()

    // Load persisted state
    const state = await this.persistence.loadDoc(recordId)
    if (state) {
      Y.applyUpdate(doc, state, 'persistence')
    }

    // Wire the persistence listener BEFORE seeding, so if we later decide
    // the seed should also be persisted we can opt in by changing the
    // origin check. Today: origin === 'seed' is excluded, so the seed
    // stays in memory and is materialized into DB only after a real
    // user edit lands on top of it.
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'persistence' || origin === 'seed') return
      this.persistence.storeUpdate(recordId, update).catch((err) =>
        console.error(`Failed to persist yjs update for ${recordId}:`, err),
      )
    })

    // Only seed from meta_records if nothing had been persisted yet.
    // A loaded snapshot/updates pair represents the authoritative Y.Doc
    // state and must not be shadowed by stale `meta_records.data`.
    if (!state) {
      await this.seedFreshDoc(recordId, doc)
    }

    this.docs.set(recordId, { doc, lastAccess: Date.now() })
    return doc
  }

  getDoc(recordId: string): Y.Doc | undefined {
    const entry = this.docs.get(recordId)
    if (entry) entry.lastAccess = Date.now()
    return entry?.doc
  }

  /**
   * Drop cached Y.Docs and persisted state for the given records so the
   * next `getOrCreateDoc` re-seeds from `meta_records.data`.
   *
   * Contract:
   *   - In-memory Y.Docs are destroyed WITHOUT snapshotting. The snapshot
   *     would encode pre-REST state and thus "win" on the next open —
   *     the exact bug this method exists to close.
   *   - Persisted snapshot + update rows are deleted via
   *     `persistence.purgeRecords` when available.
   *   - Best effort on persistence failures: in-memory eviction still
   *     happens, errors surface to the caller who should log and continue
   *     (the REST write has already committed).
   *
   * Callers MUST cancel any in-flight bridge flushes for these records
   * FIRST, otherwise a debounced bridge write will re-materialize the
   * stale Yjs-cached value over the REST write.
   */
  async invalidateDocs(recordIds: string[]): Promise<void> {
    if (recordIds.length === 0) return
    for (const recordId of recordIds) {
      const entry = this.docs.get(recordId)
      if (entry) {
        entry.doc.destroy()
        this.docs.delete(recordId)
      }
    }
    const adapter = this.persistence as YjsPersistenceAdapter & {
      purgeRecords?: (ids: string[]) => Promise<void>
    }
    if (typeof adapter.purgeRecords === 'function') {
      await adapter.purgeRecords(recordIds)
    }
  }

  async releaseDoc(recordId: string): Promise<void> {
    const entry = this.docs.get(recordId)
    if (entry) {
      // Compact into a fresh snapshot before releasing so restart recovery
      // stays bounded and old incremental updates do not accumulate forever.
      try {
        await this.persistSnapshot(recordId, entry.doc)
      } catch (err) {
        console.error(`[yjs] Failed to snapshot doc ${recordId} on release:`, err)
      }
      entry.doc.destroy()
      this.docs.delete(recordId)
    }
  }

  async cleanupIdleDocs(idleThreshold = 60_000): Promise<void> {
    const now = Date.now()
    for (const [recordId, entry] of this.docs) {
      if (now - entry.lastAccess > idleThreshold) {
        try {
          await this.persistSnapshot(recordId, entry.doc)
        } catch (err) {
          console.error(`[yjs] Failed to snapshot idle doc ${recordId}:`, err)
        }
        entry.doc.destroy()
        this.docs.delete(recordId)
      }
    }
  }

  async destroy(): Promise<void> {
    clearInterval(this.cleanupTimer)
    for (const [recordId, entry] of this.docs) {
      try {
        await this.persistSnapshot(recordId, entry.doc)
      } catch (err) {
        console.error(`[yjs] Failed to snapshot doc ${recordId} on destroy:`, err)
      }
      entry.doc.destroy()
    }
    this.docs.clear()
  }

  /** Expose doc count for testing and observability */
  get size(): number {
    return this.docs.size
  }

  /** Metrics snapshot for observability */
  getMetrics(): { activeDocCount: number; docIds: string[] } {
    return {
      activeDocCount: this.docs.size,
      docIds: [...this.docs.keys()],
    }
  }
}
