import { describe, expect, it } from 'vitest'
import {
  formShareAccessModeHint,
  formShareAllowlistSummary,
  formShareAudienceRule,
  formShareDingTalkStatusLabel,
  formShareLabel,
  formShareStatusLabel,
} from '../src/multitable/utils/meta-form-share-labels'

describe('meta-form-share-labels', () => {
  it('maps static form-share chrome in English and zh-CN', () => {
    expect(formShareLabel('title', false)).toBe('Public Form Sharing')
    expect(formShareLabel('title', true)).toBe('公开表单分享')
    expect(formShareLabel('access.option.dingtalkGranted', false)).toBe('DingTalk-authorized users only')
    expect(formShareLabel('access.option.dingtalkGranted', true)).toBe('仅已授权钉钉用户')
    expect(formShareLabel('link.regenerate', true)).toBe('重新生成令牌')
    expect(formShareLabel('error.clearBeforePublic', true)).toBe('切换回完全公开表单前，请先清除允许的用户和成员组。')
  })

  it('formats status and access-mode helper text', () => {
    expect(formShareStatusLabel('active', true)).toBe('有效')
    expect(formShareStatusLabel('expired', true)).toBe('已过期')
    expect(formShareStatusLabel('disabled', false)).toBe('Disabled')
    expect(formShareAccessModeHint('public', true)).toBe('持有链接的人都可以打开并提交此表单。')
    expect(formShareAccessModeHint('dingtalk', true)).toContain('钉钉登录')
    expect(formShareAccessModeHint('dingtalk_granted', true)).toContain('钉钉授权')
  })

  it('formats audience rules for all access-mode combinations', () => {
    expect(formShareAudienceRule('public', false, false).title).toBe('Fully public anonymous form')
    expect(formShareAudienceRule('public', false, true).title).toBe('完全公开匿名表单')
    expect(formShareAudienceRule('dingtalk', false, true).title).toBe('全部已绑定钉钉用户')
    expect(formShareAudienceRule('dingtalk', true, true).title).toBe('已选已绑定钉钉用户')
    expect(formShareAudienceRule('dingtalk_granted', false, true).title).toBe('全部授权钉钉用户')
    expect(formShareAudienceRule('dingtalk_granted', true, true).title).toBe('已选授权钉钉用户')
  })

  it('formats allowlist summaries with English plural forks and zh neutral counts', () => {
    expect(formShareAllowlistSummary(0, 0, false)).toBe(
      'No local allowlist limits are set; all users allowed by the selected DingTalk mode can fill this form.',
    )
    expect(formShareAllowlistSummary(1, 2, false)).toBe(
      'Local allowlist limits: 1 local user and 2 local member groups can fill after passing the selected DingTalk mode.',
    )
    expect(formShareAllowlistSummary(2, 1, true)).toBe(
      '本地允许名单限制：2 个本地用户和 1 个本地成员组通过当前钉钉模式后可以填写此表单。',
    )
  })

  it('formats DingTalk status labels without touching public-mode subjects', () => {
    expect(formShareDingTalkStatusLabel({ subjectType: 'member-group' }, 'dingtalk', true)).toBe('成员会逐个校验')
    expect(formShareDingTalkStatusLabel({ subjectType: 'user', dingtalkBound: false }, 'dingtalk', true)).toBe('未绑定钉钉')
    expect(formShareDingTalkStatusLabel({ subjectType: 'user', dingtalkBound: true }, 'dingtalk', true)).toBe('已绑定钉钉')
    expect(formShareDingTalkStatusLabel({ subjectType: 'user', dingtalkBound: true, dingtalkGrantEnabled: true }, 'dingtalk_granted', true)).toBe('已绑定钉钉并已授权')
    expect(formShareDingTalkStatusLabel({ subjectType: 'user', dingtalkBound: true, dingtalkGrantEnabled: false }, 'dingtalk_granted', true)).toBe('未启用钉钉授权')
    expect(formShareDingTalkStatusLabel({ subjectType: 'user', dingtalkPersonDeliveryAvailable: true }, 'dingtalk', true)).toBe('已关联钉钉投递')
    expect(formShareDingTalkStatusLabel({ subjectType: 'user', dingtalkBound: true }, 'public', true)).toBe('')
  })
})
