/**
 * GHSA-h8mf — SnapshotService.restoreSnapshot() authoritative restore-scope invariant.
 *
 * The route validates the same rules (defense-in-depth), but the SERVICE must re-validate so no
 * other caller (internal service, a future route, a test harness) can bypass the route and trigger
 * a full restore labeled 'partial', or a partial restore over an item type outside the allowlist.
 *
 * db is mocked to a SENTINEL: any real query throws DB_REACHED_SENTINEL. So a rejection carrying the
 * sentinel proves the invariant PASSED the input through to the DB; a rejection carrying an invariant
 * message proves the invariant BLOCKED it before any DB access. This distinguishes the two and makes
 * the invariant load-bearing: delete it and the "blocked" cases would fall through to the sentinel.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/db/db', () => ({
  db: {
    selectFrom: () => {
      throw new Error('DB_REACHED_SENTINEL')
    },
  },
}))

import { snapshotService } from '../../src/services/SnapshotService'

describe('SnapshotService.restoreSnapshot — restore-scope invariant (GHSA-h8mf)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects a missing/unknown restoreType before touching the DB', async () => {
    await expect(
      snapshotService.restoreSnapshot({ snapshotId: 's1', restoredBy: 'u1' }),
    ).rejects.toThrow('Invalid restoreType')
    await expect(
      // @ts-expect-error deliberately invalid at the type level to prove the runtime guard
      snapshotService.restoreSnapshot({ snapshotId: 's1', restoredBy: 'u1', restoreType: 'everything' }),
    ).rejects.toThrow('Invalid restoreType')
  })

  it("rejects restoreType 'full' that also narrows via itemTypes", async () => {
    await expect(
      snapshotService.restoreSnapshot({ snapshotId: 's1', restoredBy: 'u1', restoreType: 'full', itemTypes: ['view'] }),
    ).rejects.toThrow('must not specify itemTypes')
  })

  it("rejects partial/selective with missing or empty itemTypes", async () => {
    await expect(
      snapshotService.restoreSnapshot({ snapshotId: 's1', restoredBy: 'u1', restoreType: 'partial' }),
    ).rejects.toThrow('requires a non-empty itemTypes')
    await expect(
      snapshotService.restoreSnapshot({ snapshotId: 's1', restoredBy: 'u1', restoreType: 'selective', itemTypes: [] }),
    ).rejects.toThrow('requires a non-empty itemTypes')
  })

  it('rejects an itemType outside the allowlist', async () => {
    await expect(
      snapshotService.restoreSnapshot({
        snapshotId: 's1',
        restoredBy: 'u1',
        restoreType: 'partial',
        itemTypes: ['view', 'secrets'],
      }),
    ).rejects.toThrow('outside the allowlist')
  })

  it('PASSES a confirmed-shape full restore through to the DB (sentinel), i.e. not over-restricted', async () => {
    await expect(
      snapshotService.restoreSnapshot({ snapshotId: 's1', restoredBy: 'u1', restoreType: 'full' }),
    ).rejects.toThrow('DB_REACHED_SENTINEL')
  })

  it('PASSES a valid partial restore (allowlisted itemTypes) through to the DB (sentinel)', async () => {
    await expect(
      snapshotService.restoreSnapshot({
        snapshotId: 's1',
        restoredBy: 'u1',
        restoreType: 'partial',
        itemTypes: ['view', 'table_row'],
      }),
    ).rejects.toThrow('DB_REACHED_SENTINEL')
  })
})
