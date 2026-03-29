import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
}))

vi.mock('../../src/utils/database-errors', () => ({
  isDatabaseSchemaError: vi.fn(() => false),
}))

import { findDingTalkExternalIdentity } from '../../src/auth/external-identities'

describe('external identities', () => {
  beforeEach(() => {
    pgMocks.query.mockReset()
  })

  it('falls back to provider_union_id when external_key lookup misses', async () => {
    pgMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'binding-1',
          provider: 'dingtalk',
          external_key: 'dingtalk:corp-1:dir-user-1',
          provider_user_id: 'dir-user-1',
          provider_union_id: 'union-1',
          provider_open_id: null,
          corp_id: 'corp-1',
          local_user_id: 'user-1',
          profile: {},
          bound_by: 'admin-1',
          last_login_at: null,
          created_at: '2026-03-25T00:00:00.000Z',
          updated_at: '2026-03-25T00:00:00.000Z',
        }],
      })

    const match = await findDingTalkExternalIdentity({
      unionId: 'union-1',
    })

    expect(match?.id).toBe('binding-1')
    expect(pgMocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('provider_union_id = $2'),
      ['dingtalk', 'union-1'],
    )
  })

  it('falls back to provider_user_id with corp_id when external_key lookup misses', async () => {
    pgMocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'binding-2',
          provider: 'dingtalk',
          external_key: 'dingtalk-union:union-2',
          provider_user_id: 'dt-user-2',
          provider_union_id: 'union-2',
          provider_open_id: null,
          corp_id: 'corp-1',
          local_user_id: 'user-2',
          profile: {},
          bound_by: 'admin-1',
          last_login_at: null,
          created_at: '2026-03-25T00:00:00.000Z',
          updated_at: '2026-03-25T00:00:00.000Z',
        }],
      })

    const match = await findDingTalkExternalIdentity({
      corpId: 'corp-1',
      userId: 'dt-user-2',
    })

    expect(match?.id).toBe('binding-2')
    expect(pgMocks.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('corp_id = $2'),
      ['dingtalk', 'corp-1', 'dt-user-2'],
    )
  })
})
