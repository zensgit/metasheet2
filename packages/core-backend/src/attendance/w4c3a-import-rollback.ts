import crypto from 'node:crypto'
import { canonicalAttendanceJsonV1 } from './w4c0-fingerprints'
import {
  acquireAttendanceCalculationRolloutLock,
  acquireAttendanceCalculationTargetLocks,
  acquireAttendanceResultOperationLocks,
  createVerifiedAttendanceCalculationTargetIdentityV1,
  createVerifiedAttendanceOperationIdentityV1,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  rehydrateVerifiedAttendanceOperationIdentityV1,
  rehydrateVerifiedAttendanceOrgIdentityV1,
  type AttendanceAcceptedWritePostureV1,
  type AttendanceW4TransactionClientV1,
} from './w4c0-identity'
import {
  requireAuthorizedCapabilityForEntrypointV1,
  type AuthorizedAttendanceWriteContextV1,
} from './w4c0-authorization'
import { runAttendanceResultOperationTransactionV1 } from './w4c0-operation-registry'
import { deriveAttendanceLegacyPlanReservationIdentitiesV1 } from './w4c3a-legacy-plan-processor'
import {
  isAttendanceProjectionOwnerV1,
  isAttendanceProjectionOwnerWithCalculationPointerV1,
  type AttendanceProjectionOwnerV1,
} from './w7-provenance-domain'

export const ATTENDANCE_IMPORT_ROLLBACK_ERROR_CODES_V1 = Object.freeze([
  'IMPORT_ROLLBACK_COMMAND_INVALID',
  'IMPORT_ROLLBACK_BATCH_CHANGED',
  'IMPORT_ROLLBACK_AUTHORIZATION_STALE',
  'IMPORT_ROLLBACK_NOT_FOUND',
  'IMPORT_ROLLBACK_SUPERSEDED',
  'IMPORT_ROLLBACK_PREIMAGE_INVALID',
  'IMPORT_ROLLBACK_PREIMAGE_UNAVAILABLE',
  'IMPORT_ROLLBACK_CONFLICT',
] as const)

export type AttendanceImportRollbackErrorCodeV1 =
  (typeof ATTENDANCE_IMPORT_ROLLBACK_ERROR_CODES_V1)[number]

export class AttendanceImportRollbackError extends Error {
  readonly code: AttendanceImportRollbackErrorCodeV1

  constructor(code: AttendanceImportRollbackErrorCodeV1) {
    super(code)
    this.name = 'AttendanceImportRollbackError'
    this.code = code
  }
}

export interface AttendanceImportRollbackTargetV1 {
  readonly attendanceRecordId: string
  readonly reversalOperationId: string
  readonly reversalCalculationId: string
}

export interface FrozenAttendanceImportRollbackCommandV1 {
  readonly orgId: string
  readonly rollbackOperationId: string
  readonly sourceBatchEntrypoint: 'import_batch' | 'integration_batch'
  readonly sourceBatchId: string
  readonly expectedSourceBatchFingerprint: string
  readonly authorization: AuthorizedAttendanceWriteContextV1
  readonly correlationId: string
  readonly targets: readonly AttendanceImportRollbackTargetV1[]
}

export interface AttendanceImportRollbackResultV1 {
  readonly replayed: boolean
  readonly rollbackOperationId: string
  readonly sourceBatchId: string
  readonly reversalCalculationIds: readonly string[]
  readonly affected: number
  readonly restored: number
  readonly retired: number
}

export interface AttendanceImportRollbackAuthorizationTargetV1 {
  readonly attendanceRecordId: string
  readonly userId: string
  readonly workDate: string
}

export interface AttendanceImportRollbackAuthorizationRecheckInputV1 {
  readonly orgId: string
  readonly sourceBatchEntrypoint: 'import_batch' | 'integration_batch'
  readonly sourceBatchId: string
  readonly sourceBatchActorId: string
  readonly sourceBatchActorPosture: string
  readonly sourceBatchTokenSubjectUserId: string | null
  readonly sourceBatchSubjectScope: unknown
  readonly authorization: AuthorizedAttendanceWriteContextV1
  readonly targets: readonly AttendanceImportRollbackAuthorizationTargetV1[]
}

declare const rollbackAuthorizationWitnessOpaque: unique symbol
export type AttendanceImportRollbackAuthorizationWitnessV1 = Readonly<{
  readonly [rollbackAuthorizationWitnessOpaque]: 'AttendanceImportRollbackAuthorizationWitnessV1'
}>

export interface AttendanceImportRollbackAuthorizationPortV1 {
  readonly recheckInTransaction: (
    trx: AttendanceW4TransactionClientV1,
    input: AttendanceImportRollbackAuthorizationRecheckInputV1,
  ) => Promise<AttendanceImportRollbackAuthorizationWitnessV1>
}

const commandWitnesses = new WeakSet<object>()
const rollbackAuthorizationPorts = new WeakSet<object>()
const rollbackAuthorizationWitnessDigests = new WeakMap<object, Buffer>()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HEX64 = /^[0-9a-f]{64}$/

export const ATTENDANCE_IMPORT_ROLLBACK_PREIMAGE_FINGERPRINT_DOMAIN_V1 =
  'metasheet2:attendance:w4c3a:rollback-preimage-fingerprint:v1'

function fail(code: AttendanceImportRollbackErrorCodeV1): never {
  throw new AttendanceImportRollbackError(code)
}

function exactObject(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail('IMPORT_ROLLBACK_COMMAND_INVALID')
  }
  const names = Object.getOwnPropertyNames(input)
  if (names.length !== keys.length || Object.getOwnPropertySymbols(input).length !== 0) {
    fail('IMPORT_ROLLBACK_COMMAND_INVALID')
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !('value' in descriptor)) fail('IMPORT_ROLLBACK_COMMAND_INVALID')
  }
  return input as Record<string, unknown>
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail('IMPORT_ROLLBACK_COMMAND_INVALID')
  return value.toLowerCase()
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) fail('IMPORT_ROLLBACK_COMMAND_INVALID')
  return value
}

function rollbackAuthorizationInputDigest(
  input: AttendanceImportRollbackAuthorizationRecheckInputV1,
): Buffer {
  return crypto.createHash('sha256').update(canonicalAttendanceJsonV1(input), 'utf8').digest()
}

/**
 * Host integration seam. The supplied recheck must be core-owned and must
 * re-evaluate the commit-equivalent target scope from durable rows using the
 * provided transaction. Request JSON or a plugin-returned boolean is not a
 * valid recheck. The wrapper mints the opaque witness only after the callback
 * succeeds and verifies that the frozen input did not change.
 */
export function createCoreAttendanceImportRollbackAuthorizationPortV1(
  recheck: (
    trx: AttendanceW4TransactionClientV1,
    input: AttendanceImportRollbackAuthorizationRecheckInputV1,
  ) => Promise<void>,
): AttendanceImportRollbackAuthorizationPortV1 {
  if (typeof recheck !== 'function') fail('IMPORT_ROLLBACK_COMMAND_INVALID')
  const port = Object.freeze({
    async recheckInTransaction(
      trx: AttendanceW4TransactionClientV1,
      input: AttendanceImportRollbackAuthorizationRecheckInputV1,
    ): Promise<AttendanceImportRollbackAuthorizationWitnessV1> {
      const before = rollbackAuthorizationInputDigest(input)
      await recheck(trx, input)
      const after = rollbackAuthorizationInputDigest(input)
      if (before.length !== after.length || !crypto.timingSafeEqual(before, after)) {
        fail('IMPORT_ROLLBACK_AUTHORIZATION_STALE')
      }
      const witness = Object.freeze({}) as AttendanceImportRollbackAuthorizationWitnessV1
      rollbackAuthorizationWitnessDigests.set(witness, before)
      return witness
    },
  })
  rollbackAuthorizationPorts.add(port)
  return port
}

function requireRollbackAuthorizationPort(
  port: AttendanceImportRollbackAuthorizationPortV1,
): AttendanceImportRollbackAuthorizationPortV1 {
  if (typeof port !== 'object' || port === null || !rollbackAuthorizationPorts.has(port)) {
    fail('IMPORT_ROLLBACK_AUTHORIZATION_STALE')
  }
  return port
}

function requireRollbackAuthorizationWitness(
  witness: AttendanceImportRollbackAuthorizationWitnessV1,
  input: AttendanceImportRollbackAuthorizationRecheckInputV1,
): void {
  if (typeof witness !== 'object' || witness === null) fail('IMPORT_ROLLBACK_AUTHORIZATION_STALE')
  const registered = rollbackAuthorizationWitnessDigests.get(witness)
  const expected = rollbackAuthorizationInputDigest(input)
  if (
    !registered ||
    registered.length !== expected.length ||
    !crypto.timingSafeEqual(registered, expected)
  ) {
    fail('IMPORT_ROLLBACK_AUTHORIZATION_STALE')
  }
}

export function createFrozenAttendanceImportRollbackCommandV1(
  input: unknown,
): FrozenAttendanceImportRollbackCommandV1 {
  const row = exactObject(input, [
    'orgId',
    'rollbackOperationId',
    'sourceBatchEntrypoint',
    'sourceBatchId',
    'expectedSourceBatchFingerprint',
    'authorization',
    'correlationId',
    'targets',
  ])
  const authorization = requireAuthorizedCapabilityForEntrypointV1(
    row.authorization,
    'import_rollback',
  )
  const orgId = text(row.orgId)
  if (authorization.orgId !== orgId) fail('IMPORT_ROLLBACK_COMMAND_INVALID')
  const sourceBatchEntrypoint = row.sourceBatchEntrypoint
  if (sourceBatchEntrypoint !== 'import_batch' && sourceBatchEntrypoint !== 'integration_batch') {
    fail('IMPORT_ROLLBACK_COMMAND_INVALID')
  }
  if (typeof row.expectedSourceBatchFingerprint !== 'string' || !HEX64.test(row.expectedSourceBatchFingerprint)) {
    fail('IMPORT_ROLLBACK_COMMAND_INVALID')
  }
  if (!Array.isArray(row.targets) || row.targets.length === 0) fail('IMPORT_ROLLBACK_COMMAND_INVALID')
  const targets = row.targets.map((entry) => {
    const target = exactObject(entry, [
      'attendanceRecordId',
      'reversalOperationId',
      'reversalCalculationId',
    ])
    return Object.freeze({
      attendanceRecordId: uuid(target.attendanceRecordId),
      reversalOperationId: uuid(target.reversalOperationId),
      reversalCalculationId: uuid(target.reversalCalculationId),
    })
  })
  if (
    new Set(targets.map((target) => target.attendanceRecordId)).size !== targets.length ||
    new Set(targets.map((target) => target.reversalOperationId)).size !== targets.length ||
    new Set(targets.map((target) => target.reversalCalculationId)).size !== targets.length
  ) {
    fail('IMPORT_ROLLBACK_COMMAND_INVALID')
  }
  const rollbackOperationId = uuid(row.rollbackOperationId)
  if (targets.some((target) => target.reversalOperationId === rollbackOperationId)) {
    fail('IMPORT_ROLLBACK_COMMAND_INVALID')
  }
  const command = Object.freeze({
    orgId,
    rollbackOperationId,
    sourceBatchEntrypoint,
    sourceBatchId: uuid(row.sourceBatchId),
    expectedSourceBatchFingerprint: row.expectedSourceBatchFingerprint,
    authorization,
    correlationId: text(row.correlationId),
    targets: Object.freeze(targets),
  }) as FrozenAttendanceImportRollbackCommandV1
  commandWitnesses.add(command)
  return command
}

interface BatchRow {
  identity_source_kind: string
  source_root_id: string
  actor_id: string
  actor_posture: string
  token_subject_user_id: string | null
  subject_scope: unknown
  accepted_write_posture: AttendanceAcceptedWritePostureV1
  command_fingerprint: string
  item_count: number
  state: string
}

interface SourceItemOperationRow {
  entrypoint: string
  operation_id: string
  batch_command_id: string | null
  identity_source_kind: string
  source_root_id: string | null
  input_ordinal: number | string | null
  proof_semantic_fingerprint: string | null
  proof_user_id: string | null
  proof_work_date: string | null
  accepted_write_posture: string
  resolved_record_id: string | null
  resolved_calculation_id: string | null
  state: string
}

interface RecordRow {
  id: string
  user_id: string
  work_date: string
  current_calculation_id: string | null
  projection_owner: string
  visibility_state: string
  visibility_reason: string
  status: string
  first_in_at: string | null
  last_out_at: string | null
  work_minutes: number
  late_minutes: number
  early_leave_minutes: number
}

export type AttendanceImportRollbackSourceJobCandidateV1 = Readonly<{
  id: string
  status: string
  w4ContractVersion: 1 | null
  entrypoint: string | null
  batchCommandId: string | null
  acceptedWritePosture: AttendanceAcceptedWritePostureV1 | null
  identityProofVector: unknown
}>

let beforeRollbackDmlForTests: (() => Promise<void>) | null = null

/** Test-only barrier after final target/source rechecks and before reversal DML. */
export function __setW4C3aImportRollbackBeforeDmlForTests(
  hook: (() => Promise<void>) | null,
): void {
  beforeRollbackDmlForTests = hook
}

interface CalculationRow {
  id: string
  attendance_record_id: string
  version: number
  entrypoint: string
  source_batch_id: string | null
  semantic_input_fingerprint: string
  provenance_fingerprint: string
  source_definition_fingerprint: string
  attribution_snapshot: unknown
  context_snapshot: unknown
  segment_snapshot: unknown
  evidence_snapshot: unknown
  approved_facts_snapshot: unknown
  manual_override_snapshot: unknown
  input_provenance: unknown
  projected_status: string | null
  projected_first_in_at: string | null
  projected_last_out_at: string | null
  projected_work_minutes: number | null
  projected_late_minutes: number | null
  projected_early_leave_minutes: number | null
  projected_daily_fingerprint: string | null
  parent_preimage_snapshot: unknown
}

export type AttendanceImportRollbackProjectionV1 = Readonly<{
  status: string
  firstInAt: string | null
  lastOutAt: string | null
  workMinutes: number
  lateMinutes: number
  earlyLeaveMinutes: number
}>

export type AttendanceImportRollbackPresentPreimageFingerprintInputV1 = Readonly<{
  projection: AttendanceImportRollbackProjectionV1
  projectionOwner: AttendanceProjectionOwnerV1
  currentCalculationId: string | null
  visibilityState: 'active' | 'retired'
  visibilityReason: 'active' | 'review_placeholder' | 'import_rollback' | 'operator_retirement'
}>

export type FrozenAttendanceImportRollbackPreimageV1 = Readonly<{
  posture: 'absent' | 'present'
  projectionOwner?: AttendanceProjectionOwnerV1
  currentCalculationId?: string | null
  visibilityState?: 'active' | 'retired'
  visibilityReason?: 'active' | 'review_placeholder' | 'import_rollback' | 'operator_retirement'
  compatibilityFingerprint?: string
  projection?: AttendanceImportRollbackProjectionV1
}>

function preimageObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('IMPORT_ROLLBACK_PREIMAGE_INVALID')
  }
  const row = value as Record<string, unknown>
  const names = Object.keys(row).sort()
  const expected = [...keys].sort()
  if (
    names.length !== expected.length ||
    names.some((name, index) => name !== expected[index]) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    fail('IMPORT_ROLLBACK_PREIMAGE_INVALID')
  }
  return row
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail('IMPORT_ROLLBACK_PREIMAGE_INVALID')
  }
  return value as number
}

function nullableTimestamp(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length === 0 || !Number.isFinite(Date.parse(value))) {
    fail('IMPORT_ROLLBACK_PREIMAGE_INVALID')
  }
  return value
}

export function parseAttendanceImportRollbackPresentPreimageFingerprintInputV1(
  value: unknown,
): AttendanceImportRollbackPresentPreimageFingerprintInputV1 {
  const row = preimageObject(value, [
    'projection',
    'projectionOwner',
    'currentCalculationId',
    'visibilityState',
    'visibilityReason',
  ])
  const projection = preimageObject(row.projection, [
    'status',
    'firstInAt',
    'lastOutAt',
    'workMinutes',
    'lateMinutes',
    'earlyLeaveMinutes',
  ])
  // W7-1a-M (#4556, ratified per #4556 comments 5293034619 + 5293478713): the
  // membership test and the pointer-coupling disjunction are widened together —
  // widening only the first would admit `w4_group` and then reject it here.
  // `w4_group` takes `w4`'s non-NULL-pointer arm (semantic ruling).
  if (
    !isAttendanceProjectionOwnerV1(row.projectionOwner) ||
    !(
      (row.projectionOwner === 'legacy_untracked' && row.currentCalculationId === null) ||
      (isAttendanceProjectionOwnerWithCalculationPointerV1(row.projectionOwner) &&
        typeof row.currentCalculationId === 'string' &&
        UUID.test(row.currentCalculationId))
    ) ||
    (row.visibilityState !== 'active' && row.visibilityState !== 'retired') ||
    (row.visibilityReason !== 'active' &&
      row.visibilityReason !== 'review_placeholder' &&
      row.visibilityReason !== 'import_rollback' &&
      row.visibilityReason !== 'operator_retirement') ||
    (row.visibilityState === 'active' && row.visibilityReason !== 'active') ||
    (row.visibilityState === 'retired' && row.visibilityReason === 'active') ||
    typeof projection.status !== 'string' ||
    projection.status.length === 0
  ) {
    fail('IMPORT_ROLLBACK_PREIMAGE_INVALID')
  }
  return Object.freeze({
    projection: Object.freeze({
      status: projection.status,
      firstInAt: nullableTimestamp(projection.firstInAt),
      lastOutAt: nullableTimestamp(projection.lastOutAt),
      workMinutes: nonNegativeInteger(projection.workMinutes),
      lateMinutes: nonNegativeInteger(projection.lateMinutes),
      earlyLeaveMinutes: nonNegativeInteger(projection.earlyLeaveMinutes),
    }),
    projectionOwner: row.projectionOwner,
    // W7-1a-M: pointer-bearing owners keep their pointer. Left as `=== 'w4'` this
    // would silently NULL a `w4_group` pointer — the exact silent-downgrade shape
    // the ratification names.
    currentCalculationId: isAttendanceProjectionOwnerWithCalculationPointerV1(row.projectionOwner)
      ? uuid(row.currentCalculationId)
      : null,
    visibilityState: row.visibilityState,
    visibilityReason: row.visibilityReason,
  }) as AttendanceImportRollbackPresentPreimageFingerprintInputV1
}

export function computeAttendanceImportRollbackPreimageFingerprintV1(input: unknown): string {
  const parsed = parseAttendanceImportRollbackPresentPreimageFingerprintInputV1(input)
  return crypto
    .createHash('sha256')
    .update(
      Buffer.concat([
        Buffer.from(ATTENDANCE_IMPORT_ROLLBACK_PREIMAGE_FINGERPRINT_DOMAIN_V1, 'utf8'),
        Buffer.from([0]),
        Buffer.from(canonicalAttendanceJsonV1(parsed), 'utf8'),
      ]),
    )
    .digest('hex')
}

export function parseAttendanceImportRollbackPreimageV1(
  value: unknown,
): FrozenAttendanceImportRollbackPreimageV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('IMPORT_ROLLBACK_PREIMAGE_INVALID')
  }
  const row = value as Record<string, unknown>
  const rootKeys = Object.keys(row).sort()
  if (row.posture === 'absent') {
    if (rootKeys.length !== 1 || rootKeys[0] !== 'posture') {
      fail('IMPORT_ROLLBACK_PREIMAGE_INVALID')
    }
    return { posture: 'absent' }
  }
  const expectedRootKeys = [
    'compatibilityFingerprint',
    'currentCalculationId',
    'posture',
    'projection',
    'projectionOwner',
    'visibilityReason',
    'visibilityState',
  ]
  if (
    rootKeys.length !== expectedRootKeys.length ||
    rootKeys.some((key, index) => key !== expectedRootKeys[index]) ||
    row.posture !== 'present' ||
    // W7-1a-M: second, independent copy of the same exhaustive gate — widened in
    // lockstep with the first (membership + pointer-coupling disjunction).
    !isAttendanceProjectionOwnerV1(row.projectionOwner) ||
    !(
      (row.projectionOwner === 'legacy_untracked' && row.currentCalculationId === null) ||
      (isAttendanceProjectionOwnerWithCalculationPointerV1(row.projectionOwner) &&
        typeof row.currentCalculationId === 'string' &&
        UUID.test(row.currentCalculationId))
    ) ||
    (row.visibilityState !== 'active' && row.visibilityState !== 'retired') ||
    typeof row.visibilityReason !== 'string' ||
    typeof row.compatibilityFingerprint !== 'string' ||
    !HEX64.test(row.compatibilityFingerprint) ||
    typeof row.projection !== 'object' ||
    row.projection === null ||
    Array.isArray(row.projection)
  ) {
    fail('IMPORT_ROLLBACK_PREIMAGE_INVALID')
  }
  const fingerprintInput = parseAttendanceImportRollbackPresentPreimageFingerprintInputV1({
    projection: row.projection,
    projectionOwner: row.projectionOwner,
    currentCalculationId: row.currentCalculationId,
    visibilityState: row.visibilityState,
    visibilityReason: row.visibilityReason,
  })
  const computedFingerprint = computeAttendanceImportRollbackPreimageFingerprintV1(fingerprintInput)
  if (computedFingerprint !== row.compatibilityFingerprint) {
    fail('IMPORT_ROLLBACK_PREIMAGE_INVALID')
  }
  return Object.freeze({
    posture: 'present',
    ...fingerprintInput,
    compatibilityFingerprint: row.compatibilityFingerprint,
  })
}

function commandFingerprint(command: FrozenAttendanceImportRollbackCommandV1): string {
  return crypto
    .createHash('sha256')
    .update(
      canonicalAttendanceJsonV1({
        orgId: command.orgId,
        rollbackOperationId: command.rollbackOperationId,
        sourceBatchEntrypoint: command.sourceBatchEntrypoint,
        sourceBatchId: command.sourceBatchId,
        expectedSourceBatchFingerprint: command.expectedSourceBatchFingerprint,
        correlationId: command.correlationId,
        targets: command.targets,
      }),
    )
    .digest('hex')
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const expected = new Set(right)
  return expected.size === right.length && left.every((value) => expected.has(value))
}

async function readReplay(
  trx: AttendanceW4TransactionClientV1,
  command: FrozenAttendanceImportRollbackCommandV1,
  fingerprint: string,
): Promise<AttendanceImportRollbackResultV1 | null> {
  const result = await trx.query(
    `SELECT c.source_batch_entrypoint, c.source_batch_id::text, c.actor_id, c.actor_posture,
            c.correlation_id, o.command_fingerprint, o.state, o.response_snapshot
       FROM attendance_import_rollback_commands c
       JOIN attendance_result_operations o
         ON o.org_id = c.org_id
        AND o.entrypoint = c.rollback_entrypoint
        AND o.operation_id = c.rollback_operation_id
      WHERE c.org_id = $1 AND c.rollback_operation_id = $2::uuid`,
    [command.orgId, command.rollbackOperationId],
  )
  if (result.rows.length === 0) return null
  const row = result.rows[0]
  if (
    row.source_batch_entrypoint !== command.sourceBatchEntrypoint ||
    row.source_batch_id !== command.sourceBatchId ||
    row.actor_id !== command.authorization.actorId ||
    row.actor_posture !== command.authorization.actorPosture ||
    row.correlation_id !== command.correlationId ||
    row.command_fingerprint !== fingerprint ||
    row.state !== 'completed' ||
    typeof row.response_snapshot !== 'object' ||
    row.response_snapshot === null
  ) {
    fail('IMPORT_ROLLBACK_CONFLICT')
  }
  const ids = (row.response_snapshot as { reversalCalculationIds?: unknown }).reversalCalculationIds
  const affected = (row.response_snapshot as { affected?: unknown }).affected
  const restored = (row.response_snapshot as { restored?: unknown }).restored
  const retired = (row.response_snapshot as { retired?: unknown }).retired
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== 'string') ||
    !Number.isSafeInteger(affected) ||
    !Number.isSafeInteger(restored) ||
    !Number.isSafeInteger(retired) ||
    (affected as number) < 0 ||
    (restored as number) < 0 ||
    (retired as number) < 0 ||
    (restored as number) + (retired as number) !== affected
  ) {
    fail('IMPORT_ROLLBACK_CONFLICT')
  }
  return Object.freeze({
    replayed: true,
    rollbackOperationId: command.rollbackOperationId,
    sourceBatchId: command.sourceBatchId,
    reversalCalculationIds: Object.freeze([...ids] as string[]),
    affected: affected as number,
    restored: restored as number,
    retired: retired as number,
  })
}

async function insertOperation(
  trx: AttendanceW4TransactionClientV1,
  input: {
    command: FrozenAttendanceImportRollbackCommandV1
    operationId: string
    acceptedWritePosture: string
    fingerprint: string
  },
): Promise<void> {
  const auth = input.command.authorization
  await trx.query(
    `INSERT INTO attendance_result_operations (
       org_id, entrypoint, operation_id, identity_source_kind, source_ref,
       actor_id, actor_posture, token_subject_user_id, capability, subject_scope,
       command_fingerprint, accepted_write_posture, state
     ) VALUES ($1, 'import_rollback', $2::uuid, 'direct_import_rollback', $3,
       $4, $5, $6, 'rollback', $7::jsonb, $8, $9, 'claimed')`,
    [
      input.command.orgId,
      input.operationId,
      auth.sourceRef,
      auth.actorId,
      auth.actorPosture,
      auth.tokenSubjectUserId,
      canonicalAttendanceJsonV1(auth.subjectScope),
      input.fingerprint,
      input.acceptedWritePosture,
    ],
  )
}

const SOURCE_ITEM_COLUMNS = `entrypoint, operation_id::text, batch_command_id::text,
  identity_source_kind, source_root_id::text, input_ordinal,
  proof_semantic_fingerprint, proof_user_id::text, proof_work_date::text,
  accepted_write_posture, resolved_record_id::text,
  resolved_calculation_id::text, state`

async function readSourceBatch(
  trx: AttendanceW4TransactionClientV1,
  command: FrozenAttendanceImportRollbackCommandV1,
  lock: boolean,
): Promise<BatchRow> {
  const result = await trx.query(
    `SELECT identity_source_kind, source_root_id::text, actor_id, actor_posture,
            token_subject_user_id, subject_scope, accepted_write_posture,
            command_fingerprint, item_count, state
       FROM attendance_result_operation_batches
      WHERE org_id = $1 AND entrypoint = $2 AND batch_command_id = $3::uuid
      ${lock ? 'FOR UPDATE' : ''}`,
    [command.orgId, command.sourceBatchEntrypoint, command.sourceBatchId],
  )
  if (result.rows.length !== 1) fail('IMPORT_ROLLBACK_NOT_FOUND')
  const batch = result.rows[0] as unknown as BatchRow
  if (
    batch.identity_source_kind !== command.sourceBatchEntrypoint ||
    batch.source_root_id !== command.sourceBatchId ||
    batch.state !== 'completed' ||
    batch.command_fingerprint !== command.expectedSourceBatchFingerprint ||
    !Number.isSafeInteger(batch.item_count) ||
    batch.item_count < 1
  ) {
    fail('IMPORT_ROLLBACK_BATCH_CHANGED')
  }
  return batch
}

async function readSourceItemOperations(
  trx: AttendanceW4TransactionClientV1,
  command: FrozenAttendanceImportRollbackCommandV1,
): Promise<SourceItemOperationRow[]> {
  const result = await trx.query(
    `SELECT ${SOURCE_ITEM_COLUMNS}
       FROM attendance_result_operations
      WHERE org_id = $1
        AND entrypoint = $2
        AND batch_command_id = $3::uuid
      ORDER BY input_ordinal, operation_id`,
    [command.orgId, command.sourceBatchEntrypoint, command.sourceBatchId],
  )
  return result.rows as unknown as SourceItemOperationRow[]
}

export async function readAttendanceImportRollbackSourceJobsV1(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  batchId: string,
  lock = false,
): Promise<AttendanceImportRollbackSourceJobCandidateV1[]> {
  const result = await trx.query(
    `SELECT id::text, status, w4_contract_version, w4_entrypoint,
            w4_batch_command_id::text, w4_accepted_write_posture,
            w4_identity_proof_vector
       FROM attendance_import_jobs
      WHERE org_id = $1 AND batch_id = $2::uuid
      ORDER BY id
      ${lock ? 'FOR UPDATE' : ''}`,
    [orgId, batchId],
  )
  return result.rows.map((row) => {
    const version = row.w4_contract_version
    if (version !== null && version !== 1) fail('IMPORT_ROLLBACK_BATCH_CHANGED')
    if (version === null) {
      if (
        row.w4_entrypoint !== null ||
        row.w4_batch_command_id !== null ||
        row.w4_accepted_write_posture !== null ||
        row.w4_identity_proof_vector !== null
      ) {
        fail('IMPORT_ROLLBACK_BATCH_CHANGED')
      }
    } else if (
      row.status !== 'completed' ||
      row.w4_entrypoint !== 'import_batch' ||
      row.w4_batch_command_id !== batchId ||
      !['legacy_projection_only', 'shadow', 'authoritative'].includes(
        String(row.w4_accepted_write_posture),
      ) ||
      !Array.isArray(row.w4_identity_proof_vector)
    ) {
      fail('IMPORT_ROLLBACK_BATCH_CHANGED')
    }
    return Object.freeze({
      id: String(row.id),
      status: String(row.status),
      w4ContractVersion: version as 1 | null,
      entrypoint: typeof row.w4_entrypoint === 'string' ? row.w4_entrypoint : null,
      batchCommandId:
        typeof row.w4_batch_command_id === 'string' ? row.w4_batch_command_id : null,
      acceptedWritePosture:
        version === 1
          ? (row.w4_accepted_write_posture as AttendanceAcceptedWritePostureV1)
          : null,
      identityProofVector: row.w4_identity_proof_vector,
    })
  })
}

export function deriveAttendanceImportRollbackSourceJobIdentitiesV1(
  orgId: string,
  batchId: string,
  jobs: readonly AttendanceImportRollbackSourceJobCandidateV1[],
) {
  return jobs.flatMap((job) => {
    if (job.w4ContractVersion === null) return []
    if (job.acceptedWritePosture === null || job.batchCommandId !== batchId) {
      fail('IMPORT_ROLLBACK_BATCH_CHANGED')
    }
    return deriveAttendanceLegacyPlanReservationIdentitiesV1({
      orgId,
      acceptedWritePosture: job.acceptedWritePosture,
      batchId,
      identityProofVector: job.identityProofVector,
    })
  })
}

export async function lockAttendanceImportRollbackSourceJobsV1(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  batchId: string,
  candidates: readonly AttendanceImportRollbackSourceJobCandidateV1[],
): Promise<void> {
  const locked = await readAttendanceImportRollbackSourceJobsV1(trx, orgId, batchId, true)
  if (canonicalAttendanceJsonV1(locked) !== canonicalAttendanceJsonV1(candidates)) {
    fail('IMPORT_ROLLBACK_BATCH_CHANGED')
  }
}

function validateSourceItemOperations(
  batch: BatchRow,
  sourceItems: readonly SourceItemOperationRow[],
): string[] {
  if (
    sourceItems.length !== batch.item_count ||
    sourceItems.some(
      (item) =>
        item.entrypoint !== item.identity_source_kind.replace('_item', '_batch') ||
        item.batch_command_id !== batch.source_root_id ||
        item.source_root_id !== batch.source_root_id ||
        item.accepted_write_posture !== batch.accepted_write_posture ||
        item.state !== 'completed' ||
        (item.resolved_record_id === null) !== (item.resolved_calculation_id === null),
    )
  ) {
    fail('IMPORT_ROLLBACK_BATCH_CHANGED')
  }
  const operationRecordIds = Array.from(
    new Set(
      sourceItems
        .map((item) => item.resolved_record_id)
        .filter((value): value is string => value !== null),
    ),
  ).sort()
  for (const recordId of operationRecordIds) {
    const calculationIds = new Set(
      sourceItems
        .filter((item) => item.resolved_record_id === recordId)
        .map((item) => item.resolved_calculation_id),
    )
    if (calculationIds.size !== 1 || calculationIds.has(null)) {
      fail('IMPORT_ROLLBACK_BATCH_CHANGED')
    }
  }
  return operationRecordIds
}

async function readDurableImportRecordIds(
  trx: AttendanceW4TransactionClientV1,
  command: FrozenAttendanceImportRollbackCommandV1,
  lock: boolean,
): Promise<string[]> {
  if (command.sourceBatchEntrypoint !== 'import_batch') return []
  const result = await trx.query(
    `SELECT record_id::text
       FROM attendance_import_items
      WHERE org_id = $1 AND batch_id = $2::uuid
      ORDER BY id
      ${lock ? 'FOR UPDATE' : ''}`,
    [command.orgId, command.sourceBatchId],
  )
  return Array.from(
    new Set(
      result.rows
        .map((row) => row.record_id)
        .filter((value): value is string => typeof value === 'string'),
    ),
  ).sort()
}

async function lockCompatibilityImportBatchRow(
  trx: AttendanceW4TransactionClientV1,
  command: FrozenAttendanceImportRollbackCommandV1,
): Promise<void> {
  // The production boundary derives P23 ownership for both batch entrypoints
  // from this compatibility row, so both must retain and lock it.
  const result = await trx.query(
    `SELECT id::text
       FROM attendance_import_batches
      WHERE org_id = $1 AND id = $2::uuid
      FOR UPDATE`,
    [command.orgId, command.sourceBatchId],
  )
  if (result.rows.length !== 1) fail('IMPORT_ROLLBACK_NOT_FOUND')
}

function resolveDurableRecordIds(
  command: FrozenAttendanceImportRollbackCommandV1,
  operationRecordIds: readonly string[],
  importRecordIds: readonly string[],
): string[] {
  if (
    command.sourceBatchEntrypoint === 'import_batch' &&
    operationRecordIds.length > 0 &&
    !sameStringSet(importRecordIds, operationRecordIds)
  ) {
    fail('IMPORT_ROLLBACK_BATCH_CHANGED')
  }
  const durableRecordIds =
    command.sourceBatchEntrypoint === 'import_batch' ? [...importRecordIds] : [...operationRecordIds]
  const commandRecordIds = command.targets.map((target) => target.attendanceRecordId).sort()
  if (durableRecordIds.length === 0 || !sameStringSet(commandRecordIds, durableRecordIds)) {
    fail('IMPORT_ROLLBACK_BATCH_CHANGED')
  }
  return durableRecordIds
}

function sourceBatchIdentity(
  org: ReturnType<typeof rehydrateVerifiedAttendanceOrgIdentityV1>,
  command: FrozenAttendanceImportRollbackCommandV1,
) {
  const source =
    command.sourceBatchEntrypoint === 'import_batch'
      ? { sourceKind: 'import_batch', batchCommandId: command.sourceBatchId }
      : { sourceKind: 'integration_batch', syncRunId: command.sourceBatchId }
  return createVerifiedAttendanceOperationIdentityV1({
    org,
    kind: 'batch',
    entrypoint: command.sourceBatchEntrypoint,
    source,
  })
}

function sourceItemIdentity(orgId: string, item: SourceItemOperationRow) {
  return rehydrateVerifiedAttendanceOperationIdentityV1({
    orgId,
    entrypoint: item.entrypoint,
    kind: 'item',
    operationId: item.operation_id,
    acceptedWritePosture: item.accepted_write_posture,
    identitySourceKind: item.identity_source_kind,
    sourceRootId: item.source_root_id,
    inputOrdinal: item.input_ordinal,
    proofSemanticFingerprint: item.proof_semantic_fingerprint,
    proofUserId: item.proof_user_id,
    proofWorkDate: item.proof_work_date,
  })
}

async function lockCorrespondingOperationRows(
  trx: AttendanceW4TransactionClientV1,
  command: FrozenAttendanceImportRollbackCommandV1,
  sourceOperationIds: readonly string[],
): Promise<void> {
  const rollbackOperationIds = [
    command.rollbackOperationId,
    ...command.targets.map((target) => target.reversalOperationId),
  ]
  const result = await trx.query(
    `SELECT entrypoint, operation_id::text
       FROM attendance_result_operations
      WHERE org_id = $1
        AND (
          (entrypoint = $2 AND operation_id = ANY($3::uuid[]))
          OR (entrypoint = 'import_rollback' AND operation_id = ANY($4::uuid[]))
        )
      ORDER BY entrypoint, operation_id
      FOR UPDATE`,
    [command.orgId, command.sourceBatchEntrypoint, sourceOperationIds, rollbackOperationIds],
  )
  const lockedSourceIds = result.rows
    .filter((row) => row.entrypoint === command.sourceBatchEntrypoint)
    .map((row) => String(row.operation_id))
  if (!sameStringSet(lockedSourceIds, sourceOperationIds)) {
    fail('IMPORT_ROLLBACK_BATCH_CHANGED')
  }
}

async function readTargetRecords(
  trx: AttendanceW4TransactionClientV1,
  command: FrozenAttendanceImportRollbackCommandV1,
  recordIds: readonly string[],
  lock: boolean,
): Promise<Map<string, RecordRow>> {
  const result = await trx.query(
    `SELECT id::text, user_id::text, work_date::text, current_calculation_id::text,
            projection_owner, visibility_state, visibility_reason, status,
            first_in_at::text, last_out_at::text, work_minutes,
            late_minutes, early_leave_minutes
       FROM attendance_records
      WHERE org_id = $1 AND id = ANY($2::uuid[])
      ORDER BY user_id, work_date, id
      ${lock ? 'FOR UPDATE' : ''}`,
    [command.orgId, recordIds],
  )
  if (result.rows.length !== command.targets.length) fail('IMPORT_ROLLBACK_NOT_FOUND')
  return new Map((result.rows as unknown as RecordRow[]).map((row) => [row.id, row]))
}

async function executeRollback(
  trx: AttendanceW4TransactionClientV1,
  command: FrozenAttendanceImportRollbackCommandV1,
  authorizationPort: AttendanceImportRollbackAuthorizationPortV1,
): Promise<AttendanceImportRollbackResultV1> {
  const auth = requireAuthorizedCapabilityForEntrypointV1(command.authorization, 'import_rollback')

  const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(command.orgId)
  await acquireAttendanceCalculationRolloutLock(trx, orgKey, 'shared')

  // Section 8.2 step 1: these reads derive candidates only. They acquire no
  // row locks and confer no authority until the complete identity lock set is
  // held and every durable row is re-read below.
  const preflightBatch = await readSourceBatch(trx, command, false)
  const preflightSourceItems = await readSourceItemOperations(trx, command)
  const preflightSourceJobs = await readAttendanceImportRollbackSourceJobsV1(
    trx,
    command.orgId,
    command.sourceBatchId,
  )
  const preflightOperationRecordIds = validateSourceItemOperations(
    preflightBatch,
    preflightSourceItems,
  )
  const preflightImportRecordIds = await readDurableImportRecordIds(trx, command, false)
  const candidateRecordIds = resolveDurableRecordIds(
    command,
    preflightOperationRecordIds,
    preflightImportRecordIds,
  )
  const preflightRecords = await readTargetRecords(trx, command, candidateRecordIds, false)
  const recordIds = Array.from(preflightRecords.values())
    .sort((left, right) =>
      left.user_id.localeCompare(right.user_id) ||
      left.work_date.localeCompare(right.work_date) ||
      left.id.localeCompare(right.id),
    )
    .map((record) => record.id)
  const org = rehydrateVerifiedAttendanceOrgIdentityV1({
    orgId: command.orgId,
    acceptedWritePosture: preflightBatch.accepted_write_posture,
  })
  const rollbackOperationIdentities = [
    command.rollbackOperationId,
    ...command.targets.map((target) => target.reversalOperationId),
  ].map(
    (operationId) =>
      createVerifiedAttendanceOperationIdentityV1({
        org,
        kind: 'item',
        entrypoint: 'import_rollback',
        source: { sourceKind: 'direct_import_rollback', clientOperationId: operationId },
      }),
  )
  const operationIdentities = [
    sourceBatchIdentity(org, command),
    ...preflightSourceItems.map((item) => sourceItemIdentity(command.orgId, item)),
    ...deriveAttendanceImportRollbackSourceJobIdentitiesV1(
      command.orgId,
      command.sourceBatchId,
      preflightSourceJobs,
    ),
    ...rollbackOperationIdentities,
  ]
  await acquireAttendanceResultOperationLocks(trx, operationIdentities)

  // No source/operation row is locked before the complete canonical advisory
  // set above. Corresponding operation rows precede batch and source-item rows.
  await lockCorrespondingOperationRows(
    trx,
    command,
    preflightSourceItems.map((item) => item.operation_id),
  )
  await lockAttendanceImportRollbackSourceJobsV1(
    trx,
    command.orgId,
    command.sourceBatchId,
    preflightSourceJobs,
  )
  const sourceItems = await readSourceItemOperations(trx, command)
  if (
    canonicalAttendanceJsonV1(sourceItems) !==
    canonicalAttendanceJsonV1(preflightSourceItems)
  ) {
    fail('IMPORT_ROLLBACK_BATCH_CHANGED')
  }
  const batch = await readSourceBatch(trx, command, true)
  if (canonicalAttendanceJsonV1(batch) !== canonicalAttendanceJsonV1(preflightBatch)) {
    fail('IMPORT_ROLLBACK_BATCH_CHANGED')
  }
  await lockCompatibilityImportBatchRow(trx, command)
  const lockedImportRecordIds = await readDurableImportRecordIds(trx, command, true)
  const lockedRecordIds = resolveDurableRecordIds(
    command,
    validateSourceItemOperations(batch, sourceItems),
    lockedImportRecordIds,
  )
  if (!sameStringSet(lockedRecordIds, recordIds)) fail('IMPORT_ROLLBACK_BATCH_CHANGED')

  const buildAuthorizationInput = (
    records: ReadonlyMap<string, RecordRow>,
  ): AttendanceImportRollbackAuthorizationRecheckInputV1 =>
    Object.freeze({
      orgId: command.orgId,
      sourceBatchEntrypoint: command.sourceBatchEntrypoint,
      sourceBatchId: command.sourceBatchId,
      sourceBatchActorId: batch.actor_id,
      sourceBatchActorPosture: batch.actor_posture,
      sourceBatchTokenSubjectUserId: batch.token_subject_user_id,
      sourceBatchSubjectScope: batch.subject_scope,
      authorization: auth,
      targets: Object.freeze(
        recordIds.map((recordId) => {
          const record = records.get(recordId)
          if (!record) fail('IMPORT_ROLLBACK_NOT_FOUND')
          return Object.freeze({
            attendanceRecordId: record.id,
            userId: record.user_id,
            workDate: record.work_date,
          })
        }),
      ),
    })

  // Completed replay is still authorization-gated, but needs no target locks
  // or reversal DML. New work repeats this recheck from locked target facts.
  const replayAuthorizationInput = buildAuthorizationInput(preflightRecords)
  const replayAuthorizationWitness = await authorizationPort.recheckInTransaction(
    trx,
    replayAuthorizationInput,
  )
  requireRollbackAuthorizationWitness(replayAuthorizationWitness, replayAuthorizationInput)

  const fingerprint = commandFingerprint(command)
  const replay = await readReplay(trx, command, fingerprint)
  if (replay) return replay

  const conflicting = await trx.query(
    `SELECT rollback_operation_id::text
       FROM attendance_import_rollback_commands
      WHERE org_id = $1
        AND source_batch_entrypoint = $2
        AND source_batch_id = $3::uuid`,
    [command.orgId, command.sourceBatchEntrypoint, command.sourceBatchId],
  )
  if (conflicting.rows.length !== 0) fail('IMPORT_ROLLBACK_CONFLICT')

  const targetsByRecord = new Map(command.targets.map((target) => [target.attendanceRecordId, target]))

  const targetIdentities = recordIds.map((recordId) => {
    const record = preflightRecords.get(recordId)
    if (!record) fail('IMPORT_ROLLBACK_NOT_FOUND')
    return createVerifiedAttendanceCalculationTargetIdentityV1({
      org,
      userId: record.user_id,
      workDate: record.work_date,
    })
  })
  await acquireAttendanceCalculationTargetLocks(trx, targetIdentities)

  const records = await readTargetRecords(trx, command, recordIds, true)
  for (const recordId of recordIds) {
    const before = preflightRecords.get(recordId)
    const locked = records.get(recordId)
    if (
      !before ||
      !locked ||
      before.user_id !== locked.user_id ||
      before.work_date !== locked.work_date
    ) {
      fail('IMPORT_ROLLBACK_BATCH_CHANGED')
    }
  }

  const closure = await trx.query(
    `SELECT 1
       FROM attendance_import_rollback_closures
      WHERE org_id = $1 AND batch_id = $2::uuid
      LIMIT 1`,
    [command.orgId, command.sourceBatchId],
  )
  if (closure.rows.length !== 0) fail('IMPORT_ROLLBACK_CONFLICT')

  const currentIds = recordIds.map((recordId) => records.get(recordId)?.current_calculation_id)
  if (currentIds.some((id) => id === null || id === undefined)) fail('IMPORT_ROLLBACK_SUPERSEDED')
  const calculationsResult = await trx.query(
    `SELECT id::text, attendance_record_id::text, version, entrypoint,
            source_batch_id::text, semantic_input_fingerprint, provenance_fingerprint,
            source_definition_fingerprint, attribution_snapshot, context_snapshot,
            segment_snapshot, evidence_snapshot, approved_facts_snapshot,
            manual_override_snapshot, input_provenance, projected_status,
            projected_first_in_at::text, projected_last_out_at::text,
            projected_work_minutes, projected_late_minutes,
            projected_early_leave_minutes, projected_daily_fingerprint,
            parent_preimage_snapshot
       FROM attendance_record_calculations
      WHERE org_id = $1 AND id = ANY($2::uuid[])
      ORDER BY id
      FOR UPDATE`,
    [command.orgId, currentIds],
  )
  if (calculationsResult.rows.length !== command.targets.length) fail('IMPORT_ROLLBACK_SUPERSEDED')
  const calculations = new Map(
    (calculationsResult.rows as unknown as CalculationRow[]).map((row) => [row.attendance_record_id, row]),
  )
  const preimages = new Map<string, FrozenAttendanceImportRollbackPreimageV1>()
  let restored = 0
  let retired = 0
  for (const recordId of recordIds) {
    const record = records.get(recordId)
    const calculation = calculations.get(recordId)
    if (
      !record ||
      !calculation ||
      // W7-1a-M: pointer-owning parents are rollback-eligible; `w4_group` inherits
      // `w4`'s arm rather than silently failing SUPERSEDED.
      !isAttendanceProjectionOwnerWithCalculationPointerV1(record.projection_owner) ||
      record.current_calculation_id !== calculation.id ||
      calculation.source_batch_id !== command.sourceBatchId ||
      !['legacy_import', 'integration_sync'].includes(calculation.entrypoint)
    ) {
      fail('IMPORT_ROLLBACK_SUPERSEDED')
    }
    const expectedEntrypoint =
      command.sourceBatchEntrypoint === 'import_batch' ? 'legacy_import' : 'integration_sync'
    if (calculation.entrypoint !== expectedEntrypoint) fail('IMPORT_ROLLBACK_SUPERSEDED')
    if (calculation.parent_preimage_snapshot === null) {
      fail('IMPORT_ROLLBACK_PREIMAGE_UNAVAILABLE')
    }
    const preimage = parseAttendanceImportRollbackPreimageV1(
      calculation.parent_preimage_snapshot,
    )
    preimages.set(recordId, preimage)
    if (preimage.posture === 'present') restored += 1
    else retired += 1
  }

  const authorizationInput = buildAuthorizationInput(records)
  const authorizationWitness = await authorizationPort.recheckInTransaction(trx, authorizationInput)
  requireRollbackAuthorizationWitness(authorizationWitness, authorizationInput)
  await beforeRollbackDmlForTests?.()

  await insertOperation(trx, {
    command,
    operationId: command.rollbackOperationId,
    acceptedWritePosture: batch.accepted_write_posture,
    fingerprint,
  })
  for (const target of command.targets) {
    await insertOperation(trx, {
      command,
      operationId: target.reversalOperationId,
      acceptedWritePosture: batch.accepted_write_posture,
      fingerprint,
    })
  }
  await trx.query(
    `INSERT INTO attendance_import_rollback_commands (
       org_id, rollback_operation_id, rollback_entrypoint,
       source_batch_entrypoint, source_batch_id,
       actor_id, actor_posture, correlation_id
     ) VALUES ($1, $2::uuid, 'import_rollback', $3, $4::uuid, $5, $6, $7)`,
    [
      command.orgId,
      command.rollbackOperationId,
      command.sourceBatchEntrypoint,
      command.sourceBatchId,
      auth.actorId,
      auth.actorPosture,
      command.correlationId,
    ],
  )

  for (const recordId of recordIds) {
    const record = records.get(recordId) as RecordRow
    const reversed = calculations.get(recordId) as CalculationRow
    const target = targetsByRecord.get(recordId) as AttendanceImportRollbackTargetV1
    const preimage = preimages.get(recordId) as FrozenAttendanceImportRollbackPreimageV1
    const present = preimage.posture === 'present'
    const projection = present ? preimage.projection : undefined
    const visibilityState = present ? preimage.visibilityState : 'retired'
    const visibilityReason = present ? preimage.visibilityReason : 'import_rollback'
    const effect = visibilityState === 'active' ? 'set_active' : 'set_retired'
    const values = present
      ? {
          status: projection?.status ?? null,
          firstInAt: projection?.firstInAt ?? null,
          lastOutAt: projection?.lastOutAt ?? null,
          workMinutes: projection?.workMinutes ?? null,
          lateMinutes: projection?.lateMinutes ?? null,
          earlyLeaveMinutes: projection?.earlyLeaveMinutes ?? null,
          dailyFingerprint: preimage.compatibilityFingerprint ?? null,
        }
      : {
          status: record.status,
          firstInAt: record.first_in_at,
          lastOutAt: record.last_out_at,
          workMinutes: record.work_minutes,
          lateMinutes: record.late_minutes,
          earlyLeaveMinutes: record.early_leave_minutes,
          dailyFingerprint: reversed.projected_daily_fingerprint,
        }
    await trx.query(
      `INSERT INTO attendance_record_calculations (
         id, org_id, attendance_record_id, version, calculation_kind, mode,
         entrypoint, engine_version, snapshot_schema_version,
         supersedes_calculation_id, restores_calculation_id, source_batch_id,
         operation_id, semantic_input_fingerprint, provenance_fingerprint,
         source_definition_fingerprint, attribution_snapshot, context_snapshot,
         segment_snapshot, evidence_snapshot, approved_facts_snapshot,
         manual_override_snapshot, input_provenance, merge_policy,
         calculation_tier, outcome, outcome_reason_code, projection_effect,
         expected_segment_count, projected_status, projected_first_in_at,
         projected_last_out_at, projected_work_minutes, projected_late_minutes,
         projected_early_leave_minutes, projected_daily_fingerprint,
         actor_id, correlation_id
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4, 'reversal', 'authoritative',
         'import_rollback', 'w4c3a-import-rollback-v1', 1,
         $5::uuid, $27::uuid, $6::uuid,
         $7::uuid, $8, $9, $10,
         $11::jsonb, $12::jsonb, '[]'::jsonb, $13::jsonb, $14::jsonb,
         $15::jsonb, $16::jsonb, 'reversal',
         'segment_authoritative', 'reversed', 'import_rollback_reversal', $17,
         0, $18, $19, $20, $21, $22, $23, $24,
         $25, $26)`,
      [
        target.reversalCalculationId,
        command.orgId,
        recordId,
        reversed.version + 1,
        reversed.id,
        command.sourceBatchId,
        target.reversalOperationId,
        reversed.semantic_input_fingerprint,
        reversed.provenance_fingerprint,
        reversed.source_definition_fingerprint,
        canonicalAttendanceJsonV1(reversed.attribution_snapshot),
        canonicalAttendanceJsonV1(reversed.context_snapshot),
        canonicalAttendanceJsonV1(reversed.evidence_snapshot),
        canonicalAttendanceJsonV1(reversed.approved_facts_snapshot),
        reversed.manual_override_snapshot === null
          ? null
          : canonicalAttendanceJsonV1(reversed.manual_override_snapshot),
        canonicalAttendanceJsonV1(reversed.input_provenance),
        effect,
        values.status,
        values.firstInAt,
        values.lastOutAt,
        values.workMinutes,
        values.lateMinutes,
        values.earlyLeaveMinutes,
        values.dailyFingerprint,
        auth.actorId,
        command.correlationId,
        present ? preimage.currentCalculationId : null,
      ],
    )
    if (present) {
      await trx.query(
        `INSERT INTO attendance_import_rollback_restore_witnesses (
           org_id, attendance_record_id, reversal_calculation_id,
           reversed_calculation_id, rollback_operation_id,
           source_batch_entrypoint, source_batch_id,
           frozen_preimage_fingerprint, actor_id, actor_posture, correlation_id
         ) VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
           $6, $7::uuid, $8, $9, $10, $11)`,
        [
          command.orgId,
          recordId,
          target.reversalCalculationId,
          reversed.id,
          command.rollbackOperationId,
          command.sourceBatchEntrypoint,
          command.sourceBatchId,
          preimage.compatibilityFingerprint,
          auth.actorId,
          auth.actorPosture,
          command.correlationId,
        ],
      )
    }
    await trx.query(
      `UPDATE attendance_records
          SET current_calculation_id = $3::uuid,
              projection_owner = $4,
              visibility_state = $5,
              visibility_reason = $6,
              status = $7,
              first_in_at = $8,
              last_out_at = $9,
              work_minutes = $10,
              late_minutes = $11,
              early_leave_minutes = $12
        WHERE org_id = $1 AND id = $2::uuid
          AND current_calculation_id = $13::uuid
        RETURNING id`,
      [
        command.orgId,
        recordId,
        present ? preimage.currentCalculationId : target.reversalCalculationId,
        present ? preimage.projectionOwner : 'w4',
        visibilityState,
        visibilityReason,
        values.status,
        values.firstInAt,
        values.lastOutAt,
        values.workMinutes,
        values.lateMinutes,
        values.earlyLeaveMinutes,
        reversed.id,
      ],
    ).then((result) => {
      if (result.rows.length !== 1) fail('IMPORT_ROLLBACK_SUPERSEDED')
    })
    await trx.query(
      `UPDATE attendance_result_operations
          SET state = 'completed', resolved_record_id = $4::uuid,
              resolved_calculation_id = $5::uuid,
              response_snapshot = $6::jsonb, updated_at = now(), version = version + 1
        WHERE org_id = $1 AND entrypoint = 'import_rollback'
          AND operation_id = $2::uuid AND state = 'claimed'
          AND command_fingerprint = $3
        RETURNING operation_id`,
      [
        command.orgId,
        target.reversalOperationId,
        fingerprint,
        recordId,
        target.reversalCalculationId,
        canonicalAttendanceJsonV1({
          attendanceRecordId: recordId,
          reversalCalculationId: target.reversalCalculationId,
        }),
      ],
    )
  }

  const response = {
    rollbackOperationId: command.rollbackOperationId,
    sourceBatchId: command.sourceBatchId,
    reversalCalculationIds: command.targets.map((target) => target.reversalCalculationId),
    affected: command.targets.length,
    restored,
    retired,
  }
  const sealed = await trx.query(
    `UPDATE attendance_result_operations
        SET state = 'completed', response_snapshot = $4::jsonb,
            updated_at = now(), version = version + 1
      WHERE org_id = $1 AND entrypoint = 'import_rollback'
        AND operation_id = $2::uuid AND state = 'claimed'
        AND command_fingerprint = $3
      RETURNING operation_id`,
    [command.orgId, command.rollbackOperationId, fingerprint, canonicalAttendanceJsonV1(response)],
  )
  if (sealed.rows.length !== 1) fail('IMPORT_ROLLBACK_CONFLICT')

  return Object.freeze({
    replayed: false,
    ...response,
    reversalCalculationIds: Object.freeze(response.reversalCalculationIds),
  })
}

/**
 * Core-only rollback seam. Route/host wiring intentionally remains outside this
 * bounded slice; callers must pass both a frozen command and a core-minted
 * transaction recheck port. There is deliberately no full-import fallback.
 */
export async function rollbackAttendanceImportV1(
  connection: AttendanceW4TransactionClientV1,
  command: FrozenAttendanceImportRollbackCommandV1,
  authorizationPort: AttendanceImportRollbackAuthorizationPortV1,
): Promise<AttendanceImportRollbackResultV1> {
  return runAttendanceResultOperationTransactionV1(connection, (trx) =>
    rollbackAttendanceImportInExistingTransactionV1(trx, command, authorizationPort),
  )
}

export async function rollbackAttendanceImportInExistingTransactionV1(
  trx: AttendanceW4TransactionClientV1,
  command: FrozenAttendanceImportRollbackCommandV1,
  authorizationPort: AttendanceImportRollbackAuthorizationPortV1,
): Promise<AttendanceImportRollbackResultV1> {
  if (
    typeof command !== 'object' ||
    command === null ||
    !commandWitnesses.has(command as object) ||
    !Object.isFrozen(command)
  ) {
    fail('IMPORT_ROLLBACK_COMMAND_INVALID')
  }
  requireAuthorizedCapabilityForEntrypointV1(command.authorization, 'import_rollback')
  const verifiedPort = requireRollbackAuthorizationPort(authorizationPort)
  return executeRollback(trx, command, verifiedPort)
}
