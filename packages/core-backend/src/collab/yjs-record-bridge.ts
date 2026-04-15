/**
 * Yjs → RecordWriteService bridge (POC scope: single text field only).
 *
 * Converts Y.Text changes on a record doc into a single-field patch
 * and writes via RecordWriteService.patchRecords() — the authoritative
 * write path shared with REST.
 *
 * NOT in scope: create/delete, non-text fields, field-level permissions,
 * webhook/automation (those are downstream of RecordWriteService and will
 * fire automatically once bridge calls patchRecords).
 */

import * as Y from 'yjs'
import type { YjsSyncService } from './yjs-sync-service'
import type { RecordWriteService, RecordPatchInput, FieldMutationGuard } from '../multitable/record-write-service'

export interface YjsRecordBridgeConfig {
  /** Minimum delay (ms) between flushes to RecordWriteService. */
  mergeWindowMs?: number
  /** Maximum delay (ms) before a forced flush. */
  maxDelayMs?: number
}

/** Resolves a socket.id (Yjs transaction origin) to a verified userId. */
export type ActorResolver = (socketId: string) => string | undefined

interface PendingWrite {
  fields: Record<string, string>
  actorId: string
  timer: NodeJS.Timeout
  firstSeen: number
}

/**
 * Bridges Y.Doc field changes → RecordWriteService.patchRecords().
 *
 * Each record doc has a Y.Map "fields". When a Y.Text field inside that
 * map changes (from a remote Yjs client, NOT from 'rest' origin), the
 * bridge debounces the change and flushes it as a patch.
 */
export class YjsRecordBridge {
  private pendingWrites = new Map<string, PendingWrite>()
  private observedDocs = new Map<string, () => void>()

  private mergeWindowMs: number
  private maxDelayMs: number

  private actorResolver: ActorResolver

  constructor(
    private syncService: YjsSyncService,
    private recordWriteService: RecordWriteService,
    private getWriteInput: (recordId: string, patch: Record<string, unknown>, actorId: string) => Promise<RecordPatchInput | null>,
    config?: YjsRecordBridgeConfig,
    actorResolver?: ActorResolver,
  ) {
    this.actorResolver = actorResolver ?? (() => undefined)
    this.mergeWindowMs = config?.mergeWindowMs ?? 200
    this.maxDelayMs = config?.maxDelayMs ?? 500
  }

  /**
   * Start observing a record doc for field changes.
   * Call this after YjsSyncService.getOrCreateDoc().
   */
  observe(recordId: string, doc: Y.Doc): void {
    if (this.observedDocs.has(recordId)) return

    const fields = doc.getMap('fields')

    const handler = (events: Y.YEvent<any>[], transaction: Y.Transaction) => {
      // Skip changes from REST bridge or persistence to avoid loops
      if (transaction.origin === 'rest' || transaction.origin === 'persistence') return

      // Resolve the real userId from the socket.id that originated this transaction
      const originSocketId = typeof transaction.origin === 'string' ? transaction.origin : undefined
      const actorId = originSocketId ? (this.actorResolver(originSocketId) ?? 'unknown') : 'unknown'

      // Collect changed text field values
      const changedFields: Record<string, string> = {}

      for (const event of events) {
        if (event.target === fields && event instanceof Y.YMapEvent) {
          for (const key of event.keysChanged) {
            const value = fields.get(key)
            if (value instanceof Y.Text) {
              changedFields[key] = value.toString()
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
        this.scheduleFlush(recordId, changedFields, actorId)
      }
    }

    fields.observeDeep(handler)

    this.observedDocs.set(recordId, () => {
      fields.unobserveDeep(handler)
    })
  }

  /**
   * Stop observing a record doc.
   */
  unobserve(recordId: string): void {
    const cleanup = this.observedDocs.get(recordId)
    if (cleanup) {
      cleanup()
      this.observedDocs.delete(recordId)
    }
    // Flush any pending writes immediately
    this.flushNow(recordId)
  }

  private scheduleFlush(recordId: string, changedFields: Record<string, string>, actorId: string): void {
    const existing = this.pendingWrites.get(recordId)

    if (existing) {
      // Merge fields into pending, keep latest actorId
      Object.assign(existing.fields, changedFields)
      existing.actorId = actorId
      clearTimeout(existing.timer)

      // Check if we've exceeded max delay — force flush
      if (Date.now() - existing.firstSeen >= this.maxDelayMs) {
        this.flushNow(recordId)
        return
      }
    }

    const entry: PendingWrite = existing ?? {
      fields: { ...changedFields },
      actorId,
      timer: null!,
      firstSeen: Date.now(),
    }

    entry.timer = setTimeout(() => this.flushNow(recordId), this.mergeWindowMs)

    if (!existing) {
      this.pendingWrites.set(recordId, entry)
    }
  }

  private flushNow(recordId: string): void {
    const pending = this.pendingWrites.get(recordId)
    if (!pending) return

    clearTimeout(pending.timer)
    this.pendingWrites.delete(recordId)

    const fields = { ...pending.fields }
    const actorId = pending.actorId

    // Fire and forget — errors logged, not thrown
    this.executePatch(recordId, fields, actorId).catch((err) => {
      console.error(`[yjs-bridge] Failed to flush patch for record ${recordId}:`, err)
    })
  }

  private async executePatch(recordId: string, fields: Record<string, unknown>, actorId: string): Promise<void> {
    const input = await this.getWriteInput(recordId, fields, actorId)
    if (!input) return // record context not available (e.g., deleted)

    await this.recordWriteService.patchRecords(input)
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

  destroy(): void {
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
