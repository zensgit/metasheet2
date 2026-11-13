import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The DingTalk adapter: declared capabilities, the retry observer is the transport's own,
 * members carry no provider status, and the member pull writes its call counts to the telemetry
 * object it is given.
 */
const clientMocks = vi.hoisted(() => ({
  fetchDingTalkAppAccessToken: vi.fn(),
  listDingTalkDepartments: vi.fn(),
  getDingTalkDepartmentDetail: vi.fn(),
  listDingTalkDepartmentUsers: vi.fn(),
  getDingTalkUserDetail: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({ query: vi.fn(), transaction: vi.fn() }))
vi.mock('../../src/integrations/dingtalk/client', () => ({ ...clientMocks }))

import { Logger } from '../../src/core/logger'
import {
  DINGTALK_DIRECTORY_ADAPTER_CAPABILITIES,
  dingtalkDirectoryAdapter,
} from '../../src/directory/adapters/dingtalk-directory-adapter'
import { createDirectorySyncApiCallCounters } from '../../src/directory/directory-sync-api-telemetry'
import { DingTalkBusinessError, observeDingTalkTransportRetries } from '../../src/integrations/dingtalk/transport'
import { armGoldenClient } from '../fixtures/directory/dingtalk-golden-tenant'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const config: any = { appKey: 'a0g-appkey-a', appSecret: 'a0g-secret', rootDepartmentId: '1', pageSize: 50, baseUrl: undefined }

describe('DingTalk directory adapter', () => {
  let warnSpy: { mockRestore: () => void }

  beforeEach(() => {
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    armGoldenClient(clientMocks, 'a')
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('declares its provider and capabilities', () => {
    expect(dingtalkDirectoryAdapter.provider).toBe('dingtalk')
    expect(dingtalkDirectoryAdapter.capabilities).toBe(DINGTALK_DIRECTORY_ADAPTER_CAPABILITIES)
    expect(DINGTALK_DIRECTORY_ADAPTER_CAPABILITIES).toEqual({
      contactFields: { email: 'available', mobile: 'available' },
      memberOpenId: 'login_backfill_only',
      memberUnionId: 'available',
      managerIds: true,
      primaryDepartmentSignal: true,
      diagnostics: true,
    })
    expect(typeof dingtalkDirectoryAdapter.sampleDiagnostics).toBe('function')
    expect(typeof dingtalkDirectoryAdapter.probeConnection).toBe('function')
  })

  it('observes retries with the transport observer itself', () => {
    expect(dingtalkDirectoryAdapter.observeRetries).toBe(observeDingTalkTransportRetries)
  })

  describe('connection probe: one ordinary member-detail read', () => {
    const SAMPLED_SCOPE_NOTE = '本次只验证了已抽样的接口，未验证全员可见范围、所有成员详情或扫码登录。'
    const UNVERIFIED_WARNING = '没有普通可见成员样本，成员详情权限未验证；不能据此确认目录同步或扫码登录可用。'
    const page = (userIds: string[]) => ({
      users: userIds.map((userId) => ({ userId, name: userId, departmentIds: ['1'], source: {} })),
      nextCursor: null,
      hasMore: false,
    })
    /** Arms the three member-list reads in probe order: first child sample, ordinary root, access-limited root. */
    const armListReads = (child: string[], root: string[], restricted: string[]) => {
      clientMocks.listDingTalkDepartmentUsers.mockReset()
      clientMocks.listDingTalkDepartmentUsers
        .mockResolvedValueOnce(page(child))
        .mockResolvedValueOnce(page(root))
        .mockResolvedValueOnce(page(restricted))
    }

    it('reads exactly one member detail — the first child sample — with the list reads\' config, after them', async () => {
      const infoSpy = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => undefined)
      const result = await dingtalkDirectoryAdapter.probeConnection!(config)
      expect(result.sampledUsers.map((user) => user.userId)).toEqual(['a0g-u1', 'a0g-u2'])
      expect(clientMocks.getDingTalkUserDetail).toHaveBeenCalledTimes(1)
      expect(clientMocks.getDingTalkUserDetail).toHaveBeenCalledWith('a0g-token', 'a0g-u1', { baseUrl: undefined })
      expect(clientMocks.listDingTalkDepartmentUsers).toHaveBeenCalledTimes(3)
      const lastListOrder = Math.max(...clientMocks.listDingTalkDepartmentUsers.mock.invocationCallOrder)
      expect(clientMocks.getDingTalkUserDetail.mock.invocationCallOrder[0]).toBeGreaterThan(lastListOrder)
      expect(result.summary).toEqual({
        code: 'healthy',
        title: '部门、成员列表与一名成员详情抽样读取成功',
        nextAction: SAMPLED_SCOPE_NOTE,
      })
      expect(result.warnings).toEqual([])
      // The detail answer (synthetic email / mobile / union id) never reaches the result or the logs.
      const surfaced = JSON.stringify(result)
        + JSON.stringify(vi.mocked(Logger.prototype.warn).mock.calls)
        + JSON.stringify(infoSpy.mock.calls)
      expect(surfaced).not.toContain('@example.test')
      expect(surfaced).not.toContain('-union')
      expect(Object.keys(result)).toEqual([
        'departmentSampleCount', 'sampledDepartments', 'userSampleCount', 'sampledUsers', 'diagnostics', 'summary', 'warnings',
      ])
      infoSpy.mockRestore()
    })

    it('prefers the first child sample over a different ordinary root sample when both are present', async () => {
      armListReads(['a0g-u1'], ['a0g-u3'], ['a0g-u9'])
      const result = await dingtalkDirectoryAdapter.probeConnection!(config)
      expect(clientMocks.getDingTalkUserDetail).toHaveBeenCalledTimes(1)
      expect(clientMocks.getDingTalkUserDetail).toHaveBeenCalledWith('a0g-token', 'a0g-u1', { baseUrl: undefined })
      expect(clientMocks.getDingTalkUserDetail).not.toHaveBeenCalledWith('a0g-token', 'a0g-u3', expect.anything())
      expect(result.summary.code).toBe('healthy')
    })

    it('falls back to the ordinary root sample when the first child sample is empty — never the access-limited one', async () => {
      armListReads([], ['a0g-u3'], ['a0g-u9', 'a0g-u3'])
      const result = await dingtalkDirectoryAdapter.probeConnection!(config)
      expect(clientMocks.getDingTalkUserDetail).toHaveBeenCalledTimes(1)
      expect(clientMocks.getDingTalkUserDetail).toHaveBeenCalledWith('a0g-token', 'a0g-u3', { baseUrl: undefined })
      expect(result.summary.code).toBe('healthy')
      expect(result.warnings).not.toContain(UNVERIFIED_WARNING)
    })

    it('without any ordinary sample reads no detail, says detail access is unverified, and is not healthy', async () => {
      armListReads([], [], ['a0g-u9'])
      const result = await dingtalkDirectoryAdapter.probeConnection!(config)
      expect(clientMocks.getDingTalkUserDetail).not.toHaveBeenCalled()
      expect(clientMocks.listDingTalkDepartmentUsers).toHaveBeenCalledTimes(3)
      expect(result.summary).toEqual({
        code: 'member_detail_unverified',
        title: '成员详情权限未验证',
        nextAction: `部门与成员列表抽样读取成功，但没有普通可见成员样本可供读取详情，成员详情权限未验证；不能据此确认目录同步或扫码登录可用。${SAMPLED_SCOPE_NOTE}`,
      })
      expect(Object.keys(result.summary)).toEqual(['code', 'title', 'nextAction'])
      expect(result.warnings).toEqual([UNVERIFIED_WARNING])
      // The access-limited sample is still reported as a count, but it is never used as the detail sample.
      expect(result.diagnostics.rootDepartmentDirectUserCountWithAccessLimit).toBe(1)
    })

    it('without any ordinary sample and no child departments keeps the non-passing code and adds the warning', async () => {
      clientMocks.listDingTalkDepartments.mockReset()
      clientMocks.listDingTalkDepartments.mockResolvedValue([])
      armListReads([], [], ['a0g-u9'])
      const result = await dingtalkDirectoryAdapter.probeConnection!(config)
      expect(clientMocks.getDingTalkUserDetail).not.toHaveBeenCalled()
      expect(result.summary.code).toBe('scope_or_root_misconfigured')
      expect(result.warnings).toContain(UNVERIFIED_WARNING)
      expect(result.warnings[result.warnings.length - 1]).toBe(UNVERIFIED_WARNING)
    })

    it('a normal leaf department or small directory is not told to widen the scope to everyone', async () => {
      clientMocks.listDingTalkDepartments.mockReset()
      clientMocks.listDingTalkDepartments.mockResolvedValue([])
      for (const root of [['a0g-u5', 'a0g-u7'], ['a0g-u10']]) {
        armListReads(root, root, root)
        clientMocks.getDingTalkUserDetail.mockClear()
        const result = await dingtalkDirectoryAdapter.probeConnection!(config)
        expect(clientMocks.getDingTalkUserDetail).toHaveBeenCalledTimes(1)
        expect(result.summary.nextAction).toContain(SAMPLED_SCOPE_NOTE)
        const text = [result.summary.title, result.summary.nextAction, ...result.warnings].join('\n')
        expect(text).not.toContain('覆盖全员')
        expect(text).not.toContain('范围正常')
        expect(text).not.toContain('不是受限成员过滤')
      }
    })

    it.each([
      ['a DingTalk business rejection', () => new DingTalkBusinessError('Failed to read DingTalk user detail', { errcode: 60011 })],
      ['a plain error', () => new Error('synthetic member detail failure')],
    ])('rejects the probe with %s from the detail read after successful list reads', async (_label, makeError) => {
      // errcode 60011 is a synthetic, non-flow-control value chosen for this test, not taken from the code.
      const denied = makeError()
      clientMocks.getDingTalkUserDetail.mockRejectedValue(denied)
      await expect(dingtalkDirectoryAdapter.probeConnection!(config)).rejects.toBe(denied)
      expect(clientMocks.listDingTalkDepartmentUsers).toHaveBeenCalledTimes(3)
      expect(clientMocks.getDingTalkUserDetail).toHaveBeenCalledTimes(1)
    })
  })

  it('returns members without a provider status', async () => {
    const departments = await dingtalkDirectoryAdapter.fetchDepartments(config, 'a0g-int-a')
    const members = await dingtalkDirectoryAdapter.fetchMembers(config, departments)
    expect(members.size).toBe(12)
    for (const member of members.values()) expect(member.providerStatus).toBeUndefined()
  })

  it('writes the pull call counts to the telemetry it is given, and runs without telemetry', async () => {
    const apiCalls = createDirectorySyncApiCallCounters()
    const departments = await dingtalkDirectoryAdapter.fetchDepartments(config, 'a0g-int-a', { apiCalls })
    expect(apiCalls).toEqual({ departmentListCalls: 5, departmentDetailCalls: 5, userListPageCalls: 0, userDetailCalls: 0 })
    await dingtalkDirectoryAdapter.fetchMembers(config, departments, { apiCalls })
    expect(apiCalls).toEqual({ departmentListCalls: 5, departmentDetailCalls: 5, userListPageCalls: 6, userDetailCalls: 12 })

    const withoutTelemetry = await dingtalkDirectoryAdapter.fetchMembers(config, departments)
    expect(withoutTelemetry.size).toBe(12)
    expect(apiCalls).toEqual({ departmentListCalls: 5, departmentDetailCalls: 5, userListPageCalls: 6, userDetailCalls: 12 })
  })
})
