import { describe, expect, it } from 'vitest'

import { dispatchOnLatestCancelRound } from '../../src/approvals/approval-cancel-round-entry-port'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

/**
 * Cancel-round product entry (A2 gate r1, NIT-1) — the port's own verb allow-list.
 *
 * The attendance-side routes validate the verb before they call the port (zod enum), and the
 * service entry applies lock §9-9 after it; the port's allow-list in between had no test of its own,
 * so disabling it alone left every suite green. This pins it directly: a verb outside
 * {approve, reject, revoke} must be refused BEFORE any query is issued. The positive control (an
 * allowed verb on a document with no round reads the round table once and answers `noRound`) keeps
 * the negative leg from passing just because the helper always throws.
 */

function stubQuery(): Queryable & { calls: number } {
  const stub = {
    calls: 0,
    async query() {
      stub.calls += 1
      return { rows: [], rowCount: 0 }
    },
  }
  return stub
}

const actor = { userId: 'actor-1' }

describe('cancel-round entry port — dispatch verb allow-list', () => {
  it('positive control: an allowed verb on a document with no round reads once and answers noRound', async () => {
    const query = stubQuery()
    await expect(dispatchOnLatestCancelRound(query, 'doc-1', actor, 'approve', null)).resolves.toEqual({
      ok: false,
      noRound: true,
    })
    expect(query.calls).toBe(1)
  })

  it.each(['transfer', 'add_sign', 'reduce_sign', 'comment', 'handle', 'return'])(
    'a verb outside the allow-list (%s) throws before any query',
    async (verb) => {
      const query = stubQuery()
      await expect(
        dispatchOnLatestCancelRound(query, 'doc-1', actor, verb as 'approve', null),
      ).rejects.toThrow(/is not dispatched through this port/)
      expect(query.calls).toBe(0)
    },
  )
})
