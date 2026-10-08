import { describe, expect, it } from 'vitest'
import {
  assignmentMatchesActor,
  decidableNodeKeysForInstance,
  decisionDoorIsSeatGated,
  resolveCanDecideCurrentNode,
  type DecidableInstanceRow,
  type SeatedAssignment,
} from '../../src/services/approval-seat-authorization'
import { seatNodeKeysForViewer } from '../../src/services/approval-effective-node-operations'
import { ApprovalGraphExecutor } from '../../src/services/ApprovalGraphExecutor'
import type { RuntimeGraph } from '../../src/types/approval-product'

/**
 * `canDecideCurrentNode` — the viewer-scoped decision affordance the detail DTO ships.
 *
 * The predicate is pure (instance columns + assignment rows + the viewer's id/roles in, one boolean
 * out), so it is unit-tested here in full. What genuinely needs a database — that the ROLE the door
 * matches on is DB-derived (a `user_roles` row, not a token claim), and that the reported value
 * agrees with what the action endpoint actually does — lives in
 * `tests/integration/approval-can-decide-current-node.db.test.ts`.
 *
 * Every `false` case below is paired with the `true` case it differs from by exactly one fact, so
 * none of them can pass because the fixture was simply broken.
 */

const VIEWER = 'user_viewer'

function seat(overrides: Partial<SeatedAssignment> = {}): SeatedAssignment {
  return {
    is_active: true,
    assignment_type: 'user',
    assignee_id: VIEWER,
    node_key: 'approval_a',
    ...overrides,
  }
}

function instance(overrides: Partial<DecidableInstanceRow> = {}): DecidableInstanceRow {
  return {
    id: 'apv_1',
    status: 'pending',
    source_system: 'platform',
    published_definition_id: 'pd_1',
    current_node_key: 'approval_a',
    metadata: null,
    ...overrides,
  }
}

function canDecide(
  instanceRow: DecidableInstanceRow,
  assignments: SeatedAssignment[],
  viewerUserId: string | null = VIEWER,
  viewerRoles: string[] | null = null,
): boolean {
  return resolveCanDecideCurrentNode({ instance: instanceRow, assignments, viewerUserId, viewerRoles })
}

/** The parallel-region metadata shape `dispatchAction` persists (`buildPersistableParallelState`). */
function parallelMetadata(branches: { edgeKey: string; currentNodeKey: string | null; complete: boolean }[]) {
  return {
    parallelBranchStates: {
      parallelNodeKey: 'fork',
      joinNodeKey: 'join',
      joinMode: 'all',
      branches: Object.fromEntries(branches.map((branch) => [branch.edgeKey, { ...branch }])),
    },
  }
}

describe('resolveCanDecideCurrentNode — seat shapes at the current node', () => {
  it('a USER seat at the current node can decide', () => {
    expect(canDecide(instance(), [seat()])).toBe(true)
  })

  it('a ROLE seat at the current node can decide when the viewer holds that role', () => {
    const roleSeat = seat({ assignment_type: 'role', assignee_id: 'approver' })
    expect(canDecide(instance(), [roleSeat], VIEWER, ['approver'])).toBe(true)
  })

  it('the SAME role seat cannot decide for a viewer who does not hold the role', () => {
    const roleSeat = seat({ assignment_type: 'role', assignee_id: 'approver' })
    expect(canDecide(instance(), [roleSeat], VIEWER, ['auditor'])).toBe(false)
    expect(canDecide(instance(), [roleSeat], VIEWER, null)).toBe(false)
  })

  it('a DELEGATED seat lands on the delegatee, because delegation is applied at create time', () => {
    // `ApprovalAssigneeResolver.pushResolved` substitutes the delegatee BEFORE the assignment row is
    // written, so a delegated seat is an ordinary `user` row whose `assignee_id` IS the delegatee.
    // No special case exists at the door, and none exists here — this test pins that the shape the
    // resolver produces is the shape that decides.
    const delegatedSeat = seat({ assignee_id: 'user_delegatee', metadata: { delegatedFrom: 'user_delegator' } } as Partial<SeatedAssignment>)
    expect(canDecide(instance(), [delegatedSeat], 'user_delegatee')).toBe(true)
    expect(canDecide(instance(), [delegatedSeat], 'user_delegator')).toBe(false)
  })

  it('a non-participant cannot decide', () => {
    expect(canDecide(instance(), [seat({ assignee_id: 'user_other' })])).toBe(false)
  })

  it('an INACTIVE seat at the current node cannot decide', () => {
    expect(canDecide(instance(), [seat({ is_active: false })])).toBe(false)
  })

  it("a 'source_queue' seat at the current node cannot decide", () => {
    // The third `assignment_type` value must match nothing, at the door and here — a previous
    // hand-copy of the match rule let it fall through to the user-id arm (gate finding NIT-R1).
    expect(canDecide(instance(), [seat({ assignment_type: 'source_queue' })])).toBe(false)
  })

  it('a seat at a node the instance is NOT stopped on cannot decide', () => {
    expect(canDecide(instance({ current_node_key: 'approval_b' }), [seat({ node_key: 'approval_a' })])).toBe(false)
  })

  it('a seat with no node key cannot decide', () => {
    expect(canDecide(instance(), [seat({ node_key: null })])).toBe(false)
  })

  it('an instance stopped on no node at all cannot be decided', () => {
    expect(canDecide(instance({ current_node_key: null }), [seat()])).toBe(false)
  })

  it('no viewer identity cannot decide', () => {
    expect(canDecide(instance(), [seat()], null)).toBe(false)
    expect(canDecide(instance(), [seat()], '')).toBe(false)
  })
})

describe('resolveCanDecideCurrentNode — instance status', () => {
  it('a pending instance with a matching seat can be decided', () => {
    expect(canDecide(instance({ status: 'pending' }), [seat()])).toBe(true)
  })

  for (const status of ['approved', 'rejected', 'revoked', 'cancelled', 'draft']) {
    it(`a ${status} instance cannot be decided even by the seat holder`, () => {
      expect(canDecide(instance({ status }), [seat()])).toBe(false)
    })
  }
})

describe('resolveCanDecideCurrentNode — parallel regions', () => {
  const forkInstance = (branches: Parameters<typeof parallelMetadata>[0], currentNodeKey = 'fork') =>
    instance({ current_node_key: currentNodeKey, metadata: parallelMetadata(branches) })

  it('a seat on a still-pending branch can decide while the cursor sits on the fork gateway', () => {
    const row = forkInstance([
      { edgeKey: 'e1', currentNodeKey: 'branch_a', complete: false },
      { edgeKey: 'e2', currentNodeKey: 'branch_b', complete: false },
    ])
    expect(canDecide(row, [seat({ node_key: 'branch_b' })])).toBe(true)
  })

  it('a seat on a COMPLETED branch cannot decide', () => {
    const row = forkInstance([
      { edgeKey: 'e1', currentNodeKey: 'branch_a', complete: false },
      { edgeKey: 'e2', currentNodeKey: 'branch_b', complete: true },
    ])
    expect(canDecide(row, [seat({ node_key: 'branch_b' })])).toBe(false)
    // Same instance, same metadata, different branch — proves the `false` above is the completion
    // flag talking and not a broken fixture.
    expect(canDecide(row, [seat({ node_key: 'branch_a' })])).toBe(true)
  })

  it('branch frontiers stop counting once the cursor has left the fork gateway', () => {
    // The door only consults the branch frontier while `current_node_key === parallelNodeKey`. An
    // instance that has advanced past the join with branch state still on the row must therefore
    // report `false` for a branch seat — this is exactly where the tolerant
    // `collectActiveNodeKeys` derivation (used by the redaction gate and the upload fail-fast,
    // both of which are ALLOWED to be wider than the door) would say `true`.
    const row = forkInstance(
      [{ edgeKey: 'e1', currentNodeKey: 'branch_a', complete: false }],
      'approval_after_join',
    )
    expect(canDecide(row, [seat({ node_key: 'branch_a' })])).toBe(false)
    expect(canDecide(row, [seat({ node_key: 'approval_after_join' })])).toBe(true)
  })

  it('malformed branch metadata degrades to the stored current node, exactly as the door does', () => {
    const row = instance({
      current_node_key: 'fork',
      metadata: { parallelBranchStates: { parallelNodeKey: 'fork', branches: { e1: { edgeKey: 'e1' } } } },
    })
    expect(canDecide(row, [seat({ node_key: 'branch_a' })])).toBe(false)
    expect(canDecide(row, [seat({ node_key: 'fork' })])).toBe(true)
  })
})

describe('decidableNodeKeysForInstance', () => {
  it('is the stored current node key on a linear instance', () => {
    expect(decidableNodeKeysForInstance('approval_a', null)).toEqual(['approval_a'])
  })

  it('adds the pending branch frontier inside a parallel region', () => {
    const metadata = parallelMetadata([
      { edgeKey: 'e1', currentNodeKey: 'branch_a', complete: false },
      { edgeKey: 'e2', currentNodeKey: 'branch_b', complete: true },
      { edgeKey: 'e3', currentNodeKey: null, complete: false },
    ])
    expect(decidableNodeKeysForInstance('fork', metadata).sort()).toEqual(['branch_a', 'fork'])
  })

  it('is empty when the instance is stopped on no node and carries no branch state', () => {
    expect(decidableNodeKeysForInstance(null, null)).toEqual([])
  })
})

describe('decisionDoorIsSeatGated — which door the instance uses', () => {
  it('a template-runtime platform instance is seat gated', () => {
    expect(decisionDoorIsSeatGated(instance())).toBe(true)
  })

  it('a platform instance with no published definition is NOT seat gated', () => {
    expect(decisionDoorIsSeatGated(instance({ published_definition_id: null }))).toBe(false)
    expect(decisionDoorIsSeatGated(instance({ published_definition_id: undefined }))).toBe(false)
  })

  it('a plm mirror id is NOT seat gated', () => {
    expect(decisionDoorIsSeatGated(instance({ id: 'plm:abc' }))).toBe(false)
  })

  it('a non-platform source system is NOT seat gated', () => {
    expect(decisionDoorIsSeatGated(instance({ source_system: 'after-sales' }))).toBe(false)
  })

  it('an absent source system defaults to platform, matching the COALESCE in the route predicate', () => {
    expect(decisionDoorIsSeatGated(instance({ source_system: null }))).toBe(true)
    expect(decisionDoorIsSeatGated(instance({ source_system: undefined }))).toBe(true)
  })
})

describe('resolveCanDecideCurrentNode — instances whose door has no seat gate', () => {
  // `ApprovalBridgeService.dispatchAction` (legacy platform rows, plm mirrors, after-sales) checks
  // `approvals:act` and a pending status and nothing else. Reporting `false` there would HIDE
  // controls the server accepts, so the honest answer for a pending instance is `true`.
  it('a seatless viewer CAN decide a pending legacy instance with no published definition', () => {
    expect(canDecide(instance({ published_definition_id: null }), [])).toBe(true)
  })

  it('a seatless viewer CAN decide a pending plm mirror', () => {
    expect(canDecide(instance({ id: 'plm:abc', source_system: 'plm' }), [])).toBe(true)
  })

  it('but a CLOSED instance on that door still cannot be decided', () => {
    expect(canDecide(instance({ published_definition_id: null, status: 'approved' }), [])).toBe(false)
  })

  it('and a viewer with no identity still cannot decide it', () => {
    expect(canDecide(instance({ published_definition_id: null }), [], null)).toBe(false)
  })
})

/**
 * `seatNodeKeysForViewer` used to carry its own hand-written copy of the user/role match rule,
 * documented as mirroring `assignmentMatchesActor` "exactly". It now CALLS that function. These
 * pin the behaviour that must survive the change — the four discriminating cases the old inline
 * copy encoded — so a regression in the shared predicate reds here too, not only at the new field.
 */
describe('seatNodeKeysForViewer over the shared match rule', () => {
  const rows = [
    { is_active: true, assignment_type: 'user', assignee_id: VIEWER, node_key: 'n_user' },
    { is_active: true, assignment_type: 'role', assignee_id: 'approver', node_key: 'n_role' },
    { is_active: true, assignment_type: 'source_queue', assignee_id: VIEWER, node_key: 'n_queue' },
    { is_active: false, assignment_type: 'user', assignee_id: VIEWER, node_key: 'n_inactive' },
    { is_active: true, assignment_type: 'user', assignee_id: VIEWER, node_key: '' },
  ]

  it('keeps user and role seats, and drops source_queue / inactive / empty-node-key rows', () => {
    expect(seatNodeKeysForViewer(rows, VIEWER, ['approver']).sort()).toEqual(['n_role', 'n_user'])
  })

  it('drops the role seat for a viewer who does not hold the role', () => {
    expect(seatNodeKeysForViewer(rows, VIEWER, [])).toEqual(['n_user'])
    expect(seatNodeKeysForViewer(rows, VIEWER, null)).toEqual(['n_user'])
  })

  it('keeps or drops each row exactly as the door would, against verdicts stated HERE', () => {
    // The expected verdicts below are LITERALS written in this test, NOT a second call to the
    // predicate under test. The assertion this replaces compared `seatNodeKeysForViewer` against
    // `assignmentMatchesActor` — since the refactor those are two call sites of the SAME function,
    // so the comparison could not fail: it stayed green under the very mutation (role arm ->
    // `false`) that reds both real consumers. Each row is driven in ISOLATION so a wrong arm shows
    // up as one failing row rather than as one changed set.
    const expected: Array<{ nodeKey: string; kept: boolean; why: string }> = [
      { nodeKey: 'n_user', kept: true, why: 'user arm: assignee_id === the viewer id' },
      { nodeKey: 'n_role', kept: true, why: 'ROLE arm: assignee_id is a role the viewer holds' },
      { nodeKey: 'n_queue', kept: false, why: "'source_queue' matches nothing, at the door and here" },
      { nodeKey: 'n_inactive', kept: false, why: 'an inactive row is never a seat' },
      { nodeKey: '', kept: false, why: 'an empty node key is not a seat' },
    ]
    for (const { nodeKey, kept, why } of expected) {
      const row = rows.find((candidate) => candidate.node_key === nodeKey)
      expect(row, why).toBeDefined()
      expect(seatNodeKeysForViewer([row!], VIEWER, ['approver']), why).toEqual(kept ? [nodeKey] : [])
    }
  })

  it('the role seat is reachable ONLY through the role arm, and that arm decides it', () => {
    // These two guards keep the role coverage ATTRIBUTABLE. `assignmentMatchesActor` dispatches on
    // `assignment_type`, so as written today a role-typed row cannot reach the user arm at all —
    // but a hand-copy of this very rule once DID let an arm fall through to the user-id one (the
    // `'source_queue'` case above, gate finding NIT-R1). Holding the role seat's `assignee_id`
    // disjoint from the viewer's id is what keeps the `true` below attributable to the ROLE arm and
    // to nothing else, so a re-introduced fall-through could not keep this test green.
    const roleRow = rows.find((candidate) => candidate.node_key === 'n_role')!
    expect(roleRow.assignment_type).toBe('role')
    expect(roleRow.assignee_id).not.toBe(VIEWER)

    // Verdicts stated as literals, so a broken role arm reds here.
    expect(assignmentMatchesActor(roleRow, VIEWER, ['approver'])).toBe(true)
    expect(assignmentMatchesActor(roleRow, VIEWER, ['auditor'])).toBe(false)
    expect(seatNodeKeysForViewer([roleRow], VIEWER, ['approver'])).toEqual(['n_role'])
    expect(seatNodeKeysForViewer([roleRow], VIEWER, [])).toEqual([])
  })
})

/**
 * FIXTURE PROVENANCE. The parallel metadata driving the tests above is hand-written, so by itself
 * it says nothing about the shape the runtime actually persists — an assertion over its own key
 * list would only restate the fixture. These drive the predicate on a state produced by the
 * RUNTIME instead: `ApprovalGraphExecutor` is the component that emits `parallelState`, and
 * `dispatchAction` persists it under `metadata.parallelBranchStates`.
 *
 * Two limits, stated rather than papered over:
 *  - The executor yields the INNER object; the `parallelBranchStates` wrapper key is added at the
 *    persist site, which is not reachable from a unit test. The strict parser is the guard for that
 *    name — a wrong wrapper key parses to `null` and the parallel tests above go RED rather than
 *    vacuously green.
 *  - `buildPersistableParallelState` is module-private in `ApprovalProductService` and is
 *    deliberately NOT exported for a test; it writes the executor state through an explicit field
 *    pick, so a JSON round-trip of that state is superset-or-equal to what is persisted. The
 *    key-set assertion below is what pins it as EQUAL rather than merely wider — and it catches
 *    drift the strict parser cannot, since that parser ignores keys it does not read.
 */
describe('fixture provenance — against a runtime-produced parallel state', () => {
  /** A minimal fork/join graph; same shape as the parallel cases in approval-graph-executor.test.ts. */
  const parallelGraph: RuntimeGraph = {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'parallel_fork',
        type: 'parallel',
        config: { branches: ['edge-fork-a', 'edge-fork-b'], joinMode: 'all', joinNodeKey: 'finance-review' },
      },
      { key: 'legal-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['legal-1'] } },
      { key: 'compliance-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['compliance-1'] } },
      { key: 'finance-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['finance-1'] } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-fork', source: 'start', target: 'parallel_fork' },
      { key: 'edge-fork-a', source: 'parallel_fork', target: 'legal-review' },
      { key: 'edge-fork-b', source: 'parallel_fork', target: 'compliance-review' },
      { key: 'edge-a-join', source: 'legal-review', target: 'finance-review' },
      { key: 'edge-b-join', source: 'compliance-review', target: 'finance-review' },
      { key: 'edge-finance-end', source: 'finance-review', target: 'end' },
    ],
    policy: { allowRevoke: true },
  }

  const runtimeParallelState = new ApprovalGraphExecutor(parallelGraph, {}).resolveInitialState().parallelState!
  const metadataFromRuntime: Record<string, unknown> = {
    parallelBranchStates: JSON.parse(JSON.stringify(runtimeParallelState)),
  }

  it('the executor really produced a parallel state to compare against', () => {
    // If this ever stops holding, every assertion below would be comparing against `undefined`.
    expect(runtimeParallelState).toBeDefined()
    expect(runtimeParallelState.parallelNodeKey).toBe('parallel_fork')
    expect(Object.keys(runtimeParallelState.branches).sort()).toEqual(['edge-fork-a', 'edge-fork-b'])
  })

  it('the door mirror reads a RUNTIME-produced parallel state, not only the hand-written fixture', () => {
    expect(decidableNodeKeysForInstance('parallel_fork', metadataFromRuntime).sort()).toEqual([
      'compliance-review',
      'legal-review',
      'parallel_fork',
    ])

    const row = instance({ current_node_key: 'parallel_fork', metadata: metadataFromRuntime })
    // A seat on a runtime-emitted branch frontier decides; the runtime-emitted JOIN node does not.
    expect(canDecide(row, [seat({ node_key: 'legal-review' })])).toBe(true)
    expect(canDecide(row, [seat({ node_key: 'compliance-review' })])).toBe(true)
    expect(canDecide(row, [seat({ node_key: runtimeParallelState.joinNodeKey })])).toBe(false)
  })

  it('the hand-written fixture carries exactly the runtime state\'s keys, top level and per branch', () => {
    const fixture = parallelMetadata([
      { edgeKey: 'e1', currentNodeKey: 'branch_a', complete: false },
    ]).parallelBranchStates

    expect(Object.keys(fixture).sort()).toEqual(Object.keys(runtimeParallelState).sort())
    expect(Object.keys(Object.values(fixture.branches)[0]).sort())
      .toEqual(Object.keys(Object.values(runtimeParallelState.branches)[0]).sort())
  })

  it('the assignment fixture carries exactly the columns the match rule reads', () => {
    // Guards against a silently-renamed column making every seat assertion above vacuous.
    expect(Object.keys(seat()).sort()).toEqual(['assignee_id', 'assignment_type', 'is_active', 'node_key'])
    expect(instance().status).toBe('pending')
  })
})
