import { describe, expect, it } from 'vitest'

import {
  describeDingTalkPublicFormLinkAccess,
  getDingTalkPublicFormLinkAccessLevel,
  getDingTalkPublicFormLinkAccessState,
  listDingTalkPublicFormLinkBlockingErrors,
  listDingTalkPublicFormLinkWarnings,
} from '../src/multitable/utils/dingtalkPublicFormLinkWarnings'

const nowMs = Date.parse('2026-04-21T00:00:00.000Z')

const views = [
  { id: 'view_grid', name: 'Grid', type: 'grid' },
  {
    id: 'view_form_enabled',
    name: 'Enabled Form',
    type: 'form',
    config: { publicForm: { enabled: true, publicToken: 'pub_enabled', expiresAt: '2026-04-22T00:00:00.000Z' } },
  },
  {
    id: 'view_form_protected',
    name: 'Protected Form',
    type: 'form',
    config: {
      publicForm: {
        enabled: true,
        publicToken: 'pub_protected',
        accessMode: 'dingtalk',
        expiresAt: '2026-04-22T00:00:00.000Z',
      },
    },
  },
  {
    id: 'view_form_protected_allowed_user',
    name: 'Protected User Form',
    type: 'form',
    config: {
      publicForm: {
        enabled: true,
        publicToken: 'pub_protected_user',
        accessMode: 'dingtalk',
        allowedUserIds: ['user_1'],
        expiresAt: '2026-04-22T00:00:00.000Z',
      },
    },
  },
  {
    id: 'view_form_granted_allowed_group',
    name: 'Granted Group Form',
    type: 'form',
    config: {
      publicForm: {
        enabled: true,
        publicToken: 'pub_granted_group',
        accessMode: 'dingtalk_granted',
        allowedMemberGroupIds: ['group_1'],
        expiresAt: '2026-04-22T00:00:00.000Z',
      },
    },
  },
  {
    id: 'view_form_granted_without_allowlist',
    name: 'Granted Open Form',
    type: 'form',
    config: {
      publicForm: {
        enabled: true,
        publicToken: 'pub_granted_open',
        accessMode: 'dingtalk_granted',
        expiresAt: '2026-04-22T00:00:00.000Z',
      },
    },
  },
  { id: 'view_form_unconfigured', name: 'Unconfigured Form', type: 'form' },
  {
    id: 'view_form_disabled',
    name: 'Disabled Form',
    type: 'form',
    config: { publicForm: { enabled: false, publicToken: 'pub_disabled' } },
  },
  {
    id: 'view_form_missing_token',
    name: 'Missing Token Form',
    type: 'form',
    config: { publicForm: { enabled: true, publicToken: ' ' } },
  },
  {
    id: 'view_form_expired',
    name: 'Expired Form',
    type: 'form',
    config: { publicForm: { enabled: true, publicToken: 'pub_expired', expiresAt: '2026-04-20T00:00:00.000Z' } },
  },
  {
    id: 'view_form_expires_on',
    name: 'Expires On Form',
    type: 'form',
    config: { publicForm: { enabled: true, publicToken: 'pub_expires_on', expiresOn: '2026-04-20T00:00:00.000Z' } },
  },
]

describe('dingtalk public form link warnings', () => {
  it('returns no warning for empty input or active public form sharing', () => {
    expect(listDingTalkPublicFormLinkWarnings('', views, nowMs)).toEqual([])
    expect(listDingTalkPublicFormLinkWarnings('view_form_enabled', views, nowMs)).toEqual([])
    expect(listDingTalkPublicFormLinkWarnings('view_form_protected', views, nowMs)).toEqual([])
  })

  it('warns when the selected public form view cannot produce a working fill link', () => {
    expect(listDingTalkPublicFormLinkWarnings('missing_view', views, nowMs)).toEqual([
      'Public form view "missing_view" is not available in this sheet; DingTalk messages may not include a working fill link.',
    ])
    expect(listDingTalkPublicFormLinkWarnings('view_grid', views, nowMs)).toEqual([
      'Selected public form view "Grid" is not a form view; choose a form view before sending this DingTalk fill link.',
    ])
    expect(listDingTalkPublicFormLinkWarnings('view_form_unconfigured', views, nowMs)).toEqual([
      'Public form sharing is not configured for "Unconfigured Form"; enable sharing before sending this DingTalk fill link.',
    ])
    expect(listDingTalkPublicFormLinkWarnings('view_form_disabled', views, nowMs)).toEqual([
      'Public form sharing is disabled for "Disabled Form"; enable sharing before sending this DingTalk fill link.',
    ])
    expect(listDingTalkPublicFormLinkWarnings('view_form_missing_token', views, nowMs)).toEqual([
      'Public form sharing for "Missing Token Form" is missing a public token; re-enable sharing before sending this DingTalk fill link.',
    ])
    expect(listDingTalkPublicFormLinkWarnings('view_form_expired', views, nowMs)).toEqual([
      'Public form sharing for "Expired Form" has expired; renew sharing before sending this DingTalk fill link.',
    ])
    expect(listDingTalkPublicFormLinkWarnings('view_form_expires_on', views, nowMs)).toEqual([
      'Public form sharing for "Expires On Form" has expired; renew sharing before sending this DingTalk fill link.',
    ])
  })

  it('warns for fully public form links when group-message access guardrails are enabled', () => {
    expect(listDingTalkPublicFormLinkWarnings('view_form_enabled', views, { nowMs, warnWhenFullyPublic: true })).toEqual([
      'Public form sharing for "Enabled Form" is fully public; everyone who can open the DingTalk message link can submit. Use DingTalk-protected access and an allowlist when only selected users should fill.',
    ])
    expect(listDingTalkPublicFormLinkWarnings('view_form_protected', views, { nowMs, warnWhenFullyPublic: true })).toEqual([])
  })

  it('warns for protected form links without allowlists when group-message access guardrails are enabled', () => {
    expect(listDingTalkPublicFormLinkWarnings('view_form_protected', views, { nowMs, warnWhenProtectedWithoutAllowlist: true })).toEqual([
      'Public form sharing for "Protected Form" allows all bound DingTalk users to submit; add allowed users or member groups when only selected users should fill.',
    ])
    expect(listDingTalkPublicFormLinkWarnings('view_form_granted_without_allowlist', views, { nowMs, warnWhenProtectedWithoutAllowlist: true })).toEqual([
      'Public form sharing for "Granted Open Form" allows all authorized DingTalk users to submit; add allowed users or member groups when only selected users should fill.',
    ])
    expect(listDingTalkPublicFormLinkWarnings('view_form_protected_allowed_user', views, { nowMs, warnWhenProtectedWithoutAllowlist: true })).toEqual([])
    expect(listDingTalkPublicFormLinkWarnings('view_form_granted_allowed_group', views, { nowMs, warnWhenProtectedWithoutAllowlist: true })).toEqual([])
  })

  it('describes selected public form access for DingTalk message summaries', () => {
    expect(describeDingTalkPublicFormLinkAccess('', views, nowMs)).toBe('No public form link')
    expect(describeDingTalkPublicFormLinkAccess('view_form_enabled', views, nowMs)).toBe('Fully public; anyone with the link can submit')
    expect(describeDingTalkPublicFormLinkAccess('view_form_protected', views, nowMs)).toBe('All bound DingTalk users can submit')
    expect(describeDingTalkPublicFormLinkAccess('view_form_protected_allowed_user', views, nowMs)).toBe('DingTalk-bound users in allowlist can submit')
    expect(describeDingTalkPublicFormLinkAccess('view_form_granted_without_allowlist', views, nowMs)).toBe('All authorized DingTalk users can submit')
    expect(describeDingTalkPublicFormLinkAccess('view_form_granted_allowed_group', views, nowMs)).toBe('Authorized DingTalk users in allowlist can submit')
    expect(describeDingTalkPublicFormLinkAccess('view_form_expired', views, nowMs)).toBe('Public form sharing has expired')
    expect(describeDingTalkPublicFormLinkAccess('view_grid', views, nowMs)).toBe('Selected view is not a form')
    expect(describeDingTalkPublicFormLinkAccess('missing_view', views, nowMs)).toBe('View unavailable in this sheet')
  })

  it('returns stable access levels for automation badges', () => {
    expect(getDingTalkPublicFormLinkAccessLevel('', views, nowMs)).toBe('none')
    expect(getDingTalkPublicFormLinkAccessLevel('view_form_enabled', views, nowMs)).toBe('public')
    expect(getDingTalkPublicFormLinkAccessLevel('view_form_protected', views, nowMs)).toBe('dingtalk')
    expect(getDingTalkPublicFormLinkAccessLevel('view_form_protected_allowed_user', views, nowMs)).toBe('dingtalk')
    expect(getDingTalkPublicFormLinkAccessLevel('view_form_granted_without_allowlist', views, nowMs)).toBe('dingtalk_granted')
    expect(getDingTalkPublicFormLinkAccessLevel('view_form_granted_allowed_group', views, nowMs)).toBe('dingtalk_granted')
    expect(getDingTalkPublicFormLinkAccessLevel('missing_view', views, nowMs)).toBe('unavailable')
    expect(getDingTalkPublicFormLinkAccessLevel('view_grid', views, nowMs)).toBe('unavailable')
    expect(getDingTalkPublicFormLinkAccessLevel('view_form_unconfigured', views, nowMs)).toBe('unavailable')
    expect(getDingTalkPublicFormLinkAccessLevel('view_form_disabled', views, nowMs)).toBe('unavailable')
    expect(getDingTalkPublicFormLinkAccessLevel('view_form_missing_token', views, nowMs)).toBe('unavailable')
    expect(getDingTalkPublicFormLinkAccessLevel('view_form_expired', views, nowMs)).toBe('unavailable')
    expect(getDingTalkPublicFormLinkAccessLevel('view_form_expires_on', views, nowMs)).toBe('unavailable')
  })

  it('returns stable access state for automation summaries', () => {
    expect(getDingTalkPublicFormLinkAccessState('   ', views, nowMs)).toEqual({
      hasSelection: false,
      level: 'none',
      summary: 'No public form link',
    })
    expect(getDingTalkPublicFormLinkAccessState('view_form_enabled', views, nowMs)).toEqual({
      hasSelection: true,
      level: 'public',
      summary: 'Fully public; anyone with the link can submit',
    })
    expect(getDingTalkPublicFormLinkAccessState('view_form_protected_allowed_user', views, nowMs)).toEqual({
      hasSelection: true,
      level: 'dingtalk',
      summary: 'DingTalk-bound users in allowlist can submit',
    })
    expect(getDingTalkPublicFormLinkAccessState('view_form_granted_allowed_group', views, nowMs)).toEqual({
      hasSelection: true,
      level: 'dingtalk_granted',
      summary: 'Authorized DingTalk users in allowlist can submit',
    })
    expect(getDingTalkPublicFormLinkAccessState('missing_view', views, nowMs)).toEqual({
      hasSelection: true,
      level: 'unavailable',
      summary: 'View unavailable in this sheet',
    })
  })

  it('separates blocking link errors from advisory access warnings', () => {
    expect(listDingTalkPublicFormLinkBlockingErrors('view_form_disabled', views, nowMs)).toEqual([
      'Public form sharing is disabled for "Disabled Form"; enable sharing before sending this DingTalk fill link.',
    ])
    expect(listDingTalkPublicFormLinkBlockingErrors('view_form_expired', views, nowMs)).toEqual([
      'Public form sharing for "Expired Form" has expired; renew sharing before sending this DingTalk fill link.',
    ])
    expect(listDingTalkPublicFormLinkBlockingErrors('view_form_enabled', views, { nowMs, warnWhenFullyPublic: true })).toEqual([])
    expect(listDingTalkPublicFormLinkBlockingErrors('view_form_protected', views, { nowMs, warnWhenProtectedWithoutAllowlist: true })).toEqual([])
  })
})
