import { acquireAttendanceImportTimezonePrefixV1 } from './attendance-business-trip-locks'
import { createAuthorizedAttendanceWriteContextV1, recheckAttendanceActorLivenessInTransactionV1 } from './w4c0-authorization'
import {
  acquireAttendanceCalculationRolloutLock,
  acquireAttendanceImportReservationLocksV1,
  parseCanonicalAttendanceLegacyIdempotencyKeyV1,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  resolveSegmentCalculationPosture,
  type AttendanceW4TransactionClientV1,
} from './w4c0-identity'
import { AttendanceW4OperationError } from './w4c0-operation-contract'
import { attendanceW4ConnectionDiscardV1, runAttendanceResultOperationTransactionV1 } from './w4c0-operation-registry'
import { fingerprintAttendancePunchDetailCommandV1, readAttendancePunchDetailEnvelopeV1, type AttendancePunchDetailJobEnvelopeV1 } from './w4c3a-punch-detail-command'
import type { AttendancePunchDetailPreparationHostInputV1 } from './w4c3a-punch-detail-preparation-host'
import { loadCommittedLegacyBatch, type AttendanceSyncImportHostDepsV1 } from './w4c3a-sync-import-host'

type ReplayInput = Pick<AttendancePunchDetailPreparationHostInputV1, 'scope' | 'envelope'>

/** Shared current admission; caller retains transaction and subsequent row/identity locks. */
export async function admitCurrentAttendancePunchDetailV1(
  trx: AttendanceW4TransactionClientV1,
  scope: ReplayInput['scope'],
  envelope: AttendancePunchDetailJobEnvelopeV1,
): Promise<void> {
  const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(scope.orgId)
  const authorization = createAuthorizedAttendanceWriteContextV1({
    ...scope, subjectScope: { kind: 'explicit_users', userIds: [envelope.__punchDetailInput.userId] },
    capability: 'import', sourceRef: 'attendance-import:punch-detail-replay',
  })
  await acquireAttendanceImportTimezonePrefixV1(trx, scope.orgId)
  await acquireAttendanceCalculationRolloutLock(trx, orgKey, 'shared')
  const posture = await resolveSegmentCalculationPosture(trx, scope.orgId)
  if (!posture.referenceSegments || !['shadow', 'authoritative'].includes(posture.writePosture)) {
    throw new Error('ATTENDANCE_PUNCH_DETAIL_CANONICAL_POSTURE_REQUIRED')
  }
  await recheckAttendanceActorLivenessInTransactionV1(trx, authorization)
  // Import subjects need membership even when the shared actor gate exempts a platform admin.
  if (scope.actorPosture === 'platform_admin' && scope.actorId === envelope.__punchDetailInput.userId) {
    const membership = await trx.query(
      'SELECT 1 FROM user_orgs WHERE user_id = $1 AND org_id = $2 AND is_active = true',
      [envelope.__punchDetailInput.userId, scope.orgId],
    )
    if (membership.rows.length !== 1) throw new AttendanceW4OperationError('ATTENDANCE_WRITE_NOT_AUTHORIZED')
  }
}

/** Current admission precedes any stored result read; this callback is core-private. */
export async function withCurrentAttendancePunchDetailReplayV1<T>(
  deps: AttendanceSyncImportHostDepsV1,
  input: ReplayInput,
  read: (
    trx: AttendanceW4TransactionClientV1,
    scope: ReplayInput['scope'],
    envelope: AttendancePunchDetailJobEnvelopeV1,
    fingerprint: string,
  ) => Promise<T>,
  reservationKey?: string | null,
): Promise<T> {
  const envelope = readAttendancePunchDetailEnvelopeV1(input.envelope)
  if (!envelope) throw new Error('ATTENDANCE_PUNCH_DETAIL_COMMAND_MISMATCH')
  const scope = Object.freeze({ ...input.scope })
  const key = reservationKey === undefined ? envelope.idempotencyKey : reservationKey
  const idempotency = key === null ? null : parseCanonicalAttendanceLegacyIdempotencyKeyV1({
    orgId: scope.orgId, idempotencyKey: key,
  })
  const fingerprint = fingerprintAttendancePunchDetailCommandV1(scope, envelope)
  const acquired = await deps.acquireConnection()
  let discard: Error | undefined
  try {
    return await runAttendanceResultOperationTransactionV1(acquired.client, async (trx) => {
      await admitCurrentAttendancePunchDetailV1(trx, scope, envelope)
      await acquireAttendanceImportReservationLocksV1(trx, [], idempotency)
      return read(trx, scope, envelope, fingerprint)
    })
  } catch (error) {
    discard = attendanceW4ConnectionDiscardV1(error)
    throw error
  } finally {
    acquired.release(discard)
  }
}

/** A retry never re-freezes mutable schedule facts or consumes a token. */
export function createAttendancePunchDetailReplayHostV1(deps: AttendanceSyncImportHostDepsV1) {
  return Object.freeze({
    async readPunchDetailImportReplay(input: ReplayInput) {
      const envelope = readAttendancePunchDetailEnvelopeV1(input.envelope)
      if (!envelope) throw new Error('ATTENDANCE_PUNCH_DETAIL_COMMAND_MISMATCH')
      if (envelope.idempotencyKey === null) return null
      return withCurrentAttendancePunchDetailReplayV1(deps, input, async (trx, scope, command, fingerprint) => {
        const existing = await loadCommittedLegacyBatch(trx, scope.orgId, command.idempotencyKey!)
        if (existing && existing.meta.punchDetailRequestFingerprint !== fingerprint) {
          throw new Error('ATTENDANCE_IMPORT_IDEMPOTENCY_INPUT_CONFLICT')
        }
        return existing
      })
    },
  })
}
