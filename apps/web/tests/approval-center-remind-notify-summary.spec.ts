import { describe, expect, it } from 'vitest'
import { remindSuccessText } from '../src/approvals/remindNotifySummary'

describe('remindSuccessText — 催办成功提示', () => {
  it('老版本服务端不带计数时退回页面原来的文字', () => {
    expect(remindSuccessText({}, '已催办', true)).toBe('已催办')
    expect(remindSuccessText(undefined, '已发送催办提醒', true)).toBe('已发送催办提醒')
    expect(remindSuccessText({ notifiedUserCount: '2' }, '已催办', true)).toBe('已催办')
  })

  it('写了站内通知时说明发给了几个人', () => {
    expect(remindSuccessText({ notifiedUserCount: 2, skippedRoleSeatCount: 0 }, '已催办', true))
      .toBe('已催办，已发站内通知给 2 人')
    expect(remindSuccessText({ notifiedUserCount: 1, skippedRoleSeatCount: 0 }, 'Reminder sent', false))
      .toBe('Reminder sent; 1 person notified in-app')
  })

  it('有角色席位时如实说明这些处理人暂不发通知', () => {
    expect(remindSuccessText({ notifiedUserCount: 0, skippedRoleSeatCount: 1 }, '已催办', true))
      .toBe('已催办（按角色指派的处理人暂不发通知）')
    expect(remindSuccessText({ notifiedUserCount: 3, skippedRoleSeatCount: 2 }, '已催办', true))
      .toBe('已催办，已发站内通知给 3 人（按角色指派的处理人暂不发通知）')
    expect(remindSuccessText({ notifiedUserCount: 0, skippedRoleSeatCount: 1 }, 'Reminder sent', false))
      .toBe('Reminder sent (handlers assigned by role are not notified yet)')
  })
})
