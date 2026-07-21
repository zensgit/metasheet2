/**
 * W4-0 (Wave 4 onboarding design-lock 2026-07-21, RATIFIED): unit coverage for the
 * `GET /api/attendance-admin/setup-readiness` seven-step aggregate.
 *
 * Proves:
 *  - §9 追加门禁3: the query seam (`assertSelectOnlyReadinessSql` / `createReadOnlyReadinessSeam`)
 *    accepts SELECT/WITH and rejects everything else BEFORE any I/O.
 *  - §4.2 org-scoped counts: single CTE, every branch anchored by `org_id = $1` (six occurrences,
 *    never a second param), values-free (no identifying columns).
 *  - §3④ / OD-W4-4=(c): `punchPolicyPosture` is a back-end-only semantic comparison against the
 *    normalized punchPolicy defaults — default / customized / unknown, never leaking settings values.
 *  - §4.5 notify readiness port: env-derived fields resolve independently of the org-scoped DB
 *    probe; a DB failure narrows to `orgRecipientBindingReady: 'unknown'` alone, while a port-level
 *    failure collapses the WHOLE notify block to `unknown`.
 *  - OD-W4-1 追加门禁1: authorization (`canReadAttendanceDirectoryReadiness`, reused from S7-5) runs
 *    BEFORE `buildAttendanceSetupReadiness` — a foreign-org 403 issues ZERO aggregation queries.
 *  - Route status-code matrix (400/401/403/503/500/200) + exact response key-set lock +
 *    deployment-scoped signal registry + per-step effectiveTime registration.
 *
 * Mutation evidence (load-bearing; see PR body for the executed record):
 *  - drop the seam's SELECT/WITH guard → the seam-rejects-UPDATE test reds.
 *  - drop any `org_id = $1` filter in the CTE → the org-anchor count assertion reds.
 *  - call buildAttendanceSetupReadiness before the authz check → the "403 issues zero aggregation
 *    SQL" assertion reds.
 */
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const queryMock = vi.fn()

vi.mock('../../src/db/pg', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}))

vi.mock('../../src/rbac/rbac', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rbac/rbac')>()
  return {
    ...actual,
    rbacGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  }
})

vi.mock('../../src/rbac/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rbac/service')>()
  return {
    ...actual,
    isAdmin: vi.fn(async (userId: string) => userId === 'platform-admin'),
    listUserPermissions: vi.fn(async () => []),
  }
})

vi.mock('../../src/routes/admin-users', () => ({
  ensurePlatformAdmin: vi.fn(async () => null),
}))

vi.mock('../../src/services/AttendanceNotificationRedelivery', () => ({
  redeliverFailedAttendanceNotification: vi.fn(),
}))

vi.mock('../../src/services/ApprovalDirectoryOrg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/ApprovalDirectoryOrg')>()
  return {
    ...actual,
    MAX_MANAGER_CHAIN_LEVELS: 10,
  }
})

vi.mock('../../src/services/AttendanceNotificationDeliveryWorker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/AttendanceNotificationDeliveryWorker')>()
  return {
    ...actual,
    createAttendanceDeliveryChannelsFromEnv: vi.fn(actual.createAttendanceDeliveryChannelsFromEnv),
  }
})

const {
  attendanceAdminRouter,
  assertSelectOnlyReadinessSql,
  createReadOnlyReadinessSeam,
  readAttendanceSetupReadinessOrgCounts,
  readAttendancePunchPolicyPosture,
  readAttendanceNotifyReadinessPort,
  buildAttendanceSetupReadiness,
  ATTENDANCE_SETUP_READINESS_STEP_META,
  ATTENDANCE_SETUP_READINESS_DEPLOYMENT_SCOPED_SIGNALS,
} = await import('../../src/routes/attendance-admin')
const { createAttendanceDeliveryChannelsFromEnv } = await import(
  '../../src/services/AttendanceNotificationDeliveryWorker'
)
const pinned = usePinnedServer()

function makeApp(user: Record<string, unknown> | null) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as express.Request & { user?: unknown }).user = user ?? undefined
    next()
  })
  app.use(attendanceAdminRouter())
  return app
}

describe('assertSelectOnlyReadinessSql / createReadOnlyReadinessSeam (§9 追加门禁3)', () => {
  it('accepts SELECT and WITH statements', () => {
    expect(() => assertSelectOnlyReadinessSql('SELECT 1')).not.toThrow()
    expect(() => assertSelectOnlyReadinessSql('  select COUNT(*) FROM t')).not.toThrow()
    expect(() => assertSelectOnlyReadinessSql('WITH x AS (SELECT 1) SELECT * FROM x')).not.toThrow()
  })

  it('rejects UPDATE/INSERT/DELETE — mutation target for R1', () => {
    expect(() => assertSelectOnlyReadinessSql('UPDATE t SET x = 1')).toThrow(/SELECT\/WITH/)
    expect(() => assertSelectOnlyReadinessSql('INSERT INTO t VALUES (1)')).toThrow(/SELECT\/WITH/)
    expect(() => assertSelectOnlyReadinessSql('DELETE FROM t')).toThrow(/SELECT\/WITH/)
  })

  it('seam calls through to the underlying runner for SELECT and never for a write statement', async () => {
    const inner = vi.fn(async () => ({ rows: [] }))
    const seam = createReadOnlyReadinessSeam(inner as never)
    await seam('SELECT 1', [])
    expect(inner).toHaveBeenCalledTimes(1)

    await expect(seam('UPDATE t SET x = 1', [])).rejects.toThrow(/SELECT\/WITH/)
    // Mutation evidence: the guard rejects BEFORE any I/O — inner must still be called exactly once.
    expect(inner).toHaveBeenCalledTimes(1)
  })
})

describe('readAttendanceSetupReadinessOrgCounts (single CTE, org-anchored, values-free)', () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it('issues exactly one query, org_id = $1 six times, never a second param, no identifying columns', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          org_active_member_count: 3,
          group_count: 2,
          groups_with_members: 1,
          shift_count: 4,
          rotation_rule_count: 0,
          approval_flow_count: 1,
        },
      ],
    })
    const result = await readAttendanceSetupReadinessOrgCounts('org-a', queryMock as never)
    expect(result).toEqual({
      orgActiveMemberCount: 3,
      groupCount: 2,
      groupsWithMembers: 1,
      shiftCount: 4,
      rotationRuleCount: 0,
      approvalFlowCount: 1,
    })
    expect(queryMock).toHaveBeenCalledTimes(1)
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]]
    expect(params).toEqual(['org-a'])
    const orgAnchorMatches = sql.match(/org_id\s*=\s*\$1/g) ?? []
    expect(orgAnchorMatches.length).toBe(6)
    expect(sql).not.toMatch(/\$2\b/)
    expect(sql).toMatch(/WITH /i)
    expect(sql).not.toMatch(/email|phone|mobile|external_user_id|display_name|full_name/i)
  })

  it('defaults every count to 0 on an empty row', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{}] })
    const result = await readAttendanceSetupReadinessOrgCounts('org-empty', queryMock as never)
    expect(result).toEqual({
      orgActiveMemberCount: 0,
      groupCount: 0,
      groupsWithMembers: 0,
      shiftCount: 0,
      rotationRuleCount: 0,
      approvalFlowCount: 0,
    })
  })
})

describe('readAttendancePunchPolicyPosture (§3④ / OD-W4-4=(c), values-free)', () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it('returns default when no settings row exists', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    await expect(readAttendancePunchPolicyPosture(queryMock as never)).resolves.toBe('default')
  })

  it('returns default when the persisted punchPolicy subtree matches the normalized defaults', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          value: JSON.stringify({
            punchPolicy: {
              unscheduled: { mode: 'allow' },
              merge: { internalWinsOnIn: false, externalWinsOnOut: false },
              outdoor: { requireApproval: false, requireNote: false, requirePhoto: false, approvalFlowId: '' },
            },
          }),
        },
      ],
    })
    await expect(readAttendancePunchPolicyPosture(queryMock as never)).resolves.toBe('default')
  })

  it('returns customized when the punchPolicy subtree diverges from defaults', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          value: JSON.stringify({
            punchPolicy: {
              unscheduled: { mode: 'block' },
              merge: { internalWinsOnIn: false, externalWinsOnOut: false },
              outdoor: { requireApproval: false, requireNote: false, requirePhoto: false, approvalFlowId: '' },
            },
          }),
        },
      ],
    })
    await expect(readAttendancePunchPolicyPosture(queryMock as never)).resolves.toBe('customized')
  })

  it('returns unknown when the row exists but has no punchPolicy subtree at all', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ value: JSON.stringify({ holidayPolicy: {} }) }] })
    await expect(readAttendancePunchPolicyPosture(queryMock as never)).resolves.toBe('unknown')
  })

  it('returns unknown on a malformed/unparsable row rather than throwing', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ value: 'not-json' }] })
    await expect(readAttendancePunchPolicyPosture(queryMock as never)).resolves.toBe('unknown')
  })

  it('returns unknown on a DB error (fail-closed)', async () => {
    queryMock.mockRejectedValueOnce(new Error('relation "system_configs" does not exist'))
    await expect(readAttendancePunchPolicyPosture(queryMock as never)).resolves.toBe('unknown')
  })

  it('the query never selects columns other than value, and is not org-scoped (deployment-wide key)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })
    await readAttendancePunchPolicyPosture(queryMock as never)
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/SELECT value FROM system_configs WHERE key = \$1/)
    expect(params).toEqual(['attendance.settings'])
  })
})

describe('readAttendanceNotifyReadinessPort (§4.5, values-free, port-missing fails whole block closed)', () => {
  beforeEach(() => {
    queryMock.mockReset()
    vi.mocked(createAttendanceDeliveryChannelsFromEnv).mockClear()
  })

  it('worker enabled + dingtalk channel registered + org has a bound recipient', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ready: true }] })
    const env = { ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'true', ATTENDANCE_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED: 'true' } as NodeJS.ProcessEnv
    const result = await readAttendanceNotifyReadinessPort('org-a', queryMock as never, env)
    expect(result).toEqual({
      workerEnabled: true,
      defaultChannelAvailable: true,
      availableChannelCount: 1,
      orgRecipientBindingReady: true,
    })
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]]
    expect(params).toEqual(['org-a'])
    expect(sql).toMatch(/org_id\s*=\s*\$1/)
    expect(sql).not.toMatch(/env|channel_name|credential|secret|token/i)
  })

  it('worker disabled and no channels registered', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ready: false }] })
    const result = await readAttendanceNotifyReadinessPort('org-a', queryMock as never, {} as NodeJS.ProcessEnv)
    expect(result).toEqual({
      workerEnabled: false,
      defaultChannelAvailable: false,
      availableChannelCount: 0,
      orgRecipientBindingReady: false,
    })
  })

  it('narrows ONLY orgRecipientBindingReady to unknown when the org-scoped DB probe fails', async () => {
    queryMock.mockRejectedValueOnce(new Error('connection lost'))
    const env = { ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'true', ATTENDANCE_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED: 'true' } as NodeJS.ProcessEnv
    const result = await readAttendanceNotifyReadinessPort('org-a', queryMock as never, env)
    expect(result.workerEnabled).toBe(true)
    expect(result.defaultChannelAvailable).toBe(true)
    expect(result.availableChannelCount).toBe(1)
    expect(result.orgRecipientBindingReady).toBe('unknown')
  })

  it('collapses the WHOLE block to unknown when the port itself throws (port missing)', async () => {
    vi.mocked(createAttendanceDeliveryChannelsFromEnv).mockImplementationOnce(() => {
      throw new Error('port unavailable')
    })
    const result = await readAttendanceNotifyReadinessPort('org-a', queryMock as never, {} as NodeJS.ProcessEnv)
    expect(result).toEqual({
      workerEnabled: 'unknown',
      defaultChannelAvailable: 'unknown',
      availableChannelCount: 'unknown',
      orgRecipientBindingReady: 'unknown',
    })
    // The org-scoped probe must never have been attempted once the port itself is unavailable.
    expect(queryMock).not.toHaveBeenCalled()
  })
})

describe('ATTENDANCE_SETUP_READINESS_STEP_META / deploymentScopedSignals (locked registries)', () => {
  it('registers exactly seven steps with a source + posture for each — never omitted, never guessed immediate for unsourced steps', () => {
    expect(ATTENDANCE_SETUP_READINESS_STEP_META).toHaveLength(7)
    const steps = ATTENDANCE_SETUP_READINESS_STEP_META.map((s) => s.step)
    expect(steps).toEqual([
      'attendance-admin-user-access',
      'attendance-admin-groups',
      'attendance-admin-shifts',
      'attendance-admin-settings',
      'attendance-admin-approval-flows',
      'attendance-admin-notification-deliveries',
      'preview',
    ])
    for (const meta of ATTENDANCE_SETUP_READINESS_STEP_META) {
      expect(meta.effectiveTime.source).toBeTruthy()
      expect(['immediate', 'scheduled', 'manual_activation', 'undeterminable']).toContain(
        meta.effectiveTime.posture,
      )
      expect(meta.effectiveTime.effectiveAt).toBeUndefined()
    }
    // The two steps with no app-observable trigger must never be mislabeled 'immediate'.
    const notify = ATTENDANCE_SETUP_READINESS_STEP_META.find((s) => s.step === 'attendance-admin-notification-deliveries')
    expect(notify?.effectiveTime.posture).toBe('undeterminable')
    const preview = ATTENDANCE_SETUP_READINESS_STEP_META.find((s) => s.step === 'preview')
    expect(preview?.effectiveTime.posture).toBe('manual_activation')
  })

  it('marks only the deployment-wide signals — every other signal is org-scoped by omission', () => {
    expect(ATTENDANCE_SETUP_READINESS_DEPLOYMENT_SCOPED_SIGNALS).toEqual([
      'punchPolicyPosture',
      'notify.workerEnabled',
      'notify.defaultChannelAvailable',
      'notify.availableChannelCount',
    ])
  })

  it('settings and notification-deliveries steps are the only deployment-scoped perStep entries', () => {
    const deploymentSteps = ATTENDANCE_SETUP_READINESS_STEP_META.filter((s) => s.scope === 'deployment').map(
      (s) => s.step,
    )
    expect(deploymentSteps).toEqual(['attendance-admin-settings', 'attendance-admin-notification-deliveries'])
  })
})

describe('buildAttendanceSetupReadiness (orchestration)', () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it('assembles the full values-free response from all four reads', async () => {
    queryMock
      // directoryLinked (S7-5 reused query)
      .mockResolvedValueOnce({ rows: [{ ready: true }] })
      // org counts CTE
      .mockResolvedValueOnce({
        rows: [
          {
            org_active_member_count: 5,
            group_count: 2,
            groups_with_members: 2,
            shift_count: 3,
            rotation_rule_count: 1,
            approval_flow_count: 1,
          },
        ],
      })
      // punch policy posture
      .mockResolvedValueOnce({ rows: [] })
      // notify org-recipient-binding
      .mockResolvedValueOnce({ rows: [{ ready: false }] })

    const result = await buildAttendanceSetupReadiness('org-a', queryMock as never, {} as NodeJS.ProcessEnv)
    expect(result).toEqual({
      directoryLinked: true,
      orgActiveMemberCount: 5,
      groupCount: 2,
      groupsWithMembers: 2,
      shiftCount: 3,
      rotationRuleCount: 1,
      hasRotationRules: true,
      approvalFlowCount: 1,
      punchPolicyPosture: 'default',
      notify: {
        workerEnabled: false,
        defaultChannelAvailable: false,
        availableChannelCount: 0,
        orgRecipientBindingReady: false,
      },
      perStep: ATTENDANCE_SETUP_READINESS_STEP_META,
      deploymentScopedSignals: ATTENDANCE_SETUP_READINESS_DEPLOYMENT_SCOPED_SIGNALS,
    })
  })
})

describe('GET /api/attendance-admin/setup-readiness (route)', () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it('400 when orgId is missing', async () => {
    const app = makeApp({ id: 'delegated-admin' })
    pinned.setApp(app)
    const res = await request(pinned.url()).get('/api/attendance-admin/setup-readiness')
    expect(res.status).toBe(400)
    expect(res.body?.error?.code).toBe('ORG_ID_REQUIRED')
  })

  it('401 when unauthenticated', async () => {
    const app = makeApp(null)
    pinned.setApp(app)
    const res = await request(pinned.url()).get('/api/attendance-admin/setup-readiness?orgId=org-a')
    expect(res.status).toBe(401)
  })

  it('403 when the caller is not a member of the org — and issues ZERO aggregation SQL (OD-W4-1 追加门禁1)', async () => {
    // Only the membership-check query may fire (0 rows = not a member).
    queryMock.mockResolvedValueOnce({ rows: [] })
    const app = makeApp({ id: 'foreign-admin' })
    pinned.setApp(app)
    const res = await request(pinned.url()).get('/api/attendance-admin/setup-readiness?orgId=org-b')
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('FORBIDDEN')
    // Mutation evidence: reordering authz after aggregation would push this above 1.
    expect(queryMock).toHaveBeenCalledTimes(1)
    const [sql] = queryMock.mock.calls[0] as [string]
    expect(sql).toMatch(/user_orgs/)
  })

  it('200 with values-free payload + exact response key-set lock for an org member', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // membership
      .mockResolvedValueOnce({ rows: [{ ready: false }] }) // directoryLinked
      .mockResolvedValueOnce({
        rows: [
          {
            org_active_member_count: 0,
            group_count: 0,
            groups_with_members: 0,
            shift_count: 0,
            rotation_rule_count: 0,
            approval_flow_count: 0,
          },
        ],
      }) // org counts
      .mockResolvedValueOnce({ rows: [] }) // punch policy posture
      .mockResolvedValueOnce({ rows: [{ ready: false }] }) // notify binding

    const app = makeApp({ id: 'delegated-admin' })
    pinned.setApp(app)
    const res = await request(pinned.url()).get('/api/attendance-admin/setup-readiness?orgId=org-a')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(Object.keys(res.body.data).sort()).toEqual(
      [
        'approvalFlowCount',
        'deploymentScopedSignals',
        'directoryLinked',
        'groupCount',
        'groupsWithMembers',
        'hasRotationRules',
        'notify',
        'orgActiveMemberCount',
        'perStep',
        'punchPolicyPosture',
        'rotationRuleCount',
        'shiftCount',
      ].sort(),
    )
    expect(Object.keys(res.body.data.notify).sort()).toEqual(
      ['availableChannelCount', 'defaultChannelAvailable', 'orgRecipientBindingReady', 'workerEnabled'].sort(),
    )
    expect(res.body.data.punchPolicyPosture).toBe('default')
    // Values-free: no raw config, no ids, no names anywhere in the payload.
    const flat = JSON.stringify(res.body.data)
    expect(flat).not.toMatch(/email|phone|mobile|password|secret|token/i)
  })

  it('503 DB_NOT_READY when an aggregation read hits a missing-relation error', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // membership
      .mockResolvedValueOnce({ rows: [{ ready: false }] }) // directoryLinked
      .mockRejectedValueOnce(
        Object.assign(new Error('relation "attendance_groups" does not exist'), { code: '42P01' }),
      ) // org counts CTE
      .mockResolvedValueOnce({ rows: [] }) // punch policy posture
      .mockResolvedValueOnce({ rows: [{ ready: false }] }) // notify binding
    const app = makeApp({ id: 'delegated-admin' })
    pinned.setApp(app)
    const res = await request(pinned.url()).get('/api/attendance-admin/setup-readiness?orgId=org-a')
    expect(res.status).toBe(503)
    expect(res.body?.error?.code).toBe('DB_NOT_READY')
  })

  it('500 returns a generic message — never raw DB/driver text (values-free)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // membership
      .mockResolvedValueOnce({ rows: [{ ready: false }] }) // directoryLinked
      .mockRejectedValueOnce(new Error('SECRET_DETAIL leaking column names')) // org counts CTE
      .mockResolvedValueOnce({ rows: [] }) // punch policy posture
      .mockResolvedValueOnce({ rows: [{ ready: false }] }) // notify binding
    const app = makeApp({ id: 'delegated-admin' })
    pinned.setApp(app)
    const res = await request(pinned.url()).get('/api/attendance-admin/setup-readiness?orgId=org-a')
    expect(res.status).toBe(500)
    expect(res.body?.error?.code).toBe('SETUP_READINESS_FAILED')
    expect(JSON.stringify(res.body)).not.toContain('SECRET_DETAIL')
  })
})
