// Client mirror of plugins/plugin-attendance/lib/outdoor-approval-flow-save.cjs.
// The loaded active outdoor_punch list is what the admin card can see.
// The settings PUT remains the authority (a flow can change between load and save).

export type OutdoorApprovalSaveBlockReason = 'none' | 'ambiguous' | 'missing'

export interface OutdoorApprovalSaveAssessment {
  ok: boolean
  code: 'OUTDOOR_APPROVAL_FLOW_REQUIRED' | null
  reason: OutdoorApprovalSaveBlockReason | null
}

export function assessOutdoorApprovalSave(input: {
  requireApproval: boolean
  approvalFlowId: string
  activeOutdoorFlowIds: readonly string[]
}): OutdoorApprovalSaveAssessment {
  if (input.requireApproval !== true) {
    return { ok: true, code: null, reason: null }
  }
  const approvalFlowId = String(input.approvalFlowId || '').trim()
  const activeIds = input.activeOutdoorFlowIds
  if (approvalFlowId) {
    if (!activeIds.includes(approvalFlowId)) {
      return { ok: false, code: 'OUTDOOR_APPROVAL_FLOW_REQUIRED', reason: 'missing' }
    }
    return { ok: true, code: null, reason: null }
  }
  if (activeIds.length === 1) {
    return { ok: true, code: null, reason: null }
  }
  return {
    ok: false,
    code: 'OUTDOOR_APPROVAL_FLOW_REQUIRED',
    reason: activeIds.length === 0 ? 'none' : 'ambiguous',
  }
}
