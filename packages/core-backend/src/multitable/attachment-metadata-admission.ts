import type { Request } from 'express'
import { archiveSourceProtectionEnabled, type AttachmentPurgeTransaction } from './attachment-purge-claim'
import type { AttachmentQueryFn } from './attachment-service'
import { acquireCanonicalSheetFence } from './canonical-sheet-fence'
import { ensureRecordWriteAllowed } from './permission-service'
import { resolveRecoverySheetAuthority } from './recovery-authorization-stability'
import { loadSheetLiveness, SHEET_DELETED_MESSAGE, SHEET_NOT_FOUND_MESSAGE } from './sheet-liveness'

const commitUncertainErrors = new WeakSet<Error>()

/** Identity only: callers cannot grant the cleanup exception by supplying error fields. */
export function isAttachmentMetadataCommitUncertain(error: unknown): boolean {
  return error instanceof Error && commitUncertainErrors.has(error)
}

const recoveryRefusal = {
  code: 'RECOVERY_IN_PROGRESS',
  message: 'Another recovery operation is in progress on this sheet; retry shortly.',
}

/** Only closed, values-free refusals cross the upload callback boundary. */
export class AttachmentMetadataAdmissionError extends Error {
  constructor(
    readonly status: number,
    readonly error: { code: string; message: string },
  ) {
    super(error.code)
    this.name = 'AttachmentMetadataAdmissionError'
  }
}

function blocked(): never {
  throw new AttachmentMetadataAdmissionError(409, recoveryRefusal)
}

/** The returned query is used only for storeAttachment's legacy metadata INSERT. */
export function bindAttachmentMetadataAdmission(input: {
  query: AttachmentQueryFn
  transaction: AttachmentPurgeTransaction
  request: Request
  sheetId: string
  recordId: string | null
  fieldId: string | null
  mapFieldType: (type: string) => string
}): AttachmentQueryFn {
  // Preserve the unselected path's exact query/storage/error behavior and zero extra work.
  if (!archiveSourceProtectionEnabled()) return input.query
  return async (sql, params) => {
    let callbackCompleted = false
    try {
      return await input.transaction(async ({ query }) => {
        if (!archiveSourceProtectionEnabled()) blocked()
        // Source-free setup precedes the first business statement (the canonical fence).
        await query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
        const isolation = await query('SHOW transaction_isolation')
        if ((isolation.rows[0] as { transaction_isolation?: unknown } | undefined)?.transaction_isolation !== 'read committed') blocked()
        await acquireCanonicalSheetFence(query, input.sheetId)

        const { access, capabilities, sheetScope } = await resolveRecoverySheetAuthority(input.request, query, input.sheetId)
        if (!capabilities.canEditRecord) {
          throw new AttachmentMetadataAdmissionError(403, { code: 'FORBIDDEN', message: 'Insufficient permissions' })
        }
        const sheetLiveness = await loadSheetLiveness(query, input.sheetId)
        if (sheetLiveness !== 'live') {
          throw new AttachmentMetadataAdmissionError(404, sheetLiveness === 'deleted'
            ? { code: 'SHEET_DELETED', message: SHEET_DELETED_MESSAGE }
            : { code: 'NOT_FOUND', message: SHEET_NOT_FOUND_MESSAGE })
        }

        // Deliberately do not use the global legacy missing-column compatibility cache.
        // The protected admission requires an actual known durable state on this connection.
        let state: unknown
        try {
          const result = await query('SELECT recovery_writer_state FROM meta_sheets WHERE id = $1', [input.sheetId])
          if (result.rows.length !== 1) blocked()
          state = (result.rows[0] as { recovery_writer_state?: unknown }).recovery_writer_state
        } catch {
          blocked()
        }
        if (state !== null) blocked()

        if (input.fieldId) {
          const result = await query('SELECT id, type FROM meta_fields WHERE id = $1 AND sheet_id = $2', [input.fieldId, input.sheetId])
          const field = result.rows[0] as { type?: unknown } | undefined
          if (!field) throw new AttachmentMetadataAdmissionError(404, { code: 'NOT_FOUND', message: 'Field not found' })
          if (input.mapFieldType(String(field.type ?? 'string')) !== 'attachment') {
            throw new AttachmentMetadataAdmissionError(400, { code: 'VALIDATION_ERROR', message: 'Field is not an attachment field' })
          }
        }
        if (input.recordId) {
          const result = await query('SELECT id, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2', [input.recordId, input.sheetId])
          const record = result.rows[0] as { created_by?: unknown } | undefined
          if (!record) throw new AttachmentMetadataAdmissionError(404, { code: 'NOT_FOUND', message: 'Record not found' })
          if (!ensureRecordWriteAllowed(capabilities, sheetScope, access, typeof record.created_by === 'string' ? record.created_by : null, 'edit')) {
            throw new AttachmentMetadataAdmissionError(403, { code: 'FORBIDDEN', message: 'Record editing is not allowed for this row' })
          }
        }
        const result = await query(sql, params)
        callbackCompleted = true
        return result
      })
    } catch (error) {
      if (!callbackCompleted && error instanceof AttachmentMetadataAdmissionError) throw error
      // Never pass DB error detail (which can contain INSERT values) to the route logger.
      const refusal = new AttachmentMetadataAdmissionError(503, { code: 'DB_NOT_READY', message: 'Attachment metadata admission unavailable' })
      // COMMIT/release can fail after the server committed. Preserve a possibly pinned object.
      if (callbackCompleted) commitUncertainErrors.add(refusal)
      throw refusal
    }
  }
}
