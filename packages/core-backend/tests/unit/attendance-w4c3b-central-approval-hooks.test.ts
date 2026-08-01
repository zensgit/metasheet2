/**
 * W4C-3b Stage R0 — unit coverage for central approval classifier + auth matrix.
 * Mutation-friendly: each permission / membership / published_definition_id leg is independent.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ATTENDANCE_APPROVAL_WORKFLOW_KEY,
  ATTENDANCE_REQUEST_BUSINESS_KEY_PREFIX,
  W4C3B_CENTRAL_APPROVAL_ERROR_CODES,
  AttendanceCentralApprovalError,
  assertAttendanceCentralMutationFailClosed,
  authorizeAttendanceCentralReassign,
  classifyAndLockAttendanceRequestForInstance,
  filterBulkReassignDiscoveryForAttendance,
  parseAttendanceRequestIdFromBusinessKey,
  type W4c3bQueryClient,
} from '../../src/attendance/w4c3b-central-approval-hooks'

const ORG = 'org-a'
const REQUEST_ID = '11111111-1111-4111-8111-111111111111'
const INSTANCE_ID = 'apv_attendance_1'
const ACTOR = 'actor-1'
const TARGET = 'target-1'

function businessKey(requestId = REQUEST_ID): string {
  return `${ATTENDANCE_REQUEST_BUSINESS_KEY_PREFIX}${requestId}`
}

type Row = Record<string, unknown>

function mockClient(handler: (sql: string, params?: unknown[]) => Row[]): W4c3bQueryClient {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const rows = handler(sql, params)
      return { rows, rowCount: rows.length }
    }),
  }
}

describe('parseAttendanceRequestIdFromBusinessKey', () => {
  it('accepts the canonical attendance-request prefix and rejects garbage', () => {
    expect(parseAttendanceRequestIdFromBusinessKey(businessKey())).toBe(REQUEST_ID)
    expect(parseAttendanceRequestIdFromBusinessKey('other:foo')).toBeNull()
    expect(parseAttendanceRequestIdFromBusinessKey(null)).toBeNull()
    expect(parseAttendanceRequestIdFromBusinessKey(`${ATTENDANCE_REQUEST_BUSINESS_KEY_PREFIX}not-a-uuid`)).toBeNull()
  })
})

describe('classifyAndLockAttendanceRequestForInstance', () => {
  it('returns not_attendance when workflow_key differs (published_definition_id ignored)', async () => {
    const client = mockClient(() => {
      throw new Error('must not query attendance_requests for non-attendance')
    })
    const result = await classifyAndLockAttendanceRequestForInstance(client, {
      id: INSTANCE_ID,
      workflow_key: 'other.flow',
      business_key: businessKey(),
      published_definition_id: 'pub-def-1',
    })
    expect(result).toEqual({ kind: 'not_attendance' })
    expect(client.query).not.toHaveBeenCalled()
  })

  it('classifies attendance even when published_definition_id is set (adversary)', async () => {
    const client = mockClient((sql) => {
      expect(sql).toContain('FROM attendance_requests')
      expect(sql).toContain('FOR UPDATE')
      return [
        {
          id: REQUEST_ID,
          org_id: ORG,
          status: 'pending',
          approval_instance_id: INSTANCE_ID,
          user_id: 'subject-1',
        },
      ]
    })
    const result = await classifyAndLockAttendanceRequestForInstance(client, {
      id: INSTANCE_ID,
      workflow_key: ATTENDANCE_APPROVAL_WORKFLOW_KEY,
      business_key: businessKey(),
      published_definition_id: 'pub-def-adversarial',
    })
    expect(result.kind).toBe('attendance')
    if (result.kind === 'attendance') {
      expect(result.request).toMatchObject({
        requestId: REQUEST_ID,
        orgId: ORG,
        approvalInstanceId: INSTANCE_ID,
      })
    }
  })

  it('returns attendance with null request when join misses (orphaned workflow_key)', async () => {
    const client = mockClient(() => [])
    const result = await classifyAndLockAttendanceRequestForInstance(client, {
      id: INSTANCE_ID,
      workflow_key: ATTENDANCE_APPROVAL_WORKFLOW_KEY,
      business_key: businessKey(),
    })
    expect(result).toEqual({ kind: 'attendance', request: null })
  })
})

describe('assertAttendanceCentralMutationFailClosed', () => {
  it('no-ops for non-attendance', async () => {
    const client = mockClient(() => {
      throw new Error('unexpected')
    })
    await expect(
      assertAttendanceCentralMutationFailClosed(client, {
        id: 'x',
        workflow_key: 'leave.other',
      }),
    ).resolves.toBeUndefined()
  })

  it('throws values-free typed error before caller DML for attendance', async () => {
    const client = mockClient(() => [
      {
        id: REQUEST_ID,
        org_id: ORG,
        status: 'pending',
        approval_instance_id: INSTANCE_ID,
        user_id: 'subject-1',
      },
    ])
    await expect(
      assertAttendanceCentralMutationFailClosed(client, {
        id: INSTANCE_ID,
        workflow_key: ATTENDANCE_APPROVAL_WORKFLOW_KEY,
        business_key: businessKey(),
        published_definition_id: 'pub-def',
      }),
    ).rejects.toMatchObject({
      name: 'AttendanceCentralApprovalError',
      code: W4C3B_CENTRAL_APPROVAL_ERROR_CODES.ATTENDANCE_CENTRAL_MUTATION_UNSUPPORTED,
      statusCode: 409,
    })
  })
})

describe('authorizeAttendanceCentralReassign', () => {
  function authClient(opts: {
    platformAdmin?: boolean
    actorLive?: boolean
    actorMember?: boolean
    hasApprovalsAdmin?: boolean
    hasAttendanceAdmin?: boolean
    targetLive?: boolean
    targetMember?: boolean
  }): W4c3bQueryClient {
    const {
      platformAdmin = false,
      actorLive = true,
      actorMember = true,
      hasApprovalsAdmin = true,
      hasAttendanceAdmin = true,
      targetLive = true,
      targetMember = true,
    } = opts
    return mockClient((sql, params) => {
      const p0 = params?.[0]
      if (sql.includes("role_id = 'admin'") && sql.includes('FROM users u')) {
        return platformAdmin && p0 === ACTOR ? [{ '?column?': 1 }] : []
      }
      // Locked target users row (FOR UPDATE) — success path must take this branch.
      if (sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
        if (p0 !== TARGET) return []
        if (!targetLive) {
          return [{ id: TARGET, is_active: false, activation_status: 'deprovisioned' }]
        }
        return [{ id: TARGET, is_active: true, activation_status: 'activated' }]
      }
      // Unlocked actor liveness (no FOR UPDATE).
      if (sql.includes('FROM users') && sql.includes('activation_status')) {
        if (p0 === ACTOR) return actorLive ? [{ '?column?': 1 }] : []
        return []
      }
      // Locked exact membership (FOR UPDATE) after users lock.
      if (sql.includes('FROM user_orgs') && sql.includes('FOR UPDATE')) {
        const userId = p0
        const orgId = params?.[1]
        if (userId !== TARGET || orgId !== ORG) return []
        if (!targetMember) return []
        return [{ user_id: TARGET, org_id: ORG, is_active: true }]
      }
      if (sql.includes('FROM user_orgs')) {
        const userId = p0
        const orgId = params?.[1]
        if (orgId !== ORG) return []
        if (userId === ACTOR) return actorMember ? [{ '?column?': 1 }] : []
        return []
      }
      if (sql.includes('user_permissions') || sql.includes('role_permissions')) {
        const codes = (params?.[1] as string[]) || []
        // Families always include the exact admin code; *:* is shared so do not key on it alone.
        if (codes.includes('approvals:admin')) {
          return hasApprovalsAdmin ? [{ '?column?': 1 }] : []
        }
        if (codes.includes('attendance:admin')) {
          return hasAttendanceAdmin ? [{ '?column?': 1 }] : []
        }
        return []
      }
      return []
    })
  }

  const baseInput = {
    instance: {
      id: INSTANCE_ID,
      workflow_key: ATTENDANCE_APPROVAL_WORKFLOW_KEY,
      business_key: businessKey(),
      version: 3,
      published_definition_id: 'pub-def',
    },
    request: {
      requestId: REQUEST_ID,
      orgId: ORG,
      status: 'pending',
      approvalInstanceId: INSTANCE_ID,
      userId: 'subject-1',
    },
    actorId: ACTOR,
    targetUserId: TARGET,
  }

  it('target lock path issues users FOR UPDATE before user_orgs FOR UPDATE', async () => {
    const order: string[] = []
    const client = mockClient((sql, params) => {
      if (sql.includes("role_id = 'admin'")) return []
      if (sql.includes('FROM users') && !sql.includes('FOR UPDATE') && sql.includes('activation_status')) {
        return [{ '?column?': 1 }]
      }
      if (sql.includes('FROM user_orgs') && !sql.includes('FOR UPDATE')) {
        return [{ '?column?': 1 }]
      }
      if (sql.includes('user_permissions') || sql.includes('role_permissions')) {
        return [{ '?column?': 1 }]
      }
      if (sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
        order.push('users')
        expect(params?.[0]).toBe(TARGET)
        return [{ id: TARGET, is_active: true, activation_status: 'activated' }]
      }
      if (sql.includes('FROM user_orgs') && sql.includes('FOR UPDATE')) {
        order.push('user_orgs')
        expect(params?.[0]).toBe(TARGET)
        expect(params?.[1]).toBe(ORG)
        return [{ user_id: TARGET, org_id: ORG, is_active: true }]
      }
      return []
    })
    const result = await authorizeAttendanceCentralReassign(client, baseInput)
    expect(result.ok).toBe(true)
    expect(order).toEqual(['users', 'user_orgs'])
  })

  it('same-org success with both permissions produces org_admin audit witness', async () => {
    const result = await authorizeAttendanceCentralReassign(authClient({}), baseInput)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.actorPosture).toBe('org_admin')
      expect(result.auditWitness).toMatchObject({
        kind: 'w4c3b_attendance_reassign',
        orgId: ORG,
        requestId: REQUEST_ID,
        actorPosture: 'org_admin',
        instanceVersion: 3,
      })
    }
  })

  it('platform-admin override succeeds with audited platform_admin posture', async () => {
    const result = await authorizeAttendanceCentralReassign(
      authClient({
        platformAdmin: true,
        actorMember: false,
        hasApprovalsAdmin: false,
        hasAttendanceAdmin: false,
      }),
      baseInput,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.actorPosture).toBe('platform_admin')
      expect(result.auditWitness.actorPosture).toBe('platform_admin')
    }
  })

  it('missing approvals:admin alone → not-found', async () => {
    const result = await authorizeAttendanceCentralReassign(
      authClient({ hasApprovalsAdmin: false }),
      baseInput,
    )
    expect(result).toEqual({ ok: false, skipReason: 'not-found' })
  })

  it('missing attendance:admin alone → not-found', async () => {
    const result = await authorizeAttendanceCentralReassign(
      authClient({ hasAttendanceAdmin: false }),
      baseInput,
    )
    expect(result).toEqual({ ok: false, skipReason: 'not-found' })
  })

  it('actor not member of locked org → not-found (caller org cannot widen)', async () => {
    const result = await authorizeAttendanceCentralReassign(
      authClient({ actorMember: false }),
      baseInput,
    )
    expect(result).toEqual({ ok: false, skipReason: 'not-found' })
  })

  it('inactive actor → not-found', async () => {
    const result = await authorizeAttendanceCentralReassign(
      authClient({ actorLive: false }),
      baseInput,
    )
    expect(result).toEqual({ ok: false, skipReason: 'not-found' })
  })

  it('target non-member of locked org → target-user-invalid', async () => {
    const result = await authorizeAttendanceCentralReassign(
      authClient({ targetMember: false }),
      baseInput,
    )
    expect(result).toEqual({ ok: false, skipReason: 'target-user-invalid' })
  })

  it('inactive/deprovisioned target → target-user-invalid', async () => {
    const result = await authorizeAttendanceCentralReassign(
      authClient({ targetLive: false }),
      baseInput,
    )
    expect(result).toEqual({ ok: false, skipReason: 'target-user-invalid' })
  })

  it('null request (orphan attendance) → not-found', async () => {
    const result = await authorizeAttendanceCentralReassign(authClient({}), {
      ...baseInput,
      request: null,
    })
    expect(result).toEqual({ ok: false, skipReason: 'not-found' })
  })
})

describe('filterBulkReassignDiscoveryForAttendance', () => {
  it('keeps non-attendance, drops unauthorized attendance, keeps authorized attendance', async () => {
    const nonAtt = 'inst-non'
    const attOk = 'inst-att-ok'
    const attBad = 'inst-att-bad'
    const client = mockClient((sql, params) => {
      if (sql.includes("role_id = 'admin'")) return []
      if (sql.includes('FROM approval_instances i')) {
        return [
          { id: nonAtt, workflow_key: 'generic', org_id: null },
          { id: attOk, workflow_key: ATTENDANCE_APPROVAL_WORKFLOW_KEY, org_id: ORG },
          { id: attBad, workflow_key: ATTENDANCE_APPROVAL_WORKFLOW_KEY, org_id: 'other-org' },
        ]
      }
      if (sql.includes('FROM users') && sql.includes('activation_status')) {
        return params?.[0] === ACTOR ? [{ '?column?': 1 }] : []
      }
      if (sql.includes('FROM user_orgs')) {
        return params?.[0] === ACTOR && params?.[1] === ORG ? [{ '?column?': 1 }] : []
      }
      if (sql.includes('user_permissions') || sql.includes('role_permissions')) {
        return [{ '?column?': 1 }]
      }
      return []
    })

    const kept = await filterBulkReassignDiscoveryForAttendance(client, ACTOR, [
      nonAtt,
      attOk,
      attBad,
    ])
    expect(kept).toEqual([nonAtt, attOk])
  })
})

describe('AttendanceCentralApprovalError shape', () => {
  it('is values-free and typed', () => {
    const err = new AttendanceCentralApprovalError(
      W4C3B_CENTRAL_APPROVAL_ERROR_CODES.ATTENDANCE_CENTRAL_MUTATION_UNSUPPORTED,
      409,
      'Attendance approval cannot be mutated through this path',
    )
    expect(err.code).toBe('ATTENDANCE_CENTRAL_MUTATION_UNSUPPORTED')
    expect(err.message).not.toMatch(/org-a|request|user/i)
  })
})
