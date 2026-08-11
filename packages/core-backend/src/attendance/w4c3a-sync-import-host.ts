/**
 * W4C-3a P06 — core-owned modern synchronous import commit host.
 *
 * Plugin supplies one closed prepareOnly plan. Core opens one independent
 * SERIALIZABLE source/effect transaction and owns class-00/10/11, operation
 * claim, canonical calculation, compatibility batch/item/record/group effects,
 * and seals. Creates no attendance_import_jobs / plan / chunk / terminal rows
 * and never calls processLegacyImportPlan.
 *
 * Freeze leaves on the prepared plan (attribution/policy snapshots and any
 * plugin-side fingerprint helpers that produced them) are consumed as given.
 * This host does not re-derive or replace those helpers; a later core freeze
 * port may become the sole authority for them.
 *
 * Authority: design lock §12.4; durable-legacy-plan amendment §5.1 P06 path.
 */
import crypto from 'node:crypto'
import {
  createAuthorizedAttendanceWriteContextV1,
  recheckAttendanceActorLivenessInTransactionV1,
  type AttendanceActorPostureV1,
} from './w4c0-authorization'
import {
  computeAttendanceItemSequenceFingerprintV1,
  computeAttendanceItemSetFingerprintV1,
} from './w4c0-fingerprints'
import {
  acquireAttendanceCalculationRolloutLock,
  acquireAttendanceImportReservationLocksV1,
  createVerifiedAttendanceOperationIdentityV1,
  createVerifiedAttendanceOrgIdentityV1,
  parseCanonicalAttendanceLegacyIdempotencyKeyV1,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  resolveSegmentCalculationPosture,
  type AttendanceW4TransactionClientV1,
  type VerifiedAttendanceOperationIdentityV1,
} from './w4c0-identity'
import { runAttendanceResultOperationTransactionV1 } from './w4c0-operation-registry'
import {
  claimAttendanceCanonicalImportRegistryV1,
  executeAttendanceCanonicalImportPlanV1,
  inspectAttendanceCanonicalImportRegistryV1,
  type AttendanceCanonicalImportRegistryClaimV1,
} from './w4c3a-canonical-import-kernel'
import {
  ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1,
  ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1,
  buildLegacyImportExecutionPlanPackageV1,
  sha256HexOfCanonicalJsonV1,
  type AttendanceLegacyRowSourceKindV1,
  type LegacyImportArtifactCleanupV1,
  type LegacyImportBatchPlanV1,
  type LegacyImportItemPlanV1,
  type LegacyImportPublicJobEnvelopeV1,
  type LegacyImportRecordWritePlanV1,
} from './w4c3a-legacy-execution-plan'
import {
  AttendanceLegacyPlanEnqueueError,
  lockAndFreezeAttendanceGroupReadSetV1,
  lockAndFreezeAttendanceRecordPreconditionsV1,
  materializeAttendanceLegacyGroupEffectsV1,
  type LegacyImportGroupEffectDraftV1,
  type LegacyImportItemDraftV1,
  type LegacyImportRecordWriteDraftV1,
} from './w4c3a-legacy-plan-enqueue'
import { applyAttendanceLegacyGroupEffectsV1 } from './w4c3a-legacy-plan-group-effects'
import { applyAttendanceLegacyItemEffectsV1 } from './w4c3a-legacy-plan-item-effects'
import { lockAndRecheckAttendanceLegacyPlanPreconditionsV1 } from './w4c3a-legacy-plan-preconditions'
import { applyAttendanceLegacyRecordEffectsV1 } from './w4c3a-legacy-plan-record-effects'
import {
  acquireAttendanceLegacyPlanClass11V1,
  deriveAttendanceLegacyPlanReservationIdentitiesV1,
  deriveAttendanceLegacyPlanTargetIdentitiesV1,
} from './w4c3a-legacy-plan-processor'
import { resolveAttendanceLegacyPlanOperationalBranchV1 } from './w4c3a-legacy-plan-reservation-host'
import type { VerifiedAttendanceLegacyPlanV1 } from './w4c3a-legacy-plan-worker'
import {
  AttendanceSyncImportError,
  buildAttendanceSyncImportBatchMetaV1,
  buildAttendanceSyncImportIdempotentResponseV1,
  buildAttendanceSyncImportResponseV1,
  buildAttendanceSyncImportSyntheticJobV1,
  type AttendanceSyncImportItemReturnV1,
  type AttendanceSyncImportResponseV1,
} from './w4c3a-sync-import-kernel'

export type AttendanceSyncImportHostConnectionV1 = AttendanceW4TransactionClientV1

export type AttendanceSyncImportHostDepsV1 = Readonly<{
  acquireConnection(): Promise<{
    client: AttendanceSyncImportHostConnectionV1
    release(): void
  }>
}>

export type CommitAttendanceSyncImportPlanFromHostInputV1 = Readonly<{
  orgId: string
  actorId: string
  actorPosture: AttendanceActorPostureV1
  tokenSubjectUserId: string | null
  batchId: string
  idempotencyKey: string | null
  payload: LegacyImportPublicJobEnvelopeV1
  legacyRowSourceKind: AttendanceLegacyRowSourceKindV1
  legacySourceRowLimit: number | null
  batch: Extract<LegacyImportBatchPlanV1, { kind: 'normal' }>
  artifactCleanup: LegacyImportArtifactCleanupV1
  items: readonly LegacyImportItemDraftV1[]
  recordWrites: readonly LegacyImportRecordWriteDraftV1[]
  groupEffects: readonly LegacyImportGroupEffectDraftV1[]
  /** Governing synchronous item-return policy (not the P07 fixed false policy). */
  itemReturnPolicy: AttendanceSyncImportItemReturnV1
  csvWarnings?: readonly string[]
  groupWarnings?: readonly string[]
}>

export type AttendanceSyncImportHostV1 = Readonly<{
  commitSyncImportPlanV1(
    input: CommitAttendanceSyncImportPlanFromHostInputV1,
  ): Promise<AttendanceSyncImportResponseV1>
}>

let afterPreconditionsForTests: (() => Promise<void>) | null = null

/** Test-only barrier after class-11/precondition locks and before source DML. */
export function __setW4C3aSyncImportAfterPreconditionsForTests(
  hook: (() => Promise<void>) | null,
): void {
  afterPreconditionsForTests = hook
}

function fail(code: string): never {
  throw new AttendanceSyncImportError(code)
}

function validateHostInput(
  input: CommitAttendanceSyncImportPlanFromHostInputV1,
): void {
  if (
    typeof input !== 'object' ||
    input === null ||
    !Array.isArray(input.items) ||
    !Array.isArray(input.recordWrites) ||
    !Array.isArray(input.groupEffects)
  ) {
    fail('W4C3A_SYNC_HOST_INPUT_INVALID')
  }
  if (input.items.length !== input.batch.sourceRowCount) {
    fail('W4C3A_SYNC_HOST_SOURCE_COUNT_MISMATCH')
  }
  if (
    typeof input.itemReturnPolicy !== 'object' ||
    input.itemReturnPolicy === null ||
    typeof input.itemReturnPolicy.returnItems !== 'boolean' ||
    !(
      input.itemReturnPolicy.itemsLimit === null ||
      (Number.isSafeInteger(input.itemReturnPolicy.itemsLimit) &&
        Number(input.itemReturnPolicy.itemsLimit) >= 0)
    )
  ) {
    fail('W4C3A_SYNC_HOST_ITEM_RETURN_INVALID')
  }
}

function targetRefForRecordWrite(
  row: LegacyImportRecordWriteDraftV1,
): string {
  return JSON.stringify([row.orgId, row.userId, row.workDate])
}

async function loadCommittedLegacyBatch(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  idempotencyKey: string,
): Promise<{
  batchId: string
  imported: number
  skipped: number
  engine: string
  recordUpsertStrategy: string
  meta: Record<string, unknown>
} | null> {
  const result = await trx.query(
    `SELECT id::text AS id, row_count, meta
       FROM attendance_import_batches
      WHERE org_id = $1 AND idempotency_key = $2 AND status = 'committed'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      FOR UPDATE`,
    [orgId, idempotencyKey],
  )
  if (result.rows.length === 0) return null
  const row = result.rows[0] as Record<string, unknown>
  const meta =
    typeof row.meta === 'object' && row.meta !== null && !Array.isArray(row.meta)
      ? (row.meta as Record<string, unknown>)
      : {}
  const skippedCount = Number(meta.skippedCount ?? 0)
  const rowCount = Number(row.row_count ?? 0)
  const safeSkipped = Number.isFinite(skippedCount) ? skippedCount : 0
  const imported = Math.max(0, rowCount - safeSkipped)
  const engine =
    typeof meta.engine === 'string' && meta.engine.length > 0
      ? meta.engine
      : 'standard'
  const recordUpsertStrategy =
    typeof meta.recordUpsertStrategy === 'string' &&
    meta.recordUpsertStrategy.length > 0
      ? meta.recordUpsertStrategy
      : 'values'
  return {
    batchId: String(row.id),
    imported,
    skipped: safeSkipped,
    engine,
    recordUpsertStrategy,
    meta,
  }
}

async function assertNoBlockingV1Job(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  batchId: string,
  idempotencyKey: string | null,
): Promise<void> {
  const result = await trx.query(
    `SELECT id::text AS id, status
       FROM attendance_import_jobs
      WHERE org_id = $1 AND w4_contract_version = 1
        AND (
          (w4_entrypoint = 'import_batch' AND w4_batch_command_id = $2::uuid) OR
          ($3::text IS NOT NULL AND idempotency_key = $3)
        )
      ORDER BY id
      FOR UPDATE`,
    [orgId, batchId, idempotencyKey],
  )
  if (result.rows.length === 0) return
  const status = String((result.rows[0] as Record<string, unknown>).status ?? '')
  if (status === 'queued' || status === 'running') {
    fail('ATTENDANCE_OPERATION_IN_PROGRESS')
  }
  fail('ATTENDANCE_OPERATION_CONFLICT')
}

async function identityProofDigest(
  trx: AttendanceW4TransactionClientV1,
  vector: unknown,
): Promise<string> {
  const proofDigestResult = await trx.query(
    `SELECT encode(
       digest(convert_to($1::jsonb::text, 'UTF8'), 'sha256'),
       'hex'
     ) AS d`,
    [JSON.stringify(vector)],
  )
  const digest = String(
    (proofDigestResult.rows[0] as { d?: unknown } | undefined)?.d ?? '',
  )
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    fail('W4C3A_SYNC_PROOF_DIGEST_INVALID')
  }
  return digest
}

async function insertSyncBatchRow(
  trx: AttendanceW4TransactionClientV1,
  plan: VerifiedAttendanceLegacyPlanV1,
  effectResult: Awaited<ReturnType<typeof applyAttendanceLegacyGroupEffectsV1>>,
): Promise<void> {
  if (plan.manifest.batch.kind !== 'normal') return
  const meta = buildAttendanceSyncImportBatchMetaV1(plan, effectResult)
  const insert = await trx.query(
    `INSERT INTO attendance_import_batches (
       id, org_id, idempotency_key, created_by, source, rule_set_id,
       mapping, row_count, status, meta, created_at, updated_at
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, $6::uuid,
       $7::jsonb, $8, $9, $10::jsonb, now(), now()
     )
     RETURNING id::text AS id`,
    [
      plan.manifest.batchId,
      plan.manifest.orgId,
      plan.manifest.batch.idempotencyKey,
      plan.manifest.createdBy,
      plan.manifest.batch.source,
      plan.manifest.batch.ruleSetId,
      JSON.stringify(plan.manifest.batch.mappingSnapshot),
      plan.manifest.batch.sourceRowCount,
      plan.manifest.batch.status,
      JSON.stringify(meta),
    ],
  )
  if (
    insert.rows.length !== 1 ||
    (insert.rows[0] as Record<string, unknown>).id !== plan.manifest.batchId
  ) {
    fail('W4C3A_SYNC_BATCH_ROW_MISMATCH')
  }
}

/**
 * Shadow/authoritative path: reuse the shared execute kernel for calculation
 * + seals, then rewrite batch meta to drop the async-only `async: true` stamp
 * so the governing synchronous response stays byte-compatible.
 */
async function executeShadowOrAuthoritative(
  trx: AttendanceW4TransactionClientV1,
  input: Readonly<{
    job: ReturnType<typeof buildAttendanceSyncImportSyntheticJobV1>
    plan: VerifiedAttendanceLegacyPlanV1
    registryClaim: AttendanceCanonicalImportRegistryClaimV1
  }>,
): Promise<Awaited<ReturnType<typeof applyAttendanceLegacyGroupEffectsV1>>> {
  // executeAttendanceCanonicalImportPlanV1 applies group → batch(async meta)
  // → record/calculation → item → seals. We then strip async:true from meta.
  await executeAttendanceCanonicalImportPlanV1(trx, {
    job: input.job,
    plan: input.plan,
    registryClaim: input.registryClaim,
  })
  if (input.plan.manifest.batch.kind === 'normal') {
    const current = await trx.query(
      `SELECT meta FROM attendance_import_batches
        WHERE id = $1::uuid AND org_id = $2
        FOR UPDATE`,
      [input.plan.manifest.batchId, input.plan.manifest.orgId],
    )
    if (current.rows.length !== 1) fail('W4C3A_SYNC_BATCH_META_MISSING')
    const meta = {
      ...((current.rows[0] as { meta?: Record<string, unknown> }).meta ?? {}),
    }
    delete meta.async
    await trx.query(
      `UPDATE attendance_import_batches
          SET meta = $3::jsonb, updated_at = now()
        WHERE id = $1::uuid AND org_id = $2`,
      [
        input.plan.manifest.batchId,
        input.plan.manifest.orgId,
        JSON.stringify(meta),
      ],
    )
  }
  // groupCreated/members are already baked into meta by execute; reconstruct
  // closed counts from the written meta for the response builder.
  const metaRow = await trx.query(
    `SELECT meta FROM attendance_import_batches
      WHERE id = $1::uuid AND org_id = $2`,
    [input.plan.manifest.batchId, input.plan.manifest.orgId],
  )
  const meta =
    metaRow.rows.length === 1
      ? ((metaRow.rows[0] as { meta?: Record<string, unknown> }).meta ?? {})
      : {}
  return Object.freeze({
    groupCreated: Number(meta.groupCreated ?? 0),
    groupMembersAdded: Number(meta.groupMembersAdded ?? 0),
  })
}

export function createAttendanceSyncImportHostV1(
  deps: AttendanceSyncImportHostDepsV1,
): AttendanceSyncImportHostV1 {
  if (
    typeof deps !== 'object' ||
    deps === null ||
    typeof deps.acquireConnection !== 'function'
  ) {
    fail('W4C3A_SYNC_HOST_DEPS_INVALID')
  }

  return Object.freeze({
    async commitSyncImportPlanV1(input) {
      validateHostInput(input)
      const acquired = await deps.acquireConnection()
      try {
        const startedAt = Date.now()
        return await runAttendanceResultOperationTransactionV1(
          acquired.client,
          async (trx) => {
            const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(input.orgId)
            await acquireAttendanceCalculationRolloutLock(trx, orgKey, 'shared')
            const posture = await resolveSegmentCalculationPosture(
              trx,
              input.orgId,
            )
            if (
              posture.writePosture !== 'legacy_projection_only' &&
              posture.writePosture !== 'shadow' &&
              posture.writePosture !== 'authoritative'
            ) {
              fail('SEGMENT_CALCULATION_SUSPENDED')
            }

            const org = createVerifiedAttendanceOrgIdentityV1({
              orgKey: input.orgId,
              posture,
            })

            const sourceRef = `attendance-import:${input.batchId}`
            const subjectUserIds = [
              ...new Set(input.recordWrites.map((write) => write.userId)),
            ].sort()
            const authorization = createAuthorizedAttendanceWriteContextV1({
              actorId: input.actorId,
              actorPosture: input.actorPosture,
              tokenSubjectUserId: input.tokenSubjectUserId,
              orgId: input.orgId,
              subjectScope:
                subjectUserIds.length === 0
                  ? { kind: 'self', userId: input.actorId }
                  : { kind: 'explicit_users', userIds: subjectUserIds },
              capability: 'import',
              sourceRef,
            })

            const applyItems = input.items
              .filter(
                (
                  item,
                ): item is Extract<LegacyImportItemDraftV1, { kind: 'apply' }> =>
                  item.kind === 'apply',
              )
              .slice()
              .sort(
                (left, right) => left.semanticOrdinal - right.semanticOrdinal,
              )
            const distinctTargets = new Set(
              input.recordWrites.map(targetRefForRecordWrite),
            )
            // 5000 accepted / 5001 authoritative rejected before batch/item DML.
            const operationalBranch =
              resolveAttendanceLegacyPlanOperationalBranchV1({
                itemCount: applyItems.length,
                distinctTargetCount: distinctTargets.size,
                acceptedWritePosture: org.acceptedWritePosture,
              })

            await recheckAttendanceActorLivenessInTransactionV1(
              trx,
              authorization,
            )

            const commandFingerprint = sha256HexOfCanonicalJsonV1({
              batchId: input.batchId,
              payload: input.payload,
              batch: input.batch,
              items: input.items,
              recordWrites: input.recordWrites,
              groupEffects: input.groupEffects,
            })
            const legacyInputFingerprint = sha256HexOfCanonicalJsonV1({
              legacyRowSourceKind: input.legacyRowSourceKind,
              legacySourceRowLimit: input.legacySourceRowLimit,
              batch: input.batch,
              items: input.items,
              recordWrites: input.recordWrites,
              groupEffects: input.groupEffects,
            })

            const itemIdentityRows = applyItems.map((item) => {
              const semanticFingerprint = sha256HexOfCanonicalJsonV1({
                semanticOrdinal: item.semanticOrdinal,
                targetRef: item.targetRef,
                previewSnapshot: item.previewSnapshot,
              })
              const identity = createVerifiedAttendanceOperationIdentityV1({
                org,
                kind: 'item',
                entrypoint: 'import_batch',
                source: {
                  sourceKind: 'import_item',
                  batchCommandId: input.batchId,
                  ordinal: item.semanticOrdinal,
                  semanticFingerprint,
                },
              })
              return {
                identity,
                semanticFingerprint,
                commandFingerprint: sha256HexOfCanonicalJsonV1({
                  commandFingerprint,
                  semanticOrdinal: item.semanticOrdinal,
                  targetRef: item.targetRef,
                }),
              }
            })
            const fingerprintEntries = itemIdentityRows.map((item) => ({
              ordinal: item.identity.sourceProof.ordinal ?? '',
              operationId: item.identity.id,
              commandFingerprint: item.commandFingerprint,
            }))
            const itemSequenceFingerprint =
              fingerprintEntries.length === 0
                ? ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1
                : computeAttendanceItemSequenceFingerprintV1(fingerprintEntries)
            const itemSetFingerprint =
              fingerprintEntries.length === 0
                ? ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1
                : computeAttendanceItemSetFingerprintV1(fingerprintEntries)
            const identityProofVector =
              operationalBranch === 'strict_targeted'
                ? itemIdentityRows.map((item, ordinal) => ({
                    ordinal,
                    semanticFingerprint: item.semanticFingerprint,
                    derivedOperationId: item.identity.id,
                    commandFingerprint: item.commandFingerprint,
                  }))
                : []

            // class-00 shared, then class-10.
            const reservationIdentities =
              deriveAttendanceLegacyPlanReservationIdentitiesV1({
                orgId: input.orgId,
                batchId: input.batchId,
                acceptedWritePosture: org.acceptedWritePosture,
                identityProofVector,
                itemCount: applyItems.length,
              } as never)

            const legacyIdempotency =
              input.idempotencyKey === null
                ? null
                : parseCanonicalAttendanceLegacyIdempotencyKeyV1({
                    orgId: input.orgId,
                    idempotencyKey: input.idempotencyKey,
                  })
            await acquireAttendanceImportReservationLocksV1(
              trx,
              reservationIdentities,
              legacyIdempotency,
            )

            if (input.idempotencyKey !== null) {
              const existing = await loadCommittedLegacyBatch(
                trx,
                input.orgId,
                input.idempotencyKey,
              )
              if (existing) {
                return buildAttendanceSyncImportIdempotentResponseV1({
                  ...existing,
                  elapsedMs: Math.max(0, Date.now() - startedAt),
                })
              }
            }

            await assertNoBlockingV1Job(
              trx,
              input.orgId,
              input.batchId,
              input.idempotencyKey,
            )

            const inspectJob = buildAttendanceSyncImportSyntheticJobV1({
              orgId: input.orgId,
              batchId: input.batchId,
              actorId: input.actorId,
              actorPosture: input.actorPosture,
              tokenSubjectUserId: input.tokenSubjectUserId,
              acceptedWritePosture: org.acceptedWritePosture,
              commandFingerprint,
              legacyInputFingerprint,
              operationalBranch,
              identityProofVector,
              itemCount: applyItems.length,
              distinctTargetCount: distinctTargets.size,
              itemSequenceFingerprint,
              itemSetFingerprint,
              planDigest: '0'.repeat(64),
              idempotencyKey: input.idempotencyKey,
              sourceRef,
            })
            if (operationalBranch === 'strict_targeted') {
              const registryState =
                await inspectAttendanceCanonicalImportRegistryV1(trx, {
                  job: inspectJob,
                  identities: reservationIdentities,
                })
              if (registryState !== 'all_new') {
                fail('ATTENDANCE_OPERATION_CONFLICT')
              }
            }

            // Freeze preconditions (class-11 inside strict/bulk freeze helpers).
            const frozenRecords =
              await lockAndFreezeAttendanceRecordPreconditionsV1(
                trx,
                org,
                operationalBranch,
                input.recordWrites,
              )
            const frozenGroups = await lockAndFreezeAttendanceGroupReadSetV1(
              trx,
              input.orgId,
              input.groupEffects,
            )

            const recordWriteIdByTarget = new Map<string, string>()
            const recordWrites: LegacyImportRecordWritePlanV1[] =
              frozenRecords.map((frozen) => {
                const recordWriteId = crypto.randomUUID()
                recordWriteIdByTarget.set(
                  targetRefForRecordWrite(frozen.draft),
                  recordWriteId,
                )
                return {
                  ...frozen.draft,
                  recordWriteId,
                  targetRevision: frozen.targetRevision,
                  existingRecordPreconditionFingerprint:
                    frozen.preconditionFingerprint,
                  expectedSourceOwnership: frozen.expectedSourceOwnership,
                  recordId: frozen.existingRecordId ?? crypto.randomUUID(),
                }
              })
            const items: LegacyImportItemPlanV1[] = input.items.map((draft) => {
              const itemId = crypto.randomUUID()
              if (draft.kind === 'skip') return { ...draft, itemId }
              const recordWriteRef = recordWriteIdByTarget.get(draft.targetRef)
              if (recordWriteRef === undefined) fail('W4C3A_SYNC_DRAFT_INVALID')
              return { ...draft, itemId, recordWriteRef }
            })
            const materializedGroups = materializeAttendanceLegacyGroupEffectsV1(
              input.orgId,
              input.groupEffects,
              frozenGroups,
            )
            const identityProofVectorDigest = await identityProofDigest(
              trx,
              identityProofVector,
            )
            // Synthetic jobId is digest-bound only — never inserted as a job.
            const syntheticJobId = crypto.randomUUID()

            let planPackage: ReturnType<
              typeof buildLegacyImportExecutionPlanPackageV1
            >
            try {
              planPackage = buildLegacyImportExecutionPlanPackageV1({
                manifestSeed: {
                  schemaVersion: 1,
                  orgId: input.orgId,
                  batchId: input.batchId,
                  jobId: syntheticJobId,
                  sourceKind: 'import_batch',
                  sourceRef,
                  createdBy: input.actorId,
                  actorId: input.actorId,
                  actorPosture: input.actorPosture,
                  tokenSubjectUserId: input.tokenSubjectUserId,
                  acceptedWritePosture: org.acceptedWritePosture,
                  commandFingerprint,
                  legacyInputFingerprint,
                  operationalBranch,
                  legacyRowSourceKind: input.legacyRowSourceKind,
                  sourceRowCount: input.items.length,
                  w4ItemCount: applyItems.length,
                  w4DistinctTargetCount: distinctTargets.size,
                  w4ItemSequenceFingerprint: itemSequenceFingerprint,
                  w4ItemSetFingerprint: itemSetFingerprint,
                  identityProofVectorDigest,
                  legacySourceRowLimit: input.legacySourceRowLimit,
                  // Plan union freezes P07 item-return policy; P06 HTTP item
                  // return is owned only by the independent response builder.
                  batch: input.batch,
                  artifactCleanup: input.artifactCleanup,
                  groupRevision: materializedGroups.revision,
                  groupStateFingerprint: materializedGroups.fingerprint,
                },
                items,
                recordWrites,
                groupEffects: materializedGroups.effects,
                groupEffectPlacements: materializedGroups.placements,
              })
            } catch (error) {
              if (error instanceof AttendanceLegacyPlanEnqueueError) throw error
              if (
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                typeof (error as { code: unknown }).code === 'string'
              ) {
                fail(String((error as { code: string }).code))
              }
              throw error
            }

            const plan: VerifiedAttendanceLegacyPlanV1 = Object.freeze({
              manifest: planPackage.manifest,
              chunks: planPackage.chunks,
              items: Object.freeze(items),
              recordWrites: Object.freeze(recordWrites),
              groupEffects: Object.freeze(materializedGroups.effects),
            })

            const job = buildAttendanceSyncImportSyntheticJobV1({
              orgId: input.orgId,
              batchId: input.batchId,
              actorId: input.actorId,
              actorPosture: input.actorPosture,
              tokenSubjectUserId: input.tokenSubjectUserId,
              acceptedWritePosture: org.acceptedWritePosture,
              commandFingerprint,
              legacyInputFingerprint,
              operationalBranch,
              identityProofVector,
              itemCount: applyItems.length,
              distinctTargetCount: distinctTargets.size,
              itemSequenceFingerprint,
              itemSetFingerprint,
              planDigest: planPackage.planDigest,
              idempotencyKey: input.idempotencyKey,
              sourceRef,
            })

            const targetIdentities =
              deriveAttendanceLegacyPlanTargetIdentitiesV1(plan)
            if (
              plan.manifest.operationalBranch === 'operational_only_batch_limit'
            ) {
              await acquireAttendanceLegacyPlanClass11V1(
                trx,
                plan,
                targetIdentities,
              )
            }

            const preconditionsOk =
              await lockAndRecheckAttendanceLegacyPlanPreconditionsV1(
                trx,
                plan,
              )
            if (!preconditionsOk) {
              fail('ATTENDANCE_IMPORT_LEGACY_PLAN_PRECONDITION_CHANGED')
            }
            await afterPreconditionsForTests?.()

            let effectResult: Awaited<
              ReturnType<typeof applyAttendanceLegacyGroupEffectsV1>
            >

            if (
              org.acceptedWritePosture === 'legacy_projection_only' ||
              plan.manifest.operationalBranch !== 'strict_targeted'
            ) {
              // Legacy / operational-only: pure compatibility adapters, no
              // operation claim or W4 calculation rows.
              effectResult = await applyAttendanceLegacyGroupEffectsV1(
                trx,
                plan,
              )
              await insertSyncBatchRow(trx, plan, effectResult)
              await applyAttendanceLegacyRecordEffectsV1(trx, plan)
              await applyAttendanceLegacyItemEffectsV1(trx, plan)
            } else {
              // Shadow/authoritative strict: claim (malformed freeze fails
              // pre-DML), then shared execute for calculation/seals.
              const registryClaim =
                await claimAttendanceCanonicalImportRegistryV1(trx, {
                  job,
                  plan,
                  identities:
                    reservationIdentities as readonly VerifiedAttendanceOperationIdentityV1[],
                })
              if (registryClaim === null) {
                fail('W4C3A_SYNC_REGISTRY_CLAIM_MISSING')
              }
              effectResult = await executeShadowOrAuthoritative(trx, {
                job,
                plan,
                registryClaim,
              })
            }

            return buildAttendanceSyncImportResponseV1({
              plan,
              effectResult,
              elapsedMs: Math.max(0, Date.now() - startedAt),
              itemReturnPolicy: input.itemReturnPolicy,
              csvWarnings: input.csvWarnings ?? [],
              groupWarnings: input.groupWarnings ?? [],
            })
          },
        )
      } finally {
        acquired.release()
      }
    },
  })
}
