import { createHash } from 'node:crypto'
import type { StorageProvider } from '../services/StorageService'
import type { QueryFn } from './permission-service'
import { verifyExactArchiveRecoveryIdentity } from './restore-preview-identity'
import { prepareArchiveAttachmentBatch } from './recovery-archive-attachment-prepare'
import {
  applyMaterializedExactArchiveRecoverySyncInternal,
  ApplyRefusalError,
  lockArchiveSyncBinding,
  type ExactAnchorApplyInput,
  type ExactAnchorApplyResult,
  type MaterializedArchiveLink,
} from './exact-anchor-recovery-execute'
import {
  readRecoveryArchiveCompleteSectionState,
  type RecoveryArchiveReaderInput,
} from './recovery-archive-reader'
import type { RecoveryArchiveRowEnvelope } from './recovery-archive-manifest'

export interface RecoveryArchiveSyncRestoreInput {
  readonly transaction: <T>(fn: (query: QueryFn) => Promise<T>) => Promise<T>
  /** Autocommit query used by D4 reconstruction before the destructive transaction opens. */
  readonly query: QueryFn
  readonly apply: ExactAnchorApplyInput
  readonly archive: RecoveryArchiveReaderInput
  readonly selectedRecordIds: readonly string[]
  readonly selectedFieldIds: readonly string[]
  /** Owner-policy value supplied by the server runtime, never by the HTTP request. */
  readonly auditedReplayHorizonMs: number
  /** Server-owned isolated preparation port; public runtime stays unregistered until cleanup acceptance. */
  readonly attachmentStorage?: Pick<StorageProvider, 'uploadByKey' | 'readRecoveryAttachment' | 'reserveRecoveryAttachment'>
}

/**
 * D4 -> D5 sync facade. Provider/KMS/object reads and D4 reconstruction finish before L8 opens its
 * destructive transaction. The transaction receives only the authenticated immutable record/link state.
 */
export async function applyRecoveryArchiveSyncRestore(
  input: RecoveryArchiveSyncRestoreInput,
): Promise<ExactAnchorApplyResult> {
  try {
    return await applyArchiveRestore({ ...input, apply: { ...input.apply },
      archive: { ...input.archive, selectedBinding: { ...input.archive.selectedBinding } },
      selectedRecordIds: [...input.selectedRecordIds], selectedFieldIds: [...input.selectedFieldIds] })
  } catch (error) {
    if (error instanceof ApplyRefusalError) return { ok: false, reason: error.reason }
    throw error
  }
}

async function applyArchiveRestore(input: RecoveryArchiveSyncRestoreInput): Promise<ExactAnchorApplyResult> {
  const verified = input.attachmentStorage ? verifyExactArchiveRecoveryIdentity(input.apply.token, {
    sheetId: input.apply.sheetId, actorId: input.apply.actorId,
  }) : undefined
  if (input.attachmentStorage && (!verified?.valid || !verified.claims)) return { ok: false, reason: 'identity-invalid' }
  if (input.attachmentStorage) {
    if (!(await input.apply.preliminaryFullRead(input.query))) return { ok: false, reason: 'forbidden' }
    const burned = await input.query('SELECT 1 FROM meta_recovery_token_burns WHERE token_sha256=$1',
      [createHash('sha256').update(input.apply.token).digest('hex')])
    if (burned.rows.length) return { ok: false, reason: 'token-replayed' }
    await input.transaction(query => lockArchiveSyncBinding(query, input.apply, {
      claims: verified!.claims!, workspaceId: input.archive.selectedBinding.workspaceId,
      baseId: input.archive.selectedBinding.baseId,
    }))
  }
  const state = await readRecoveryArchiveCompleteSectionState({
    ...input.archive,
    query: input.query,
  })
  let targetLinks: readonly MaterializedArchiveLink[]
  try {
    targetLinks = materializeRecoveryArchiveLinksForSync(state.links)
  } catch (error) {
    if (error instanceof RecoveryArchiveSyncRestoreError) {
      return { ok: false, reason: 'recovery-trust-required' }
    }
    throw error
  }
  const attachments = input.attachmentStorage && verified?.claims
    ? await prepareArchiveAttachmentBatch({ ...input, state, targetLinks, claims: verified.claims,
      storage: input.attachmentStorage }) : undefined
  return applyMaterializedExactArchiveRecoverySyncInternal(input.transaction, input.apply, {
    ...(attachments ? { attachments } : {}),
    workspaceId: input.archive.selectedBinding.workspaceId,
    baseId: input.archive.selectedBinding.baseId,
    targetRecords: state.records,
    targetLinks,
    selectedRecordIds: input.selectedRecordIds,
    selectedFieldIds: input.selectedFieldIds,
    auditedReplayHorizonMs: input.auditedReplayHorizonMs,
  })
}

export class RecoveryArchiveSyncRestoreError extends Error {
  readonly code = 'RECOVERY_ARCHIVE_SYNC_LINKS_INVALID' as const

  constructor() {
    super('RECOVERY_ARCHIVE_SYNC_LINKS_INVALID')
    this.name = 'RecoveryArchiveSyncRestoreError'
  }
}

export function materializeRecoveryArchiveLinksForSync(
  rows: readonly RecoveryArchiveRowEnvelope[],
): readonly MaterializedArchiveLink[] {
  if (!Array.isArray(rows)) invalidLinks()
  const linkIds = new Set<string>()
  const edgeIds = new Set<string>()
  const result: MaterializedArchiveLink[] = []
  for (const envelope of rows) {
    if (!isExactDataRecord(envelope, ['entity_key', 'payload'])) invalidLinks()
    const payload = envelope.payload
    if (!isExactDataRecord(payload, ['field_id', 'foreign_record_id', 'link_id', 'record_id'])) invalidLinks()
    const linkId = opaque(payload.link_id)
    const fieldId = opaque(payload.field_id)
    const recordId = opaque(payload.record_id)
    const foreignRecordId = opaque(payload.foreign_record_id)
    if (envelope.entity_key !== `link/${linkId}` || linkIds.has(linkId)) invalidLinks()
    linkIds.add(linkId)
    const edgeId = JSON.stringify([fieldId, recordId, foreignRecordId])
    if (edgeIds.has(edgeId)) invalidLinks()
    edgeIds.add(edgeId)
    result.push({ fieldId, recordId, foreignRecordId })
  }
  return result.sort((left, right) =>
    left.recordId.localeCompare(right.recordId) ||
    left.fieldId.localeCompare(right.fieldId) ||
    left.foreignRecordId.localeCompare(right.foreignRecordId),
  )
}

function isExactDataRecord(value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length !== expectedKeys.length) return false
  const expected = new Set(expectedKeys)
  return keys.every((key) => {
    if (typeof key !== 'string' || !expected.has(key)) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable === true && 'value' in descriptor
  })
}

function opaque(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) invalidLinks()
  return value
}

function invalidLinks(): never {
  throw new RecoveryArchiveSyncRestoreError()
}
