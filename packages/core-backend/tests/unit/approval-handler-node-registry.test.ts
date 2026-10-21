import { describe, expect, it } from 'vitest'
import { HANDLER_ASSIGNEE_SOURCE_KINDS } from '../../src/types/approval-product'

/**
 * Lock-3 §1.5 / G-13 — BACKEND arm of the handler assignee-source registry exact-set pin (the FE
 * arm lives in apps/web/tests/approval-handler-node-authoring.spec.ts; the two constants must
 * byte-mirror each other, which the FE spec's roster assertions + this file's set enforce from
 * both sides). G-13, quoted: "the handler roster equals a DECLARED … handler registry constant by
 * exact set equality — not count, not subset … two separate mutations: drop one admitted kind, and
 * add `continuous_managers`; each must fail".
 *
 * The expected set is written out LITERALLY here (never derived from the constant) so that any
 * change to HANDLER_ASSIGNEE_SOURCE_KINDS — adding or dropping a kind — reds this test until the
 * expected set is edited in the same commit, which makes every roster change a reviewed decision.
 *
 * Composition (each layer is ratified text):
 *  - base roster, OD-L3-6(a): seven of the originally shipped eight (`continuous_managers` out);
 *  - Lock-2 §2.4: `form_field_user_manager` + `form_field_user_dept_head` (approval AND handler);
 *  - Lock-3 §1.5 forward rows (W1-1d): "`user_group` (K1), `requester_choice` (K2) and
 *    `dept_head_at_level` (K5-b) ADMIT … `prior_node_approver` (K3) and `continuous_dept_heads`
 *    (K4) do NOT".
 */
const EXPECTED_HANDLER_ROSTER = [
  'static_user',
  'static_role',
  'requester',
  'form_field_user',
  'direct_manager',
  'dept_head',
  'manager_at_level',
  'form_field_user_manager',
  'form_field_user_dept_head',
  'user_group',
  'requester_choice',
  'dept_head_at_level',
] as const

describe('Lock-3 G-13 (backend) — HANDLER_ASSIGNEE_SOURCE_KINDS exact set', () => {
  it('equals the declared roster by exact-set equality (not count, not subset) and carries no duplicates', () => {
    expect(new Set(HANDLER_ASSIGNEE_SOURCE_KINDS)).toEqual(new Set(EXPECTED_HANDLER_ROSTER))
    expect(HANDLER_ASSIGNEE_SOURCE_KINDS).toHaveLength(EXPECTED_HANDLER_ROSTER.length)
    expect(new Set(HANDLER_ASSIGNEE_SOURCE_KINDS).size).toBe(HANDLER_ASSIGNEE_SOURCE_KINDS.length)
  })

  it('W1-1d: the three Lock-3 §1.5 forward rows are admitted', () => {
    for (const kind of ['user_group', 'requester_choice', 'dept_head_at_level'] as const) {
      expect(HANDLER_ASSIGNEE_SOURCE_KINDS as readonly string[]).toContain(kind)
    }
  })

  it('the kinds Lock-3 §1.5 names "do NOT" (K3, K4) and OD-L3-6(a) excludes (continuous_managers) stay OUT', () => {
    for (const kind of ['prior_node_approver', 'continuous_dept_heads', 'continuous_managers'] as const) {
      expect(HANDLER_ASSIGNEE_SOURCE_KINDS as readonly string[]).not.toContain(kind)
    }
  })

  it('mutation 1 — dropping an admitted kind fails the exact-set check', () => {
    const dropped = HANDLER_ASSIGNEE_SOURCE_KINDS.filter((kind) => kind !== 'user_group')
    expect(new Set(dropped)).not.toEqual(new Set(EXPECTED_HANDLER_ROSTER))
  })

  it('mutation 2 — adding continuous_managers fails the exact-set check', () => {
    const added = [...HANDLER_ASSIGNEE_SOURCE_KINDS, 'continuous_managers']
    expect(new Set(added)).not.toEqual(new Set(EXPECTED_HANDLER_ROSTER))
  })
})
