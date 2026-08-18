import { describe, expect, it } from 'vitest'
import { fieldDerivedAssigneeSourceKey, resolveApprovalAssignees } from '../../src/services/ApprovalAssigneeResolver'
import type { ApprovalNodeConfig, FormSchema } from '../../src/types/approval-product'

const userFieldSchema: FormSchema = {
  fields: [
    { id: 'approver', type: 'user', label: 'Approver' },
    { id: 'notes', type: 'text', label: 'Notes' },
  ],
}

function resolve(config: ApprovalNodeConfig, formSnapshot: Record<string, unknown> = {}) {
  return resolveApprovalAssignees({
    nodeKey: 'review',
    sourceStep: 2,
    config,
    formSchema: userFieldSchema,
    formSnapshot,
    requesterSnapshot: { id: 'requester-1', name: 'Requester One' },
  })
}

describe('ApprovalAssigneeResolver', () => {
  it('keeps legacy static user and role assignments metadata-free', () => {
    expect(resolve({ assigneeType: 'user', assigneeIds: ['user-1', 'user-2'] })).toEqual([
      { assignmentType: 'user', assigneeId: 'user-1', nodeKey: 'review', sourceStep: 2 },
      { assignmentType: 'user', assigneeId: 'user-2', nodeKey: 'review', sourceStep: 2 },
    ])

    expect(resolve({ assigneeType: 'role', assigneeIds: ['finance'] })).toEqual([
      { assignmentType: 'role', assigneeId: 'finance', nodeKey: 'review', sourceStep: 2 },
    ])
  })

  // direct_manager — resolves to requesterSnapshot.managerId (frozen at start).
  function resolveDirectManager(requesterSnapshot: Record<string, unknown> | null) {
    return resolveApprovalAssignees({
      nodeKey: 'review',
      sourceStep: 2,
      config: { assigneeSources: [{ kind: 'direct_manager' }] },
      formSnapshot: {},
      requesterSnapshot,
    })
  }

  it('resolves direct_manager to the requester snapshot managerId, with resolvedFrom metadata', () => {
    expect(resolveDirectManager({ id: 'requester-1', managerId: 'manager-9' })).toEqual([
      { assignmentType: 'user', assigneeId: 'manager-9', nodeKey: 'review', sourceStep: 2, metadata: { resolvedFrom: { kind: 'direct_manager', sourceIndex: 0 } } },
    ])
  })

  it('resolves direct_manager to empty when the requester has no manager (falls to emptyAssigneePolicy)', () => {
    expect(resolveDirectManager({ id: 'requester-1' })).toEqual([])
    expect(resolveDirectManager(null)).toEqual([])
  })

  it('excludes self: a direct_manager that resolves to the requester is not a valid manager (empty)', () => {
    expect(resolveDirectManager({ id: 'requester-1', managerId: 'requester-1' })).toEqual([])
  })

  // dept_head — resolves to requesterSnapshot.deptHeadId (frozen at start), mirroring direct_manager.
  function resolveDeptHead(requesterSnapshot: Record<string, unknown> | null) {
    return resolveApprovalAssignees({
      nodeKey: 'review',
      sourceStep: 2,
      config: { assigneeSources: [{ kind: 'dept_head' }] },
      formSnapshot: {},
      requesterSnapshot,
    })
  }

  it('resolves dept_head to the requester snapshot deptHeadId, with resolvedFrom metadata', () => {
    expect(resolveDeptHead({ id: 'requester-1', deptHeadId: 'head-7' })).toEqual([
      { assignmentType: 'user', assigneeId: 'head-7', nodeKey: 'review', sourceStep: 2, metadata: { resolvedFrom: { kind: 'dept_head', sourceIndex: 0 } } },
    ])
  })

  it('resolves dept_head to empty when the requester has no department head (falls to emptyAssigneePolicy)', () => {
    expect(resolveDeptHead({ id: 'requester-1' })).toEqual([])
    expect(resolveDeptHead(null)).toEqual([])
  })

  it('excludes self: a dept_head that resolves to the requester is not a valid approver (empty)', () => {
    expect(resolveDeptHead({ id: 'requester-1', deptHeadId: 'requester-1' })).toEqual([])
  })

  // continuous_managers — resolves the snapshot managerChainIds, sliced to `levels`.
  function resolveContinuousManagers(levels: number, requesterSnapshot: Record<string, unknown> | null) {
    return resolveApprovalAssignees({
      nodeKey: 'review',
      sourceStep: 2,
      config: { assigneeSources: [{ kind: 'continuous_managers', levels }] },
      formSnapshot: {},
      requesterSnapshot,
    })
  }

  const cmEntry = (assigneeId: string) => ({
    assignmentType: 'user', assigneeId, nodeKey: 'review', sourceStep: 2,
    metadata: { resolvedFrom: { kind: 'continuous_managers', sourceIndex: 0 } },
  })

  it('resolves continuous_managers to the chain sliced to levels, with metadata', () => {
    expect(resolveContinuousManagers(2, { id: 'requester-1', managerChainIds: ['m1', 'm2', 'm3'] }))
      .toEqual([cmEntry('m1'), cmEntry('m2')])
  })

  it('resolves the whole chain when it is shorter than levels', () => {
    expect(resolveContinuousManagers(5, { id: 'requester-1', managerChainIds: ['m1', 'm2'] }))
      .toEqual([cmEntry('m1'), cmEntry('m2')])
  })

  it('resolves continuous_managers to empty with no chain (falls to emptyAssigneePolicy)', () => {
    expect(resolveContinuousManagers(3, { id: 'requester-1' })).toEqual([])
    expect(resolveContinuousManagers(3, null)).toEqual([])
  })

  it('excludes self and dedups within the sliced chain', () => {
    expect(resolveContinuousManagers(4, { id: 'requester-1', managerChainIds: ['requester-1', 'm2', 'm2', 'm3'] }))
      .toEqual([cmEntry('m2'), cmEntry('m3')])
  })

  // manager_at_level (Reading B / B1) — resolves a SINGLE level of the snapshot
  // managerChainIds (chain[level-1]); N authored nodes at levels 1..N = 顺序逐级.
  function resolveManagerAtLevel(level: number, requesterSnapshot: Record<string, unknown> | null) {
    return resolveApprovalAssignees({
      nodeKey: 'review',
      sourceStep: 2,
      config: { assigneeSources: [{ kind: 'manager_at_level', level }] },
      formSnapshot: {},
      requesterSnapshot,
    })
  }

  const malEntry = (assigneeId: string) => ({
    assignmentType: 'user', assigneeId, nodeKey: 'review', sourceStep: 2,
    metadata: { resolvedFrom: { kind: 'manager_at_level', sourceIndex: 0 } },
  })

  it('resolves manager_at_level to the single chain manager at that 1-based level', () => {
    expect(resolveManagerAtLevel(1, { id: 'requester-1', managerChainIds: ['m1', 'm2', 'm3'] }))
      .toEqual([malEntry('m1')])
    expect(resolveManagerAtLevel(3, { id: 'requester-1', managerChainIds: ['m1', 'm2', 'm3'] }))
      .toEqual([malEntry('m3')])
  })

  it('resolves manager_at_level to empty when the chain is shorter than the level (→ emptyAssigneePolicy)', () => {
    expect(resolveManagerAtLevel(4, { id: 'requester-1', managerChainIds: ['m1', 'm2'] })).toEqual([])
    expect(resolveManagerAtLevel(2, { id: 'requester-1' })).toEqual([])
    expect(resolveManagerAtLevel(2, null)).toEqual([])
  })

  it('self-excludes manager_at_level when the picked level resolves to the requester', () => {
    expect(resolveManagerAtLevel(1, { id: 'requester-1', managerChainIds: ['requester-1', 'm2'] })).toEqual([])
    expect(resolveManagerAtLevel(2, { id: 'requester-1', managerChainIds: ['requester-1', 'm2'] })).toEqual([malEntry('m2')])
  })

  // Density-contract pin: the production snapshot is DENSE (resolveManagerChain in
  // ApprovalDirectoryOrg pushes only linked, non-self ids — it walks THROUGH unlinked
  // rungs), so positional chain[level-1] = the level-th linked manager. This pins the
  // defensive behavior if a null/'' rung ever reached the resolver: that level resolves
  // empty (positional, no compaction), and a later dense level is unaffected.
  it('manager_at_level treats a null/empty rung positionally (dense-snapshot contract)', () => {
    expect(resolveManagerAtLevel(2, { id: 'requester-1', managerChainIds: ['m1', null as never, 'm3'] })).toEqual([])
    expect(resolveManagerAtLevel(1, { id: 'requester-1', managerChainIds: ['m1', null as never, 'm3'] })).toEqual([malEntry('m1')])
    expect(resolveManagerAtLevel(3, { id: 'requester-1', managerChainIds: ['m1', null as never, 'm3'] })).toEqual([malEntry('m3')])
  })

  // dept_head_at_level (Lock-1 §K5-b) — resolves a SINGLE level of the snapshot
  // deptHeadChainIds (chain[level-1]), positionally IDENTICAL to manager_at_level above but over
  // the K4 department-head chain instead of managerChainIds.
  function resolveDeptHeadAtLevel(level: number, requesterSnapshot: Record<string, unknown> | null) {
    return resolveApprovalAssignees({
      nodeKey: 'review',
      sourceStep: 2,
      config: { assigneeSources: [{ kind: 'dept_head_at_level', level }] },
      formSnapshot: {},
      requesterSnapshot,
    })
  }

  const dhalEntry = (assigneeId: string) => ({
    assignmentType: 'user', assigneeId, nodeKey: 'review', sourceStep: 2,
    metadata: { resolvedFrom: { kind: 'dept_head_at_level', sourceIndex: 0 } },
  })

  it('resolves dept_head_at_level to the single dept-head-chain entry at that 1-based level (positive control: a valid in-range level resolves the right head)', () => {
    expect(resolveDeptHeadAtLevel(1, { id: 'requester-1', deptHeadChainIds: ['h1', 'h2', 'h3'] }))
      .toEqual([dhalEntry('h1')])
    expect(resolveDeptHeadAtLevel(3, { id: 'requester-1', deptHeadChainIds: ['h1', 'h2', 'h3'] }))
      .toEqual([dhalEntry('h3')])
  })

  it('resolves dept_head_at_level to empty when the chain is shorter than the level, and when deptHeadChainIds is absent — falls to emptyAssigneePolicy, NEVER a dispatch-time failure (Lock-1 §K5)', () => {
    // Out-of-range: level valid in contract ([1, MAX_MANAGER_CHAIN_LEVELS]) but deeper than THIS
    // requester's (possibly shorter) chain — empty, not an error.
    expect(resolveDeptHeadAtLevel(4, { id: 'requester-1', deptHeadChainIds: ['h1', 'h2'] })).toEqual([])
    // deptHeadChainIds absent entirely (e.g. requester has no primary department, or the snapshot
    // simply was not baked) — still empty, never a throw.
    expect(resolveDeptHeadAtLevel(2, { id: 'requester-1' })).toEqual([])
    expect(resolveDeptHeadAtLevel(2, null)).toEqual([])
  })

  it('self-excludes dept_head_at_level when the picked level resolves to the requester', () => {
    expect(resolveDeptHeadAtLevel(1, { id: 'requester-1', deptHeadChainIds: ['requester-1', 'h2'] })).toEqual([])
    expect(resolveDeptHeadAtLevel(2, { id: 'requester-1', deptHeadChainIds: ['requester-1', 'h2'] })).toEqual([dhalEntry('h2')])
  })

  // Density-contract pin (mirrors manager_at_level's above): resolveDeptHeadChain
  // (ApprovalDirectoryOrg) is DENSE under the RATIFIED continue-past-empty-level posture — a level
  // whose head is unresolved contributes NOTHING but does not truncate the walk, so the walk
  // itself already compacted before the snapshot was frozen. chain[level-1] is therefore the
  // level-th *resolved* head, not "the head N parent-hops up" — positional over the DENSE array,
  // never a live re-walk. This pins the defensive behavior if a null/'' rung ever reached the
  // resolver: that level resolves empty (positional, no compaction), and a later dense level is
  // unaffected.
  it('dept_head_at_level treats a null/empty rung positionally (dense-snapshot contract)', () => {
    expect(resolveDeptHeadAtLevel(2, { id: 'requester-1', deptHeadChainIds: ['h1', null as never, 'h3'] })).toEqual([])
    expect(resolveDeptHeadAtLevel(1, { id: 'requester-1', deptHeadChainIds: ['h1', null as never, 'h3'] })).toEqual([dhalEntry('h1')])
    expect(resolveDeptHeadAtLevel(3, { id: 'requester-1', deptHeadChainIds: ['h1', null as never, 'h3'] })).toEqual([dhalEntry('h3')])
  })

  // form_field_user_manager / form_field_user_dept_head (Lock-2 §L2-C) — pure map lookup over
  // the create-frozen fieldDerivedAssigneeIds (source fingerprint → resolved local user ids).
  function resolveFieldDerived(
    kind: 'form_field_user_manager' | 'form_field_user_dept_head',
    fieldId: string,
    level: number,
    requesterSnapshot: Record<string, unknown> | null,
  ) {
    return resolveApprovalAssignees({
      nodeKey: 'review',
      sourceStep: 2,
      config: { assigneeSources: [{ kind, fieldId, level }] },
      formSnapshot: { [fieldId]: 'contact-1' },
      requesterSnapshot,
    })
  }

  it('resolves the contact-extension kinds from the frozen fieldDerivedAssigneeIds entry keyed by <kind>:<fieldId>:<level> (positive control, both kinds; metadata carries fieldId + level)', () => {
    expect(resolveFieldDerived('form_field_user_manager', 'contact', 2, {
      id: 'requester-1',
      fieldDerivedAssigneeIds: { 'form_field_user_manager:contact:2': ['mgr-2'] },
    })).toEqual([{
      assignmentType: 'user', assigneeId: 'mgr-2', nodeKey: 'review', sourceStep: 2,
      metadata: { resolvedFrom: { kind: 'form_field_user_manager', sourceIndex: 0, fieldId: 'contact', level: 2 } },
    }])
    expect(resolveFieldDerived('form_field_user_dept_head', 'contact', 1, {
      id: 'requester-1',
      fieldDerivedAssigneeIds: { 'form_field_user_dept_head:contact:1': ['head-1'] },
    })).toEqual([{
      assignmentType: 'user', assigneeId: 'head-1', nodeKey: 'review', sourceStep: 2,
      metadata: { resolvedFrom: { kind: 'form_field_user_dept_head', sourceIndex: 0, fieldId: 'contact', level: 1 } },
    }])
  })

  it('the resolver lookup key IS fieldDerivedAssigneeSourceKey — a mismatched key (wrong level / wrong field) resolves EMPTY, proving snapshot key and fingerprint cannot drift silently', () => {
    // Sanity-pin the exported producer itself (the create path, the fingerprint, and this arm all
    // consume it — one producer, no drift).
    expect(fieldDerivedAssigneeSourceKey({ kind: 'form_field_user_manager', fieldId: ' contact ', level: 2 }))
      .toBe('form_field_user_manager:contact:2')
    // A frozen entry at a DIFFERENT level/field is not read (empty resolution → emptyAssigneePolicy).
    expect(resolveFieldDerived('form_field_user_manager', 'contact', 1, {
      id: 'requester-1',
      fieldDerivedAssigneeIds: { 'form_field_user_manager:contact:2': ['mgr-2'] },
    })).toEqual([])
    expect(resolveFieldDerived('form_field_user_manager', 'other', 2, {
      id: 'requester-1',
      fieldDerivedAssigneeIds: { 'form_field_user_manager:contact:2': ['mgr-2'] },
    })).toEqual([])
  })

  it('contact-extension kinds apply NO requester self-exclusion (Lock-2 §L2-C deliberate posture — unlike manager_at_level/dept_head_at_level): a frozen id equal to the requester still gets the seat', () => {
    expect(resolveFieldDerived('form_field_user_manager', 'contact', 1, {
      id: 'requester-1',
      fieldDerivedAssigneeIds: { 'form_field_user_manager:contact:1': ['requester-1'] },
    })).toEqual([{
      assignmentType: 'user', assigneeId: 'requester-1', nodeKey: 'review', sourceStep: 2,
      metadata: { resolvedFrom: { kind: 'form_field_user_manager', sourceIndex: 0, fieldId: 'contact', level: 1 } },
    }])
    // Discriminating negative control: the SAME snapshot shape through dept_head_at_level (a
    // requester-anchored kind) DOES self-exclude — the no-exclusion above is kind-selected.
    expect(resolveApprovalAssignees({
      nodeKey: 'review', sourceStep: 2,
      config: { assigneeSources: [{ kind: 'dept_head_at_level', level: 1 }] },
      formSnapshot: {},
      requesterSnapshot: { id: 'requester-1', deptHeadChainIds: ['requester-1'] },
    })).toEqual([])
  })

  it('contact-extension kinds resolve EMPTY (never throw) when the frozen entry is an empty array, the map is absent, or the snapshot is null — falls to emptyAssigneePolicy (Lock-2 §2.6)', () => {
    expect(resolveFieldDerived('form_field_user_manager', 'contact', 1, {
      id: 'requester-1',
      fieldDerivedAssigneeIds: { 'form_field_user_manager:contact:1': [] },
    })).toEqual([])
    expect(resolveFieldDerived('form_field_user_dept_head', 'contact', 1, { id: 'requester-1' })).toEqual([])
    expect(resolveFieldDerived('form_field_user_manager', 'contact', 1, null)).toEqual([])
  })

  // prior_node_approver (Lock-1 §K3) — resolves the referenced prior node's ACTUAL deciders from
  // the CALLER-supplied priorNodeApprovers map (instance-internal audit-row actors, latest round;
  // read by the caller at activation — the resolver adds no DB access, §2.1).
  function resolvePrior(
    nodeKey: string,
    priorNodeApprovers: Record<string, string[]> | undefined,
    requesterSnapshot: Record<string, unknown> | null = { id: 'requester-1' },
  ) {
    return resolveApprovalAssignees({
      nodeKey: 'review',
      sourceStep: 2,
      config: { assigneeSources: [{ kind: 'prior_node_approver', nodeKey }] },
      formSnapshot: {},
      requesterSnapshot,
      ...(priorNodeApprovers !== undefined ? { priorNodeApprovers } : {}),
    })
  }

  const priorEntry = (assigneeId: string, priorNodeKey = 'gate') => ({
    assignmentType: 'user', assigneeId, nodeKey: 'review', sourceStep: 2,
    metadata: { resolvedFrom: { kind: 'prior_node_approver', sourceIndex: 0, priorNodeKey } },
  })

  it('resolves prior_node_approver to the referenced node deciders from the caller-supplied map, stamping resolvedFrom.priorNodeKey (positive control)', () => {
    expect(resolvePrior('gate', { gate: ['decider-1', 'decider-2'] }))
      .toEqual([priorEntry('decider-1'), priorEntry('decider-2')])
    // Keyed by the SOURCE's nodeKey, not the resolving node's — a map entry for a different node
    // contributes nothing (reference-selected, not map-order-selected).
    expect(resolvePrior('gate', { other: ['decider-9'] })).toEqual([])
  })

  it('resolves prior_node_approver to empty when the map is absent (create-time cascade / preview) or the entry is missing/empty — falls to emptyAssigneePolicy (OD-L1-4(a)), never a throw', () => {
    expect(resolvePrior('gate', undefined)).toEqual([])
    expect(resolvePrior('gate', {})).toEqual([])
    expect(resolvePrior('gate', { gate: [] })).toEqual([])
  })

  it('drops system sentinel actors (system:auto-approval / system:approval-timeout) — never assigned, even from a hand-assembled map (G-11 pure re-check; the human decider in the SAME list survives)', () => {
    expect(resolvePrior('gate', { gate: ['system:auto-approval', 'system:approval-timeout'] })).toEqual([])
    // Actor-selected, not blanket: a human decider alongside the sentinels still resolves.
    expect(resolvePrior('gate', { gate: ['system:auto-approval', 'decider-1'] })).toEqual([priorEntry('decider-1')])
  })

  it('does NOT self-exclude prior_node_approver (deliberate §K2-posture: a prior decider who is the requester keeps the seat; self-approval stays owned by autoApprovalPolicy)', () => {
    expect(resolvePrior('gate', { gate: ['requester-1'] })).toEqual([priorEntry('requester-1')])
  })

  it('keeps intra-node identity dedup (G-12 positive control): the same decider listed twice — or resolved by two sources — collapses to ONE seat at this node', () => {
    expect(resolvePrior('gate', { gate: ['decider-1', 'decider-1'] })).toEqual([priorEntry('decider-1')])
    // Two prior_node_approver sources resolving the same person: one seat, first source wins.
    expect(resolveApprovalAssignees({
      nodeKey: 'review',
      sourceStep: 2,
      config: {
        assigneeSources: [
          { kind: 'prior_node_approver', nodeKey: 'gate' },
          { kind: 'prior_node_approver', nodeKey: 'gate2' },
        ],
      },
      formSnapshot: {},
      requesterSnapshot: { id: 'requester-1' },
      priorNodeApprovers: { gate: ['decider-1'], gate2: ['decider-1'] },
    })).toEqual([priorEntry('decider-1')])
  })

  it('applies delegation substitution to a prior_node_approver decider (expansion happens BEFORE pushResolved, so the frozen delegation map covers this kind too)', () => {
    expect(resolvePrior('gate', { gate: ['decider-1'] }, { id: 'requester-1', delegations: { 'decider-1': 'delegatee-7' } }))
      .toEqual([{
        assignmentType: 'user', assigneeId: 'delegatee-7', nodeKey: 'review', sourceStep: 2,
        metadata: { resolvedFrom: { kind: 'prior_node_approver', sourceIndex: 0, priorNodeKey: 'gate' }, delegatedFrom: 'decider-1' },
      }])
  })

  it('resolves requester and static sources with source metadata', () => {
    expect(resolve({
      assigneeSources: [
        { kind: 'requester' },
        { kind: 'static_user', userIds: ['manager-1'] },
        { kind: 'static_role', roleIds: ['finance'] },
      ],
    })).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'requester-1',
        nodeKey: 'review',
        sourceStep: 2,
        metadata: { resolvedFrom: { kind: 'requester', sourceIndex: 0 } },
      },
      {
        assignmentType: 'user',
        assigneeId: 'manager-1',
        nodeKey: 'review',
        sourceStep: 2,
        metadata: { resolvedFrom: { kind: 'static_user', sourceIndex: 1 } },
      },
      {
        assignmentType: 'role',
        assigneeId: 'finance',
        nodeKey: 'review',
        sourceStep: 2,
        metadata: { resolvedFrom: { kind: 'static_role', sourceIndex: 2 } },
      },
    ])
  })

  it('resolves user form fields from string and object values', () => {
    expect(resolve({
      assigneeSources: [{ kind: 'form_field_user', fieldId: 'approver' }],
    }, { approver: 'form-user-1' })).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'form-user-1',
        nodeKey: 'review',
        sourceStep: 2,
        metadata: { resolvedFrom: { kind: 'form_field_user', sourceIndex: 0, fieldId: 'approver' } },
      },
    ])

    expect(resolve({
      assigneeSources: [{ kind: 'form_field_user', fieldId: 'approver' }],
    }, { approver: { id: 'form-user-2', name: 'Form User' } })).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'form-user-2',
        nodeKey: 'review',
        sourceStep: 2,
        metadata: { resolvedFrom: { kind: 'form_field_user', sourceIndex: 0, fieldId: 'approver' } },
      },
    ])
  })

  it('returns no assignments for missing dynamic values so the node policy decides', () => {
    expect(resolve({
      assigneeSources: [
        { kind: 'form_field_user', fieldId: 'approver' },
      ],
    }, { approver: null })).toEqual([])

    expect(resolveApprovalAssignees({
      nodeKey: 'review',
      sourceStep: 2,
      config: { assigneeSources: [{ kind: 'requester' }] },
      formSchema: userFieldSchema,
      formSnapshot: {},
      requesterSnapshot: null,
    })).toEqual([])
  })

  it('rejects form_field_user sources that do not point at user fields when schema is available', () => {
    expect(() => resolve({
      assigneeSources: [{ kind: 'form_field_user', fieldId: 'notes' }],
    }, { notes: 'user-1' })).toThrowError(expect.objectContaining({
      code: 'APPROVAL_ASSIGNEE_INVALID_SOURCE',
      statusCode: 400,
    }))

    expect(() => resolve({
      assigneeSources: [{ kind: 'form_field_user', fieldId: 'missing' }],
    })).toThrowError(expect.objectContaining({
      code: 'APPROVAL_ASSIGNEE_INVALID_SOURCE',
      statusCode: 400,
    }))
  })

  it('dedupes duplicate resolved assignees and keeps the first source metadata', () => {
    expect(resolve({
      assigneeSources: [
        { kind: 'requester' },
        { kind: 'static_user', userIds: ['requester-1', 'manager-1'] },
      ],
    })).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'requester-1',
        nodeKey: 'review',
        sourceStep: 2,
        metadata: { resolvedFrom: { kind: 'requester', sourceIndex: 0 } },
      },
      {
        assignmentType: 'user',
        assigneeId: 'manager-1',
        nodeKey: 'review',
        sourceStep: 2,
        metadata: { resolvedFrom: { kind: 'static_user', sourceIndex: 1 } },
      },
    ])
  })

  // delegation (委托) — substitution INSIDE pushResolved, before the dedup key,
  // user-only, with delegatedFrom metadata; dedup runs on the substituted id.
  function resolveWithDelegations(
    assigneeSources: ApprovalNodeConfig['assigneeSources'],
    delegations: Record<string, string>,
  ) {
    return resolveApprovalAssignees({
      nodeKey: 'review',
      sourceStep: 2,
      config: { assigneeSources },
      formSnapshot: {},
      requesterSnapshot: { id: 'requester-1', delegations },
    })
  }

  it('substitutes a delegated user assignee and records delegatedFrom', () => {
    expect(resolveWithDelegations([{ kind: 'static_user', userIds: ['A'] }], { A: 'B' })).toEqual([
      { assignmentType: 'user', assigneeId: 'B', nodeKey: 'review', sourceStep: 2, metadata: { resolvedFrom: { kind: 'static_user', sourceIndex: 0 }, delegatedFrom: 'A' } },
    ])
  })

  it('KEYSTONE: delegator A→B where B is already another source assignee resolves to exactly one B', () => {
    // Substitution before the dedup key collapses A→B and the existing B to one B. A
    // post-loop replace would build the seen key on A, then replace → two B entries.
    const result = resolveWithDelegations([{ kind: 'static_user', userIds: ['A', 'B'] }], { A: 'B' })
    expect(result.map((r) => r.assigneeId)).toEqual(['B'])
    expect(result).toHaveLength(1)
  })

  it('does not substitute role assignees (user-only)', () => {
    expect(resolveWithDelegations([{ kind: 'static_role', roleIds: ['A'] }], { A: 'B' })).toEqual([
      { assignmentType: 'role', assigneeId: 'A', nodeKey: 'review', sourceStep: 2, metadata: { resolvedFrom: { kind: 'static_role', sourceIndex: 0 } } },
    ])
  })

  it('is one hop only: A→B→C resolves A to B, not C', () => {
    expect(resolveWithDelegations([{ kind: 'static_user', userIds: ['A'] }], { A: 'B', B: 'C' }).map((r) => r.assigneeId))
      .toEqual(['B'])
  })

  it('ignores a self-delegation entry and a missing map (no substitution, no delegatedFrom)', () => {
    const selfLoop = resolveWithDelegations([{ kind: 'static_user', userIds: ['A'] }], { A: 'A' })
    expect(selfLoop.map((r) => r.assigneeId)).toEqual(['A'])
    expect(selfLoop[0].metadata).toEqual({ resolvedFrom: { kind: 'static_user', sourceIndex: 0 } })
    expect(resolveWithDelegations([{ kind: 'static_user', userIds: ['A'] }], {}).map((r) => r.assigneeId)).toEqual(['A'])
  })

  // P1 regression: delegation applies to LEGACY assigneeIds templates too (not only
  // authored assigneeSources). The legacy path now routes through pushResolved.
  function resolveLegacy(assigneeIds: string[], delegations: Record<string, string>) {
    return resolveApprovalAssignees({
      nodeKey: 'review',
      sourceStep: 2,
      config: { assigneeType: 'user', assigneeIds },
      formSnapshot: {},
      requesterSnapshot: { id: 'requester-1', delegations },
    })
  }

  it('applies delegation to a legacy assigneeIds template (A→B, B already listed → one B)', () => {
    const result = resolveLegacy(['A', 'B'], { A: 'B' })
    expect(result.map((r) => r.assigneeId)).toEqual(['B'])
    expect(result).toHaveLength(1)
    // legacy-delegated metadata carries delegatedFrom but NO resolvedFrom (stays non-dynamic)
    expect(result[0].metadata).toEqual({ delegatedFrom: 'A' })
  })

  it('keeps a legacy assigneeIds template metadata-free when no delegation applies', () => {
    expect(resolveLegacy(['A', 'B'], {})).toEqual([
      { assignmentType: 'user', assigneeId: 'A', nodeKey: 'review', sourceStep: 2 },
      { assignmentType: 'user', assigneeId: 'B', nodeKey: 'review', sourceStep: 2 },
    ])
  })
})
