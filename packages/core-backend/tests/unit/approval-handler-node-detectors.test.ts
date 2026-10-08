import { describe, expect, it } from 'vitest'
import {
  runtimeGraphUsesOrgAssigneeSource,
  runtimeGraphUsesManagerChain,
} from '../../src/services/ApprovalProductService'
import type { RuntimeGraph } from '../../src/types/approval-product'

/**
 * Lock-3 R-13/R-14 — the create-time org-read fail-closed detectors must include HANDLER nodes.
 *
 * R-14 is the P1 hazard: `runtimeGraphUsesOrgAssigneeSource` drives the create-time guard that
 * fails closed (422/503, zero rows) when the org read FAILED and the graph carries an org-derived
 * source. Leaving the detector approval-only reproduces the B5-b fail-open for a handler. This is
 * the mechanical arm of G-3: the create-side wiring
 * (`if (orgReadFailed && runtimeGraphUsesOrgAssigneeSource(...))`) is shipped and unchanged — only
 * the DETECTOR now recognizes a handler's org source.
 *
 * MUTATION (the guard's load-bearing proof): reverting either detector's arm to `node.type !==
 * 'approval'` REDs the handler cases below while the approval positive controls stay green.
 */
const POLICY = { allowRevoke: false }

function graph(nodes: RuntimeGraph['nodes']): RuntimeGraph {
  return { nodes, edges: [], policy: POLICY }
}

const START = { key: 'start', type: 'start' as const, config: {} }
const END = { key: 'end', type: 'end' as const, config: {} }

describe('Lock-3 R-14 — runtimeGraphUsesOrgAssigneeSource includes handler nodes', () => {
  it('returns TRUE for a handler node carrying an org-derived source (direct_manager)', () => {
    const g = graph([
      START,
      { key: 'h', type: 'handler', config: { assigneeSources: [{ kind: 'direct_manager' }] } },
      END,
    ])
    expect(runtimeGraphUsesOrgAssigneeSource(g)).toBe(true)
  })

  it('returns TRUE for a handler using dept_head and manager_at_level', () => {
    expect(runtimeGraphUsesOrgAssigneeSource(graph([
      START,
      { key: 'h', type: 'handler', config: { assigneeSources: [{ kind: 'dept_head' }] } },
      END,
    ]))).toBe(true)
    expect(runtimeGraphUsesOrgAssigneeSource(graph([
      START,
      { key: 'h', type: 'handler', config: { assigneeSources: [{ kind: 'manager_at_level', level: 1 }] } },
      END,
    ]))).toBe(true)
  })

  it('positive control: an APPROVAL node with an org source still returns TRUE (guard is not vacuous)', () => {
    const g = graph([
      START,
      { key: 'a', type: 'approval', config: { assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single' } },
      END,
    ])
    expect(runtimeGraphUsesOrgAssigneeSource(g)).toBe(true)
  })

  it('negative control: a handler with only a NON-org source (static_user) returns FALSE', () => {
    const g = graph([
      START,
      { key: 'h', type: 'handler', config: { assigneeSources: [{ kind: 'static_user', userIds: ['u1'] }] } },
      END,
    ])
    expect(runtimeGraphUsesOrgAssigneeSource(g)).toBe(false)
  })
})

describe('Lock-3 R-13 — runtimeGraphUsesManagerChain includes handler nodes', () => {
  it('returns TRUE for a handler using manager_at_level', () => {
    const g = graph([
      START,
      { key: 'h', type: 'handler', config: { assigneeSources: [{ kind: 'manager_at_level', level: 2 }] } },
      END,
    ])
    expect(runtimeGraphUsesManagerChain(g)).toBe(true)
  })

  it('negative control: a handler with static_user returns FALSE', () => {
    const g = graph([
      START,
      { key: 'h', type: 'handler', config: { assigneeSources: [{ kind: 'static_user', userIds: ['u1'] }] } },
      END,
    ])
    expect(runtimeGraphUsesManagerChain(g)).toBe(false)
  })
})
