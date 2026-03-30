import { describe, expect, it } from 'vitest'

import { readDingTalkPermissionErrorDetails, readErrorMessage } from '../../src/utils/error'

describe('readErrorMessage', () => {
  it('prefers DingTalk errmsg payloads', () => {
    expect(readErrorMessage({
      errmsg: '应用尚未开通所需的权限',
      sub_msg: 'qyapi_get_department_list',
    }, 'fallback')).toBe('应用尚未开通所需的权限')
  })

  it('falls back to DingTalk sub_msg when errmsg is absent', () => {
    expect(readErrorMessage({
      sub_msg: '缺少 qyapi_get_department_member 权限',
    }, 'fallback')).toBe('缺少 qyapi_get_department_member 权限')
  })

  it('keeps legacy message extraction behavior', () => {
    expect(readErrorMessage({
      error: {
        message: 'legacy nested error',
      },
    }, 'fallback')).toBe('legacy nested error')
  })

  it('extracts DingTalk missing-scope remediation details from live-style errors', () => {
    expect(readDingTalkPermissionErrorDetails({
      errmsg: 'ding talk error[subcode=60011,submsg=应用尚未开通所需的权限：[qyapi_get_department_list]，点击链接申请并开通即可：https://open-dev.dingtalk.com/appscope/apply?content=ding33bpfsmhnrdt0clu%23qyapi_get_department_list, {requiredScopes=[qyapi_get_department_list]}]',
    })).toEqual({
      provider: 'dingtalk',
      message: 'ding talk error[subcode=60011,submsg=应用尚未开通所需的权限：[qyapi_get_department_list]，点击链接申请并开通即可：https://open-dev.dingtalk.com/appscope/apply?content=ding33bpfsmhnrdt0clu%23qyapi_get_department_list, {requiredScopes=[qyapi_get_department_list]}]',
      subcode: '60011',
      requiredScopes: ['qyapi_get_department_list'],
      applyUrl: 'https://open-dev.dingtalk.com/appscope/apply?content=ding33bpfsmhnrdt0clu%23qyapi_get_department_list',
    })
  })
})
