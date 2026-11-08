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
import { observeDingTalkTransportRetries } from '../../src/integrations/dingtalk/transport'
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
