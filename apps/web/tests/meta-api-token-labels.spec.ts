import { describe, expect, it } from 'vitest'

import {
  apiDeliveryResultLabel,
  apiDingTalkDeliverySourceLabel,
  apiDingTalkEnabledLabel,
  apiDingTalkScopeLabel,
  apiDingTalkSecretStateLabel,
  apiDingTalkToggleLabel,
  apiManagerTitle,
  apiScopeLabel,
  apiScopesText,
  apiTokenLabel,
  apiToggleLabel,
  apiWebhookEventLabel,
  apiWebhookEventsText,
  apiWebhookStatusLabel,
} from '../src/multitable/utils/meta-api-token-labels'

describe('meta-api-token-labels', () => {
  it('returns static API-token manager labels in en and zh', () => {
    expect(apiTokenLabel('title.full', false)).toBe('API Tokens, Webhooks & DingTalk Groups')
    expect(apiTokenLabel('title.full', true)).toBe('API 令牌、Webhook 与钉钉群')
    expect(apiTokenLabel('dingtalk.empty', true)).toContain('暂无钉钉群目标')
  })

  it('selects the manager title by DingTalk group capability', () => {
    expect(apiManagerTitle(true, false)).toBe('API Tokens, Webhooks & DingTalk Groups')
    expect(apiManagerTitle(false, true)).toBe('API 令牌与 Webhook')
  })

  it('localizes known token scopes and preserves unknown raw scopes', () => {
    expect(apiScopeLabel('read', true)).toBe('读取')
    expect(apiScopeLabel('admin', true)).toBe('管理')
    expect(apiScopeLabel('custom.scope', true)).toBe('custom.scope')
    expect(apiScopesText([], true)).toBe('无')
    expect(apiScopesText(['read', 'custom.scope'], true)).toBe('读取, custom.scope')
  })

  it('localizes known webhook events and preserves unknown raw events', () => {
    expect(apiWebhookEventLabel('record.created', true)).toBe('记录已创建')
    expect(apiWebhookEventLabel('field.changed', true)).toBe('字段已变更')
    expect(apiWebhookEventLabel('custom.event', true)).toBe('custom.event')
    expect(apiWebhookEventsText(['record.deleted', 'custom.event'], true)).toBe('记录已删除, custom.event')
  })

  it('formats webhook status, toggles, and delivery results', () => {
    expect(apiWebhookStatusLabel(true, true)).toBe('有效')
    expect(apiWebhookStatusLabel(false, true)).toBe('已停用')
    expect(apiToggleLabel(true, true)).toBe('停用')
    expect(apiToggleLabel(false, true)).toBe('启用')
    expect(apiDeliveryResultLabel(true, true)).toBe('成功')
    expect(apiDeliveryResultLabel(false, true)).toBe('失败')
  })

  it('formats DingTalk group status and actions', () => {
    expect(apiDingTalkEnabledLabel(true, true)).toBe('已启用')
    expect(apiDingTalkEnabledLabel(false, true)).toBe('已停用')
    expect(apiDingTalkToggleLabel(true, true)).toBe('停用')
    expect(apiDingTalkToggleLabel(false, true)).toBe('启用')
    expect(apiDingTalkSecretStateLabel(true, true)).toBe('已配置')
    expect(apiDingTalkSecretStateLabel(false, true)).toBe('未配置')
  })

  it('formats DingTalk group scope labels with raw ids preserved', () => {
    expect(apiDingTalkScopeLabel('org', { orgId: 'org_1' }, true)).toBe('组织目录群: org_1')
    expect(apiDingTalkScopeLabel('org', {}, true)).toBe('组织目录群')
    expect(apiDingTalkScopeLabel('sheet', { sheetId: 'sheet_1' }, true)).toBe('共享到表: sheet_1')
    expect(apiDingTalkScopeLabel('sheet', {}, true)).toBe('与此表共享')
    expect(apiDingTalkScopeLabel('private', {}, true)).toBe('私有旧版群')
  })

  it('formats DingTalk delivery source labels', () => {
    expect(apiDingTalkDeliverySourceLabel('manual_test', true)).toBe('手动测试')
    expect(apiDingTalkDeliverySourceLabel('automation', true)).toBe('自动化')
    expect(apiDingTalkDeliverySourceLabel('future_source', true)).toBe('future_source')
  })
})
