import { describe, expect, it } from 'vitest'

import { listDingTalkPublicFormLinkWarnings } from '../src/multitable/utils/dingtalkPublicFormLinkWarnings'

const nowMs = Date.parse('2026-04-21T00:00:00.000Z')

const views = [
  { id: 'view_grid', name: 'Grid', type: 'grid' },
  {
    id: 'view_form_enabled',
    name: 'Enabled Form',
    type: 'form',
    config: { publicForm: { enabled: true, publicToken: 'pub_enabled', expiresAt: '2026-04-22T00:00:00.000Z' } },
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
})
