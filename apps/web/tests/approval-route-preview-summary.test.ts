import { describe, expect, it } from 'vitest'

import { routePreviewAssigneeSummary } from '../src/approvals/routePreviewSummary'
import type { ApprovalRoutePreviewNode } from '../src/approvals/api'

// RP-2 (B3-05) — honest-rendering matrix for the resolved-route chip summary:
// unresolved/empty nodes render 「（审批人待定）」 (never a guess, never blank), role
// assignees carry a visible 「角色:」 marker, multi-assignee joins with 「、」.

function node(partial: Partial<ApprovalRoutePreviewNode>): ApprovalRoutePreviewNode {
  return { nodeKey: 'n1', nodeLabel: '一级审批', assignees: [], ...partial }
}

describe('routePreviewAssigneeSummary', () => {
  it('renders 待定 for a resolveError node even when assignees leaked through', () => {
    expect(
      routePreviewAssigneeSummary(node({ resolveError: 'EMPTY_ASSIGNEES', assignees: [{ id: 'u1', name: '张三', assignmentType: 'user' }] })),
    ).toBe('（审批人待定）')
  })

  it('renders 待定 for an empty assignee list', () => {
    expect(routePreviewAssigneeSummary(node({ assignees: [] }))).toBe('（审批人待定）')
  })

  it('renders a single user by display name', () => {
    expect(routePreviewAssigneeSummary(node({ assignees: [{ id: 'u1', name: '张三', assignmentType: 'user' }] }))).toBe('张三')
  })

  it('marks role assignees with 角色: so a bucket is never mistaken for a person', () => {
    expect(routePreviewAssigneeSummary(node({ assignees: [{ id: 'r1', name: '财务主管', assignmentType: 'role' }] }))).toBe('角色:财务主管')
  })

  it('joins mixed assignees with 、 preserving order', () => {
    expect(
      routePreviewAssigneeSummary(
        node({
          assignees: [
            { id: 'u1', name: '张三', assignmentType: 'user' },
            { id: 'r1', name: '财务主管', assignmentType: 'role' },
            { id: 'u2', name: 'u2', assignmentType: 'user' },
          ],
        }),
      ),
    ).toBe('张三、角色:财务主管、u2')
  })

  it('renders the honest id fallback verbatim (server enriches; FE never re-guesses)', () => {
    expect(routePreviewAssigneeSummary(node({ assignees: [{ id: 'u_gone', name: 'u_gone', assignmentType: 'user' }] }))).toBe('u_gone')
  })
})
