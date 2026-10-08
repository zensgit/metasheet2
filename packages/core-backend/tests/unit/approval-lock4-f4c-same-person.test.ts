import { describe, expect, it } from 'vitest'
import {
  REQUEST_VALIDATION_CONTEXT,
  SAME_PERSON_POLICIES,
  hasEnabledAutoApprovalRule,
  normalizeAutoApprovalPolicy,
} from '../../src/services/ApprovalProductService'
import { resolveApprovalAssignees } from '../../src/services/ApprovalAssigneeResolver'

/**
 * Lock-4 §2 F4-C — same-person policy (审批人=提交人), `samePersonPolicy` inside the existing
 * `autoApprovalPolicy` object. Source: `docs/development/approval-lock4-flow-policies-20260817.md`
 * (RATIFIED 2026-08-17) OD-L4-4(a), OD-L4-5(a), gates C-1, C-2, C-3, X-1.
 *
 * DB-INDEPENDENT (required `test (18.x/20.x)` lane): the normalizer's synthesis output shape, the
 * §2.2 enable-predicate widening (`hasEnabledAutoApprovalRule`, mutate-proven per term), and the
 * resolver's pure same-person transfer substitution are all exercisable without a DB. C-1's byte-
 * identical deep-equal over real dispatch records, C-2's temporal frozen-snapshot control, and C-3's
 * absent-target-governs-emptyAssigneePolicy behavior live in the real-DB companion
 * `tests/integration/approval-lock4-f4c-same-person.db.test.ts`.
 */

describe('Lock-4 F4-C — SAME_PERSON_POLICIES exact-set membership', () => {
  it('contains exactly the four ratified members', () => {
    expect(SAME_PERSON_POLICIES).toEqual(
      new Set(['self_approve', 'auto_skip', 'transfer_direct_manager', 'transfer_dept_head']),
    )
  })
})

describe('Lock-4 F4-C — normalizeAutoApprovalPolicy synthesis (the "auto_skip persists as mergeWithRequester:true" carrier claim, pinned not just described)', () => {
  it('samePersonPolicy:"auto_skip" ALONE synthesizes mergeWithRequester:true in the normalized/persisted shape', () => {
    const result = normalizeAutoApprovalPolicy({ samePersonPolicy: 'auto_skip' }, REQUEST_VALIDATION_CONTEXT, 'p')
    expect(result).toEqual({ mergeWithRequester: true, samePersonPolicy: 'auto_skip' })
  })

  it('an explicit mergeWithRequester:false is OVERRIDDEN by samePersonPolicy:"auto_skip" (the enum is authoritative)', () => {
    const result = normalizeAutoApprovalPolicy(
      { mergeWithRequester: false, samePersonPolicy: 'auto_skip' },
      REQUEST_VALIDATION_CONTEXT,
      'p',
    )
    expect(result).toEqual({ mergeWithRequester: true, samePersonPolicy: 'auto_skip' })
  })

  it('samePersonPolicy:"transfer_direct_manager" does NOT synthesize mergeWithRequester — a different mechanism entirely', () => {
    const result = normalizeAutoApprovalPolicy(
      { samePersonPolicy: 'transfer_direct_manager' },
      REQUEST_VALIDATION_CONTEXT,
      'p',
    )
    expect(result).toEqual({ samePersonPolicy: 'transfer_direct_manager' })
  })

  it('samePersonPolicy:"self_approve" (explicit) leaves mergeWithRequester untouched — the absent-equivalent default round-trips as itself, not as an implicit true', () => {
    const result = normalizeAutoApprovalPolicy({ samePersonPolicy: 'self_approve' }, REQUEST_VALIDATION_CONTEXT, 'p')
    expect(result).toEqual({ samePersonPolicy: 'self_approve' })
  })

  it('rejects an off-enum samePersonPolicy value', () => {
    expect(() => normalizeAutoApprovalPolicy({ samePersonPolicy: 'ask_admin' }, REQUEST_VALIDATION_CONTEXT, 'p'))
      .toThrow(/samePersonPolicy must be self_approve, auto_skip, transfer_direct_manager, or transfer_dept_head/)
  })

  it('absent samePersonPolicy on an otherwise-populated policy is unaffected (no key added)', () => {
    const result = normalizeAutoApprovalPolicy({ mergeAdjacentApprover: true }, REQUEST_VALIDATION_CONTEXT, 'p')
    expect(result).toEqual({ mergeAdjacentApprover: true })
    expect(result).not.toHaveProperty('samePersonPolicy')
  })
})

describe('Lock-4 F4-C gate X-1 — "a node carrying ONLY a new AutoApprovalPolicy field executes that policy | a node with no policy at all still skips the cascade — proving the predicate widened rather than disappeared"', () => {
  it('POSITIVE — samePersonPolicy:"transfer_direct_manager" ALONE enables the predicate (no legacy flag present)', () => {
    expect(hasEnabledAutoApprovalRule({ samePersonPolicy: 'transfer_direct_manager' })).toBe(true)
  })

  it('POSITIVE — samePersonPolicy:"transfer_dept_head" ALONE enables the predicate', () => {
    expect(hasEnabledAutoApprovalRule({ samePersonPolicy: 'transfer_dept_head' })).toBe(true)
  })

  it('NEGATIVE — samePersonPolicy:"self_approve" ALONE does NOT enable the predicate (the documented node-level opt-out must survive)', () => {
    expect(hasEnabledAutoApprovalRule({ samePersonPolicy: 'self_approve' })).toBe(false)
  })

  it('NEGATIVE (scan negative control) — undefined policy does not enable the predicate', () => {
    expect(hasEnabledAutoApprovalRule(undefined)).toBe(false)
  })

  it('NEGATIVE (scan negative control) — an all-absent-flags object does not enable the predicate', () => {
    expect(hasEnabledAutoApprovalRule({})).toBe(false)
  })

  it('MUTATION EVIDENCE (析取式判定必须逐项单删) — deleting ONLY the samePersonPolicy disjunct reproduces the pre-widening predicate: the transfer fixture goes to false while the three legacy fixtures stay true', () => {
    // This is the "single-delete, not whole-function-delete" discipline: it directly exercises what
    // reverting JUST the new disjunct would do, without touching the shipped file.
    const legacyOnly = (policy: { mergeWithRequester?: boolean; mergeAdjacentApprover?: boolean; dedupeHistoricalApprover?: boolean } | undefined): boolean =>
      Boolean(policy?.mergeWithRequester || policy?.mergeAdjacentApprover || policy?.dedupeHistoricalApprover)

    expect(legacyOnly({ mergeWithRequester: true })).toBe(true)
    expect(legacyOnly({ mergeAdjacentApprover: true })).toBe(true)
    expect(legacyOnly({ dedupeHistoricalApprover: true })).toBe(true)
    // The discriminating fixture: with the disjunct deleted, a transfer-only policy is invisible —
    // this is exactly why an 'auto_skip'-only fixture would NOT be discriminating (it trips the
    // FIRST/legacy term via normalizeAutoApprovalPolicy's synthesis regardless of this widening).
    expect(legacyOnly({ samePersonPolicy: 'transfer_direct_manager' } as never)).toBe(false)
    // ...while the ACTUAL (widened) predicate correctly reports true for that same fixture.
    expect(hasEnabledAutoApprovalRule({ samePersonPolicy: 'transfer_direct_manager' })).toBe(true)
  })
})

describe('Lock-4 F4-C — resolveApprovalAssignees same-person transfer substitution (pure resolver behavior)', () => {
  const baseSnapshot = { id: 'requester-1', managerId: 'manager-1', deptHeadId: 'depthead-1' }

  it('transfer_direct_manager: a requester-kind source resolving to the requester is substituted with the frozen managerId, keeping resolvedFrom.kind', () => {
    const result = resolveApprovalAssignees({
      nodeKey: 'n1',
      sourceStep: 1,
      config: { assigneeSources: [{ kind: 'requester' }] } as never,
      formSnapshot: {},
      requesterSnapshot: baseSnapshot,
      getEffectiveSamePersonPolicy: () => 'transfer_direct_manager',
    })
    expect(result).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'manager-1',
        nodeKey: 'n1',
        sourceStep: 1,
        metadata: {
          resolvedFrom: { kind: 'requester', sourceIndex: 0 },
          samePersonTransfer: { from: 'requester-1', policy: 'transfer_direct_manager' },
        },
      },
    ])
  })

  it('transfer_dept_head: substitutes the frozen deptHeadId', () => {
    const result = resolveApprovalAssignees({
      nodeKey: 'n1',
      sourceStep: 1,
      config: { assigneeSources: [{ kind: 'requester' }] } as never,
      formSnapshot: {},
      requesterSnapshot: baseSnapshot,
      getEffectiveSamePersonPolicy: () => 'transfer_dept_head',
    })
    expect(result[0].assigneeId).toBe('depthead-1')
    expect(result[0].metadata?.samePersonTransfer).toEqual({ from: 'requester-1', policy: 'transfer_dept_head' })
  })

  it('gate C-3 — OD-L4-5(a): absent transfer target ⇒ the seat is NOT produced (never falls back to self_approve)', () => {
    const result = resolveApprovalAssignees({
      nodeKey: 'n1',
      sourceStep: 1,
      config: { assigneeSources: [{ kind: 'requester' }] } as never,
      formSnapshot: {},
      requesterSnapshot: { id: 'requester-1' }, // no managerId
      getEffectiveSamePersonPolicy: () => 'transfer_direct_manager',
    })
    expect(result).toEqual([])
  })

  it('POSITIVE CONTROL for C-3 — the SAME fixture with a manager present DOES produce the transferred seat', () => {
    const result = resolveApprovalAssignees({
      nodeKey: 'n1',
      sourceStep: 1,
      config: { assigneeSources: [{ kind: 'requester' }] } as never,
      formSnapshot: {},
      requesterSnapshot: baseSnapshot,
      getEffectiveSamePersonPolicy: () => 'transfer_direct_manager',
    })
    expect(result).toHaveLength(1)
  })

  it('gate C-1 companion — a "self_approve" policy leaves the requester\'s own seat pending (no substitution)', () => {
    const result = resolveApprovalAssignees({
      nodeKey: 'n1',
      sourceStep: 1,
      config: { assigneeSources: [{ kind: 'requester' }] } as never,
      formSnapshot: {},
      requesterSnapshot: baseSnapshot,
      getEffectiveSamePersonPolicy: () => 'self_approve',
    })
    expect(result).toEqual([
      { assignmentType: 'user', assigneeId: 'requester-1', nodeKey: 'n1', sourceStep: 1, metadata: { resolvedFrom: { kind: 'requester', sourceIndex: 0 } } },
    ])
  })

  it('no getEffectiveSamePersonPolicy provider at all (omitted) — today\'s behavior, byte-identical (no crash, no substitution)', () => {
    const result = resolveApprovalAssignees({
      nodeKey: 'n1',
      sourceStep: 1,
      config: { assigneeSources: [{ kind: 'requester' }] } as never,
      formSnapshot: {},
      requesterSnapshot: baseSnapshot,
    })
    expect(result[0].assigneeId).toBe('requester-1')
  })

  it('delegation-ordering pin — the transfer is computed POST-delegation: a requester who has delegated away is NOT transferred (their seat is already the delegatee, which is not the requester)', () => {
    const result = resolveApprovalAssignees({
      nodeKey: 'n1',
      sourceStep: 1,
      config: { assigneeSources: [{ kind: 'requester' }] } as never,
      formSnapshot: {},
      requesterSnapshot: { ...baseSnapshot, delegations: { 'requester-1': 'delegatee-1' } },
      getEffectiveSamePersonPolicy: () => 'transfer_direct_manager',
    })
    // finalId after delegation is 'delegatee-1', which !== requesterId — so the same-person branch
    // never triggers, and the seat is the delegatee's, carrying delegatedFrom only.
    expect(result).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'delegatee-1',
        nodeKey: 'n1',
        sourceStep: 1,
        metadata: { resolvedFrom: { kind: 'requester', sourceIndex: 0 }, delegatedFrom: 'requester-1' },
      },
    ])
  })

  it('a transferred manager who is already a directly-listed assignee collapses to ONE seat (pushResolved\'s seen-dedup applies for free)', () => {
    const result = resolveApprovalAssignees({
      nodeKey: 'n1',
      sourceStep: 1,
      config: {
        assigneeSources: [
          { kind: 'static_user', userIds: ['manager-1'] },
          { kind: 'requester' },
        ],
      } as never,
      formSnapshot: {},
      requesterSnapshot: baseSnapshot,
      getEffectiveSamePersonPolicy: () => 'transfer_direct_manager',
    })
    expect(result).toHaveLength(1)
    expect(result[0].assigneeId).toBe('manager-1')
  })
})
