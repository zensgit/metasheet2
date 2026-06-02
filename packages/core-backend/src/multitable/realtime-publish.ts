/**
 * Shared realtime publish helper for multitable record mutations.
 *
 * Extracted from `univer-meta.ts` so that both the REST route handler
 * and the future Yjs CRDT bridge can publish to the same channel.
 */

import { eventBus } from '../integration/events/event-bus'

export type MultitableSheetRealtimePayload = {
  spreadsheetId: string
  actorId?: string | null
  source: 'multitable'
  kind: 'record-created' | 'record-updated' | 'record-deleted' | 'attachment-updated'
  recordId?: string
  recordIds?: string[]
  fieldIds?: string[]
  recordPatches?: Array<{
    recordId: string
    version?: number
    patch: Record<string, unknown>
  }>
}

export type MultitableSheetRealtimeBroadcastPayload = Omit<MultitableSheetRealtimePayload, 'recordPatches'>

/**
 * Invalidate the lightweight cursor-paginated records cache for a sheet.
 *
 * Accepts an external invalidation function so we don't couple this module
 * to the cache implementation living inside `univer-meta.ts`.
 */
export type InvalidateCacheFn = (sheetId: string) => void

let _invalidateCache: InvalidateCacheFn = () => {}

/** Register the cache invalidation callback (called once at router setup). */
export function setRealtimeCacheInvalidator(fn: InvalidateCacheFn): void {
  _invalidateCache = fn
}

export function publishMultitableSheetRealtime(payload: MultitableSheetRealtimePayload): void {
  if (!payload.spreadsheetId) return
  _invalidateCache(payload.spreadsheetId)
  const broadcastPayload: MultitableSheetRealtimeBroadcastPayload = {
    spreadsheetId: payload.spreadsheetId,
    source: payload.source,
    kind: payload.kind,
  }
  if (payload.actorId !== undefined) broadcastPayload.actorId = payload.actorId
  if (payload.recordId !== undefined) broadcastPayload.recordId = payload.recordId
  if (payload.recordIds) broadcastPayload.recordIds = [...payload.recordIds]
  if (payload.fieldIds) broadcastPayload.fieldIds = [...payload.fieldIds]
  try {
    eventBus.publish('spreadsheet.cell.updated', broadcastPayload)
  } catch (err) {
    console.warn('[multitable] failed to publish multitable sheet realtime update', err)
  }
}
