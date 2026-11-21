import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NOTIFICATION_EN,
  NOTIFICATION_REASON_KEYS,
  NOTIFICATION_ZH,
  notificationProviderName,
  notificationReason,
} from '../src/notifications/labels'

const CJK = /[　-〿一-鿿＀-￯]/
const forbiddenDeliveryClaim = ['已', '送', '达'].join('')

describe('notification label tables', () => {
  it('has exactly the same keys in ZH and EN', () => {
    expect(Object.keys(NOTIFICATION_EN).sort()).toEqual(Object.keys(NOTIFICATION_ZH).sort())
  })

  it('uses non-empty copy in the corresponding language', () => {
    expect(Object.entries(NOTIFICATION_ZH).filter(([, value]) => value.length === 0 || !CJK.test(value))).toEqual([])
    expect(Object.entries(NOTIFICATION_EN).filter(([, value]) => value.length === 0 || CJK.test(value))).toEqual([])
  })

  it('maps every reason key to an existing label in both languages', () => {
    for (const key of Object.values(NOTIFICATION_REASON_KEYS)) {
      expect(NOTIFICATION_ZH[key].length).toBeGreaterThan(0)
      expect(NOTIFICATION_EN[key].length).toBeGreaterThan(0)
    }
    expect(notificationReason('address_kind_not_derivable', NOTIFICATION_ZH)).toBe('钉钉自助绑定的身份暂不能用于工作通知')
    expect(notificationReason('address_bound_on_other_connection', NOTIFICATION_ZH)).toBe('该账号已在另一连接上启用')
    expect(notificationReason('not_a_contract_code', NOTIFICATION_ZH)).toBe(NOTIFICATION_ZH.reasonUnknown)
    expect(notificationProviderName('dingtalk', NOTIFICATION_ZH)).toBe('钉钉')
  })

  it('never makes a delivery-completion claim in product copy or view source', () => {
    expect(JSON.stringify(NOTIFICATION_ZH)).not.toContain(forbiddenDeliveryClaim)
    expect(JSON.stringify(NOTIFICATION_EN)).not.toContain(forbiddenDeliveryClaim)
    const view = readFileSync(resolve('src/views/NotificationPreferencesView.vue'), 'utf8')
    const api = readFileSync(resolve('src/notifications/notificationApi.ts'), 'utf8')
    expect(view).not.toContain(forbiddenDeliveryClaim)
    expect(api).not.toContain(forbiddenDeliveryClaim)
  })
})
