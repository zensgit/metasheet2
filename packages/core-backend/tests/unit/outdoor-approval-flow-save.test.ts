import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { refuseOutdoorApprovalFlowSave } = require('../../../../plugins/plugin-attendance/lib/outdoor-approval-flow-save.cjs') as {
  refuseOutdoorApprovalFlowSave: (input: {
    requireApproval?: boolean
    approvalFlowId?: string
    explicitFlow?: { requestType?: string; isActive?: boolean } | null
    activeOutdoorFlowCount?: number
  }) => { status: number; code: string; message: string } | null
}

const activeOutdoor = { requestType: 'outdoor_punch', isActive: true }

describe('refuseOutdoorApprovalFlowSave', () => {
  it('allows requireApproval off with zero flows', () => {
    expect(refuseOutdoorApprovalFlowSave({
      requireApproval: false,
      approvalFlowId: '',
      activeOutdoorFlowCount: 0,
    })).toBeNull()
  })

  it('refuses an empty id when there are 0 or more than 1 active outdoor flows', () => {
    const none = refuseOutdoorApprovalFlowSave({
      requireApproval: true,
      approvalFlowId: '  ',
      activeOutdoorFlowCount: 0,
    })
    expect(none).toMatchObject({ status: 422, code: 'OUTDOOR_APPROVAL_FLOW_REQUIRED' })
    expect(none?.message).toContain('未配置')

    const many = refuseOutdoorApprovalFlowSave({
      requireApproval: true,
      approvalFlowId: '',
      activeOutdoorFlowCount: 2,
    })
    expect(many).toMatchObject({ status: 422, code: 'OUTDOOR_APPROVAL_FLOW_REQUIRED' })
    expect(many?.message).toContain('多个')
  })

  it('allows an empty id when exactly one active outdoor flow exists', () => {
    expect(refuseOutdoorApprovalFlowSave({
      requireApproval: true,
      approvalFlowId: '',
      activeOutdoorFlowCount: 1,
    })).toBeNull()
  })

  it('allows an explicit active outdoor_punch flow even when other active flows exist', () => {
    expect(refuseOutdoorApprovalFlowSave({
      requireApproval: true,
      approvalFlowId: 'flow-a',
      explicitFlow: activeOutdoor,
      activeOutdoorFlowCount: 2,
    })).toBeNull()
  })

  it('refuses a missing, inactive, or non-outdoor explicit flow', () => {
    expect(refuseOutdoorApprovalFlowSave({
      requireApproval: true,
      approvalFlowId: 'missing',
      explicitFlow: null,
      activeOutdoorFlowCount: 1,
    })?.code).toBe('OUTDOOR_APPROVAL_FLOW_REQUIRED')
    expect(refuseOutdoorApprovalFlowSave({
      requireApproval: true,
      approvalFlowId: 'inactive',
      explicitFlow: { requestType: 'outdoor_punch', isActive: false },
    })?.code).toBe('OUTDOOR_APPROVAL_FLOW_REQUIRED')
    expect(refuseOutdoorApprovalFlowSave({
      requireApproval: true,
      approvalFlowId: 'leave',
      explicitFlow: { requestType: 'leave', isActive: true },
    })?.code).toBe('OUTDOOR_APPROVAL_FLOW_REQUIRED')
  })
})
