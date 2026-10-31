import { acquireAttendanceImportTimezonePrefixV1 } from './attendance-business-trip-locks'
import {
  createAuthorizedAttendanceWriteContextV1,
  recheckAttendanceActorLivenessInTransactionV1,
} from './w4c0-authorization'
import {
  acquireAttendanceCalculationRolloutLock,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  resolveSegmentCalculationPosture,
} from './w4c0-identity'
import {
  attendanceW4ConnectionDiscardV1,
  runAttendanceResultOperationTransactionV1,
} from './w4c0-operation-registry'
import { AttendanceW4OperationError } from './w4c0-operation-contract'
import { readAttendancePunchDetailEnvelopeV1 } from './w4c3a-punch-detail-command'
import {
  buildAttendancePunchDetailPreparedPlanV1,
  type AttendancePunchDetailPreparationInputV1,
} from './w4c3a-punch-detail-prepare'
import type { AttendanceSyncImportHostDepsV1 } from './w4c3a-sync-import-host'

export type AttendancePunchDetailPreparationHostInputV1 = Pick<
  AttendancePunchDetailPreparationInputV1, 'scope' | 'batchId' | 'envelope' | 'chunkConfig'>
export type AttendancePunchDetailPreparationReadClientV1 = Readonly<{
  __w4CanonicalTrx: true
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>
}>
export type AttendancePunchDetailFrozenTargetResolverV1 = (
  trx: AttendancePunchDetailPreparationReadClientV1,
  posture: Readonly<{ referenceSegments: true }>,
) => Promise<Pick<AttendancePunchDetailPreparationInputV1, 'attribution' | 'context' | 'policySourceProof'>>

/** Preparation owns only its read/lock transaction; commit/reservation retain effect ownership. */
export function createAttendancePunchDetailPreparationHostV1(deps: AttendanceSyncImportHostDepsV1) {
  return Object.freeze({
    async preparePunchDetailImport(
      input: AttendancePunchDetailPreparationHostInputV1,
      resolveFrozenTarget: AttendancePunchDetailFrozenTargetResolverV1,
    ) {
      const envelope = readAttendancePunchDetailEnvelopeV1(input.envelope)
      if (!envelope) throw new Error('ATTENDANCE_PUNCH_DETAIL_COMMAND_MISMATCH')
      const scope = Object.freeze({ ...input.scope })
      const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(scope.orgId)
      const batchId = input.batchId
      const chunkConfig: unknown = JSON.parse(JSON.stringify(input.chunkConfig))
      const authorization = createAuthorizedAttendanceWriteContextV1({
        ...scope, subjectScope: { kind: 'explicit_users', userIds: [envelope.__punchDetailInput.userId] },
        capability: 'import', sourceRef: `attendance-import:${batchId}`,
      })
      const acquired = await deps.acquireConnection()
      let discard: Error | undefined
      try {
        return await runAttendanceResultOperationTransactionV1(acquired.client, async (trx) => {
          await acquireAttendanceImportTimezonePrefixV1(trx, scope.orgId)
          await acquireAttendanceCalculationRolloutLock(trx, orgKey, 'shared')
          const posture = await resolveSegmentCalculationPosture(trx, scope.orgId)
          if (!posture.referenceSegments || !['shadow', 'authoritative'].includes(posture.writePosture)) {
            throw new Error('ATTENDANCE_PUNCH_DETAIL_CANONICAL_POSTURE_REQUIRED')
          }
          await recheckAttendanceActorLivenessInTransactionV1(trx, authorization)
          // The shared helper exempts a platform actor and skips a self subject.
          // Import still requires that same identity to belong to the target org.
          if (scope.actorPosture === 'platform_admin' && scope.actorId === envelope.__punchDetailInput.userId) {
            const membership = await trx.query(
              'SELECT 1 FROM user_orgs WHERE user_id = $1 AND org_id = $2 AND is_active = true',
              [envelope.__punchDetailInput.userId, scope.orgId],
            )
            if (membership.rows.length !== 1) throw new AttendanceW4OperationError('ATTENDANCE_WRITE_NOT_AUTHORIZED')
          }
          let active = true
          const readClient: AttendancePunchDetailPreparationReadClientV1 = Object.freeze({
            __w4CanonicalTrx: true,
            async query(sql: string, params?: unknown[]) {
              if (!active) throw new Error('ATTENDANCE_PUNCH_DETAIL_PREPARATION_CLOSED')
              return (await trx.query(sql, params)).rows as Record<string, unknown>[]
            },
          })
          try {
            const frozen = await resolveFrozenTarget(readClient, Object.freeze({ referenceSegments: true }))
            return buildAttendancePunchDetailPreparedPlanV1({
              ...frozen, scope, batchId, envelope, chunkConfig,
            })
          } finally {
            active = false
          }
        })
      } catch (error) {
        discard = attendanceW4ConnectionDiscardV1(error)
        throw error
      } finally {
        acquired.release(discard)
      }
    },
  })
}
