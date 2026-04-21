import { describe, expect, it, vi } from 'vitest'

import {
  collectDingTalkAutomationLinkIds,
  normalizeDingTalkAutomationActionInputs,
  validateDingTalkAutomationActionConfigs,
  validateDingTalkAutomationLinks,
  type AutomationLinkQueryFn,
} from '../../src/multitable/dingtalk-automation-link-validation'

const nowMs = Date.parse('2026-04-21T00:00:00.000Z')

function queryWithRows(rowsByCall: unknown[][]): AutomationLinkQueryFn {
  const query = vi.fn(async () => ({ rows: rowsByCall.shift() ?? [] }))
  return query as unknown as AutomationLinkQueryFn
}

describe('dingtalk automation link validation', () => {
  it('normalizes legacy DingTalk title and content fields before persistence', () => {
    const normalized = normalizeDingTalkAutomationActionInputs(
      'send_dingtalk_group_message',
      { destinationId: 'group_1', title: 'Please fill', content: 'Open form' },
      [
        {
          type: 'send_dingtalk_person_message',
          config: { userIds: ['user_1'], title: 'Person title', content: 'Person body' },
        },
      ],
    )

    expect(normalized.actionConfig).toMatchObject({
      titleTemplate: 'Please fill',
      bodyTemplate: 'Open form',
    })
    expect(normalized.actions).toEqual([
      {
        type: 'send_dingtalk_person_message',
        config: {
          userIds: ['user_1'],
          title: 'Person title',
          content: 'Person body',
          titleTemplate: 'Person title',
          bodyTemplate: 'Person body',
        },
      },
    ])
  })

  it('rejects DingTalk group actions without an effective destination source', () => {
    expect(validateDingTalkAutomationActionConfigs(
      'send_dingtalk_group_message',
      {
        destinationIds: [],
        destinationIdFieldPath: 'record., ,',
        titleTemplate: 'Please fill',
        bodyTemplate: 'Open form',
      },
      null,
    )).toBe('At least one DingTalk destination or record destination field path is required')
  })

  it('rejects DingTalk person actions without an effective recipient source', () => {
    expect(validateDingTalkAutomationActionConfigs(
      'send_dingtalk_person_message',
      {
        userIds: [','],
        memberGroupIds: [],
        userIdFieldPaths: ['record.'],
        memberGroupIdFieldPath: ',',
        titleTemplate: 'Please fill',
        bodyTemplate: 'Open form',
      },
      null,
    )).toBe('At least one local userId, memberGroupId, record recipient field path, or member group record field path is required')
  })

  it('rejects DingTalk actions without executable template fields', () => {
    expect(validateDingTalkAutomationActionConfigs(
      'notify',
      {},
      [
        {
          type: 'send_dingtalk_person_message',
          config: { userIds: ['user_1'], titleTemplate: ' ', bodyTemplate: 'Open form' },
        },
      ],
    )).toBe('DingTalk titleTemplate is required')
  })

  it('collects public form and internal view ids from legacy and multi-action configs', () => {
    expect(collectDingTalkAutomationLinkIds(
      'send_dingtalk_group_message',
      { publicFormViewId: ' view_form ', internalViewId: 'view_grid' },
      [
        { type: 'send_dingtalk_person_message', config: { publicFormViewId: 'view_person_form', internalViewId: 'view_person_grid' } },
        { type: 'notify', config: { publicFormViewId: 'ignored' } },
      ],
    )).toEqual({
      publicFormViewIds: ['view_form', 'view_person_form'],
      internalViewIds: ['view_grid', 'view_person_grid'],
    })
  })

  it('allows active public form links and internal processing links in the current sheet', async () => {
    const query = queryWithRows([
      [
        {
          id: 'view_form',
          type: 'form',
          config: { publicForm: { enabled: true, publicToken: 'pub_view_form', accessMode: 'public' } },
        },
      ],
      [{ id: 'view_grid' }],
    ])

    await expect(validateDingTalkAutomationLinks(
      query,
      'sheet_1',
      'send_dingtalk_group_message',
      { publicFormViewId: 'view_form', internalViewId: 'view_grid' },
      null,
      nowMs,
    )).resolves.toBeNull()
  })

  it('allows DingTalk-protected public forms with or without allowlists', async () => {
    const query = queryWithRows([
      [
        {
          id: 'view_bound',
          type: 'form',
          config: { publicForm: { enabled: true, publicToken: 'pub_bound', accessMode: 'dingtalk' } },
        },
        {
          id: 'view_granted',
          type: 'form',
          config: { publicForm: { enabled: true, publicToken: 'pub_granted', accessMode: 'dingtalk_granted', allowedUserIds: ['user_1'] } },
        },
      ],
    ])

    await expect(validateDingTalkAutomationLinks(
      query,
      'sheet_1',
      'send_dingtalk_group_message',
      {},
      [
        { type: 'send_dingtalk_group_message', config: { publicFormViewId: 'view_bound' } },
        { type: 'send_dingtalk_person_message', config: { publicFormViewId: 'view_granted' } },
      ],
      nowMs,
    )).resolves.toBeNull()
  })

  it('rejects missing public form views', async () => {
    const query = queryWithRows([[]])

    await expect(validateDingTalkAutomationLinks(
      query,
      'sheet_1',
      'send_dingtalk_group_message',
      { publicFormViewId: 'missing_view' },
      null,
      nowMs,
    )).resolves.toBe('Public form view not found: missing_view')
  })

  it('rejects public form links that point to non-form views', async () => {
    const query = queryWithRows([[{ id: 'view_grid', type: 'grid', config: {} }]])

    await expect(validateDingTalkAutomationLinks(
      query,
      'sheet_1',
      'send_dingtalk_group_message',
      { publicFormViewId: 'view_grid' },
      null,
      nowMs,
    )).resolves.toBe('Public form view is not a form view: view_grid')
  })

  it('rejects public form links without active sharing or public tokens', async () => {
    const disabledQuery = queryWithRows([[
      { id: 'view_disabled', type: 'form', config: { publicForm: { enabled: false, publicToken: 'pub_disabled' } } },
    ]])
    await expect(validateDingTalkAutomationLinks(
      disabledQuery,
      'sheet_1',
      'send_dingtalk_group_message',
      { publicFormViewId: 'view_disabled' },
      null,
      nowMs,
    )).resolves.toBe('Selected public form view is not shared: view_disabled')

    const missingTokenQuery = queryWithRows([[
      { id: 'view_missing_token', type: 'form', config: { publicForm: { enabled: true, publicToken: ' ' } } },
    ]])
    await expect(validateDingTalkAutomationLinks(
      missingTokenQuery,
      'sheet_1',
      'send_dingtalk_person_message',
      { publicFormViewId: 'view_missing_token' },
      null,
      nowMs,
    )).resolves.toBe('Selected public form view is not shared: view_missing_token')
  })

  it('rejects expired public form links', async () => {
    const query = queryWithRows([[
      {
        id: 'view_expired',
        type: 'form',
        config: { publicForm: { enabled: true, publicToken: 'pub_expired', expiresAt: '2026-04-20T00:00:00.000Z' } },
      },
    ]])

    await expect(validateDingTalkAutomationLinks(
      query,
      'sheet_1',
      'send_dingtalk_group_message',
      { publicFormViewId: 'view_expired' },
      null,
      nowMs,
    )).resolves.toBe('Selected public form view has expired: view_expired')
  })

  it('rejects missing internal processing views after public form validation passes', async () => {
    const query = queryWithRows([
      [
        {
          id: 'view_form',
          type: 'form',
          config: { publicForm: { enabled: true, publicToken: 'pub_view_form' } },
        },
      ],
      [],
    ])

    await expect(validateDingTalkAutomationLinks(
      query,
      'sheet_1',
      'send_dingtalk_group_message',
      { publicFormViewId: 'view_form', internalViewId: 'missing_internal' },
      null,
      nowMs,
    )).resolves.toBe('Internal processing view not found: missing_internal')
  })
})
