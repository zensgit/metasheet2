// 'restore' is a record-level version restore (Layer 1). It is NOT bridge-origin,
// so the invalidator below (skips only 'yjs-bridge') correctly fires for it — a
// restore writes meta_records.data and any live Y.Doc must re-seed from the DB.
export type RecordWriteSource = 'rest' | 'yjs-bridge' | 'restore'

export type YjsInvalidator = (recordIds: string[]) => Promise<void> | void

export interface RecordPostCommitContext {
  recordIds: string[]
  sheetId: string
  actorId: string | null
  source?: RecordWriteSource
}

export type RecordPostCommitHook = (context: RecordPostCommitContext) => Promise<void> | void

export function createYjsInvalidationPostCommitHook(
  invalidator: YjsInvalidator,
): RecordPostCommitHook {
  return async ({ recordIds, source }) => {
    if (source === 'yjs-bridge' || recordIds.length === 0) {
      return
    }
    await invalidator(recordIds)
  }
}
