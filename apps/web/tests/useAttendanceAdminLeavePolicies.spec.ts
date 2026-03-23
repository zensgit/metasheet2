import { describe, expect, it, vi } from 'vitest'
import { nextTick, reactive, ref } from 'vue'
import { useAttendanceAdminLeavePolicies } from '../src/views/attendance/useAttendanceAdminLeavePolicies'

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response
}

async function flushUi(): Promise<void> {
  await nextTick()
  await nextTick()
}

describe('useAttendanceAdminLeavePolicies', () => {
  it('loads leave types and seeds the request form selection', async () => {
    const adminForbidden = ref(false)
    const requestForm = reactive({ leaveTypeId: '', overtimeRuleId: '' })
    const apiFetch = vi.fn().mockResolvedValue(jsonResponse(200, {
      ok: true,
      data: {
        items: [
          {
            id: 'leave-1',
            code: 'annual',
            name: 'Annual Leave',
            paid: true,
            requiresApproval: true,
            requiresAttachment: false,
            defaultMinutesPerDay: 480,
            isActive: true,
          },
        ],
      },
    }))

    const policies = useAttendanceAdminLeavePolicies({
      adminForbidden,
      requestForm,
      apiFetch,
    })

    await policies.loadLeaveTypes()

    expect(apiFetch).toHaveBeenCalledWith('/api/attendance/leave-types?')
    expect(policies.leaveTypes.value).toHaveLength(1)
    expect(requestForm.leaveTypeId).toBe('leave-1')
    expect(adminForbidden.value).toBe(false)
  })

  it('saves a leave type, reloads the list, resets the form, and forwards success status', async () => {
    const adminForbidden = ref(false)
    const requestForm = reactive({ leaveTypeId: '', overtimeRuleId: '' })
    const setStatus = vi.fn()
    const setStatusFromError = vi.fn()
    const apiFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, data: { id: 'leave-2' } }))
      .mockResolvedValueOnce(jsonResponse(200, {
        ok: true,
        data: {
          items: [
            {
              id: 'leave-2',
              code: 'sick',
              name: 'Sick Leave',
              paid: false,
              requiresApproval: false,
              requiresAttachment: true,
              defaultMinutesPerDay: 240,
              isActive: true,
            },
          ],
        },
      }))

    const policies = useAttendanceAdminLeavePolicies({
      adminForbidden,
      requestForm,
      apiFetch,
      getOrgId: () => 'org-1',
      setStatus,
      setStatusFromError,
    })

    policies.leaveTypeForm.code = ' sick '
    policies.leaveTypeForm.name = ' Sick Leave '
    policies.leaveTypeForm.paid = false
    policies.leaveTypeForm.requiresApproval = false
    policies.leaveTypeForm.requiresAttachment = true
    policies.leaveTypeForm.defaultMinutesPerDay = 240

    await policies.saveLeaveType()

    expect(apiFetch).toHaveBeenNthCalledWith(1, '/api/attendance/leave-types', {
      method: 'POST',
      body: JSON.stringify({
        code: 'sick',
        name: 'Sick Leave',
        paid: false,
        requiresApproval: false,
        requiresAttachment: true,
        defaultMinutesPerDay: 240,
        isActive: true,
        orgId: 'org-1',
      }),
    })
    expect(apiFetch).toHaveBeenNthCalledWith(2, '/api/attendance/leave-types?orgId=org-1')
    expect(policies.leaveTypes.value[0]?.id).toBe('leave-2')
    expect(policies.leaveTypeEditingId.value).toBeNull()
    expect(policies.leaveTypeForm.code).toBe('')
    expect(policies.leaveTypeForm.name).toBe('')
    expect(setStatus).toHaveBeenCalledWith('Leave type created.')
    expect(setStatusFromError).not.toHaveBeenCalled()
  })

  it('auto-generates a leave type code from the name when the code is blank', async () => {
    const adminForbidden = ref(false)
    const requestForm = reactive({ leaveTypeId: '', overtimeRuleId: '' })
    const apiFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, data: { id: 'leave-3' } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, data: { items: [] } }))

    const policies = useAttendanceAdminLeavePolicies({
      adminForbidden,
      requestForm,
      apiFetch,
    })

    policies.leaveTypeForm.code = '   '
    policies.leaveTypeForm.name = 'Annual Leave'

    await policies.saveLeaveType()

    expect(apiFetch).toHaveBeenNthCalledWith(1, '/api/attendance/leave-types', {
      method: 'POST',
      body: JSON.stringify({
        code: 'annual_leave',
        name: 'Annual Leave',
        paid: true,
        requiresApproval: true,
        requiresAttachment: false,
        defaultMinutesPerDay: 480,
        isActive: true,
        orgId: undefined,
      }),
    })
  })

  it('deletes an overtime rule after confirmation and reloads data', async () => {
    const adminForbidden = ref(false)
    const requestForm = reactive({ leaveTypeId: '', overtimeRuleId: '' })
    const confirm = vi.fn().mockReturnValue(true)
    const setStatus = vi.fn()
    const apiFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
      .mockResolvedValueOnce(jsonResponse(200, {
        ok: true,
        data: {
          items: [
            {
              id: 'ot-2',
              name: 'Weekday OT',
              minMinutes: 30,
              roundingMinutes: 15,
              maxMinutesPerDay: 240,
              requiresApproval: true,
              isActive: true,
            },
          ],
        },
      }))

    const policies = useAttendanceAdminLeavePolicies({
      adminForbidden,
      requestForm,
      apiFetch,
      confirm,
      setStatus,
    })

    await policies.deleteOvertimeRule('ot-1')

    expect(confirm).toHaveBeenCalledWith('Delete this overtime rule?')
    expect(apiFetch).toHaveBeenNthCalledWith(1, '/api/attendance/overtime-rules/ot-1', { method: 'DELETE' })
    expect(apiFetch).toHaveBeenNthCalledWith(2, '/api/attendance/overtime-rules?')
    expect(policies.overtimeRules.value[0]?.id).toBe('ot-2')
    expect(setStatus).toHaveBeenCalledWith('Overtime rule deleted.')
  })

  it('rejects invalid approval flow steps JSON without calling the API', async () => {
    const adminForbidden = ref(false)
    const requestForm = reactive({ leaveTypeId: '', overtimeRuleId: '' })
    const setStatus = vi.fn()
    const apiFetch = vi.fn()

    const policies = useAttendanceAdminLeavePolicies({
      adminForbidden,
      requestForm,
      apiFetch,
      setStatus,
    })

    policies.approvalFlowForm.name = 'Manager Approval'
    policies.approvalFlowForm.steps = '{not-json}'

    await policies.saveApprovalFlow()

    expect(apiFetch).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith('Invalid steps JSON', 'error')
  })

  it('marks admin forbidden and forwards admin errors for leave type 403 responses', async () => {
    const adminForbidden = ref(false)
    const requestForm = reactive({ leaveTypeId: '', overtimeRuleId: '' })
    const setStatus = vi.fn()
    const setStatusFromError = vi.fn()
    const apiFetch = vi.fn().mockResolvedValue(jsonResponse(403, { ok: false }))

    const policies = useAttendanceAdminLeavePolicies({
      adminForbidden,
      requestForm,
      apiFetch,
      setStatus,
      setStatusFromError,
    })

    policies.leaveTypeForm.code = 'annual'
    policies.leaveTypeForm.name = 'Annual Leave'

    await policies.saveLeaveType()

    expect(adminForbidden.value).toBe(true)
    expect(setStatusFromError).toHaveBeenCalledTimes(1)
    expect(setStatus).not.toHaveBeenCalled()
  })

  it('marks admin forbidden and shows the approval flow 403 message directly', async () => {
    const adminForbidden = ref(false)
    const requestForm = reactive({ leaveTypeId: '', overtimeRuleId: '' })
    const setStatus = vi.fn()
    const apiFetch = vi.fn().mockResolvedValue(jsonResponse(403, { ok: false }))

    const policies = useAttendanceAdminLeavePolicies({
      adminForbidden,
      requestForm,
      apiFetch,
      setStatus,
    })

    policies.approvalFlowForm.name = 'Manager Approval'
    policies.approvalFlowForm.steps = '[]'

    await policies.saveApprovalFlow()

    expect(adminForbidden.value).toBe(true)
    expect(setStatus).toHaveBeenCalledWith('Admin permissions required', 'error')
  })

  it('keeps the visual approval builder and JSON fallback in sync', async () => {
    const adminForbidden = ref(false)
    const requestForm = reactive({ leaveTypeId: '', overtimeRuleId: '' })
    const apiFetch = vi.fn()

    const policies = useAttendanceAdminLeavePolicies({
      adminForbidden,
      requestForm,
      apiFetch,
    })

    expect(policies.approvalFlowBuilderSteps.value).toHaveLength(0)

    policies.addApprovalFlowBuilderStep()
    await flushUi()
    expect(policies.approvalFlowBuilderSteps.value).toHaveLength(1)

    policies.approvalFlowBuilderSteps.value[0]!.name = 'Manager review'
    policies.approvalFlowBuilderSteps.value[0]!.approverRoleIdsText = 'manager, hr'
    policies.approvalFlowBuilderSteps.value[0]!.approverUserIdsText = 'user-1'
    await flushUi()

    expect(JSON.parse(policies.approvalFlowForm.steps)).toEqual([
      {
        name: 'Manager review',
        approverRoleIds: ['manager', 'hr'],
        approverUserIds: ['user-1'],
      },
    ])

    policies.approvalFlowForm.steps = JSON.stringify([
      {
        name: 'HR review',
        approver_user_ids: ['user-2'],
        approverRoleIds: ['hr'],
      },
    ], null, 2)
    await flushUi()

    expect(policies.approvalFlowBuilderError.value).toBe('')
    expect(policies.approvalFlowBuilderSteps.value).toHaveLength(1)
    expect(policies.approvalFlowBuilderSteps.value[0]).toMatchObject({
      name: 'HR review',
      approverUserIdsText: 'user-2',
      approverRoleIdsText: 'hr',
    })
  })

  it('applies request-type approval templates and reports invalid JSON fallback state', async () => {
    const adminForbidden = ref(false)
    const requestForm = reactive({ leaveTypeId: '', overtimeRuleId: '' })
    const apiFetch = vi.fn()

    const policies = useAttendanceAdminLeavePolicies({
      adminForbidden,
      requestForm,
      apiFetch,
    })

    policies.approvalFlowForm.requestType = 'overtime'
    await flushUi()

    expect(policies.approvalFlowTemplates.value.map((template) => template.id)).toEqual([
      'manager-only',
      'manager-payroll',
      'manager-ops-payroll',
    ])

    policies.applyApprovalFlowTemplate('manager-payroll')
    await flushUi()

    expect(JSON.parse(policies.approvalFlowForm.steps)).toEqual([
      {
        name: 'Manager review',
        approverRoleIds: ['manager'],
      },
      {
        name: 'Payroll review',
        approverRoleIds: ['payroll'],
      },
    ])
    expect(policies.approvalFlowBuilderSummary.value).toMatchObject({
      stepCount: 2,
      roleAssignmentCount: 2,
      directUserCount: 0,
    })

    policies.approvalFlowForm.steps = '{bad-json}'
    await flushUi()

    expect(policies.approvalFlowBuilderError.value).toContain('Fix the JSON fallback')
    expect(policies.approvalFlowBuilderSteps.value).toHaveLength(2)
  })

  it('tracks linked workflow drafts when editing approval flows', async () => {
    const adminForbidden = ref(false)
    const requestForm = reactive({ leaveTypeId: '', overtimeRuleId: '' })
    const apiFetch = vi.fn().mockResolvedValue(jsonResponse(200, {
      ok: true,
      data: {
        items: [
          {
            id: 'flow-1',
            name: 'Leave manager to HR',
            requestType: 'leave',
            workflowId: 'wf-1',
            steps: [{ name: 'Manager review', approverRoleIds: ['manager'] }],
            isActive: true,
          },
        ],
      },
    }))

    const policies = useAttendanceAdminLeavePolicies({
      adminForbidden,
      requestForm,
      apiFetch,
    })

    await policies.loadApprovalFlows()
    policies.editApprovalFlow(policies.approvalFlows.value[0]!)

    expect(policies.approvalFlowForm.workflowId).toBe('wf-1')
  })

  it('updates the approval flow workflow link without reloading the full list', async () => {
    const adminForbidden = ref(false)
    const requestForm = reactive({ leaveTypeId: '', overtimeRuleId: '' })
    const setStatus = vi.fn()
    const apiFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        ok: true,
        data: {
          items: [
            {
              id: 'flow-1',
              name: 'Leave manager to HR',
              requestType: 'leave',
              workflowId: null,
              steps: [{ name: 'Manager review', approverRoleIds: ['manager'] }],
              isActive: true,
            },
          ],
        },
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        ok: true,
        data: {
          id: 'flow-1',
          name: 'Leave manager to HR',
          requestType: 'leave',
          workflowId: 'wf-123',
          steps: [{ name: 'Manager review', approverRoleIds: ['manager'] }],
          isActive: true,
        },
      }))

    const policies = useAttendanceAdminLeavePolicies({
      adminForbidden,
      requestForm,
      apiFetch,
      getOrgId: () => 'org-1',
      setStatus,
    })

    await policies.loadApprovalFlows()
    policies.editApprovalFlow(policies.approvalFlows.value[0]!)
    await policies.linkApprovalFlowWorkflow('flow-1', 'wf-123')

    expect(apiFetch).toHaveBeenNthCalledWith(2, '/api/attendance/approval-flows/flow-1/workflow-link', {
      method: 'PUT',
      body: JSON.stringify({
        workflowId: 'wf-123',
        orgId: 'org-1',
      }),
    })
    expect(policies.approvalFlows.value[0]?.workflowId).toBe('wf-123')
    expect(policies.approvalFlowForm.workflowId).toBe('wf-123')
    expect(setStatus).toHaveBeenCalledWith('Workflow draft linked to approval flow.')
  })
})
