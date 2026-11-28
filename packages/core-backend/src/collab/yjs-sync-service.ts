import * as Y from 'yjs'
import type { YjsPersistenceAdapter } from './yjs-persistence-adapter'
import { bindYjsRecord, getYjsRecordOwner, YjsRecordRetiredError, type YjsRecordIncarnation } from './yjs-record-incarnation'

/**
 * Seeds a fresh Y.Doc's `fields` Y.Map from the record's current value in
 * `meta_records.data`. Only invoked when there's no persisted Yjs state
 * yet (no snapshot, no incremental updates).
 *
 * Seeding rule (see the loop below for the authoritative logic):
 *   - String values (free-text AND string-stored atomics like select/date) → a
 *     Y.Text pre-populated with the string, under the fieldId key (char-level merge).
 *   - Non-string ATOMIC values (number/currency/percent/rating/duration/boolean,
 *     multiSelect arrays) → a PLAIN value under the fieldId key, synced LWW per key
 *     via the Y.Map. The bridge persists these through the validated patchRecords
 *     path, so the stored shape is unchanged.
 *   - null/undefined → left absent (a delete; nothing to seed).
 *
 * Frontend binding: `useYjsTextField`/`useYjsCellBinding` bind Y.Text string cells;
 * `useYjsScalarCell` binds the FULL scalar set the grid has wired (since #2832/#2838/#2849):
 * number/currency/percent/boolean/rating/multiSelect/select/date/duration/dateTime. A cell with
 * no active binding (a genuine free-text field, or any field once the doc is empty) falls
 * back to the existing REST edit path.
 */
export type YjsRecordSeedFn = (
  recordId: string,
) => Promise<Record<string, unknown> | null>

/**
 * A record document that cannot be served: its earlier generation was invalidated and its persisted
 * state could not be removed, or it kept being invalidated while it was loading.
 */
export class YjsDocUnavailableError extends Error {
  constructor(message = 'Record document is not available') {
    super(message)
    this.name = 'YjsDocUnavailableError'
  }
}

interface PendingPurge {
  recordId: string
  owner: Promise<YjsRecordIncarnation | undefined>
  running?: Promise<void>
}

export class YjsSyncService {
  private docs = new Map<string, { doc: Y.Doc; lastAccess: number }>()
  /**
   * Generation of each record document. Invalidation starts a new generation: a document that was
   * still loading in the old one is discarded instead of being published, and persistence writes of
   * the old one are settled before its persisted state is removed.
   */
  private generations = new Map<string, number>()
  private pendingPersistence = new Map<string, Set<Promise<void>>>()
  /** Records whose invalidated state could not be removed: not served until a removal succeeds. */
  private quarantined = new Map<string, PendingPurge>()
  private persistence: YjsPersistenceAdapter
  private retiredListener?: (recordId: string) => void
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
        // Don't overwrite anything that already exists in fields (defense
        // in depth — persistence.loadDoc returning null SHOULD mean an
        // empty Y.Doc, but if future refactors change that, we'd rather
        // no-op than clobber).
        if (fields.has(fieldId)) continue
        if (typeof value === 'string') {
          // Free-text / atomic-string: Y.Text gives char-level collaborative merge.
          const yText = new Y.Text()
          yText.insert(0, value)
          fields.set(fieldId, yText)
        } else if (value !== null && value !== undefined) {
          // Non-string ATOMIC fields (number/currency/percent/rating/duration/boolean,
          // multiSelect arrays, etc.): seed as a PLAIN value so they sync LWW per key
          // via the Y.Map (char-merge is meaningless for atomic values). The bridge
          // persists whatever's here through the validated patchRecords path, so the
          // stored shape is unchanged. (string-stored atomics like select/date stay
          // Y.Text for now — flipping their representation is a separate, gated decision.)
          fields.set(fieldId, value as never)
        }
        // null/undefined: leave absent (a delete; nothing to seed).
      }
    }, 'seed')
  }

  private generationOf(recordId: string): number {
    return this.generations.get(recordId) ?? 0
  }

  private startPurge(targets: PendingPurge[], settling: Promise<void>[] = []): Promise<void> {
    const work = (async () => {
      // Resolve owner promises immediately so a failed cold lookup is also observed.
      const owners = await Promise.all(targets.map(target => target.owner))
      await Promise.allSettled(settling)
      const ids = targets.map(target => target.recordId)
      if (typeof this.persistence.getRecordIncarnations === 'function') {
        await this.persistence.purgeRecords(ids, owners.filter((owner): owner is YjsRecordIncarnation => owner != null))
      } else {
        // Persistence implementations without record generations retain the one-argument contract.
        await this.persistence.purgeRecords(ids)
      }
      for (const target of targets) {
        if (this.quarantined.get(target.recordId) === target) this.quarantined.delete(target.recordId)
      }
    })().finally(() => {
      for (const target of targets) target.running = undefined
    })
    for (const target of targets) target.running = work
    return work
  }

  private trackPersistence(recordId: string, work: Promise<void>): void {
    const pending = this.pendingPersistence.get(recordId) ?? new Set<Promise<void>>()
    pending.add(work)
    this.pendingPersistence.set(recordId, pending)
    void work.then(undefined, () => undefined).then(() => {
      pending.delete(work)
      if (pending.size === 0 && this.pendingPersistence.get(recordId) === pending) this.pendingPersistence.delete(recordId)
    })
  }

  setRetiredListener(listener: (recordId: string) => void): void {
    this.retiredListener = listener
  }

  /** A remote deletion can retire a cached document without a notification reaching this worker. */
  async isCurrentDocument(recordId: string, doc: Y.Doc): Promise<boolean> {
    const owner = getYjsRecordOwner(doc)
    if (owner) {
      const live = await this.persistence.getRecordIncarnation(recordId)
      if (!live || live.incarnation !== owner.incarnation) {
        this.retireDocument(recordId, doc)
        return false
      }
    }
    return this.docs.get(recordId)?.doc === doc
  }

  private retireDocument(recordId: string, doc: Y.Doc): void {
    if (this.docs.get(recordId)?.doc !== doc) return
    this.generations.set(recordId, this.generationOf(recordId) + 1)
    this.docs.delete(recordId)
    doc.destroy()
    // The database cleanup already committed. Purging by record id here could erase a new doc.
    this.retiredListener?.(recordId)
  }

  async getOrCreateDoc(recordId: string): Promise<Y.Doc> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = this.docs.get(recordId)
      if (existing && await this.isCurrentDocument(recordId, existing.doc)) {
        existing.lastAccess = Date.now()
        return existing.doc
      }
      const pending = this.quarantined.get(recordId)
      if (pending) {
        try {
          await (pending.running ?? this.startPurge([pending]))
        } catch {
          throw new YjsDocUnavailableError()
        }
        if (this.quarantined.has(recordId)) continue
      }
      const generation = this.generationOf(recordId)
      const doc = await this.loadDocForGeneration(recordId, generation)
      if (doc) return doc
    }
    throw new YjsDocUnavailableError()
  }

  /** Null when the record was invalidated while this document was loading: it is not published. */
  private async loadDocForGeneration(recordId: string, generation: number): Promise<Y.Doc | null> {
    const getOwner = this.persistence.getRecordIncarnation?.bind(this.persistence)
    const owner = await getOwner?.(recordId)
    if (owner === null) throw new YjsDocUnavailableError()
    const doc = new Y.Doc()
    if (owner) bindYjsRecord(doc, owner)

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
      // A document of an invalidated generation persists nothing more.
      if (this.generationOf(recordId) !== generation) return
      const write = owner ? this.persistence.storeUpdate(recordId, update, owner) : this.persistence.storeUpdate(recordId, update)
      this.trackPersistence(recordId, write.catch((err) => {
        if (err instanceof YjsRecordRetiredError) this.retireDocument(recordId, doc)
        else console.error('Failed to persist collaborative update', err)
      }))
    })

    // Only seed from meta_records if nothing had been persisted yet.
    // A loaded snapshot/updates pair represents the authoritative Y.Doc
    // state and must not be shadowed by stale `meta_records.data`.
    if (!state) {
      await this.seedFreshDoc(recordId, doc)
    }

    // The snapshot and seed are independent reads. Never publish them if their owner disappeared
    // between these reads. An unbound persistence double has no database identity to verify.
    const latest = owner && await this.persistence.getRecordIncarnation(recordId)
    if ((owner && (!latest || latest.incarnation !== owner.incarnation)) ||
        this.generationOf(recordId) !== generation || this.quarantined.has(recordId)) {
      doc.destroy()
      return null
    }
    const raced = this.docs.get(recordId)
    if (raced) {
      // Another loader of the same generation published first; this copy is dropped.
      doc.destroy()
      raced.lastAccess = Date.now()
      return raced.doc
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
    const ids = [...new Set(recordIds)]
    const cached = new Map<string, YjsRecordIncarnation>()
    const settling: Promise<void>[] = []
    for (const recordId of ids) {
      this.generations.set(recordId, this.generationOf(recordId) + 1)
      const entry = this.docs.get(recordId)
      if (entry) {
        const owner = getYjsRecordOwner(entry.doc)
        if (owner) cached.set(recordId, owner)
        entry.doc.destroy()
        this.docs.delete(recordId)
      }
      const previous = this.quarantined.get(recordId)?.running
      if (previous) settling.push(previous)
      for (const work of this.pendingPersistence.get(recordId) ?? []) settling.push(work)
    }
    if (typeof this.persistence.purgeRecords !== 'function') {
      await Promise.allSettled(settling)
      return
    }
    const cold = ids.filter(id => !cached.has(id))
    const lookup = cold.length && typeof this.persistence.getRecordIncarnations === 'function'
      ? this.persistence.getRecordIncarnations(cold).then(rows => new Map(rows.map(row => [row.recordId, row])))
      : Promise.resolve(new Map<string, YjsRecordIncarnation>())
    const targets = ids.map(recordId => {
      const known = cached.get(recordId)
      const target: PendingPurge = { recordId, owner: known ? Promise.resolve(known) : lookup.then(rows => rows.get(recordId)) }
      this.quarantined.set(recordId, target)
      return target
    })
    await this.startPurge(targets, settling)
  }

  async releaseDoc(recordId: string): Promise<void> {
    const entry = this.docs.get(recordId)
    if (entry) {
      // Compact into a fresh snapshot before releasing so restart recovery
      // stays bounded and old incremental updates do not accumulate forever.
      try {
        await this.persistSnapshot(recordId, entry.doc)
      } catch (err) {
        if (err instanceof YjsRecordRetiredError) this.retireDocument(recordId, entry.doc)
        else console.error('[yjs] Failed to snapshot document on release', err)
      }
      if (this.docs.get(recordId) === entry) {
        entry.doc.destroy()
        this.docs.delete(recordId)
      }
    }
  }

  async cleanupIdleDocs(idleThreshold = 60_000): Promise<void> {
    const now = Date.now()
    for (const [recordId, entry] of this.docs) {
      if (now - entry.lastAccess > idleThreshold) {
        try {
          await this.persistSnapshot(recordId, entry.doc)
        } catch (err) {
          if (err instanceof YjsRecordRetiredError) this.retireDocument(recordId, entry.doc)
          else console.error('[yjs] Failed to snapshot idle document', err)
        }
        if (this.docs.get(recordId) === entry) {
          entry.doc.destroy()
          this.docs.delete(recordId)
        }
      }
    }
  }

  async destroy(): Promise<void> {
    clearInterval(this.cleanupTimer)
    for (const [recordId, entry] of this.docs) {
      try {
        await this.persistSnapshot(recordId, entry.doc)
      } catch (err) {
        if (!(err instanceof YjsRecordRetiredError)) console.error('[yjs] Failed to snapshot document on shutdown', err)
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
