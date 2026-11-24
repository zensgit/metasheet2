/**
 * Invalidation of record documents on the realtime (Yjs) side.
 *
 * Two pieces, both wired in src/index.ts and both importable so the tests run the code production runs:
 *
 *  1. `createYjsInvalidator` — the invalidation every authoritative write outside the bridge already performs
 *     (REST writes, recovery, a field type conversion): cancel the bridge's pending flushes for the records, drop
 *     their in-memory documents and persisted Yjs state, tell the editors in each record's room with the existing
 *     `yjs:invalidated` message. The order is the contract (see `YjsRecordBridge.cancelPending`).
 *
 *  2. `createFieldSchemaRefusalHandler` — field retype slice 3b (design lock
 *     docs/development/multitable-field-retype-first-batch-adr-20260926.md, 增补 C). A realtime edit can be refused
 *     with `FieldSchemaChangedError`: its flush validated the value against the column as it was, waited on the
 *     sheet fence while a conversion rewrote the column, and was stopped by the post-fence re-check. The bridge has
 *     no response to answer on; before this handler the refusal was counted and logged, and the edit stayed visible
 *     in the shared document without ever reaching `meta_records`. The handler invalidates that record's document
 *     through (1): the editors receive the message their client already handles — it leaves the document and
 *     falls back to the ordinary editor, which shows the committed value — and a reopened document is seeded from
 *     the committed row. No new message, no new payload field.
 *
 * INERT UNLESS BOTH FLAGS ARE ON. `FieldSchemaChangedError` is only ever thrown behind
 * `isFieldSchemaFenceRecheckEnabled()` (the conversion flag AND the writer fence); the handler checks the same
 * predicate itself, so with either flag off it returns before doing anything, whatever it is handed. Every other
 * refusal on the bridge (validation, permission, record lock, a sheet that is no longer live, a recovery in
 * progress) is left exactly as it was.
 */
import {
  FieldSchemaChangedError,
  isFieldSchemaFenceRecheckEnabled,
} from '../multitable/field-schema-fence-recheck'
import { FieldWritePermissionDeniedError } from '../multitable/permission-derivation'
import { YjsContributionRefusedError, type YjsBridgeRefusalHandler } from './yjs-record-bridge'

export type YjsInvalidate = (recordIds: string[]) => Promise<void>

export interface YjsInvalidatorParts {
  bridge: { cancelPending(recordIds: string[]): void }
  syncService: { invalidateDocs(recordIds: string[]): Promise<void> }
  adapter: { notifyInvalidated(recordIds: string[]): void }
}

/**
 * Pending bridge flushes are cancelled FIRST — without that a debounced bridge write would re-materialise the
 * stale document value on top of the write that has just committed. The editors are told even when dropping the
 * persisted state failed: their in-memory documents are gone either way.
 */
export function createYjsInvalidator(parts: YjsInvalidatorParts): YjsInvalidate {
  return async (recordIds: string[]) => {
    if (recordIds.length === 0) return
    parts.bridge.cancelPending(recordIds)
    try {
      await parts.syncService.invalidateDocs(recordIds)
    } finally {
      parts.adapter.notifyInvalidated(recordIds)
    }
  }
}

export function createFieldSchemaRefusalHandler(invalidate: YjsInvalidate): YjsBridgeRefusalHandler {
  return async (recordId: string, error: unknown) => {
    if (!isFieldSchemaFenceRecheckEnabled()) return
    if (!(error instanceof FieldSchemaChangedError)) return
    await invalidate([recordId])
  }
}

/**
 * A realtime write that was refused for an authorization reason leaves its change in the shared
 * document and in the persisted document state although it never reached the record. The handler
 * invalidates that generation of the document through the invalidator above: pending writes are
 * cancelled, the in-memory document and its persisted state are dropped, the editors are told with
 * the message they already handle, and a reopened document is built from the committed record.
 *
 * Authorization reasons are: a contribution that is no longer authorized or cannot be attributed,
 * and a field the writer may not write. Always active while realtime editing is served; it does not
 * depend on any switch.
 */
export function createAuthorizationRefusalHandler(invalidate: YjsInvalidate): YjsBridgeRefusalHandler {
  return async (recordId: string, error: unknown) => {
    if (!(error instanceof YjsContributionRefusedError) && !(error instanceof FieldWritePermissionDeniedError)) return
    await invalidate([recordId])
  }
}

/** Runs each handler in turn; one that fails does not stop the others. */
export function composeRefusalHandlers(...handlers: YjsBridgeRefusalHandler[]): YjsBridgeRefusalHandler {
  return async (recordId: string, error: unknown) => {
    for (const handler of handlers) {
      try {
        await handler(recordId, error)
      } catch (handlerError) {
        console.error(`[yjs] refusal handler failed for record ${recordId}:`, handlerError)
      }
    }
  }
}
