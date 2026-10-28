import { describe, expect, it } from 'vitest'
import {
  APPROVAL_REMIND_NOTIFICATION_RECORD_ID,
  APPROVAL_REMIND_NOTIFICATION_SHEET_ID,
  approvalDetailPath,
  buildApprovalRemindNotificationMessage,
} from '../../src/services/approval-remind-notification'

describe('催办站内通知正文', () => {
  it('第一行带「催办」、催办人、标题和编号，第二行是审批详情路径', () => {
    const message = buildApprovalRemindNotificationMessage({
      instanceId: 'apv_001',
      title: '请假申请',
      requestNo: 'AP-001',
      actorName: '张三',
    })
    const [line1, line2, ...rest] = message.split('\n')
    expect(rest).toEqual([])
    expect(line1).toBe('【催办】张三 提醒你处理审批「请假申请」（编号 AP-001）')
    expect(line2).toBe('/approvals/apv_001')
  })

  it('没有编号时不写编号；没有标题、没有姓名时用兜底词', () => {
    const message = buildApprovalRemindNotificationMessage({
      instanceId: 'apv_002',
      title: '  ',
      requestNo: null,
      actorName: null,
    })
    expect(message.split('\n')[0]).toBe('【催办】有人 提醒你处理审批「（无标题）」')
  })

  it('标题里的换行折成空格，正文始终只有两行', () => {
    const message = buildApprovalRemindNotificationMessage({
      instanceId: 'apv_003',
      title: '第一行\n第二行',
      requestNo: 'AP-003',
      actorName: '李四\n',
    })
    expect(message.split('\n')).toHaveLength(2)
    expect(message.split('\n')[0]).toBe('【催办】李四 提醒你处理审批「第一行 第二行」（编号 AP-003）')
  })

  it('过长的标题截断', () => {
    const message = buildApprovalRemindNotificationMessage({
      instanceId: 'apv_004',
      title: '长'.repeat(200),
      requestNo: null,
      actorName: '王五',
    })
    const line1 = message.split('\n')[0]
    expect(line1).toContain(`「${'长'.repeat(120)}…」`)
  })

  it('路径对 id 做编码，与前端路由 /approvals/:id 一致', () => {
    expect(approvalDetailPath('plm:eco/1')).toBe('/approvals/plm%3Aeco%2F1')
  })

  it('通知行不挂任何表或记录', () => {
    expect(APPROVAL_REMIND_NOTIFICATION_SHEET_ID).toBe('')
    expect(APPROVAL_REMIND_NOTIFICATION_RECORD_ID).toBe('')
  })
})
