import {
  acceptFrozenRecoveryArchiveRestoreJob,
  buildRecoveryArchiveAsyncPlan,
  persistRecoveryArchiveAsyncPlan,
} from '../../src/multitable/recovery-archive-async-plan'
import { RECOVERY_AUTHORITY_TRIGGERS } from '../../src/db/migrations/zzzz20260721121000_add_recovery_authority_locks'
import { createTransactionGuardedRecoveryArchiveObjectStore } from '../../src/multitable/recovery-archive-object-store'
import type { RecoveryArchiveObjectStoreProvider } from '../../src/multitable/recovery-archive-object-store'
import { prepareRecoveryArchiveRestorePlan } from '../../src/multitable/recovery-archive-restore-jobs'
import type {
  RecoveryArchiveRestoreJobQuery,
  RecoveryArchiveRestoreJobTransaction,
} from '../../src/multitable/recovery-archive-restore-jobs'
import {
  hashAnchorRecoveryScope,
  hashExactAnchorLiveSet,
  hashExactAnchorSchema,
  hashRecoveryAuthorizationScope,
  mintExactArchiveRecoveryIdentity,
} from '../../src/multitable/restore-preview-identity'
import type { RecoveryArchiveTransactionDepthProbe } from '../../src/multitable/recovery-archive-crypto'
import type { LocalArchiveCustodyAdmission } from '../../src/multitable/recovery-local-custody'
import {
  createRecoveryArchiveDurableFixture,
  type RecoveryArchiveDurableFixture,
} from './recovery-archive-durable-fixture'
import {
  seedVerifiedArchive,
  type Fixture,
} from './recovery-archive-verified-fixture'

const RECORD_COUNT = 5001

export interface RecoveryArchiveLocalBackupFixture {
  readonly fixture: Fixture
  readonly durable: RecoveryArchiveDurableFixture
  readonly fieldId: string
  readonly recordIds: readonly string[]
  readonly jobId: string
  readonly archivedKeyId: string
  readonly expectedNonceSections: readonly string[]
}

export async function createRecoveryArchiveLocalBackupFixture(input: {
  readonly prefix: string
  readonly query: RecoveryArchiveRestoreJobQuery
  readonly transaction: RecoveryArchiveRestoreJobTransaction
  readonly transactionDepth: RecoveryArchiveTransactionDepthProbe
  readonly objectStore: RecoveryArchiveObjectStoreProvider
  readonly keyCustody: LocalArchiveCustodyAdmission
  readonly expiresAt: string
  readonly expectedNonceSections: readonly string[]
}): Promise<RecoveryArchiveLocalBackupFixture> {
  let durable: RecoveryArchiveDurableFixture | undefined
  let fieldId = ''
  let recordIds: string[] = []
  const fixture = await seedVerifiedArchive({
    prefix: input.prefix,
    query: input.query,
    transaction: input.transaction,
    label: 'local_backup_set',
    keyId: input.keyCustody.keyId,
    expiresAt: input.expiresAt,
    materialize: async (candidate) => {
      fieldId = `fld_${candidate.sheetId}_value`
      recordIds = Array.from({ length: RECORD_COUNT }, (_, index) =>
        `${candidate.sheetId}_record_${String(index).padStart(5, '0')}`,
      )
      const archiveRow = await input.query(
        `SELECT created_at, expires_at
           FROM public.meta_recovery_archives
          WHERE generation_id=$1::uuid`,
        [candidate.generationId],
      )
      const row = archiveRow.rows[0] as { created_at?: unknown; expires_at?: unknown } | undefined
      const createdAt = timestamp(row?.created_at)
      const expiresAt = timestamp(row?.expires_at)
      durable = await createRecoveryArchiveDurableFixture({
        binding: {
          archive_generation_id: candidate.generationId,
          workspace_id: candidate.workspaceId,
          base_id: candidate.baseId,
          sheet_id: candidate.sheetId,
          anchor_operation_id: candidate.anchorOperationId,
          anchor_seq: candidate.anchorSeq,
          checkpoint_id: candidate.checkpointId,
          created_at: createdAt,
          expires_at: expiresAt,
          source_vector_hash: candidate.sourceVectorHash,
        },
        keyId: candidate.keyId,
        sectionRows: {
          schema: [{
            field_id: fieldId,
            name: 'Synthetic backup value',
            type: 'string',
            property: {},
            order: 1,
          }],
          records: recordIds.map((recordId, index) => ({
            record_id: recordId,
            exists: true,
            version: 1,
            data: { [fieldId]: archivedValue(index) },
          })),
          links: [],
          field_value_tombstones: [],
          link_tombstones: [],
          auto_number: [],
          attachments_index: [],
          permission_evidence: [],
          views_config: [],
        },
        objectStore: input.objectStore,
        transactionDepth: input.transactionDepth,
        objectExpiresAt: expiresAt,
        keyCustody: input.keyCustody,
        reserveNonces: async (reservations) => input.transaction(async (query) => {
          if (reservations.map((reservation) => reservation.sectionName).join(',') !== input.expectedNonceSections.join(',')) {
            throw new Error('RECOVERY_LOCAL_BACKUP_NONCE_SECTION_MISMATCH')
          }
          for (const reservation of reservations) {
            await query(
              'SELECT meta_recovery_archive_reserve_nonce($1,$2,$3::uuid,$4,$5,$6::integer)',
              [
                reservation.dekFingerprint,
                reservation.nonceHex,
                reservation.generationId,
                reservation.sectionName,
                reservation.aeadAlgorithm,
                reservation.formatVersion,
              ],
            )
          }
        }),
      })
      return durable
    },
  })
  if (!durable || !fieldId || recordIds.length !== RECORD_COUNT) {
    throw new Error('RECOVERY_LOCAL_BACKUP_FIXTURE_NOT_MATERIALIZED')
  }

  // This fixture runs only in the driver's disposable database; the dump must retain the trust substrate.
  for (const [table, trigger] of RECOVERY_AUTHORITY_TRIGGERS) {
    await input.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
  }
  await input.query(
    `INSERT INTO public.users (id, password_hash, permissions)
     VALUES ($1, 'synthetic-not-a-password', $2::jsonb)`,
    [fixture.actorId, JSON.stringify([
      'multitable:read',
      'multitable:write',
      'multitable:share',
      'multitable:manage-schema',
    ])],
  )
  await input.query(
    `INSERT INTO public.meta_fields (id, sheet_id, name, type, property, "order")
     VALUES ($1, $2, 'Synthetic backup value', 'string', '{}'::jsonb, 1)`,
    [fieldId, fixture.sheetId],
  )
  await input.query(
    `INSERT INTO public.meta_records (id, sheet_id, data, version, created_by, modified_by)
     SELECT $1::text || pg_catalog.lpad(candidate.index::text, 5, '0'),
            $2::text,
            pg_catalog.jsonb_build_object($3::text, 'live-' || pg_catalog.lpad(candidate.index::text, 5, '0')),
            2,
            $4::text,
            $4::text
       FROM pg_catalog.generate_series(0, ${RECORD_COUNT - 1}) AS candidate(index)`,
    [`${fixture.sheetId}_record_`, fixture.sheetId, fieldId, fixture.actorId],
  )

  const targetRecords = new Map(recordIds.map((recordId) => [
    recordId,
    { recordId, exists: true, version: 1 },
  ]))
  const liveRecords = new Map(recordIds.map((recordId) => [recordId, { version: 2 }]))
  const schemaHash = hashExactAnchorSchema([{ id: fieldId, type: 'string', property: {} }])
  const bundle = buildRecoveryArchiveAsyncPlan({
    workspaceId: fixture.workspaceId,
    baseId: fixture.baseId,
    sheetId: fixture.sheetId,
    actorId: fixture.actorId,
    recoveryMode: 'revert',
    scopeKind: 'whole_sheet',
    scopeHash: hashAnchorRecoveryScope([...targetRecords.values()]),
    archiveGenerationId: fixture.generationId,
    archiveRootHash: fixture.rootHash,
    sourceVectorHash: fixture.sourceVectorHash,
    keyId: fixture.keyId,
    anchorOperationId: fixture.anchorOperationId,
    anchorSeq: fixture.anchorSeq,
    checkpointId: fixture.checkpointId,
    schemaHash,
    authorizedScopeHash: hashRecoveryAuthorizationScope({
      sheetId: fixture.sheetId,
      actorId: fixture.actorId,
    }),
    selectedRecordIds: [],
    selectedFieldIds: [],
    liveRecords,
    targetRecords,
    liveLinks: [],
    revertWrites: recordIds.map((recordId, index) => ({
      recordId,
      liveVersion: 2,
      changedFieldIds: [fieldId],
      patch: { [fieldId]: archivedValue(index) },
      projectedData: { [fieldId]: archivedValue(index) },
      linkUpdates: [],
    })),
    deleteRecordIds: [],
    expiresAt: input.expiresAt,
  })
  await persistRecoveryArchiveAsyncPlan(
    createTransactionGuardedRecoveryArchiveObjectStore(input.objectStore, input.transactionDepth),
    bundle,
  )

  const payload = bundle.planObject.payload
  const planObject = bundle.planObject.descriptor
  const token = mintExactArchiveRecoveryIdentity({
    sheetId: fixture.sheetId,
    anchorOperationId: fixture.anchorOperationId,
    anchorSeq: fixture.anchorSeq,
    checkpointId: fixture.checkpointId,
    scopeHash: payload.scopeHash,
    liveSetHash: hashExactAnchorLiveSet(recordIds.map((recordId) => ({ recordId, version: 2 })), []),
    schemaHash,
    actorId: fixture.actorId,
    mode: 'revert',
    authorizedScopeHash: payload.authorizedScopeHash,
    archiveGenerationId: fixture.generationId,
    archiveRootHash: fixture.rootHash,
    archiveSourceVectorHash: fixture.sourceVectorHash,
    archiveKeyId: fixture.keyId,
    archivePlanHash: bundle.plan.planHash,
    archivePlanObject: {
      objectId: planObject.objectId,
      version: planObject.version,
      sha256: planObject.sha256,
      size: planObject.size,
      expiresAt: planObject.expiresAt,
    },
    scopeKind: 'whole_sheet',
  }, '1h')
  const identity = {
    workspaceId: fixture.workspaceId,
    baseId: fixture.baseId,
    sheetId: fixture.sheetId,
    actorId: fixture.actorId,
  }
  await prepareRecoveryArchiveRestorePlan(input.transaction, { token, plan: bundle.plan, identity })
  const accepted = await acceptFrozenRecoveryArchiveRestoreJob(
    input.transaction,
    input.objectStore,
    input.transactionDepth,
    {
      identity,
      token,
      resumeDeadline: new Date(Date.now() + 30 * 60_000).toISOString(),
      recheckAuthority: async () => true,
    },
  )
  if (accepted.state !== 'planned' || accepted.totalCount !== String(RECORD_COUNT)) {
    throw new Error('RECOVERY_LOCAL_BACKUP_JOB_NOT_PLANNED')
  }

  return Object.freeze({
    fixture,
    durable,
    fieldId,
    recordIds: Object.freeze(recordIds),
    jobId: accepted.id,
    archivedKeyId: fixture.keyId,
    expectedNonceSections: Object.freeze([...input.expectedNonceSections]),
  })
}

export function recoveryLocalBackupArchivedValue(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= RECORD_COUNT) {
    throw new Error('RECOVERY_LOCAL_BACKUP_RECORD_INDEX_REFUSED')
  }
  return archivedValue(index)
}

export function recoveryLocalBackupRecordCount(): number {
  return RECORD_COUNT
}

function archivedValue(index: number): string {
  return `archived-${String(index).padStart(5, '0')}`
}

function timestamp(value: unknown): string {
  const result = value instanceof Date ? value : new Date(String(value))
  if (!Number.isFinite(result.getTime())) throw new Error('RECOVERY_LOCAL_BACKUP_TIMESTAMP_INVALID')
  return result.toISOString()
}
