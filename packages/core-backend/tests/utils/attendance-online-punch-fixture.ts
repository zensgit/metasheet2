import { createRequire } from 'node:module'

const requireCjs = createRequire(import.meta.url)
const clock = requireCjs('../../../../plugins/plugin-attendance/lib/attendance-online-punch-clock.cjs') as {
  setOnlinePunchInstantForTests(value: unknown): void
}

/** Historical HTTP fixtures choose the process clock, never a production request override. */
export async function withOnlinePunchFixtureTime<T>(body: Record<string, unknown>, send: (body: Record<string, unknown>) => Promise<T>): Promise<T> {
  const { occurredAt, occurred_at, ...onlineBody } = body
  const instant = occurredAt ?? occurred_at
  if (instant === undefined) return send(onlineBody)
  clock.setOnlinePunchInstantForTests(instant)
  try { return await send(onlineBody) } finally { clock.setOnlinePunchInstantForTests(null) }
}

export async function requestOnlinePunchFixture<T, O extends { body?: string | Record<string, unknown> }>(
  url: string, options: O, send: (url: string, options: O) => Promise<T>,
): Promise<T> {
  if (new URL(url).pathname !== '/api/attendance/punch' || !options.body) return send(url, options)
  const body = typeof options.body === 'string' ? JSON.parse(options.body) as Record<string, unknown> : options.body
  return withOnlinePunchFixtureTime(body, onlineBody => send(url, {
    ...options, body: typeof options.body === 'string' ? JSON.stringify(onlineBody) : onlineBody,
  }))
}

// Internal historical ingress deliberately retains the old raw timestamp/parser/freeze path.
// This driver invokes existing production adapters; it does not add a production HTTP bypass.
export async function executeHistoricalPunchFixture(pool: import('pg').Pool, input: {
  orgId: string; userId: string; occurredAtRaw: string; operationId: string | null
}) {
  const { createAttendanceLiveScheduledBoundaryV1 } = await import('../../src/attendance/w4c2-live-scheduled-boundary')
  const { applyAttendanceInOutMergePolicyPureV1 } = await import('../../src/attendance/w4c1-merge-policy')
  type Adapters = import('../../src/attendance/w4c2-live-scheduled-boundary').AttendanceW4LiveScheduledLegacyAdaptersV1
  const plugin = requireCjs('../../../../plugins/plugin-attendance/index.cjs') as {
    __attendanceW4c2LivePunchAdaptersForTests: {
      applyLivePunchProjectionLegacyV1: (trx: Parameters<Adapters['applyLivePunchLegacy']>[0], args: Parameters<Adapters['applyLivePunchLegacy']>[1], merge: typeof applyAttendanceInOutMergePolicyPureV1) => ReturnType<Adapters['applyLivePunchLegacy']>
      insertLivePunchEventV1: Adapters['insertLivePunchEvent']
      deriveLivePunchWorkDateResolutionV1: Adapters['deriveLivePunchWorkDateResolution']
      resolveW4LiveCandidateInTransactionV1: Adapters['resolveLiveCandidate']
      buildW4ShadowFrozenContextV1: Adapters['buildShadowFrozenContext']
    }
    __attendanceW7IssuanceSeamForTests: { issueAttendanceFrozenContextV1: Adapters['issueFrozenContext'] }
  }
  const a = plugin.__attendanceW4c2LivePunchAdaptersForTests
  const boundary = createAttendanceLiveScheduledBoundaryV1({
    acquireConnection: async () => {
      const client = await pool.connect()
      return { client, release: () => client.release() }
    },
    legacyAdapters: {
      applyLivePunchLegacy: (trx, args) => a.applyLivePunchProjectionLegacyV1(trx, args, applyAttendanceInOutMergePolicyPureV1),
      insertLivePunchEvent: a.insertLivePunchEventV1,
      deriveLivePunchWorkDateResolution: a.deriveLivePunchWorkDateResolutionV1,
      applyScheduledAbsenceLegacy: async () => [],
      resolveLiveCandidate: a.resolveW4LiveCandidateInTransactionV1,
      resolveScheduledCandidate: async () => ({ kind: 'unresolved' as const }),
      buildShadowFrozenContext: a.buildW4ShadowFrozenContextV1,
      issueFrozenContext: plugin.__attendanceW7IssuanceSeamForTests.issueAttendanceFrozenContextV1,
    },
  })
  const occurredAtResolved = new Date(input.occurredAtRaw).toISOString()
  const workDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(occurredAtResolved))
  try {
    const outcome = await boundary.executeLivePunch({ ...input, occurredAtResolved, eventType: 'check_in',
      timezone: 'Asia/Shanghai', requestTimezone: 'Asia/Shanghai', source: 'manual', location: null,
      meta: null, photoFileRef: null, workDate, shiftId: null, outerSourceDefinitionFingerprint: null, isWorkday: true, holidayKind: null,
    })
    const raw = JSON.stringify({ ok: true, data: outcome.response })
    return { status: 200, body: JSON.parse(raw), raw }
  } catch (error) {
    const refusal = error as { httpStatus?: number; code?: string }
    if (!refusal.code) throw error
    const raw = JSON.stringify({ ok: false, error: { code: refusal.code, message: refusal.code } })
    return { status: refusal.httpStatus ?? 422, body: JSON.parse(raw), raw }
  }
}
