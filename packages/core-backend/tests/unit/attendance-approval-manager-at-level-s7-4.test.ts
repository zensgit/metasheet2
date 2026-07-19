import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

// S7-4 (RATIFIED attendance-approval-s7 resolver design-lock §2.3 B1 / §3.4 / §4 / §7 S7-4): pure-helper
// unit coverage for create-time managerChainIds freeze + positional assignment build from the frozen
// snapshot. Directory chain walk is owned by ApprovalDirectoryOrg (+ its unit/db suites); the port
// wiring is covered by the port-scoping unit + the real-DB S7-4 integration matrix. These tests pin
// the PLUGIN-side contracts:
//   • freeze is a no-op for static-only flows (legacy byte-identity)
//   • freeze calls the port once for a flow containing manager_at_level (no level arg)
//   • short/empty chain at freeze → APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED (whole-flow)
//   • assignment build reads ONLY frozen managerChainIds at level-1 (no port re-call)
//   • self / empty / short / missing at assignment build → APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED
//   • direct_manager + dept_head freeze/assignment preserved (regression)
//   • continuous_managers remains UNGATED (OUT-of-v1)

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
  resolveAttendanceManagerChainFreeze: (input: {
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
  flowStepsNeedManagerChainFreeze: (steps: unknown) => boolean
  ATTENDANCE_DYNAMIC_ASSIGNEE_FLAG_ENV: string
}

const {
  buildAttendanceApprovalAssignments,
  buildAttendanceApprovalInstancePayload,
  resolveAttendanceManagerChainFreeze,
  resolveAttendanceOrgRelationsFreeze,
  flowStepsNeedManagerChainFreeze,
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

describe('S7-4 flowStepsNeedManagerChainFreeze', () => {
  it('is false for static-only / empty flows (legacy freeze no-op)', () => {
    expect(flowStepsNeedManagerChainFreeze([{ approverUserIds: ['u1'] }])).toBe(false)
    expect(flowStepsNeedManagerChainFreeze([])).toBe(false)
  })

  it('is true when any step is manager_at_level (incl. later steps)', () => {
    expect(flowStepsNeedManagerChainFreeze([{ kind: 'manager_at_level', level: 1 }])).toBe(true)
    expect(
      flowStepsNeedManagerChainFreeze([
        { name: 'S', approverUserIds: ['u1'] },
        { kind: 'manager_at_level', level: 2 },
      ]),
    ).toBe(true)
  })

  it('is false for direct_manager / dept_head (their own freeze seams)', () => {
    expect(flowStepsNeedManagerChainFreeze([{ kind: 'direct_manager' }])).toBe(false)
    expect(flowStepsNeedManagerChainFreeze([{ kind: 'dept_head' }])).toBe(false)
  })
})

describe('S7-4 resolveAttendanceManagerChainFreeze — create-time port call', () => {
  it('static-only flow never calls the port', async () => {
    let calls = 0
    const context = {
      services: {
        approvalAssigneeResolver: {
          implementedKinds: ['manager_at_level'],
          resolve: async () => {
            calls += 1
            return {
              status: 'resolved',
              assignees: [{ assignmentType: 'user', assigneeId: 'm1' }],
            }
          },
        },
      },
    }
    const rel = await resolveAttendanceManagerChainFreeze({
      orgId: 'org-1',
      userId: 'req-1',
      flowSteps: [{ approverUserIds: ['u1'] }],
      context,
    })
    expect(rel).toEqual({})
    expect(calls).toBe(0)
  })

  it('linked chain freezes managerChainIds from ordered port assignees (no level arg)', async () => {
    let seen: { orgId: string; request: Record<string, unknown> } | null = null
    const context = {
      services: {
        approvalAssigneeResolver: {
          implementedKinds: ['manager_at_level'],
          resolve: async (orgId: string, request: Record<string, unknown>) => {
            seen = { orgId, request }
            return {
              status: 'resolved',
              assignees: [
                { assignmentType: 'user', assigneeId: 'm1' },
                { assignmentType: 'user', assigneeId: 'm2' },
                { assignmentType: 'user', assigneeId: 'm3' },
              ],
            }
          },
        },
      },
    }
    const rel = await resolveAttendanceManagerChainFreeze({
      orgId: 'org-home',
      userId: 'req-1',
      flowSteps: [{ kind: 'manager_at_level', level: 2 }],
      context,
    })
    expect(rel).toEqual({ managerChainIds: ['m1', 'm2', 'm3'] })
    expect(seen).toEqual({
      orgId: 'org-home',
      request: { kind: 'manager_at_level', requesterUserId: 'req-1' },
    })
    // Freeze path must NOT pass level — full chain hydrate, positional pick is assignment-time only.
    expect((seen as { request: Record<string, unknown> }).request.level).toBeUndefined()
  })

  it('short chain vs required level rejects at create-time freeze (whole-flow)', async () => {
    const context = {
      services: {
        approvalAssigneeResolver: {
          implementedKinds: ['manager_at_level'],
          resolve: async () => ({
            status: 'resolved',
            assignees: [{ assignmentType: 'user', assigneeId: 'm1' }],
          }),
        },
      },
    }
    await expect(
      resolveAttendanceManagerChainFreeze({
        orgId: 'org-1',
        userId: 'req-1',
        flowSteps: [
          { name: 'S0', approverUserIds: ['u1'] },
          { kind: 'manager_at_level', level: 2 },
        ],
        context,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED' })
  })

  it('empty / unresolved chain rejects at create-time freeze', async () => {
    const context = {
      services: {
        approvalAssigneeResolver: {
          implementedKinds: ['manager_at_level'],
          resolve: async () => ({ status: 'unresolved', reason: 'no_manager_chain' }),
        },
      },
    }
    await expect(
      resolveAttendanceManagerChainFreeze({
        orgId: 'org-1',
        userId: 'req-1',
        flowSteps: [{ kind: 'manager_at_level', level: 1 }],
        context,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED' })
  })

  it('self id in chain is stripped; if level then empty → UNRESOLVED', async () => {
    const context = {
      services: {
        approvalAssigneeResolver: {
          implementedKinds: ['manager_at_level'],
          resolve: async () => ({
            status: 'resolved',
            assignees: [{ assignmentType: 'user', assigneeId: 'req-1' }],
          }),
        },
      },
    }
    await expect(
      resolveAttendanceManagerChainFreeze({
        orgId: 'org-1',
        userId: 'req-1',
        flowSteps: [{ kind: 'manager_at_level', level: 1 }],
        context,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED' })
  })

  it('missing port throws APPROVAL_STEP_KIND_UNAVAILABLE (resolver-unavailable §4.1)', async () => {
    await expect(
      resolveAttendanceManagerChainFreeze({
        orgId: 'org-1',
        userId: 'req-1',
        flowSteps: [{ kind: 'manager_at_level', level: 1 }],
        context: { services: {} },
      }),
    ).rejects.toMatchObject({ status: 422, code: 'APPROVAL_STEP_KIND_UNAVAILABLE' })
  })

  it('throwing port maps to APPROVAL_STEP_KIND_UNAVAILABLE (never admin fallback)', async () => {
    const context = {
      services: {
        approvalAssigneeResolver: {
          implementedKinds: ['manager_at_level'],
          resolve: async () => {
            throw new Error('directory boom')
          },
        },
      },
    }
    await expect(
      resolveAttendanceManagerChainFreeze({
        orgId: 'org-1',
        userId: 'req-1',
        flowSteps: [{ kind: 'manager_at_level', level: 1 }],
        context,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'APPROVAL_STEP_KIND_UNAVAILABLE' })
  })
})

describe('S7-4 resolveAttendanceOrgRelationsFreeze — mixed kinds', () => {
  it('freezes managerId + deptHeadId + managerChainIds for a triple mixed flow', async () => {
    const kinds: string[] = []
    const context = {
      services: {
        approvalAssigneeResolver: {
          implementedKinds: ['direct_manager', 'dept_head', 'manager_at_level'],
          resolve: async (_orgId: string, request: { kind: string }) => {
            kinds.push(request.kind)
            if (request.kind === 'direct_manager') {
              return { status: 'resolved', assignees: [{ assignmentType: 'user', assigneeId: 'mgr-1' }] }
            }
            if (request.kind === 'dept_head') {
              return { status: 'resolved', assignees: [{ assignmentType: 'user', assigneeId: 'dh-1' }] }
            }
            if (request.kind === 'manager_at_level') {
              return {
                status: 'resolved',
                assignees: [
                  { assignmentType: 'user', assigneeId: 'm1' },
                  { assignmentType: 'user', assigneeId: 'm2' },
                ],
              }
            }
            return { status: 'unimplemented' }
          },
        },
      },
    }
    const rel = await resolveAttendanceOrgRelationsFreeze({
      orgId: 'org-1',
      userId: 'req-1',
      flowSteps: [
        { kind: 'direct_manager' },
        { kind: 'dept_head' },
        { kind: 'manager_at_level', level: 2 },
      ],
      context,
    })
    expect(rel).toEqual({
      managerId: 'mgr-1',
      deptHeadId: 'dh-1',
      managerChainIds: ['m1', 'm2'],
    })
    expect(kinds.sort()).toEqual(['dept_head', 'direct_manager', 'manager_at_level'])
  })

  it('fails closed when manager_at_level is short even if direct_manager resolves', async () => {
    const context = {
      services: {
        approvalAssigneeResolver: {
          implementedKinds: ['direct_manager', 'manager_at_level'],
          resolve: async (_orgId: string, request: { kind: string }) => {
            if (request.kind === 'direct_manager') {
              return { status: 'resolved', assignees: [{ assignmentType: 'user', assigneeId: 'mgr-1' }] }
            }
            return {
              status: 'resolved',
              assignees: [{ assignmentType: 'user', assigneeId: 'm1' }],
            }
          },
        },
      },
    }
    await expect(
      resolveAttendanceOrgRelationsFreeze({
        orgId: 'org-1',
        userId: 'req-1',
        flowSteps: [{ kind: 'direct_manager' }, { kind: 'manager_at_level', level: 2 }],
        context,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED' })
  })
})

describe('S7-4 buildAttendanceApprovalAssignments — frozen managerChainIds only', () => {
  it('resolves exactly one positional manager at level-1 (1-based index)', () => {
    const snap = { id: 'req-1', name: 'Requester', managerChainIds: ['m1', 'm2', 'm3'] }
    expect(
      buildAttendanceApprovalAssignments([{ name: 'L1', kind: 'manager_at_level', level: 1 }], 0, snap),
    ).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'm1',
        sourceStep: 0,
        nodeKey: 'attendance_request_step_0',
        metadata: {
          source: 'attendance',
          kind: 'manager_at_level',
          stepName: 'L1',
          resolvedFrom: { kind: 'manager_at_level', level: 1 },
        },
      },
    ])
    expect(
      buildAttendanceApprovalAssignments([{ name: 'L2', kind: 'manager_at_level', level: 2 }], 0, snap),
    ).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'm2',
        sourceStep: 0,
        nodeKey: 'attendance_request_step_0',
        metadata: {
          source: 'attendance',
          kind: 'manager_at_level',
          stepName: 'L2',
          resolvedFrom: { kind: 'manager_at_level', level: 2 },
        },
      },
    ])
    expect(
      buildAttendanceApprovalAssignments([{ name: 'L3', kind: 'manager_at_level', level: 3 }], 0, snap),
    ).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'm3',
        sourceStep: 0,
        nodeKey: 'attendance_request_step_0',
        metadata: {
          source: 'attendance',
          kind: 'manager_at_level',
          stepName: 'L3',
          resolvedFrom: { kind: 'manager_at_level', level: 3 },
        },
      },
    ])
  })

  it('short chain at assignment → APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED (never admin fallback)', () => {
    expect(
      httpCode(() =>
        buildAttendanceApprovalAssignments([{ kind: 'manager_at_level', level: 3 }], 0, {
          id: 'req-1',
          managerChainIds: ['m1', 'm2'],
        }),
      ),
    ).toEqual({ status: 422, code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED' })
  })

  it('self-exclusion at picked level → APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED', () => {
    expect(
      httpCode(() =>
        buildAttendanceApprovalAssignments([{ kind: 'manager_at_level', level: 1 }], 0, {
          id: 'req-1',
          managerChainIds: ['req-1', 'm2'],
        }),
      ),
    ).toEqual({ status: 422, code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED' })
    // Level 2 still works if that slot is non-self.
    const out = buildAttendanceApprovalAssignments([{ kind: 'manager_at_level', level: 2 }], 0, {
      id: 'req-1',
      managerChainIds: ['req-1', 'm2'],
    })
    expect(out[0]).toMatchObject({ assigneeId: 'm2' })
  })

  it('missing managerChainIds / null snapshot → APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED', () => {
    expect(
      httpCode(() =>
        buildAttendanceApprovalAssignments([{ kind: 'manager_at_level', level: 1 }], 0, { id: 'req-1' }),
      ),
    ).toEqual({ status: 422, code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED' })
    expect(
      httpCode(() => buildAttendanceApprovalAssignments([{ kind: 'manager_at_level', level: 1 }], 0, null)),
    ).toEqual({ status: 422, code: 'APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED' })
  })

  it('mutation canary: dynamic unresolved must NOT produce admin/source_queue rows', () => {
    try {
      buildAttendanceApprovalAssignments([{ kind: 'manager_at_level', level: 1 }], 0, { id: 'req-1' })
      expect.fail('expected throw')
    } catch (err) {
      const e = err as { code?: string }
      expect(e.code).toBe('APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED')
    }
    const legacy = buildAttendanceApprovalAssignments([], 0)
    expect(legacy.some((a) => a.assignmentType === 'role' && a.assigneeId === 'admin')).toBe(true)
    expect(legacy.some((a) => a.assignmentType === 'source_queue')).toBe(true)
  })

  it('step-advance index uses frozen chain for step 1 (no live re-resolve)', () => {
    const steps = [
      { name: 'S0', approverUserIds: ['u-step0'] },
      { name: 'S1', kind: 'manager_at_level', level: 2 },
    ]
    const snap = { id: 'req-1', managerChainIds: ['m1-frozen', 'm2-frozen'] }
    const out = buildAttendanceApprovalAssignments(steps, 1, snap)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      assignmentType: 'user',
      assigneeId: 'm2-frozen',
      sourceStep: 1,
      nodeKey: 'attendance_request_step_1',
      metadata: expect.objectContaining({
        kind: 'manager_at_level',
        resolvedFrom: { kind: 'manager_at_level', level: 2 },
      }),
    })
  })

  it('sequential levels 1 then 2 each pick their own frozen index (no auto-expansion)', () => {
    const steps = [
      { kind: 'manager_at_level', level: 1 },
      { kind: 'manager_at_level', level: 2 },
    ]
    const snap = { id: 'req-1', managerChainIds: ['m1', 'm2', 'm3'] }
    expect(buildAttendanceApprovalAssignments(steps, 0, snap)[0].assigneeId).toBe('m1')
    expect(buildAttendanceApprovalAssignments(steps, 1, snap)[0].assigneeId).toBe('m2')
  })

  it('legacy static byte-identity: user/role assignments unchanged when chain snapshot is present', () => {
    const out = buildAttendanceApprovalAssignments(
      [{ name: 'LM', approverUserIds: ['u1', 'u2'], approverRoleIds: ['r1'] }],
      0,
      { id: 'req-1', managerChainIds: ['m1', 'm2'] },
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

  it('direct_manager + dept_head assignment paths still work alongside manager_at_level freeze fields', () => {
    const steps = [
      { kind: 'direct_manager' },
      { kind: 'dept_head' },
      { kind: 'manager_at_level', level: 1 },
    ]
    const snap = {
      id: 'req-1',
      managerId: 'mgr-frozen',
      deptHeadId: 'dh-frozen',
      managerChainIds: ['m1', 'm2'],
    }
    expect(buildAttendanceApprovalAssignments(steps, 0, snap)[0]).toMatchObject({
      assigneeId: 'mgr-frozen',
      metadata: expect.objectContaining({ kind: 'direct_manager' }),
    })
    expect(buildAttendanceApprovalAssignments(steps, 1, snap)[0]).toMatchObject({
      assigneeId: 'dh-frozen',
      metadata: expect.objectContaining({ kind: 'dept_head' }),
    })
    expect(buildAttendanceApprovalAssignments(steps, 2, snap)[0]).toMatchObject({
      assigneeId: 'm1',
      metadata: expect.objectContaining({ kind: 'manager_at_level' }),
    })
  })
})

describe('S7-4 buildAttendanceApprovalInstancePayload — freeze managerChainIds into requesterSnapshot', () => {
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

  it('freezes managerChainIds when orgRelations carries them', () => {
    const payload = buildAttendanceApprovalInstancePayload({
      approvalId: 'apv_1',
      requestId: '00000000-0000-4000-8000-000000000002',
      orgId: 'org-1',
      userId: 'req-1',
      requesterName: 'Alice',
      draft: {
        requestType: 'leave',
        workDate: '2026-07-01',
        metadata: { approvalFlow: { steps: [{ kind: 'manager_at_level', level: 1 }] } },
      },
      orgRelations: { managerChainIds: ['m1', 'm2'] },
    })
    expect(payload.requesterSnapshot).toEqual({
      id: 'req-1',
      name: 'Alice',
      managerChainIds: ['m1', 'm2'],
    })
  })

  it('freezes all three org-relation fields for mixed orgRelations', () => {
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
          approvalFlow: {
            steps: [
              { kind: 'direct_manager' },
              { kind: 'dept_head' },
              { kind: 'manager_at_level', level: 1 },
            ],
          },
        },
      },
      orgRelations: { managerId: 'mgr-1', deptHeadId: 'dh-1', managerChainIds: ['m1', 'm2'] },
    })
    expect(payload.requesterSnapshot).toEqual({
      id: 'req-1',
      name: 'Alice',
      managerId: 'mgr-1',
      deptHeadId: 'dh-1',
      managerChainIds: ['m1', 'm2'],
    })
  })
})
