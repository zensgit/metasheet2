export type RecordWriteSource = 'rest' | 'yjs-bridge'

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
