import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
}))

import { getDirectoryReviewItem, listDirectoryReviewItems } from '../../src/directory/directory-sync'

describe('listDirectoryReviewItems', () => {
  beforeEach(() => {
    pgMocks.query.mockReset()
    pgMocks.transaction.mockReset()
  })

  it('returns a safe recommendation for uniquely matched pending bindings', async () => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{ total: 1 }],
      })
      .mockResolvedValueOnce({
        rows: [{
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          directory_account_id: 'account-1',
          external_user_id: '0447654442691174',
          union_id: 'union-1',
          open_id: 'open-1',
          external_key: 'union-1',
          account_name: '林岚',
          account_email: 'alpha@example.com',
          account_mobile: '13900001234',
          account_is_active: true,
          account_updated_at: '2026-04-15T08:00:00.000Z',
          link_status: 'pending',
          match_strategy: 'email',
          reviewed_by: null,
          review_note: null,
          link_updated_at: '2026-04-15T08:00:00.000Z',
          local_user_id: 'user-1',
          local_user_email: 'alpha@example.com',
          local_user_name: 'Alpha',
          department_paths: ['DingTalk CN'],
          review_kind: 'pending_binding',
          review_reason: '目录成员当前不是已确认绑定状态，建议复核。',
          missing_union_id: false,
          missing_open_id: false,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          mobile: '13900001234',
        }],
      })
      .mockResolvedValueOnce({
        rows: [],
      })
      .mockResolvedValueOnce({
        rows: [{
          local_user_id: 'user-1',
          external_key: 'dingcorp:open-1',
          provider_union_id: 'union-1',
          provider_open_id: 'open-1',
          corp_id: 'dingcorp',
        }],
      })

    const result = await listDirectoryReviewItems('dir-1', { limit: 100, offset: 0 }, 'pending_binding')

    expect(result.total).toBe(1)
    expect(result.items[0]).toMatchObject({
      kind: 'pending_binding',
      account: {
        id: 'account-1',
      },
      recommendationStatus: {
        code: 'recommended',
        message: '已命中唯一精确候选，可直接确认推荐绑定。',
      },
      actionable: {
        canConfirmRecommendation: true,
      },
      recommendations: [{
        localUser: {
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          isActive: true,
        },
        reasons: ['pending_link', 'email', 'mobile'],
      }],
    })
  })

  it('suppresses ambiguous or conflicting recommendations', async () => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{ total: 1 }],
      })
      .mockResolvedValueOnce({
        rows: [{
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          directory_account_id: 'account-1',
          external_user_id: '0447654442691174',
          union_id: 'union-1',
          open_id: 'open-1',
          external_key: 'union-1',
          account_name: '林岚',
          account_email: null,
          account_mobile: '13900001234',
          account_is_active: true,
          account_updated_at: '2026-04-15T08:00:00.000Z',
          link_status: 'unmatched',
          match_strategy: 'none',
          reviewed_by: null,
          review_note: null,
          link_updated_at: '2026-04-15T08:00:00.000Z',
          local_user_id: null,
          local_user_email: null,
          local_user_name: null,
          department_paths: ['DingTalk CN'],
          review_kind: 'pending_binding',
          review_reason: '目录成员尚未绑定本地用户。',
          missing_union_id: false,
          missing_open_id: false,
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'user-1',
            email: 'alpha@example.com',
            name: 'Alpha',
            role: 'user',
            is_active: true,
            mobile: '13900001234',
          },
          {
            id: 'user-2',
            email: 'beta@example.com',
            name: 'Beta',
            role: 'user',
            is_active: true,
            mobile: '13900001234',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [],
      })
      .mockResolvedValueOnce({
        rows: [],
      })

    const result = await listDirectoryReviewItems('dir-1', { limit: 100, offset: 0 }, 'pending_binding')

    expect(result.items[0]).toMatchObject({
      recommendationStatus: {
        code: 'ambiguous_exact_match',
        message: '邮箱或手机号命中多个本地用户，需人工确认。',
      },
      actionable: {
        canConfirmRecommendation: false,
      },
    })
    expect(result.items[0]?.recommendations).toEqual([])
  })

  it('returns a manual-required status when no exact candidate exists', async () => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{ total: 1 }],
      })
      .mockResolvedValueOnce({
        rows: [{
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          directory_account_id: 'account-1',
          external_user_id: '0447654442691174',
          union_id: 'union-1',
          open_id: 'open-1',
          external_key: 'union-1',
          account_name: '林岚',
          account_email: null,
          account_mobile: null,
          account_is_active: true,
          account_updated_at: '2026-04-15T08:00:00.000Z',
          link_status: 'unmatched',
          match_strategy: 'none',
          reviewed_by: null,
          review_note: null,
          link_updated_at: '2026-04-15T08:00:00.000Z',
          local_user_id: null,
          local_user_email: null,
          local_user_name: null,
          department_paths: ['DingTalk CN'],
          review_kind: 'pending_binding',
          review_reason: '目录成员尚未绑定本地用户。',
          missing_union_id: false,
          missing_open_id: false,
        }],
      })

    const result = await listDirectoryReviewItems('dir-1', { limit: 100, offset: 0 }, 'pending_binding')

    expect(result.items[0]).toMatchObject({
      recommendationStatus: {
        code: 'no_exact_match',
        message: '未命中唯一的邮箱或手机号精确匹配，请人工搜索本地用户。',
      },
      actionable: {
        canConfirmRecommendation: false,
      },
    })
    expect(result.items[0]?.recommendations).toEqual([])
  })

  it('returns a conflict status when pending binding disagrees with the exact candidate', async () => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{ total: 1 }],
      })
      .mockResolvedValueOnce({
        rows: [{
          integration_id: 'dir-1',
          provider: 'dingtalk',
          corp_id: 'dingcorp',
          directory_account_id: 'account-1',
          external_user_id: '0447654442691174',
          union_id: 'union-1',
          open_id: 'open-1',
          external_key: 'union-1',
          account_name: '林岚',
          account_email: 'alpha@example.com',
          account_mobile: null,
          account_is_active: true,
          account_updated_at: '2026-04-15T08:00:00.000Z',
          link_status: 'pending',
          match_strategy: 'email',
          reviewed_by: null,
          review_note: null,
          link_updated_at: '2026-04-15T08:00:00.000Z',
          local_user_id: 'user-pending',
          local_user_email: 'pending@example.com',
          local_user_name: 'Pending',
          department_paths: ['DingTalk CN'],
          review_kind: 'pending_binding',
          review_reason: '目录成员当前不是已确认绑定状态，建议复核。',
          missing_union_id: false,
          missing_open_id: false,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'user-1',
          email: 'alpha@example.com',
          name: 'Alpha',
          role: 'user',
          is_active: true,
          mobile: null,
        }],
      })
      .mockResolvedValueOnce({
        rows: [],
      })
      .mockResolvedValueOnce({
        rows: [],
      })

    const result = await listDirectoryReviewItems('dir-1', { limit: 100, offset: 0 }, 'pending_binding')

    expect(result.items[0]).toMatchObject({
      recommendationStatus: {
        code: 'pending_link_conflict',
        message: '现有待确认匹配与精确候选不一致，请人工复核。',
      },
      actionable: {
        canConfirmRecommendation: false,
      },
    })
    expect(result.items[0]?.recommendations).toEqual([])
  })

  it('uses grouped user columns instead of raw link columns in review list SQL', async () => {
    pgMocks.query
      .mockResolvedValueOnce({
        rows: [{ total: 0 }],
      })
      .mockResolvedValueOnce({
        rows: [],
      })

    await listDirectoryReviewItems('dir-1', { limit: 100, offset: 0 }, 'pending_binding')

    const listSql = String(pgMocks.query.mock.calls[1]?.[0] ?? '')
    expect(listSql).toContain("WHEN a.is_active = FALSE AND u.id IS NOT NULL THEN 'inactive_linked'")
    expect(listSql).toContain("WHEN u.id IS NULL THEN '目录成员尚未绑定本地用户。'")
    expect(listSql).not.toContain("WHEN a.is_active = FALSE AND l.local_user_id IS NOT NULL THEN 'inactive_linked'")
    expect(listSql).not.toContain("WHEN l.local_user_id IS NULL THEN '目录成员尚未绑定本地用户。'")
  })

  it('uses grouped user columns instead of raw link columns in single review item SQL', async () => {
    pgMocks.query.mockResolvedValueOnce({
      rows: [],
    })

    await getDirectoryReviewItem('account-1')

    const detailSql = String(pgMocks.query.mock.calls[0]?.[0] ?? '')
    expect(detailSql).toContain("WHEN a.is_active = FALSE AND u.id IS NOT NULL THEN 'inactive_linked'")
    expect(detailSql).toContain("WHEN u.id IS NULL THEN '目录成员尚未绑定本地用户。'")
    expect(detailSql).not.toContain("WHEN a.is_active = FALSE AND l.local_user_id IS NOT NULL THEN 'inactive_linked'")
    expect(detailSql).not.toContain("WHEN l.local_user_id IS NULL THEN '目录成员尚未绑定本地用户。'")
  })
})
