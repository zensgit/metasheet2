import { describe, expect, it } from 'vitest'

import { readCancelRoundSummaryForDocumentV1 } from '../../src/approvals/approval-cancel-round-entry-port'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

/**
 * Cancel-round product entry, phase A — the round-summary reader's handling of an outcome it does
 * not recognise (lock v5.9 product-entry v2, P-8 ③: an unknown state must not collapse into the
 * empty result).
 *
 * The `approval_rounds` outcome CHECK makes this state unreachable on a real database today, so the
 * reader is driven with a stub `Queryable` that returns one round row. The positive control (no row
 * ⇒ `round: null`) keeps the negative leg from passing just because the reader always throws.
 */

function stubQuery(rows: Array<Record<string, unknown>>): Queryable & { calls: number } {
  const stub = {
    calls: 0,
    async query() {
      stub.calls += 1
      return { rows: stub.calls === 1 ? rows : [], rowCount: stub.calls === 1 ? rows.length : 0 }
    },
  }
  return stub
}

describe('cancel-round entry — round summary on an unrecognised outcome', () => {
  it('no round row ⇒ `round: null` (positive control: the empty result is still the no-round shape)', async () => {
    const query = stubQuery([])
    await expect(readCancelRoundSummaryForDocumentV1(query, 'doc-1', 'viewer-1')).resolves.toEqual({
      documentInstanceId: 'doc-1',
      round: null,
    })
    expect(query.calls).toBe(1)
  })

  it('an outcome outside the known enum ⇒ explicit error, never the `round: null` no-round shape', async () => {
    const query = stubQuery([
      {
        round_id: 'apr_unknown_outcome',
        engine_instance_id: 'eng-1',
        outcome: 'some_future_outcome',
        started_at: new Date('2026-09-29T00:00:00Z'),
        ended_at: null,
        engine_status: 'pending',
        engine_current_node_key: null,
        engine_requester_id: 'viewer-1',
        allow_revoke: null,
        revoke_before_node_keys: null,
      },
    ])
    await expect(readCancelRoundSummaryForDocumentV1(query, 'doc-1', 'viewer-1')).rejects.toThrow(
      /unrecognised round outcome "some_future_outcome" on round apr_unknown_outcome/,
    )
    // It stops at the round row: no projection / audit / withdraw reads on an unknown state.
    expect(query.calls).toBe(1)
  })
})
