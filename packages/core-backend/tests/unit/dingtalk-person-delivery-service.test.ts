import { describe, expect, it, vi } from 'vitest'
import { listAutomationDingTalkPersonDeliveries } from '../../src/multitable/dingtalk-person-delivery-service'

describe('dingtalk person delivery service', () => {
  it('lists and maps automation-scoped deliveries', async () => {
    const queryFn = vi.fn(async () => ({
      rows: [
        {
          id: 'dpd_1',
          local_user_id: 'user_1',
          dingtalk_user_id: 'dt_1',
          source_type: 'automation',
          subject: 'Ticket rec_1 ready',
          content: 'Please review the latest changes.',
          success: true,
          status: 'success',
          http_status: 200,
          response_body: '{"errcode":0}',
          error_message: null,
          automation_rule_id: 'rule_1',
          record_id: 'rec_1',
          initiated_by: 'user_2',
          created_at: '2026-04-19T12:00:00.000Z',
          delivered_at: '2026-04-19T12:00:01.000Z',
          local_user_name: 'Lin Lan',
          local_user_email: 'lin@example.com',
          local_user_is_active: true,
        },
        {
          id: 'dpd_2',
          local_user_id: 'user_2',
          dingtalk_user_id: null,
          source_type: 'automation',
          subject: 'Ticket rec_1 ready',
          content: 'Please review the latest changes.',
          success: false,
          status: 'skipped',
          http_status: null,
          response_body: null,
          error_message: 'DingTalk account is not linked or user is inactive',
          automation_rule_id: 'rule_1',
          record_id: 'rec_1',
          initiated_by: 'user_2',
          created_at: '2026-04-19T12:00:02.000Z',
          delivered_at: null,
          local_user_name: 'Unbound User',
          local_user_email: null,
          local_user_is_active: true,
        },
      ],
    }))

    const deliveries = await listAutomationDingTalkPersonDeliveries(queryFn, 'rule_1', 500)

    expect(queryFn).toHaveBeenCalledWith(expect.stringContaining('FROM dingtalk_person_deliveries d'), ['rule_1', 200])
    expect(String(queryFn.mock.calls[0]?.[0] ?? '')).not.toContain('d.record_id =')
    expect(deliveries).toEqual([
      {
        id: 'dpd_1',
        localUserId: 'user_1',
        dingtalkUserId: 'dt_1',
        sourceType: 'automation',
        subject: 'Ticket rec_1 ready',
        content: 'Please review the latest changes.',
        success: true,
        status: 'success',
        httpStatus: 200,
        responseBody: '{"errcode":0}',
        errorMessage: undefined,
        automationRuleId: 'rule_1',
        recordId: 'rec_1',
        initiatedBy: 'user_2',
        createdAt: '2026-04-19T12:00:00.000Z',
        deliveredAt: '2026-04-19T12:00:01.000Z',
        localUserLabel: 'Lin Lan',
        localUserSubtitle: 'lin@example.com',
        localUserIsActive: true,
      },
      {
        id: 'dpd_2',
        localUserId: 'user_2',
        dingtalkUserId: undefined,
        sourceType: 'automation',
        subject: 'Ticket rec_1 ready',
        content: 'Please review the latest changes.',
        success: false,
        status: 'skipped',
        httpStatus: undefined,
        responseBody: undefined,
        errorMessage: 'DingTalk account is not linked or user is inactive',
        automationRuleId: 'rule_1',
        recordId: 'rec_1',
        initiatedBy: 'user_2',
        createdAt: '2026-04-19T12:00:02.000Z',
        deliveredAt: undefined,
        localUserLabel: 'Unbound User',
        localUserSubtitle: undefined,
        localUserIsActive: true,
      },
    ])
  })

  it('filters automation-scoped deliveries by record id when provided', async () => {
    const queryFn = vi.fn(async () => ({ rows: [] }))

    await listAutomationDingTalkPersonDeliveries(queryFn, 'rule_1', 25, ' rec_42 ')

    expect(queryFn).toHaveBeenCalledWith(
      expect.stringContaining('AND d.record_id = $2'),
      ['rule_1', 'rec_42', 25],
    )
    expect(String(queryFn.mock.calls[0]?.[0] ?? '')).toContain('LIMIT $3')
  })
})
