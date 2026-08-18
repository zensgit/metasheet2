import { describe, expect, it } from 'vitest'
import {
  APPROVAL_ASSIGNEE_SOURCE_KIND_TRAITS,
  DEPT_HEAD_CHAIN_ASSIGNEE_SOURCE_KINDS,
  FIELD_DERIVED_ORG_ASSIGNEE_SOURCE_KINDS,
  MANAGER_CHAIN_ASSIGNEE_SOURCE_KINDS,
  ORG_ASSIGNEE_SOURCE_KINDS,
  collectRuntimeGraphFieldDerivedSources,
  runtimeGraphUsesDeptHeadChain,
  runtimeGraphUsesManagerChain,
  runtimeGraphUsesOrgAssigneeSource,
} from '../../src/services/ApprovalProductService'
import type { ApprovalAssigneeSourceKind, RuntimeGraph } from '../../src/types/approval-product'

/**
 * Lock-2 §2.3 (the locked derived-not-enumerated refactor) + gate D-3 (adapted): the create-time
 * detectors' kind sets are DERIVED from the single APPROVAL_ASSIGNEE_SOURCE_KIND_TRAITS table —
 * not four hand-maintained `||` chains — and each derived set is pinned by EXACT set equality.
 *
 * The "proven DERIVED" arm: the per-kind detector sweep below drives every detector from the trait
 * table itself (expected = the trait row), so editing ONLY a trait row — touching no detector —
 * moves the detector AND reds the exact-set pin here. Without that arm this file would pass on
 * hand-maintained chains that happen to agree (the count-style assertion D-3's own text calls
 * insufficient).
 */

// A minimal one-approval-node runtime graph carrying exactly one source of `kind`.
function graphWithKind(kind: ApprovalAssigneeSourceKind, nodeType: 'approval' | 'handler' = 'approval'): RuntimeGraph {
  // Shape params are irrelevant to the detectors (they read `kind` structurally); supply a
  // superset of the per-kind params so the fixture is one function, not a per-kind switch.
  const source = { kind, fieldId: 'contact', level: 1, levels: 1, nodeKey: 'gate', userIds: ['u'], roleIds: ['r'], mode: 'single', scope: { type: 'company' } }
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'node_1', type: nodeType, config: { assigneeSources: [source] } as never },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'node_1' },
      { key: 'e2', source: 'node_1', target: 'end' },
    ],
    policy: { allowRevoke: false },
  }
}

const ALL_KINDS = Object.keys(APPROVAL_ASSIGNEE_SOURCE_KIND_TRAITS) as ApprovalAssigneeSourceKind[]

describe('Lock-2 §2.3 — trait-derived detector kind sets (gate D-3 adapted)', () => {
  it('the trait table covers the FULL fifteen-member ApprovalAssigneeSourceKind union (compile-forced Record; runtime exact-set pin)', () => {
    expect([...ALL_KINDS].sort()).toEqual([
      'continuous_dept_heads',
      'continuous_managers',
      'dept_head',
      'dept_head_at_level',
      'direct_manager',
      'form_field_user',
      'form_field_user_dept_head',
      'form_field_user_manager',
      'manager_at_level',
      'prior_node_approver',
      'requester',
      'requester_choice',
      'static_role',
      'static_user',
      'user_group',
    ])
  })

  it('each derived set equals its canonical membership by EXACT set equality (not count or subset)', () => {
    expect([...ORG_ASSIGNEE_SOURCE_KINDS].sort()).toEqual([
      'continuous_dept_heads',
      'continuous_managers',
      'dept_head',
      'dept_head_at_level',
      'direct_manager',
      'manager_at_level',
    ])
    expect([...MANAGER_CHAIN_ASSIGNEE_SOURCE_KINDS].sort()).toEqual([
      'continuous_managers',
      'manager_at_level',
    ])
    expect([...DEPT_HEAD_CHAIN_ASSIGNEE_SOURCE_KINDS].sort()).toEqual([
      'continuous_dept_heads',
      'dept_head_at_level',
    ])
    // Lock-2 §L2-C: the field-derived pair is its OWN detector set — deliberately NOT part of
    // ORG_ASSIGNEE_SOURCE_KINDS (§2.3: the requester wedge stays requester-scoped).
    expect([...FIELD_DERIVED_ORG_ASSIGNEE_SOURCE_KINDS].sort()).toEqual([
      'form_field_user_dept_head',
      'form_field_user_manager',
    ])
    const orgAndFieldDerived = [...ORG_ASSIGNEE_SOURCE_KINDS].filter((kind) => FIELD_DERIVED_ORG_ASSIGNEE_SOURCE_KINDS.has(kind))
    expect(orgAndFieldDerived).toEqual([])
  })

  it('every detector is DRIVEN by the trait table: for EVERY kind, detector output equals the trait row (editing only a trait row moves the detector and reds the exact-set pin above)', () => {
    for (const kind of ALL_KINDS) {
      const traits = APPROVAL_ASSIGNEE_SOURCE_KIND_TRAITS[kind]
      const graph = graphWithKind(kind)
      expect(runtimeGraphUsesOrgAssigneeSource(graph), `${kind} requesterOrgRead`).toBe(traits.requesterOrgRead)
      expect(runtimeGraphUsesManagerChain(graph), `${kind} managerChain`).toBe(traits.managerChain)
      expect(runtimeGraphUsesDeptHeadChain(graph), `${kind} deptHeadChain`).toBe(traits.deptHeadChain)
      expect(collectRuntimeGraphFieldDerivedSources(graph).size > 0, `${kind} fieldDerivedOrgRead`).toBe(traits.fieldDerivedOrgRead)
    }
  })
})

describe('Lock-2 §L2-C — collectRuntimeGraphFieldDerivedSources (detector + freeze driver)', () => {
  it('collects one entry per DISTINCT fingerprint (identical sources share one; differing level/field/kind each get their own), keyed <kind>:<fieldId>:<level>', () => {
    const graph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'a1',
          type: 'approval',
          config: {
            assigneeSources: [
              { kind: 'form_field_user_manager', fieldId: 'contact', level: 1 },
              { kind: 'form_field_user_manager', fieldId: 'contact', level: 2 },
              { kind: 'form_field_user_dept_head', fieldId: 'contact', level: 1 },
              // form_field_user (联系人自己) is NOT field-derived-org — no directory read at all.
              { kind: 'form_field_user', fieldId: 'contact' },
            ],
          } as never,
        },
        {
          key: 'a2',
          type: 'approval',
          // Identical to a1's first source — shares its fingerprint entry (first nodeKey kept).
          config: { assigneeSources: [{ kind: 'form_field_user_manager', fieldId: 'contact', level: 1 }] } as never,
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'a1' },
        { key: 'e2', source: 'a1', target: 'a2' },
        { key: 'e3', source: 'a2', target: 'end' },
      ],
      policy: { allowRevoke: false },
    }
    const collected = collectRuntimeGraphFieldDerivedSources(graph)
    expect([...collected.keys()].sort()).toEqual([
      'form_field_user_dept_head:contact:1',
      'form_field_user_manager:contact:1',
      'form_field_user_manager:contact:2',
    ])
    expect(collected.get('form_field_user_manager:contact:1')).toEqual({
      nodeKey: 'a1',
      source: { kind: 'form_field_user_manager', fieldId: 'contact', level: 1 },
    })
  })

  it('collects from HANDLER nodes too (Lock-2 §2.4 admits both node types; leaving handler out would be the R-13 silent-skip class), and returns empty for a graph with no field-derived source', () => {
    expect([...collectRuntimeGraphFieldDerivedSources(graphWithKind('form_field_user_manager', 'handler')).keys()])
      .toEqual(['form_field_user_manager:contact:1'])
    expect(collectRuntimeGraphFieldDerivedSources(graphWithKind('static_user')).size).toBe(0)
    expect(collectRuntimeGraphFieldDerivedSources(graphWithKind('form_field_user')).size).toBe(0)
  })
})
