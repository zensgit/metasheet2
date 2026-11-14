import { attendanceOwningSessionForClientV1 } from '../../src/attendance/attendance-owning-session'
import { createRequire } from 'node:module'
import type { Pool } from 'pg'
import {
  createAttendanceLiveScheduledBoundaryV1,
  computeAttendanceOuterSourceDefinitionFingerprintV1,
  type AttendanceLivePunchBoundaryInputV1,
  type AttendancePluginShapedTrxV1,
  type AttendanceW4LiveScheduledLegacyAdaptersV1,
} from '../../src/attendance/w4c2-live-scheduled-boundary'
import { applyAttendanceInOutMergePolicyPureV1 } from '../../src/attendance/w4c1-merge-policy'

type Adapters = AttendanceW4LiveScheduledLegacyAdaptersV1
type LivePluginAdapters = {
  insertLivePunchEventV1: Adapters['insertLivePunchEvent']
  deriveLivePunchWorkDateResolutionV1: Adapters['deriveLivePunchWorkDateResolution']
  applyLivePunchProjectionLegacyV1: (
    trx: AttendancePluginShapedTrxV1,
    args: Parameters<Adapters['applyLivePunchLegacy']>[1],
    merge: typeof applyAttendanceInOutMergePolicyPureV1,
  ) => ReturnType<Adapters['applyLivePunchLegacy']>
  resolveW4LiveCandidateInTransactionV1: Adapters['resolveLiveCandidate']
  buildW4ShadowFrozenContextV1: Adapters['buildShadowFrozenContext']
}

export interface LegacyLivePunchCommand {
  orgId: string
  userId: string
  eventType: 'check_in' | 'check_out'
  occurredAt: string
  timezone: string
  operationId?: string | null
}

// Explicitly the legacy canonical boundary layer, not the HTTP timezone contract.
// Fixture premise: shifts work every day; isWorkday=true / holidayKind=null
// is limited to these fixtures, not an arbitrary calendar resolver.
// Requires a real activated plugin and real PostgreSQL; no adapter injection or
// prepareLiveTimezoneContext option. HTTP continues to install its strict frame.
export function createLegacyLivePunchBoundaryDriver(pool: Pool) {
  const plugin = createRequire(import.meta.url)('../../../../plugins/plugin-attendance/index.cjs') as {
    __attendanceW4c2LivePunchAdaptersForTests: LivePluginAdapters
    __attendanceW7IssuanceSeamForTests: { issueAttendanceFrozenContextV1: Adapters['issueFrozenContext'] | null }
  }
  const adapters = plugin.__attendanceW4c2LivePunchAdaptersForTests
  const issue = plugin.__attendanceW7IssuanceSeamForTests.issueAttendanceFrozenContextV1
  if (typeof issue !== 'function') throw new Error('ACTIVATED_W7_ISSUANCE_REQUIRED')
  const boundary = createAttendanceLiveScheduledBoundaryV1({
    acquireConnection: async () => {
      const client = await pool.connect()
      return { client: attendanceOwningSessionForClientV1(client), release: () => client.release() }
    },
    legacyAdapters: {
      applyLivePunchLegacy: (trx, args) => adapters.applyLivePunchProjectionLegacyV1(trx, args, applyAttendanceInOutMergePolicyPureV1),
      insertLivePunchEvent: (trx, args) => adapters.insertLivePunchEventV1(trx, args),
      deriveLivePunchWorkDateResolution: (trx, args) => adapters.deriveLivePunchWorkDateResolutionV1(trx, args),
      resolveLiveCandidate: (trx, args) => adapters.resolveW4LiveCandidateInTransactionV1(trx, args),
      buildShadowFrozenContext: (trx, args) => adapters.buildW4ShadowFrozenContextV1(trx, args),
      issueFrozenContext: (trx, args) => issue(trx, args),
      // Never exercised by this live-only driver; fail loudly if that changes.
      applyScheduledAbsenceLegacy: async () => { throw new Error('LIVE_DRIVER_SCHEDULED_CALL') },
      resolveScheduledCandidate: async () => { throw new Error('LIVE_DRIVER_SCHEDULED_CALL') },
    },
  })

  async function prepare(command: LegacyLivePunchCommand) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const trx: AttendancePluginShapedTrxV1 = {
        __w4CanonicalTrx: true,
        query: async (sql, values) => (await client.query(sql, values ?? [])).rows,
      }
      const outerResolution = await adapters.resolveW4LiveCandidateInTransactionV1(trx, {
        orgId: command.orgId, userId: command.userId,
        occurredAt: command.occurredAt, timezone: command.timezone,
      })
      const resolved = outerResolution.kind === 'resolved' && outerResolution.shiftId && outerResolution.workDate
      const outerIssued = resolved ? await issue(trx, {
        orgId: command.orgId, userId: command.userId,
        workDate: String(outerResolution.workDate), shiftId: String(outerResolution.shiftId),
        timezone: outerResolution.fullWinner?.timezone ?? command.timezone,
        isWorkday: true, holidayKind: null, purpose: 'mirror',
      }) : null
      const outerContext = outerIssued?.context ?? null
      const input: AttendanceLivePunchBoundaryInputV1 = {
        orgId: command.orgId, userId: command.userId, operationId: command.operationId ?? null,
        eventType: command.eventType, occurredAtRaw: command.occurredAt, occurredAtResolved: command.occurredAt,
        timezone: outerResolution.fullWinner?.timezone ?? command.timezone, requestTimezone: command.timezone,
        source: 'manual', location: null, meta: null, photoFileRef: null,
        workDate: resolved ? String(outerResolution.workDate) : new Intl.DateTimeFormat('en-CA', {
          timeZone: command.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date(command.occurredAt)),
        shiftId: resolved ? String(outerResolution.shiftId) : null,
        outerSourceDefinitionFingerprint: computeAttendanceOuterSourceDefinitionFingerprintV1({
          orgId: command.orgId, userId: command.userId, source: 'live_resolution',
          nowIso: new Date().toISOString(), resolution: outerResolution, context: outerContext,
        }),
        isWorkday: true, holidayKind: null,
      }
      await client.query('COMMIT')
      return { input, outerResolution, outerContext, outerIssued }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  return {
    prepare,
    execute: (prepared: Awaited<ReturnType<typeof prepare>>) => boundary.executeLivePunch(prepared.input),
  }
}
