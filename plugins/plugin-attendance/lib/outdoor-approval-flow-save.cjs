'use strict'

// #5961: whether a settings write of punchPolicy.outdoor.requireApproval=true
// would resolve at punch time. Mirrors prepareOutdoorRequestCreate:
// an explicit approvalFlowId must be an active outdoor_punch flow; an empty
// id requires exactly one active outdoor_punch flow (0 or >1 refuse).
// requireApproval other than exact true is not this gate's problem.

const OUTDOOR_APPROVAL_FLOW_REQUIRED = 'OUTDOOR_APPROVAL_FLOW_REQUIRED'

function refuseOutdoorApprovalFlowSave(input) {
  if (!input || input.requireApproval !== true) return null
  const approvalFlowId = typeof input.approvalFlowId === 'string' ? input.approvalFlowId.trim() : ''
  if (approvalFlowId) {
    const flow = input.explicitFlow
    if (!flow || flow.requestType !== 'outdoor_punch' || flow.isActive !== true) {
      return {
        status: 422,
        code: OUTDOOR_APPROVAL_FLOW_REQUIRED,
        message: '外勤审批流不存在或未启用',
      }
    }
    return null
  }
  const activeCount = Number(input.activeOutdoorFlowCount)
  if (activeCount === 1) return null
  return {
    status: 422,
    code: OUTDOOR_APPROVAL_FLOW_REQUIRED,
    message: activeCount === 0
      ? '外勤审批流未配置'
      : '存在多个启用的外勤审批流，请指定 approvalFlowId',
  }
}

module.exports = {
  OUTDOOR_APPROVAL_FLOW_REQUIRED,
  refuseOutdoorApprovalFlowSave,
}
