import { describe, expect, it } from 'vitest'
import {
  buildAttendanceWorkflowHandoffQuery,
  readAttendanceWorkflowHandoff,
  resolveAttendanceWorkflowStarterId,
} from '../src/views/attendance/attendanceWorkflowHandoff'

describe('attendanceWorkflowHandoff', () => {
  it('builds and reads attendance approval handoff query state', () => {
    const query = buildAttendanceWorkflowHandoffQuery({
      requestType: 'leave',
      approvalFlowId: 'flow-1',
      approvalFlowName: 'Leave manager to HR',
      steps: [
        {
          name: 'Manager review',
          approverRoleIdsText: 'manager',
        },
        {
          name: 'HR review',
          approverRoleIdsText: 'hr',
          approverUserIdsText: 'user-hr-1',
        },
      ],
    })

    expect(query).toMatchObject({
      tab: 'workflow',
      wfSource: 'attendance',
      wfHandoff: 'approval-flow',
      attendanceRequestType: 'leave',
      approvalFlowId: 'flow-1',
      approvalFlowName: 'Leave manager to HR',
      approvalStepCount: '2',
      workflowStarterId: 'parallel-review',
      templateId: 'parallel-review',
      workflowName: 'Leave manager to HR',
    })

    expect(readAttendanceWorkflowHandoff(query)).toEqual({
      source: 'attendance',
      handoff: 'approval-flow',
      requestType: 'leave',
      approvalFlowId: 'flow-1',
      approvalFlowName: 'Leave manager to HR',
      approvalStepCount: 2,
      approvalStepSummary: 'Manager review -> HR review',
      workflowName: 'Leave manager to HR',
      workflowDescription: 'Attendance leave starter from approval builder',
      workflowStarterId: 'parallel-review',
      templateId: 'parallel-review',
    })
  })

  it('ignores empty placeholder steps and falls back to the simple starter', () => {
    const query = buildAttendanceWorkflowHandoffQuery({
      requestType: 'missed_check_in',
      approvalFlowName: '',
      steps: [
        {
          name: '   ',
          approverRoleIdsText: '',
          approverUserIdsText: '',
        },
      ],
    })

    expect(query.approvalStepCount).toBe('0')
    expect(query.workflowStarterId).toBe('simple-approval')
    expect(query.templateId).toBe('simple-approval')
    expect(query.approvalFlowName).toBe('Missed check-in approval flow')
    expect(resolveAttendanceWorkflowStarterId('overtime', 1)).toBe('simple-approval')
    expect(resolveAttendanceWorkflowStarterId('leave', 3)).toBe('parallel-review')
  })
})
