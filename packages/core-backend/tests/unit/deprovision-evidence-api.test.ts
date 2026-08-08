import { beforeEach, describe, expect, it, vi } from 'vitest'

const dbMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  clientQuery: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: dbMocks.query,
  transaction: dbMocks.transaction,
}))

import {
  previewDeprovisionForUser,
  readDeprovisionRuntimeFlags,
} from '../../src/directory/deprovision-evidence-api'

describe('readDeprovisionRuntimeFlags', () => {
  it('defaults deprovision writer OFF', () => {
    const prev = process.env.DIRECTORY_DEPROVISION_ENABLED
    delete process.env.DIRECTORY_DEPROVISION_ENABLED
    const flags = readDeprovisionRuntimeFlags()
    expect(flags.enabled).toBe(false)
    expect(flags.maxBatch).toBe(25)
    expect(flags.policyNote).toMatch(/策略≠已执行/)
    if (prev === undefined) delete process.env.DIRECTORY_DEPROVISION_ENABLED
    else process.env.DIRECTORY_DEPROVISION_ENABLED = prev
  })
})

describe('previewDeprovisionForUser snapshot contract', () => {
  beforeEach(() => {
    dbMocks.query.mockReset()
    dbMocks.clientQuery.mockReset()
    dbMocks.transaction.mockReset()
    dbMocks.transaction.mockImplementation(
      async (handler: (client: { query: typeof dbMocks.clientQuery }) => Promise<unknown>) =>
        handler({ query: dbMocks.clientQuery }),
    )
  })

  it('sets read-only repeatable-read before every preview read', async () => {
    dbMocks.clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          activation_status: 'activated',
          is_active: true,
          access_generation: 3,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          org_id: 'org-1',
          default_deprovision_policy: 'mark_inactive',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const preview = await previewDeprovisionForUser(
      'user-1',
      '00000000-0000-4000-8000-000000000001',
    )

    expect(dbMocks.clientQuery).toHaveBeenNthCalledWith(
      1,
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    )
    expect(dbMocks.query).not.toHaveBeenCalled()
    expect(preview).toMatchObject({
      prospectiveDeactivatedAccountIds: [],
      plan: {
        skipReason: 'no_active_linked_accounts',
        effects: [],
      },
    })
  })
})
