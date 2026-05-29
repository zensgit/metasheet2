import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceApprovalCenterForTests

describe('attendance approval center bridge helpers', () => {
  it('assigns flow-backed attendance requests to the current approval step', () => {
    expect(helpers.buildAttendanceApprovalAssignments([
      {
        name: 'Line manager',
        approverUserIds: ['manager-1', 'manager-1'],
        approverRoleIds: ['attendance-reviewer'],
      },
      {
        name: 'HR',
        approverUserIds: ['hr-1'],
      },
    ], 0)).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'manager-1',
        sourceStep: 0,
        nodeKey: 'attendance_request_step_0',
        metadata: { source: 'attendance', stepName: 'Line manager' },
      },
      {
        assignmentType: 'role',
        assigneeId: 'attendance-reviewer',
        sourceStep: 0,
        nodeKey: 'attendance_request_step_0',
        metadata: { source: 'attendance', stepName: 'Line manager' },
      },
    ])
  })

  it('falls back to the attendance approval permission queue when no flow exists', () => {
    expect(helpers.buildAttendanceApprovalAssignments([], 0)).toEqual([
      {
        assignmentType: 'role',
        assigneeId: 'admin',
        sourceStep: 0,
        nodeKey: 'attendance_request_step_0',
        metadata: { source: 'attendance', queue: 'attendance-approval' },
      },
      {
        assignmentType: 'source_queue',
        assigneeId: 'attendance:approve',
        sourceStep: 0,
        nodeKey: 'attendance_request_step_0',
        metadata: { source: 'attendance', queue: 'attendance-approval' },
      },
      {
        assignmentType: 'source_queue',
        assigneeId: 'attendance:admin',
        sourceStep: 0,
        nodeKey: 'attendance_request_step_0',
        metadata: { source: 'attendance', queue: 'attendance-approval' },
      },
    ])
  })

  it('builds approval instance metadata that the global approval inbox can route back to attendance', () => {
    const payload = helpers.buildAttendanceApprovalInstancePayload({
      approvalId: 'apv-1',
      requestId: 'request-1',
      orgId: 'org-1',
      userId: 'employee-1',
      requesterName: 'Employee One',
      draft: {
        workDate: '2026-05-29',
        requestType: 'missed_check_out',
        requestedInAt: null,
        requestedOutAt: new Date('2026-05-29T18:00:00.000Z'),
        reason: 'forgot checkout',
        metadata: { minutes: 395 },
      },
    })

    expect(payload.workflowKey).toBe('attendance.request')
    expect(payload.businessKey).toBe('attendance-request:request-1')
    expect(payload.title).toContain('漏打下班卡')
    expect(payload.requesterSnapshot).toEqual({ id: 'employee-1', name: 'Employee One' })
    expect(payload.formSnapshot).toMatchObject({
      attendanceRequestId: 'request-1',
      requestType: 'missed_check_out',
      workDate: '2026-05-29',
      requestedOutAt: '2026-05-29T18:00:00.000Z',
    })
    expect(payload.policySnapshot).toMatchObject({ sourceOfTruth: 'attendance' })
  })
})
