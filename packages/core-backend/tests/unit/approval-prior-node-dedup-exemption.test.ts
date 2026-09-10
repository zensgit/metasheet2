import { describe, expect, it } from 'vitest'
import type { ApprovalAssigneeResolutionMetadata } from '../../src/types/approval-product'
import { isPriorNodeApproverHistoryDedupExempt } from '../../src/services/approval-prior-node-dedup-exemption'

type SourceKind = NonNullable<ApprovalAssigneeResolutionMetadata['resolvedFrom']>['kind']

function metadata(kind: SourceKind): ApprovalAssigneeResolutionMetadata {
  return { resolvedFrom: { kind, sourceIndex: 0 } }
}

describe('Lock-4 F4-D prior_node_approver history-dedup exemption', () => {
  it('exempts only the exact prior_node_approver source kind', () => {
    expect(isPriorNodeApproverHistoryDedupExempt(metadata('prior_node_approver'))).toBe(true)
    expect(isPriorNodeApproverHistoryDedupExempt(metadata('static_user'))).toBe(false)
  })

  it('does not turn missing source provenance into an exemption', () => {
    expect(isPriorNodeApproverHistoryDedupExempt(undefined)).toBe(false)
    expect(isPriorNodeApproverHistoryDedupExempt({ delegatedFrom: 'delegator' })).toBe(false)
  })
})
