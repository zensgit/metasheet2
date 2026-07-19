import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

// S7-2 (RATIFIED attendance-approval-s7 resolver design-lock §2.1 / §3.4 / §4 / §7 S7-2): pure-helper
// unit coverage for create-time freeze + assignment build from the frozen requester snapshot.
// Directory resolution itself is owned by ApprovalDirectoryOrg (+ its unit/db suites); the port
// wiring is covered by the port-scoping unit + the real-DB S7-2 integration matrix. These tests
// pin the PLUGIN-side contracts:
//   • freeze is a no-op for static-only flows (legacy byte-identity)
//   • freeze calls the port once for a flow containing direct_manager
//   • unresolved / self / empty at freeze → APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED (whole-flow,
//     including multi-step [static, direct_manager] — never empty freeze + later strand)
//   • assignment build reads ONLY the frozen snapshot (no port re-call)
//   • self / empty / missing at assignment build → APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED
//   • legacy static empty-approver fallback is preserved when no dynamic kind is present

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceApprovalCenterForTests as {
  buildAttendanceApprovalAssignments: (
    steps: unknown,
    index?: number,
    snapshot?: Record<string, unknown> | null,
  ) => Array<Record<string, unknown>>
  buildAttendanceApprovalInstancePayload: (input: Record<string, unknown>) => {
    requesterSnapshot: Record<string, unknown>
  }
  resolveAttendanceDirectManagerFreeze: (input: {
    orgId: string
    userId: string
    flowSteps: unknown
    context: unknown
  }) => Promise<Record<string, unknown>>
  flowStepsNeedDirectManagerFreeze: (steps: unknown) => boolean
  ATTENDANCE_DYNAMIC_ASSIGNEE_FLAG_ENV: string
}

const {
  buildAttendanceApprovalAssignments,
  buildAttendanceApprovalInstancePayload,
  resolveAttendanceDirectManagerFreeze,
  flowStepsNeedDirectManagerFreeze,
  ATTENDANCE_DYNAMIC_ASSIGNEE_FLAG_ENV,
} = helpers

function httpCode(fn: () => void): { status: number; code: string } | null {
  try {
    fn()
    return null
  } catch (err) {
    const e = err as { status?: number; code?: string }
    return { status: e.status ?? -1, code: e.code ?? '<none>' }
  }
}

afterEach(() => {
  delete process.env[ATTENDANCE_DYNAMIC_ASSIGNEE_FLAG_ENV]
})

describe('S7-2 flowStepsNeedDirectManagerFreeze', () => {
  it('is false for static-only / empty flows (legacy freeze no-op)', () => {
    expect(flowStepsNeedDirectManagerFreeze([{ approverUserIds: ['u1'] }])).toBe(false)
    expect(flowStepsNeedDirectManagerFreeze([])).toBe(false)
  })

  it('is true when any step is direct_manager (incl. later steps)', () => {
    expect(flowStepsNeedDirectManagerFreeze([{ kind: 'direct_manager' }])).toBe(true)
    expect(
      flowStepsNeedDirectManagerFreeze([
        { name: 'S', approverUserIds: ['u1'] },
        { kind: 'direct_manager' },
      ]),
    ).toBe(true)
  })

  it('is false for other dynamic kinds (dept_head is S7-3 — no freeze yet)', () => {
    expect(flowStepsNeedDirectManagerFreeze([{ kind: 'dept_head' }])).toBe(false)
  })
})

describe('S7-2 resolveAttendanceDirectManagerFreeze — create-time port call', () => {
  it('static-only flow never calls the port', async () => {
    let calls = 0
    const context = {
      services: {
        approvalAssigneeResolver: {
          implementedKinds: ['direct_manager'],
          resolve: async () => {
            calls += 1
            return { status: 'resolved', assignees: [{ assignmentType: 'user', assigneeId: 'm1' }] }
          },
        },
      },
    }
    const rel = await resolveAttendanceDirectManagerFreeze({
      orgId: 'org-1',
      userId: 'req-1',
      flowSteps: [{ approverUserIds: ['u1'] }],
      context,
    })
    expect(rel).toEqual({})
    expect(calls).toBe(0)
  })

  it('linked resolution freezes managerId from the port assignees', async () => {
    let seen: { orgId: string; request: Record<string, unknown> } | null = null
    const context = {
      services: {
        approvalAssigneeResolver: {
          implementedKinds: ['direct_manager'],
          resolve: async (orgId: string, request: Record<string, unknown>) => {
            seen = { orgId, request }
            return { status: 'resolved', assignees: [{ assignmentType: 'user', assigneeId: 'mgr-local' }] }
          },
        },
      },
    }
    const rel = await resolveAttendanceDirectManagerFreeze({
      orgId: 'org-home',
      userId: 'req-1',
      flowSteps: [{ kind: 'direct_manager' }],
      context,
    })
    expect(rel).toEqual({ managerId: 'mgr-local' })
    expect(seen).toEqual({
      orgId: 'org-home',
      request: { kind: 'direct_manager', requesterUserId: 'req-1' },
    })
  })

  it('self-resolving manager rejects at create-time freeze (APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED)', async () => {
    const context = {
      services: {
        approvalAssigneeResolver: {
          implementedKinds: ['direct_manager'],
          resolve: async () => ({
            status: 'resolved',
            assignees: [{ assignmentType: 'user', assigneeId: 'req-1' }],
          }),
        },
      },
    }
    await expect(
      resolveAttendanceDirectManagerFreeze({
        orgId: 'org-1',
        userId: 'req-1',
        flowSteps: [{ kind: 'direct_manager' }],
        context,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED' })
  })

  it('unresolved port result rejects at create-time freeze (whole-flow; never empty freeze)', async () => {
    const context = {
      services: {
        approvalAssigneeResolver: {
          implementedKinds: ['direct_manager'],
          resolve: async () => ({ status: 'unresolved', reason: 'no_manager_linked' }),
        },
      },
    }
    await expect(
      resolveAttendanceDirectManagerFreeze({
        orgId: 'org-1',
        userId: 'req-1',
        flowSteps: [{ kind: 'direct_manager' }],
        context,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED' })
  })

  it('empty assignees array rejects at create-time freeze', async () => {
    const context = {
      services: {
        approvalAssigneeResolver: {
          implementedKinds: ['direct_manager'],
          resolve: async () => ({ status: 'resolved', assignees: [] }),
        },
      },
    }
    await expect(
      resolveAttendanceDirectManagerFreeze({
        orgId: 'org-1',
        userId: 'req-1',
        flowSteps: [{ name: 'S0', approverUserIds: ['u1'] }, { kind: 'direct_manager' }],
        context,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED' })
  })

  it('missing port throws APPROVAL_STEP_KIND_UNAVAILABLE (resolver-unavailable §4.1)', async () => {
    await expect(
      resolveAttendanceDirectManagerFreeze({
        orgId: 'org-1',
        userId: 'req-1',
        flowSteps: [{ kind: 'direct_manager' }],
        context: { services: {} },
      }),
    ).rejects.toMatchObject({ status: 422, code: 'APPROVAL_STEP_KIND_UNAVAILABLE' })
  })
})

describe('S7-2 buildAttendanceApprovalAssignments — frozen snapshot only', () => {
  it('builds a user assignment from frozen managerId (linked resolution)', () => {
    const out = buildAttendanceApprovalAssignments(
      [{ name: '直属上级', kind: 'direct_manager' }],
      0,
      { id: 'req-1', name: 'Requester', managerId: 'mgr-1' },
    )
    expect(out).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'mgr-1',
        sourceStep: 0,
        nodeKey: 'attendance_request_step_0',
        metadata: {
          source: 'attendance',
          kind: 'direct_manager',
          stepName: '直属上级',
          resolvedFrom: { kind: 'direct_manager' },
        },
      },
    ])
  })

  it('self-exclusion → APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED (never admin fallback)', () => {
    expect(
      httpCode(() =>
        buildAttendanceApprovalAssignments([{ kind: 'direct_manager' }], 0, {
          id: 'req-1',
          managerId: 'req-1',
        }),
      ),
    ).toEqual({ status: 422, code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED' })
  })

  it('missing managerId → APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED', () => {
    expect(
      httpCode(() =>
        buildAttendanceApprovalAssignments([{ kind: 'direct_manager' }], 0, { id: 'req-1' }),
      ),
    ).toEqual({ status: 422, code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED' })
  })

  it('null snapshot → APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED', () => {
    expect(httpCode(() => buildAttendanceApprovalAssignments([{ kind: 'direct_manager' }], 0, null))).toEqual({
      status: 422,
      code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED',
    })
  })

  it('mutation canary: dynamic unresolved must NOT produce admin/source_queue rows', () => {
    try {
      buildAttendanceApprovalAssignments([{ kind: 'direct_manager' }], 0, { id: 'req-1' })
      expect.fail('expected throw')
    } catch (err) {
      const e = err as { code?: string }
      expect(e.code).toBe('APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED')
    }
    // Positive control: static empty still falls back (legacy reserved path).
    const legacy = buildAttendanceApprovalAssignments([], 0)
    expect(legacy.some((a) => a.assignmentType === 'role' && a.assigneeId === 'admin')).toBe(true)
    expect(legacy.some((a) => a.assignmentType === 'source_queue')).toBe(true)
  })

  it('step-advance index uses frozen snapshot for step 1 (no live re-resolve)', () => {
    const steps = [
      { name: 'S0', approverUserIds: ['u-step0'] },
      { name: 'S1', kind: 'direct_manager' },
    ]
    const snap = { id: 'req-1', managerId: 'mgr-frozen' }
    const out = buildAttendanceApprovalAssignments(steps, 1, snap)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      assignmentType: 'user',
      assigneeId: 'mgr-frozen',
      sourceStep: 1,
      nodeKey: 'attendance_request_step_1',
    })
  })

  it('legacy static byte-identity: user/role assignments unchanged when snapshot is present', () => {
    const out = buildAttendanceApprovalAssignments(
      [{ name: 'LM', approverUserIds: ['u1', 'u2'], approverRoleIds: ['r1'] }],
      0,
      { id: 'req-1', managerId: 'mgr-ignored-for-static' },
    )
    expect(out).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'u1',
        sourceStep: 0,
        nodeKey: 'attendance_request_step_0',
        metadata: { source: 'attendance', stepName: 'LM' },
      },
      {
        assignmentType: 'user',
        assigneeId: 'u2',
        sourceStep: 0,
        nodeKey: 'attendance_request_step_0',
        metadata: { source: 'attendance', stepName: 'LM' },
      },
      {
        assignmentType: 'role',
        assigneeId: 'r1',
        sourceStep: 0,
        nodeKey: 'attendance_request_step_0',
        metadata: { source: 'attendance', stepName: 'LM' },
      },
    ])
  })
})

describe('S7-2 buildAttendanceApprovalInstancePayload — freeze into requesterSnapshot', () => {
  it('legacy static: snapshot is still {id, name} only when orgRelations is empty', () => {
    const payload = buildAttendanceApprovalInstancePayload({
      approvalId: 'apv_1',
      requestId: '00000000-0000-4000-8000-000000000001',
      orgId: 'org-1',
      userId: 'req-1',
      requesterName: 'Alice',
      draft: { requestType: 'leave', workDate: '2026-07-01', metadata: { approvalFlow: { steps: [] } } },
    })
    expect(payload.requesterSnapshot).toEqual({ id: 'req-1', name: 'Alice' })
  })

  it('freezes managerId when orgRelations carries it', () => {
    const payload = buildAttendanceApprovalInstancePayload({
      approvalId: 'apv_1',
      requestId: '00000000-0000-4000-8000-000000000002',
      orgId: 'org-1',
      userId: 'req-1',
      requesterName: 'Alice',
      draft: {
        requestType: 'leave',
        workDate: '2026-07-01',
        metadata: { approvalFlow: { steps: [{ kind: 'direct_manager' }] } },
      },
      orgRelations: { managerId: 'mgr-1' },
    })
    expect(payload.requesterSnapshot).toEqual({ id: 'req-1', name: 'Alice', managerId: 'mgr-1' })
  })
})
