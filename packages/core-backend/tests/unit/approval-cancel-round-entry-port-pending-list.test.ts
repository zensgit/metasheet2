import { describe, expect, it } from 'vitest'

import {
  CANCEL_ROUND_DISPATCH_ROLE_CLAIMS,
  listSeatedPendingCancelRoundsV1,
} from '../../src/approvals/approval-cancel-round-entry-port'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

/**
 * Cancel-round product entry C2 (owner 2026-09-29 16:5x, 「Attendance-side list (Recommended)」) — the
 * port's pending list, over shapes the real-DB suite cannot build on a cancel round (the creation path
 * seats persons by user id on one node of a template-runtime instance): a ROLE seat, a seat at a node
 * the instance is not stopped on, a parallel branch frontier, and an instance the decision door does
 * not seat-gate at all.
 *
 * What this pins: the verdict is the decision door's own predicate (`decisionDoorIsSeatGated` +
 * `resolveCanDecideCurrentNode`) computed with the role claims the port DISPATCHES with
 * (`CANCEL_ROUND_DISPATCH_ROLE_CLAIMS`, today none) — so a role seat is never listed, because the door
 * would refuse the listed viewer on it; and the candidate read is narrowed by values derived from that
 * same constant.
 */

type Candidate = {
  round_id: string
  document_id: string
  started_at: string
  engine_instance_id: string
  status: string
  source_system: string | null
  published_definition_id: string | null
  current_node_key: string | null
  metadata: Record<string, unknown> | null
}

type Seat = { instance_id: string; node_key: string | null; is_active: boolean; assignment_type: string; assignee_id: string }

function fakeQuery(candidates: Candidate[], seats: Seat[]): Queryable & { calls: Array<{ text: string; values: unknown[] }> } {
  const stub = {
    calls: [] as Array<{ text: string; values: unknown[] }>,
    async query(text: string, values: unknown[] = []) {
      stub.calls.push({ text, values })
      if (text.includes('FROM approval_rounds r')) return { rows: candidates, rowCount: candidates.length }
      if (text.includes('FROM approval_assignments')) {
        const ids = new Set(values[0] as string[])
        const rows = seats.filter((seat) => ids.has(seat.instance_id) && seat.is_active)
        return { rows, rowCount: rows.length }
      }
      throw new Error(`unexpected SQL: ${text}`)
    },
  }
  return stub as unknown as Queryable & { calls: Array<{ text: string; values: unknown[] }> }
}

function candidate(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    round_id: `round-${id}`,
    document_id: `doc-${id}`,
    started_at: '2026-09-29T08:00:00.000Z',
    engine_instance_id: `eng-${id}`,
    status: 'pending',
    source_system: 'platform',
    published_definition_id: 'pub-1',
    current_node_key: 'approval_a',
    metadata: null,
    ...overrides,
  }
}

const VIEWER = 'viewer-1'

describe('cancel-round entry port — C2 seated pending list', () => {
  it('the dispatch role claims are empty, and the candidate read is narrowed by the viewer plus exactly those claims', async () => {
    expect(CANCEL_ROUND_DISPATCH_ROLE_CLAIMS).toEqual([])
    const query = fakeQuery([], [])
    await expect(listSeatedPendingCancelRoundsV1(query, VIEWER)).resolves.toEqual([])
    expect(query.calls).toHaveLength(1)
    expect(query.calls[0].values).toEqual([[VIEWER, ...CANCEL_ROUND_DISPATCH_ROLE_CLAIMS]])
  })

  it('positive control: an active USER seat at the node the instance is stopped on is listed, keyed back to its original document', async () => {
    const query = fakeQuery(
      [candidate('1')],
      [{ instance_id: 'eng-1', node_key: 'approval_a', is_active: true, assignment_type: 'user', assignee_id: VIEWER }],
    )
    await expect(listSeatedPendingCancelRoundsV1(query, VIEWER)).resolves.toEqual([
      { roundId: 'round-1', engineInstanceId: 'eng-1', documentInstanceId: 'doc-1', launchedAt: '2026-09-29T08:00:00.000Z' },
    ])
  })

  it('a ROLE seat is not listed even when its role id equals the viewer id: the port dispatches with no role claims, so the door would refuse the viewer there', async () => {
    const query = fakeQuery(
      [candidate('2')],
      [{ instance_id: 'eng-2', node_key: 'approval_a', is_active: true, assignment_type: 'role', assignee_id: VIEWER }],
    )
    await expect(listSeatedPendingCancelRoundsV1(query, VIEWER)).resolves.toEqual([])
  })

  it('a seat at a node the instance is NOT stopped on, and a non-pending engine instance, are not listed', async () => {
    const query = fakeQuery(
      [candidate('3', { current_node_key: 'approval_b' }), candidate('4', { status: 'approved' })],
      [
        { instance_id: 'eng-3', node_key: 'approval_a', is_active: true, assignment_type: 'user', assignee_id: VIEWER },
        { instance_id: 'eng-4', node_key: 'approval_a', is_active: true, assignment_type: 'user', assignee_id: VIEWER },
      ],
    )
    await expect(listSeatedPendingCancelRoundsV1(query, VIEWER)).resolves.toEqual([])
  })

  it('inside a parallel region the viewer\'s seat at a still-pending branch frontier is listed (the door\'s own node-key set)', async () => {
    const metadata = {
      parallelBranchStates: {
        parallelNodeKey: 'fork',
        joinNodeKey: 'join',
        joinMode: 'all',
        branches: {
          'e-a': { edgeKey: 'e-a', currentNodeKey: 'branch_a', complete: false },
          'e-b': { edgeKey: 'e-b', currentNodeKey: 'branch_b', complete: true },
        },
      },
    }
    const query = fakeQuery(
      [candidate('5', { current_node_key: 'fork', metadata }), candidate('6', { current_node_key: 'fork', metadata })],
      [
        { instance_id: 'eng-5', node_key: 'branch_a', is_active: true, assignment_type: 'user', assignee_id: VIEWER },
        // A COMPLETE branch's node is not decidable.
        { instance_id: 'eng-6', node_key: 'branch_b', is_active: true, assignment_type: 'user', assignee_id: VIEWER },
      ],
    )
    const listed = await listSeatedPendingCancelRoundsV1(query, VIEWER)
    expect(listed.map((row) => row.roundId)).toEqual(['round-5'])
  })

  it('an instance the decision door does not seat-gate (no published definition, or not a platform row) is not listed — the door refuses it outright', async () => {
    const query = fakeQuery(
      [candidate('7', { published_definition_id: null }), candidate('8', { source_system: 'plm' })],
      [
        { instance_id: 'eng-7', node_key: 'approval_a', is_active: true, assignment_type: 'user', assignee_id: VIEWER },
        { instance_id: 'eng-8', node_key: 'approval_a', is_active: true, assignment_type: 'user', assignee_id: VIEWER },
      ],
    )
    await expect(listSeatedPendingCancelRoundsV1(query, VIEWER)).resolves.toEqual([])
  })

  it('a blank viewer reads nothing', async () => {
    const query = fakeQuery([candidate('9')], [])
    await expect(listSeatedPendingCancelRoundsV1(query, '  ')).resolves.toEqual([])
    expect(query.calls).toHaveLength(0)
  })
})
