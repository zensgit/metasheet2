import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

// S7-3 (RATIFIED attendance-approval-s7 resolver design-lock §2.2 / §3.4 / §4 / §7 S7-3): pure-helper
// unit coverage for create-time freeze + assignment build from the frozen requester snapshot.
// Directory resolution itself is owned by ApprovalDirectoryOrg (+ its unit/db suites); the port
// wiring is covered by the port-scoping unit + the real-DB S7-3 integration matrix. These tests
// pin the PLUGIN-side contracts:
//   • freeze is a no-op for static-only flows (legacy byte-identity)
//   • freeze calls the port once for a flow containing dept_head
//   • mixed direct_manager + dept_head freezes BOTH
//   • unresolved / self / empty at freeze → APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED (whole-flow)
//   • assignment build reads ONLY the frozen snapshot (no port re-call)
//   • self / empty / missing at assignment build → APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED
//   • direct_manager freeze/assignment preserved (regression)

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
  resolveAttendanceDeptHeadFreeze: (input: {
    orgId: string
    userId: string
    flowSteps: unknown
    context: unknown
  }) => Promise<Record<string, unknown>>
  resolveAttendanceOrgRelationsFreeze: (input: {
    orgId: string
    userId: string
    flowSteps: unknown
    context: unknown
  }) => Promise<Record<string, unknown>>
  flowStepsNeedDeptHeadFreeze: (steps: unknown) => boolean
  ATTENDANCE_DYNAMIC_ASSIGNEE_FLAG_ENV: string
}

const {
  buildAttendanceApprovalAssignments,
  buildAttendanceApprovalInstancePayload,
  resolveAttendanceDeptHeadFreeze,
  resolveAttendanceOrgRelationsFreeze,
  flowStepsNeedDeptHeadFreeze,
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

describe('S7-3 flowStepsNeedDeptHeadFreeze', () => {
  it('is false for static-only / empty flows (legacy freeze no-op)', () => {
    expect(flowStepsNeedDeptHeadFreeze([{ approverUserIds: ['u1'] }])).toBe(false)
    expect(flowStepsNeedDeptHeadFreeze([])).toBe(false)
  })

  it('is true when any step is dept_head (incl. later steps)', () => {
    expect(flowStepsNeedDeptHeadFreeze([{ kind: 'dept_head' }])).toBe(true)
    expect(
      flowStepsNeedDeptHeadFreeze([
        { name: 'S', approverUserIds: ['u1'] },
        { kind: 'dept_head' },
      ]),
    ).toBe(true)
  })

  it('is false for direct_manager (its own S7-2 freeze seam)', () => {
    expect(flowStepsNeedDeptHeadFreeze([{ kind: 'direct_manager' }])).toBe(false)
  })
})

describe('S7-3 resolveAttendanceDeptHeadFreeze — create-time port call', () => {
  it('static-only flow never calls the port', async () => {
    let calls = 0
    const context = {
      services: {
        approvalAssigneeResolver: {
          implementedKinds: ['dept_head'],
          resolve: async () => {
            calls += 1
            return { status: 'resolved', assignees: [{ assignmentType: 'user', assigneeId: 'dh1' }] }
          },
        },
      },
    }
    const rel = await resolveAttendanceDeptHeadFreeze({
      orgId: 'org-1',
      userId: 'req-1',
      flowSteps: [{ approverUserIds: ['u1'] }],
      context,
    })
    expect(rel).toEqual({})
    expect(calls).toBe(0)
  })

  it('linked resolution freezes deptHeadId from the port assignees', async () => {
    let seen: { orgId: string; request: Record<string, unknown> } | null = null
    const context = {
      services: {
        approvalAssigneeResolver: {
          implementedKinds: ['dept_head'],
          resolve: async (orgId: string, request: Record<string, unknown>) => {
            seen = { orgId, request }
            return { status: 'resolved', assignees: [{ assignmentType: 'user', assigneeId: 'dh-local' }] }
          },
        },
      },
    }
    const rel = await resolveAttendanceDeptHeadFreeze({
      orgId: 'org-home',
      userId: 'req-1',
      flowSteps: [{ kind: 'dept_head' }],
      context,
    })
    expect(rel).toEqual({ deptHeadId: 'dh-local' })
    expect(seen).toEqual({
      orgId: 'org-home',
      request: { kind: 'dept_head', requesterUserId: 'req-1' },
    })
  })

  it('self-resolving dept head rejects at create-time freeze (APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED)', async () => {
    const context = {
      services: {
        approvalAssigneeResolver: {
          implementedKinds: ['dept_head'],
          resolve: async () => ({
            status: 'resolved',
            assignees: [{ assignmentType: 'user', assigneeId: 'req-1' }],
          }),
        },
      },
    }
    await expect(
      resolveAttendanceDeptHeadFreeze({
        orgId: 'org-1',
        userId: 'req-1',
        flowSteps: [{ kind: 'dept_head' }],
        context,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED' })
  })

  it('unresolved port result rejects at create-time freeze (whole-flow; never empty freeze)', async () => {
    const context = {
      services: {
        approvalAssigneeResolver: {
          implementedKinds: ['dept_head'],
          resolve: async () => ({ status: 'unresolved', reason: 'no_dept_head_linked' }),
        },
      },
    }
    await expect(
      resolveAttendanceDeptHeadFreeze({
        orgId: 'org-1',
        userId: 'req-1',
        flowSteps: [{ kind: 'dept_head' }],
        context,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED' })
  })

  it('empty assignees array rejects at create-time freeze', async () => {
    const context = {
      services: {
        approvalAssigneeResolver: {
          implementedKinds: ['dept_head'],
          resolve: async () => ({ status: 'resolved', assignees: [] }),
        },
      },
    }
    await expect(
      resolveAttendanceDeptHeadFreeze({
        orgId: 'org-1',
        userId: 'req-1',
        flowSteps: [{ name: 'S0', approverUserIds: ['u1'] }, { kind: 'dept_head' }],
        context,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED' })
  })

  it('missing port throws APPROVAL_STEP_KIND_UNAVAILABLE (resolver-unavailable §4.1)', async () => {
    await expect(
      resolveAttendanceDeptHeadFreeze({
        orgId: 'org-1',
        userId: 'req-1',
        flowSteps: [{ kind: 'dept_head' }],
        context: { services: {} },
      }),
    ).rejects.toMatchObject({ status: 422, code: 'APPROVAL_STEP_KIND_UNAVAILABLE' })
  })
})

describe('S7-3 resolveAttendanceOrgRelationsFreeze — mixed direct_manager + dept_head', () => {
  it('freezes both managerId and deptHeadId for a mixed flow', async () => {
    const kinds: string[] = []
    const context = {
      services: {
        approvalAssigneeResolver: {
          implementedKinds: ['direct_manager', 'dept_head'],
          resolve: async (_orgId: string, request: { kind: string }) => {
            kinds.push(request.kind)
            if (request.kind === 'direct_manager') {
              return { status: 'resolved', assignees: [{ assignmentType: 'user', assigneeId: 'mgr-1' }] }
            }
            if (request.kind === 'dept_head') {
              return { status: 'resolved', assignees: [{ assignmentType: 'user', assigneeId: 'dh-1' }] }
            }
            return { status: 'unimplemented' }
          },
        },
      },
    }
    const rel = await resolveAttendanceOrgRelationsFreeze({
      orgId: 'org-1',
      userId: 'req-1',
      flowSteps: [{ kind: 'direct_manager' }, { kind: 'dept_head' }],
      context,
    })
    expect(rel).toEqual({ managerId: 'mgr-1', deptHeadId: 'dh-1' })
    expect(kinds.sort()).toEqual(['dept_head', 'direct_manager'])
  })

  it('fails closed when dept_head is unresolved even if direct_manager resolves', async () => {
    const context = {
      services: {
        approvalAssigneeResolver: {
          implementedKinds: ['direct_manager', 'dept_head'],
          resolve: async (_orgId: string, request: { kind: string }) => {
            if (request.kind === 'direct_manager') {
              return { status: 'resolved', assignees: [{ assignmentType: 'user', assigneeId: 'mgr-1' }] }
            }
            return { status: 'unresolved', reason: 'no_dept_head_linked' }
          },
        },
      },
    }
    await expect(
      resolveAttendanceOrgRelationsFreeze({
        orgId: 'org-1',
        userId: 'req-1',
        flowSteps: [{ kind: 'direct_manager' }, { kind: 'dept_head' }],
        context,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED' })
  })

  it('dept_head-only flow freezes only deptHeadId', async () => {
    const context = {
      services: {
        approvalAssigneeResolver: {
          implementedKinds: ['direct_manager', 'dept_head'],
          resolve: async (_orgId: string, request: { kind: string }) => {
            if (request.kind === 'dept_head') {
              return { status: 'resolved', assignees: [{ assignmentType: 'user', assigneeId: 'dh-only' }] }
            }
            return { status: 'unimplemented' }
          },
        },
      },
    }
    const rel = await resolveAttendanceOrgRelationsFreeze({
      orgId: 'org-1',
      userId: 'req-1',
      flowSteps: [{ kind: 'dept_head' }],
      context,
    })
    expect(rel).toEqual({ deptHeadId: 'dh-only' })
  })
})

describe('S7-3 buildAttendanceApprovalAssignments — frozen snapshot only', () => {
  it('builds a user assignment from frozen deptHeadId (linked resolution)', () => {
    const out = buildAttendanceApprovalAssignments(
      [{ name: '部门主管', kind: 'dept_head' }],
      0,
      { id: 'req-1', name: 'Requester', deptHeadId: 'dh-1' },
    )
    expect(out).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'dh-1',
        sourceStep: 0,
        nodeKey: 'attendance_request_step_0',
        metadata: {
          source: 'attendance',
          kind: 'dept_head',
          stepName: '部门主管',
          resolvedFrom: { kind: 'dept_head' },
        },
      },
    ])
  })

  it('self-exclusion → APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED (never admin fallback)', () => {
    expect(
      httpCode(() =>
        buildAttendanceApprovalAssignments([{ kind: 'dept_head' }], 0, {
          id: 'req-1',
          deptHeadId: 'req-1',
        }),
      ),
    ).toEqual({ status: 422, code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED' })
  })

  it('missing deptHeadId → APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED', () => {
    expect(
      httpCode(() =>
        buildAttendanceApprovalAssignments([{ kind: 'dept_head' }], 0, { id: 'req-1' }),
      ),
    ).toEqual({ status: 422, code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED' })
  })

  it('blank deptHeadId → APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED', () => {
    expect(
      httpCode(() =>
        buildAttendanceApprovalAssignments([{ kind: 'dept_head' }], 0, {
          id: 'req-1',
          deptHeadId: '   ',
        }),
      ),
    ).toEqual({ status: 422, code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED' })
  })

  it('null snapshot → APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED', () => {
    expect(httpCode(() => buildAttendanceApprovalAssignments([{ kind: 'dept_head' }], 0, null))).toEqual({
      status: 422,
      code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED',
    })
  })

  it('mutation canary: dynamic unresolved must NOT produce admin/source_queue rows', () => {
    try {
      buildAttendanceApprovalAssignments([{ kind: 'dept_head' }], 0, { id: 'req-1' })
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
      { name: 'S1', kind: 'dept_head' },
    ]
    const snap = { id: 'req-1', deptHeadId: 'dh-frozen' }
    const out = buildAttendanceApprovalAssignments(steps, 1, snap)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      assignmentType: 'user',
      assigneeId: 'dh-frozen',
      sourceStep: 1,
      nodeKey: 'attendance_request_step_1',
    })
  })

  it('mixed flow step 0 direct_manager + step 1 dept_head read their own frozen fields', () => {
    const steps = [
      { name: 'S0', kind: 'direct_manager' },
      { name: 'S1', kind: 'dept_head' },
    ]
    const snap = { id: 'req-1', managerId: 'mgr-frozen', deptHeadId: 'dh-frozen' }
    expect(buildAttendanceApprovalAssignments(steps, 0, snap)[0]).toMatchObject({
      assigneeId: 'mgr-frozen',
      metadata: expect.objectContaining({ kind: 'direct_manager' }),
    })
    expect(buildAttendanceApprovalAssignments(steps, 1, snap)[0]).toMatchObject({
      assigneeId: 'dh-frozen',
      metadata: expect.objectContaining({ kind: 'dept_head' }),
    })
  })

  it('legacy static byte-identity: user/role assignments unchanged when snapshot is present', () => {
    const out = buildAttendanceApprovalAssignments(
      [{ name: 'LM', approverUserIds: ['u1', 'u2'], approverRoleIds: ['r1'] }],
      0,
      { id: 'req-1', deptHeadId: 'dh-ignored-for-static' },
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

describe('S7-3 buildAttendanceApprovalInstancePayload — freeze into requesterSnapshot', () => {
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

  it('freezes deptHeadId when orgRelations carries it', () => {
    const payload = buildAttendanceApprovalInstancePayload({
      approvalId: 'apv_1',
      requestId: '00000000-0000-4000-8000-000000000002',
      orgId: 'org-1',
      userId: 'req-1',
      requesterName: 'Alice',
      draft: {
        requestType: 'leave',
        workDate: '2026-07-01',
        metadata: { approvalFlow: { steps: [{ kind: 'dept_head' }] } },
      },
      orgRelations: { deptHeadId: 'dh-1' },
    })
    expect(payload.requesterSnapshot).toEqual({ id: 'req-1', name: 'Alice', deptHeadId: 'dh-1' })
  })

  it('freezes both managerId and deptHeadId for mixed orgRelations', () => {
    const payload = buildAttendanceApprovalInstancePayload({
      approvalId: 'apv_1',
      requestId: '00000000-0000-4000-8000-000000000003',
      orgId: 'org-1',
      userId: 'req-1',
      requesterName: 'Alice',
      draft: {
        requestType: 'leave',
        workDate: '2026-07-01',
        metadata: {
          approvalFlow: { steps: [{ kind: 'direct_manager' }, { kind: 'dept_head' }] },
        },
      },
      orgRelations: { managerId: 'mgr-1', deptHeadId: 'dh-1' },
    })
    expect(payload.requesterSnapshot).toEqual({
      id: 'req-1',
      name: 'Alice',
      managerId: 'mgr-1',
      deptHeadId: 'dh-1',
    })
  })
})
