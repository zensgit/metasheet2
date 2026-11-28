import { getYjsRecordOwner, lockYjsRecordSql, YjsRecordRetiredError, type YjsRecordIncarnation } from './yjs-record-incarnation'
/**
 * Yjs → RecordWriteService bridge.
 *
 * Converts changes on a record doc's `fields` Y.Map into single-field patches
 * and writes via RecordWriteService.patchRecords() — the authoritative write
 * path shared with REST. Field-type-agnostic: collects both Y.Text values
 * (string fields, char-level merged) AND any PLAIN value set directly under a
 * Y.Map key (atomic scalars, LWW). Nested Yjs shared types (Y.Map/Y.Array) are
 * skipped.
 *
 * NOTE: being a generic plain-value collector does NOT mean a type is live in the product;
 * which fields reach the bridge is determined by the seed (yjs-sync-service) + the FE cell
 * bindings, not here. As of #2832 / #2838 / #2849 the FULL scalar set is wired — incl.
 * select/date (Y.Text-tolerant `coerceText` dual-reader), duration (commit-on-confirm), and
 * dateTime (canonical-UTC-ISO invariant). Only genuine free-text fields use Y.Text char-merge
 * rather than plain-value LWW.
 *
 * NOT in scope: create/delete, field-level permissions, webhook/automation
 * (downstream of RecordWriteService; they fire once the bridge calls patchRecords).
 */

import * as Y from 'yjs'
import type { YjsSyncService } from './yjs-sync-service'
import type { RecordWriteService, RecordPatchInput, FieldMutationGuard } from '../multitable/record-write-service'

export interface YjsRecordBridgeConfig {
  /** Minimum delay (ms) between flushes to RecordWriteService. */
  mergeWindowMs?: number
  /** Maximum delay (ms) before a forced flush. */
  maxDelayMs?: number
  /** First delay (ms) before a write whose re-check could not be answered is re-checked. */
  deferRetryMinMs?: number
  /** Upper bound (ms) of the delay between two re-checks of a deferred write. */
  deferRetryMaxMs?: number
  /** How long (ms) one re-check may take before it counts as not answered. */
  recheckTimeoutMs?: number
  /** How long (ms) a write may stay un-rechecked in all before it is ended like a refused one. */
  deferMaxMs?: number
}

/** Resolves a socket.id (Yjs transaction origin) to a verified userId. */
export type ActorResolver = (socketId: string) => string | undefined

/**
 * Called after a flush was REFUSED (the write threw), with the record and the error as thrown. The bridge has no
 * HTTP response to answer on, so this is the one place a refusal can be turned into something the editors are
 * told. Optional: with no handler the bridge counts and logs the failure, exactly as before.
 */
export type YjsBridgeRefusalHandler = (recordId: string, error: unknown) => void | Promise<void>

/** What one connection contributed to a pending write: who it was bound to and which fields it changed. */
export interface YjsContribution {
  /** Connection the changes arrived on; null when the origin of a change could not be told. */
  originId: string | null
  actorId: string
  fieldIds: string[]
}

/**
 * Answer of the re-check of one contribution:
 *   - allowed: the contributor may still write every field it changed;
 *   - denied:  an authoritative fact says it may not;
 *   - unknown: the facts could not be read, or the instance is not serving. Neither a yes nor a no.
 */
export type YjsContributionVerdict = 'allowed' | 'denied' | 'unknown'

/**
 * Re-checks one contribution right before the merged write is persisted. A checker that rejects is
 * read as `unknown`.
 */
export type YjsContributionChecker = (recordId: string, contribution: YjsContribution) => Promise<YjsContributionVerdict>

/**
 * A merged write was refused because one of its contributions is no longer authorized or cannot
 * be attributed. The whole batch is refused: no contribution of it is persisted.
 */
export class YjsContributionRefusedError extends Error {
  constructor(message = 'A contribution to this write is not authorized') {
    super(message)
    this.name = 'YjsContributionRefusedError'
  }
}

/**
 * A merged write whose re-check could not be answered for longer than a write may stay unchecked.
 * It is handled like a refused one: nothing of it is persisted and its document generation ends.
 * Nobody was found unauthorized; the write could not be confirmed in time.
 */
export class YjsContributionUndecidedError extends YjsContributionRefusedError {
  constructor(message = 'A contribution to this write could not be re-checked in time') {
    super(message)
    this.name = 'YjsContributionUndecidedError'
  }
}

interface PendingWrite {
  owner?: YjsRecordIncarnation
  fields: Record<string, unknown>
  actorIds: Set<string>
  /** Keyed by origin connection ('' for an unattributable change). */
  contributions: Map<string, { originId: string | null; actorId: string; fieldIds: Set<string> }>
  timer: NodeJS.Timeout
  firstSeen: number
  /** How many times the re-check of this write could not be answered so far. */
  deferrals: number
  /** A write put back after an unanswered re-check is not taken out again before this time. */
  notBefore: number
  /**
   * When the first re-check that could not be answered began, for the oldest change in this write.
   * Later changes merged into the write do not move it.
   */
  undecidedSince: number | null
}

export const DEFAULT_DEFER_RETRY_MIN_MS = 250
export const DEFAULT_DEFER_RETRY_MAX_MS = 5_000
/** How long one re-check may take before it counts as not answered. */
export const DEFAULT_RECHECK_TIMEOUT_MS = 30_000
/**
 * How long a change may stay in the shared document and its persisted state without its re-check
 * having been answered. Past it the write is ended like a refused one.
 */
export const DEFAULT_DEFER_MAX_MS = 30_000

/**
 * Bridges Y.Doc field changes → RecordWriteService.patchRecords().
 *
 * Each record doc has a Y.Map "fields". When a Y.Text field inside that
 * map changes (from a remote Yjs client, NOT from 'rest' origin), the
 * bridge debounces the change and flushes it as a patch.
 */
export class YjsRecordBridge {
  private pendingWrites = new Map<string, PendingWrite>()
  /**
   * Tracks per-record observer state. Keyed by recordId. Value holds the
   * current Y.Doc ref and the cleanup closure for that observer.
   *
   * We key by recordId AND validate the Y.Doc identity on every observe()
   * call. The sync service may destroy and recreate Y.Doc instances across
   * idle-release cycles; if the incoming doc is a different instance than
   * the one we previously hooked, we must tear down the stale observer and
   * re-register on the new doc. Without this, edits on the recreated doc
   * have no observer and silently fail to flush.
   */
  private observedDocs = new Map<string, { doc: Y.Doc; cleanup: () => void }>()
  private _flushSuccessCount = 0
  private _flushFailureCount = 0
  private _deferredFlushCount = 0
  /**
   * The one write of each record whose re-check or persistence is running right now. Writes of a
   * record are taken out one at a time: a change that arrives meanwhile waits in `pendingWrites`
   * and is taken out only after the earlier write has been written, refused or put back. A write
   * that is put back is therefore always older than whatever waits, and a retried write can never
   * overwrite a later value that was already written.
   */
  private flushing = new Map<string, PendingWrite>()
  /** Records whose waiting write is to be taken out as soon as the running one is done. */
  private wantFlush = new Set<string>()
  /** Advanced by `cancelPending`: a write taken out before the cancellation is void afterwards. */
  private cancelEpochs = new Map<string, number>()
  private destroyed = false

  private mergeWindowMs: number
  private maxDelayMs: number
  private deferRetryMinMs: number
  private deferRetryMaxMs: number
  private recheckTimeoutMs: number
  private deferMaxMs: number
  private _expiredDeferralCount = 0

  private actorResolver: ActorResolver
  private refusalHandler: YjsBridgeRefusalHandler | null = null
  private contributionChecker: YjsContributionChecker | null = null

  constructor(
    private syncService: YjsSyncService,
    private recordWriteService: RecordWriteService,
    private getWriteInput: (recordId: string, patch: Record<string, unknown>, primaryActorId: string, allActorIds: string[], contributions?: YjsContribution[]) => Promise<RecordPatchInput | null>,
    config?: YjsRecordBridgeConfig,
    actorResolver?: ActorResolver,
  ) {
    this.actorResolver = actorResolver ?? (() => undefined)
    this.mergeWindowMs = config?.mergeWindowMs ?? 200
    this.maxDelayMs = config?.maxDelayMs ?? 500
    this.deferRetryMinMs = config?.deferRetryMinMs ?? DEFAULT_DEFER_RETRY_MIN_MS
    this.deferRetryMaxMs = config?.deferRetryMaxMs ?? DEFAULT_DEFER_RETRY_MAX_MS
    this.recheckTimeoutMs = config?.recheckTimeoutMs ?? DEFAULT_RECHECK_TIMEOUT_MS
    this.deferMaxMs = config?.deferMaxMs ?? DEFAULT_DEFER_MAX_MS
  }

  /**
   * Attach (or detach, with null) the per-contributor re-check. With a checker attached, every
   * contributor of a merged write is checked against the fields it changed before anything is
   * persisted, and an unattributable or refused contribution refuses the whole write.
   */
  setContributionChecker(checker: YjsContributionChecker | null): void {
    this.contributionChecker = checker
  }

  /** Attach (or detach, with null) the handler told about refused flushes. */
  setRefusalHandler(handler: YjsBridgeRefusalHandler | null): void {
    this.refusalHandler = handler
  }

  /**
   * Start observing a record doc for field changes.
   * Call this after YjsSyncService.getOrCreateDoc().
   */
  observe(recordId: string, doc: Y.Doc): void {
    // If we already observe this record and the caller is handing us the
    // SAME Y.Doc instance, nothing to do — the existing observer is live.
    const existing = this.observedDocs.get(recordId)
    if (existing && existing.doc === doc) return

    // Doc identity changed (recreated after idle release). Clean up the
    // stale observer binding first so we don't leak / double-observe.
    if (existing) {
      try { existing.cleanup() } catch { /* ignore */ }
      this.observedDocs.delete(recordId)
    }

    const owner = getYjsRecordOwner(doc)
    const previousOwner = existing && getYjsRecordOwner(existing.doc)
    if (previousOwner && previousOwner.incarnation !== owner?.incarnation) this.cancelPending([recordId])
    const fields = doc.getMap('fields')

    const handler = (events: Y.YEvent<any>[], transaction: Y.Transaction) => {
      // Skip changes from REST bridge or persistence to avoid loops
      if (transaction.origin === 'rest' || transaction.origin === 'persistence') return

      // Resolve the real userId from the socket.id that originated this transaction
      const originSocketId = typeof transaction.origin === 'string' ? transaction.origin : undefined
      const actorId = originSocketId ? (this.actorResolver(originSocketId) ?? 'unknown') : 'unknown'

      // Collect changed field values: Y.Text (string fields, char-level merged) AND
      // plain values (scalar fields — number/currency/select/boolean/date/etc. — synced
      // last-write-wins via the Y.Map). Both flush through the same validated patch path.
      const changedFields: Record<string, unknown> = {}

      for (const event of events) {
        if (event.target === fields && event instanceof Y.YMapEvent) {
          for (const key of event.keysChanged) {
            const value = fields.get(key)
            if (value instanceof Y.Text) {
              changedFields[key] = value.toString()
            } else if (value !== undefined && !(value instanceof Y.AbstractType)) {
              // Scalar field: a plain value set under the Y.Map key (LWW). Skip Yjs
              // shared types (Y.Text handled above; Y.Map/Y.Array out of scope) and
              // deletes (undefined key). patchRecords validates the value downstream.
              changedFields[key] = value
            }
          }
        }
        // Also handle changes within existing Y.Text values
        if (event.target instanceof Y.Text && event.target.parent === fields) {
          // Find the key for this Y.Text in the parent map
          for (const [key, val] of fields) {
            if (val === event.target) {
              changedFields[key] = event.target.toString()
              break
            }
          }
        }
      }

      if (Object.keys(changedFields).length > 0) {
        this.scheduleFlush(recordId, changedFields, actorId, originSocketId ?? null, owner)
      }
    }

    fields.observeDeep(handler)

    this.observedDocs.set(recordId, {
      doc,
      cleanup: () => {
        fields.unobserveDeep(handler)
      },
    })
  }

  /**
   * Stop observing a record doc.
   */
  unobserve(recordId: string): void {
    const entry = this.observedDocs.get(recordId)
    if (entry) {
      entry.cleanup()
      this.observedDocs.delete(recordId)
    }
    // Flush any pending writes immediately
    this.flushNow(recordId)
  }

  private noteContribution(
    pending: PendingWrite,
    changedFields: Record<string, unknown>,
    actorId: string,
    originId: string | null,
  ): void {
    const key = originId ?? ''
    const contribution = pending.contributions.get(key) ?? { originId, actorId, fieldIds: new Set<string>() }
    // One connection is bound to one actor; a different actor on the same origin is not attributable.
    if (contribution.actorId !== actorId) contribution.actorId = 'unknown'
    for (const fieldId of Object.keys(changedFields)) contribution.fieldIds.add(fieldId)
    pending.contributions.set(key, contribution)
  }

  private scheduleFlush(
    recordId: string,
    changedFields: Record<string, unknown>,
    actorId: string,
    originId: string | null = null,
    owner?: YjsRecordIncarnation,
  ): void {
    const existing = this.pendingWrites.get(recordId)

    if (existing) {
      Object.assign(existing.fields, changedFields)
      existing.actorIds.add(actorId)
      this.noteContribution(existing, changedFields, actorId, originId)
      clearTimeout(existing.timer)

      // Check if we've exceeded max delay — force flush
      if (Date.now() - existing.firstSeen >= this.maxDelayMs) {
        this.flushNow(recordId)
        return
      }
    }

    const entry: PendingWrite = existing ?? {
      owner,
      fields: { ...changedFields },
      actorIds: new Set([actorId]),
      contributions: new Map(),
      timer: null!,
      firstSeen: Date.now(),
      deferrals: 0,
      notBefore: 0,
      undecidedSince: null,
    }
    if (!existing) this.noteContribution(entry, changedFields, actorId, originId)

    entry.timer = setTimeout(() => this.flushNow(recordId), this.mergeWindowMs)

    if (!existing) {
      this.pendingWrites.set(recordId, entry)
    }
  }

  private flushNow(recordId: string): void {
    const pending = this.pendingWrites.get(recordId)
    if (!pending) return

    clearTimeout(pending.timer)
    if (this.flushing.has(recordId)) {
      // One write of a record at a time: this one is taken out when the running one is done.
      this.wantFlush.add(recordId)
      return
    }
    const wait = pending.notBefore - Date.now()
    if (wait > 0) {
      // Put back after an unanswered re-check: not asked again before its delay has passed.
      pending.timer = setTimeout(() => this.flushNow(recordId), wait)
      return
    }
    this.pendingWrites.delete(recordId)
    this.wantFlush.delete(recordId)
    this.flushing.set(recordId, pending)
    const epoch = this.cancelEpochs.get(recordId) ?? 0
    const cancelled = (): boolean => (this.cancelEpochs.get(recordId) ?? 0) !== epoch

    const fields = { ...pending.fields }
    const actorIds = [...pending.actorIds]
    // Primary actor = first contributor in the window; all contributors tracked
    const primaryActorId = actorIds[0] ?? 'unknown'
    const contributions: YjsContribution[] = [...pending.contributions.values()].map((contribution) => ({
      originId: contribution.originId,
      actorId: contribution.actorId,
      fieldIds: [...contribution.fieldIds],
    }))

    const startedAt = Date.now()
    const left = pending.undecidedSince === null ? this.deferMaxMs : pending.undecidedSince + this.deferMaxMs - startedAt

    // Fire and forget — errors logged, not thrown
    this.recheckWithinTime(recordId, contributions, Math.max(0, Math.min(this.recheckTimeoutMs, left)))
      .then((outcome) => {
        // The document was invalidated while the re-check ran: its pending writes are void.
        if (cancelled()) return false
        if (outcome === 'defer') {
          if (pending.undecidedSince === null) pending.undecidedSince = startedAt
          if (Date.now() - pending.undecidedSince >= this.deferMaxMs) {
            // Un-rechecked for as long as a write may be: it is ended like a refused one, so its
            // content does not stay in the document and its persisted state unconfirmed.
            this._expiredDeferralCount++
            throw new YjsContributionUndecidedError()
          }
          // Neither a yes nor a no: the write is kept and re-checked later. Nothing is written and
          // nothing is refused meanwhile.
          this.deferPending(recordId, pending)
          return false
        }
        return this.executePatch(recordId, fields, primaryActorId, actorIds, contributions, pending.owner)
      })
      .then((applied) => {
        if (applied) this._flushSuccessCount++
      })
      .catch((err) => {
        this._flushFailureCount++
        console.error(`[yjs-bridge] Failed to flush patch for record ${recordId}:`, err)
        this.tellRefusal(recordId, err)
      })
      .finally(() => {
        // Whatever the outcome — written, refused, put back, void, nothing to write — the record
        // is free again and the write that waited behind this one is taken out.
        if (this.flushing.get(recordId) === pending) this.flushing.delete(recordId)
        if (this.wantFlush.delete(recordId) && this.pendingWrites.has(recordId)) this.flushNow(recordId)
      })
  }

  /**
   * The re-check with a time limit. A re-check that does not answer in time counts as not answered,
   * and whatever it answers afterwards is ignored: the write is put back, and the record is not
   * held up by a read that never returns.
   */
  private recheckWithinTime(recordId: string, contributions: YjsContribution[], limitMs: number): Promise<'proceed' | 'defer'> {
    // Nothing is asked without a checker, so there is nothing that could fail to answer.
    if (!this.contributionChecker) return this.recheckContributions(recordId, contributions)
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve('defer')
      }, limitMs)
      timer.unref?.()
      this.recheckContributions(recordId, contributions).then(
        (outcome) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(outcome)
        },
        (error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  /** Puts a write whose re-check could not be answered back, to be re-checked after a bounded delay. */
  private deferPending(recordId: string, older: PendingWrite): void {
    if (this.destroyed) return
    this._deferredFlushCount++
    older.deferrals += 1
    const delay = Math.min(this.deferRetryMinMs * 2 ** Math.min(older.deferrals - 1, 16), this.deferRetryMaxMs)
    const newer = this.pendingWrites.get(recordId)
    if (newer) {
      if (older.owner?.incarnation !== newer.owner?.incarnation) return
      // Whatever waits arrived after this write was taken out, because writes of a record are taken
      // out one at a time: field by field the waiting values are the later ones and win.
      clearTimeout(newer.timer)
      newer.fields = { ...older.fields, ...newer.fields }
      newer.actorIds = new Set([...older.actorIds, ...newer.actorIds])
      for (const [key, contribution] of older.contributions) {
        const later = newer.contributions.get(key)
        if (!later) {
          newer.contributions.set(key, contribution)
          continue
        }
        if (later.actorId !== contribution.actorId) later.actorId = 'unknown'
        for (const fieldId of contribution.fieldIds) later.fieldIds.add(fieldId)
      }
      newer.firstSeen = older.firstSeen
      newer.deferrals = older.deferrals
      newer.undecidedSince = older.undecidedSince
      newer.notBefore = Date.now() + delay
      newer.timer = setTimeout(() => this.flushNow(recordId), delay)
      return
    }
    older.notBefore = Date.now() + delay
    older.timer = setTimeout(() => this.flushNow(recordId), delay)
    this.pendingWrites.set(recordId, older)
  }

  /** True while a write that this connection contributed to is waiting or being persisted. */
  hasPendingOrigin(originId: string): boolean {
    for (const pending of this.pendingWrites.values()) if (pending.contributions.has(originId)) return true
    for (const pending of this.flushing.values()) if (pending.contributions.has(originId)) return true
    return false
  }

  /** Never throws and never rejects: a handler that fails is logged, the flush outcome stands. */
  private tellRefusal(recordId: string, error: unknown): void {
    const handler = this.refusalHandler
    if (!handler) return
    Promise.resolve()
      .then(() => handler(recordId, error))
      .catch((handlerError) => {
        console.error(`[yjs-bridge] Refusal handler failed for record ${recordId}:`, handlerError)
      })
  }

  /**
   * Every contributor of the merged write is checked against its own fields, whatever the order the
   * contributions arrived in. One refused or unattributable contribution refuses the whole write.
   * When nobody is refused but an answer is missing, the write is deferred: a missing answer is
   * never read as a refusal, and never as permission.
   */
  private async recheckContributions(recordId: string, contributions: YjsContribution[]): Promise<'proceed' | 'defer'> {
    const checker = this.contributionChecker
    if (!checker) return 'proceed'
    if (contributions.length === 0) throw new YjsContributionRefusedError()
    let undecided = false
    for (const contribution of contributions) {
      if (contribution.originId === null || contribution.actorId === 'unknown') throw new YjsContributionRefusedError()
      let verdict: YjsContributionVerdict
      try {
        verdict = await checker(recordId, contribution)
      } catch {
        verdict = 'unknown'
      }
      if (verdict === 'denied') throw new YjsContributionRefusedError()
      if (verdict !== 'allowed') undecided = true
    }
    return undecided ? 'defer' : 'proceed'
  }

  private async executePatch(
    recordId: string,
    fields: Record<string, unknown>,
    primaryActorId: string,
    allActorIds: string[],
    contributions: YjsContribution[] = [],
    owner?: YjsRecordIncarnation,
  ): Promise<boolean> {
    // The contribution records are handed to the builder only where they are re-checked: without a
    // contribution checker the builder is called exactly as before.
    const input = this.contributionChecker
      ? await this.getWriteInput(recordId, fields, primaryActorId, allActorIds, contributions)
      : await this.getWriteInput(recordId, fields, primaryActorId, allActorIds)
    if (!input) return false // record context not available (e.g., deleted)

    // The record may have been recreated since the debounce started or while the write waited
    // for a sheet lock. Bind the row in the transaction that actually writes the patch.
    if (owner) {
      const existingGuard = input.preWriteGuard
      input.preWriteGuard = async (query) => {
        await existingGuard?.(query)
        const row = await query(lockYjsRecordSql, [owner.recordId, owner.incarnation])
        if (!row.rows.length) throw new YjsRecordRetiredError()
      }
    }
    const result = await this.recordWriteService.patchRecords(input)
    return result.updated.length > 0
  }

  /**
   * Cancel any pending debounced flushes for the given records.
   *
   * Called by the REST → Yjs invalidation path BEFORE wiping the Yjs
   * state. Without this, the 200–500ms debounce window can fire AFTER
   * invalidation and re-materialize the stale Yjs-cached values on top
   * of the just-committed REST write.
   */
  cancelPending(recordIds: string[]): void {
    for (const recordId of recordIds) {
      // A write of this record whose re-check is running right now is void as well.
      this.cancelEpochs.set(recordId, (this.cancelEpochs.get(recordId) ?? 0) + 1)
      this.wantFlush.delete(recordId)
      const pending = this.pendingWrites.get(recordId)
      if (!pending) continue
      clearTimeout(pending.timer)
      this.pendingWrites.delete(recordId)
    }
  }

  /**
   * Flush all pending writes (e.g., on shutdown).
   */
  async flushAll(): Promise<void> {
    const recordIds = [...this.pendingWrites.keys()]
    for (const recordId of recordIds) {
      this.flushNow(recordId)
    }
  }

  /** Metrics snapshot for observability */
  getMetrics(): { pendingWriteCount: number; observedDocCount: number; flushSuccessCount: number; flushFailureCount: number; deferredFlushCount: number; expiredDeferralCount: number } {
    return {
      pendingWriteCount: this.pendingWrites.size,
      observedDocCount: this.observedDocs.size,
      flushSuccessCount: this._flushSuccessCount,
      flushFailureCount: this._flushFailureCount,
      // Times a write was kept because its re-check could not be answered (neither written nor refused).
      deferredFlushCount: this._deferredFlushCount,
      // Writes ended because their re-check stayed unanswered for as long as a write may.
      expiredDeferralCount: this._expiredDeferralCount,
    }
  }

  destroy(): void {
    this.destroyed = true
    // Unobserve all docs
    for (const [recordId] of this.observedDocs) {
      this.unobserve(recordId)
    }
    // Clear pending
    for (const [, pending] of this.pendingWrites) {
      clearTimeout(pending.timer)
    }
    this.pendingWrites.clear()
  }
}
