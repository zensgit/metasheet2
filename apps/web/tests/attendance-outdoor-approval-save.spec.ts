import { describe, expect, it } from 'vitest'
import { assessOutdoorApprovalSave } from '../src/views/attendance/outdoorApprovalSave'

describe('assessOutdoorApprovalSave', () => {
  it('allows turning approval off with no flows', () => {
    expect(assessOutdoorApprovalSave({
      requireApproval: false,
      approvalFlowId: '',
      activeOutdoorFlowIds: [],
    })).toEqual({ ok: true, code: null, reason: null })
  })

  it('refuses an empty id when 0 or more than 1 active outdoor flows are loaded', () => {
    expect(assessOutdoorApprovalSave({
      requireApproval: true,
      approvalFlowId: '',
      activeOutdoorFlowIds: [],
    })).toEqual({ ok: false, code: 'OUTDOOR_APPROVAL_FLOW_REQUIRED', reason: 'none' })
    expect(assessOutdoorApprovalSave({
      requireApproval: true,
      approvalFlowId: '  ',
      activeOutdoorFlowIds: ['a', 'b'],
    })).toEqual({ ok: false, code: 'OUTDOOR_APPROVAL_FLOW_REQUIRED', reason: 'ambiguous' })
  })

  it('allows an empty id when exactly one active outdoor flow is loaded', () => {
    expect(assessOutdoorApprovalSave({
      requireApproval: true,
      approvalFlowId: '',
      activeOutdoorFlowIds: ['only'],
    })).toEqual({ ok: true, code: null, reason: null })
  })

  it('allows an explicit id that is in the active list, and refuses one that is not', () => {
    expect(assessOutdoorApprovalSave({
      requireApproval: true,
      approvalFlowId: 'a',
      activeOutdoorFlowIds: ['a', 'b'],
    })).toEqual({ ok: true, code: null, reason: null })
    expect(assessOutdoorApprovalSave({
      requireApproval: true,
      approvalFlowId: 'stale',
      activeOutdoorFlowIds: ['a'],
    })).toEqual({ ok: false, code: 'OUTDOOR_APPROVAL_FLOW_REQUIRED', reason: 'missing' })
  })
})
