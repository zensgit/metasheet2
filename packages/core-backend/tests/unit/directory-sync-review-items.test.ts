import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
}))

import {
  __directorySyncInternalsForTests,
  getDirectoryReviewItem,
  listDirectoryReviewItems,
  resolveDirectoryIdentityMatch,
} from '../../src/directory/directory-sync'

const { doesExternalIdentityMatchAccount } = __directorySyncInternalsForTests

describe('directory review identity corp scope', () => {
  const account = {
    corp_id: 'corp-b',
    external_key: 'shared-union',
    open_id: null,
    union_id: 'shared-union',
  }

  it('rejects a legacy raw identity key from another corp', () => {
    expect(doesExternalIdentityMatchAccount({
      local_user_id: 'user-a',
      external_key: 'shared-union',
      provider_union_id: null,
      provider_open_id: null,
      corp_id: 'corp-a',
    }, account)).toBe(false)
  })

  it('accepts the same legacy raw identity key within the same corp', () => {
    expect(doesExternalIdentityMatchAccount({
      local_user_id: 'user-b',
      external_key: 'shared-union',
      provider_union_id: null,
      provider_open_id: null,
      corp_id: 'corp-b',
    }, account)).toBe(true)
  })

  it('preserves global legacy matching only when both sides have no corp', () => {
    expect(doesExternalIdentityMatchAccount({
      local_user_id: 'legacy-user',
      external_key: 'legacy-key',
      provider_union_id: null,
      provider_open_id: null,
      corp_id: null,
    }, {
      ...account,
      corp_id: null,
      external_key: 'legacy-key',
      union_id: 'legacy-key',
    })).toBe(true)
  })

  it('does not collide delimiter-containing corp and provider ids', () => {
    expect(doesExternalIdentityMatchAccount({
      local_user_id: 'user-a',
      external_key: 'unrelated',
      provider_union_id: null,
      provider_open_id: 'c',
      corp_id: 'a:b',
    }, {
      corp_id: 'a',
      external_key: 'unrelated',
      open_id: 'b:c',
      union_id: null,
    })).toBe(false)
  })

  it('returns ambiguous before matching a duplicate corp-scoped provider identity', () => {
    const ambiguousUnionKey = JSON.stringify(['corp-a', 'duplicate-union'])
    expect(resolveDirectoryIdentityMatch(
      {
        corpId: 'corp-a',
        externalKey: 'duplicate-union',
        unionId: 'duplicate-union',
        openId: null,
        email: null,
        mobile: null,
      },
      null,
      {
        scopedExternalIdentityMap: new Map(),
        scopedUnionIdentityMap: new Map(),
        scopedOpenIdentityMap: new Map(),
        ambiguousScopedExternalIdentityKeys: new Set(),
        ambiguousScopedUnionIdentityKeys: new Set([ambiguousUnionKey]),
        ambiguousScopedOpenIdentityKeys: new Set(),
        emailMap: new Map(),
        mobileMap: new Map(),
        ambiguousEmailKeys: new Set(),
        ambiguousMobileKeys: new Set(),
      },
    )).toEqual({ matched: 'ambiguous' })
  })

  it.each([
    ['external', 'duplicate-external', 'duplicate-external', null, null],
    ['open', 'duplicate-open', null, 'duplicate-open', null],
  ])('keeps the %s ambiguity branch load-bearing', (_kind, ambiguousId, externalKey, openId, unionId) => {
    const scopedKey = JSON.stringify(['corp-a', ambiguousId])
    expect(resolveDirectoryIdentityMatch(
      {
        corpId: 'corp-a',
        externalKey: externalKey ?? 'unrelated',
        unionId,
        openId,
        email: null,
        mobile: null,
      },
      null,
      {
        scopedExternalIdentityMap: new Map(),
        scopedUnionIdentityMap: new Map(),
        scopedOpenIdentityMap: new Map(),
        ambiguousScopedExternalIdentityKeys: new Set(externalKey ? [scopedKey] : []),
        ambiguousScopedUnionIdentityKeys: new Set(),
        ambiguousScopedOpenIdentityKeys: new Set(openId ? [scopedKey] : []),
        emailMap: new Map(),
        mobileMap: new Map(),
        ambiguousEmailKeys: new Set(),
        ambiguousMobileKeys: new Set(),
      },
    )).toEqual({ matched: 'ambiguous' })
  })

  it('re-evaluates ambiguity before preserving an existing linked account', () => {
    const scopedKey = JSON.stringify(['corp-a', 'duplicate-union'])
    expect(resolveDirectoryIdentityMatch(
      {
        corpId: 'corp-a',
        externalKey: 'duplicate-union',
        unionId: 'duplicate-union',
        openId: null,
        email: null,
        mobile: null,
      },
      { local_user_id: 'previous-user', link_status: 'linked', match_strategy: 'manual_admin' },
      {
        scopedExternalIdentityMap: new Map(),
        scopedUnionIdentityMap: new Map(),
        scopedOpenIdentityMap: new Map(),
        ambiguousScopedExternalIdentityKeys: new Set(),
        ambiguousScopedUnionIdentityKeys: new Set([scopedKey]),
        ambiguousScopedOpenIdentityKeys: new Set(),
        emailMap: new Map(),
        mobileMap: new Map(),
        ambiguousEmailKeys: new Set(),
        ambiguousMobileKeys: new Set(),
      },
    )).toEqual({ matched: 'ambiguous' })
  })
})

/**
 * An administrator's explicit unbind is persisted as the link row shape
 * `(local_user_id NULL, link_status <> 'linked', match_strategy 'manual_unbound')`. The cascade
 * must report it as `admin_unbound` before any automatic strategy — external identity, unique
 * email or mobile hint, and the ambiguity checks — can produce a different outcome, and must
 * recognise it by those three columns only.
 */
describe('resolveDirectoryIdentityMatch keeps an administrator-unbound link', () => {
  const account = {
    corpId: 'corp-a',
    externalKey: 'union-held',
    unionId: 'union-held',
    openId: 'open-held',
    email: 'Held@Example.test',
    mobile: '138 0000 0000',
  }
  const scopedUnionKey = JSON.stringify(['corp-a', 'union-held'])
  const held = { local_user_id: null, link_status: 'unmatched', match_strategy: 'manual_unbound' }

  function emptyMaps() {
    return {
      scopedExternalIdentityMap: new Map<string, string>(),
      scopedUnionIdentityMap: new Map<string, string>(),
      scopedOpenIdentityMap: new Map<string, string>(),
      ambiguousScopedExternalIdentityKeys: new Set<string>(),
      ambiguousScopedUnionIdentityKeys: new Set<string>(),
      ambiguousScopedOpenIdentityKeys: new Set<string>(),
      emailMap: new Map<string, string>(),
      mobileMap: new Map<string, string>(),
      ambiguousEmailKeys: new Set<string>(),
      ambiguousMobileKeys: new Set<string>(),
    }
  }

  it('u1: stays held when an external identity now matches the account', () => {
    const maps = emptyMaps()
    maps.scopedUnionIdentityMap.set(scopedUnionKey, 'user-via-identity')
    expect(resolveDirectoryIdentityMatch(account, held, maps)).toEqual({ matched: 'admin_unbound' })
  })

  it('u2: stays held when a unique email or mobile matches the account', () => {
    const emailMaps = emptyMaps()
    emailMaps.emailMap.set('held@example.test', 'user-via-email')
    expect(resolveDirectoryIdentityMatch(account, held, emailMaps)).toEqual({ matched: 'admin_unbound' })

    const mobileMaps = emptyMaps()
    mobileMaps.mobileMap.set('13800000000', 'user-via-mobile')
    expect(resolveDirectoryIdentityMatch(account, held, mobileMaps)).toEqual({ matched: 'admin_unbound' })
  })

  it('u3: stays held even under an ambiguous external identity (hold precedes the ambiguity check)', () => {
    const maps = emptyMaps()
    maps.ambiguousScopedUnionIdentityKeys.add(scopedUnionKey)
    expect(resolveDirectoryIdentityMatch(account, held, maps)).toEqual({ matched: 'admin_unbound' })
  })

  it('u4: a linked row is not held even if its strategy text reads manual_unbound', () => {
    expect(resolveDirectoryIdentityMatch(
      account,
      { local_user_id: 'user-linked', link_status: 'linked', match_strategy: 'manual_unbound' },
      emptyMaps(),
    )).toEqual({ matched: 'already_linked' })
  })

  it('u5: an ordinary unmatched row still takes a unique email match', () => {
    const maps = emptyMaps()
    maps.emailMap.set('held@example.test', 'user-via-email')
    expect(resolveDirectoryIdentityMatch(
      account,
      { local_user_id: null, link_status: 'unmatched', match_strategy: 'none' },
      maps,
    )).toEqual({ matched: 'email', localUserId: 'user-via-email' })
  })

  it('u6: a reviewer on a pending hint row is not treated as an unbind', () => {
    const maps = emptyMaps()
    maps.emailMap.set('held@example.test', 'user-via-email')
    const reviewedHint = {
      local_user_id: 'user-via-email',
      link_status: 'pending',
      match_strategy: 'email',
      reviewed_by: 'admin-1',
    }
    expect(resolveDirectoryIdentityMatch(account, reviewedHint, maps))
      .toEqual({ matched: 'email', localUserId: 'user-via-email' })
  })

  it('a missing link row and a NULL strategy both walk the ordinary cascade', () => {
    const maps = emptyMaps()
    maps.emailMap.set('held@example.test', 'user-via-email')
    expect(resolveDirectoryIdentityMatch(account, null, maps))
      .toEqual({ matched: 'email', localUserId: 'user-via-email' })
    expect(resolveDirectoryIdentityMatch(
      account,
      { local_user_id: null, link_status: 'unmatched', match_strategy: null },
      maps,
    )).toEqual({ matched: 'email', localUserId: 'user-via-email' })
  })
})

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
