import { describe, expect, it, vi } from 'vitest'
import { listAutomationDingTalkGroupDeliveries } from '../../src/multitable/dingtalk-group-delivery-service'

describe('dingtalk group delivery service', () => {
  it('lists and maps automation-scoped deliveries', async () => {
    const queryFn = vi.fn(async () => ({
      rows: [
        {
          id: 'dgd_1',
          destination_id: 'group_1',
          destination_name: 'Ops Group',
          source_type: 'automation',
          subject: 'Ticket rec_1 ready',
          content: 'Please review the latest changes.',
          success: true,
          http_status: 200,
          response_body: '{"errcode":0}',
          error_message: null,
          automation_rule_id: 'rule_1',
          record_id: 'rec_1',
          initiated_by: 'user_2',
          created_at: '2026-04-20T08:00:00.000Z',
          delivered_at: '2026-04-20T08:00:01.000Z',
        },
      ],
    }))

    const deliveries = await listAutomationDingTalkGroupDeliveries(queryFn, 'rule_1', 500)

    expect(queryFn).toHaveBeenCalledWith(expect.stringContaining('FROM dingtalk_group_deliveries d'), ['rule_1', 200])
    expect(String(queryFn.mock.calls[0]?.[0] ?? '')).not.toContain('d.record_id =')
    expect(deliveries).toEqual([
      {
        id: 'dgd_1',
        destinationId: 'group_1',
        destinationName: 'Ops Group',
        sourceType: 'automation',
        subject: 'Ticket rec_1 ready',
        content: 'Please review the latest changes.',
        success: true,
        httpStatus: 200,
        responseBody: '{"errcode":0}',
        errorMessage: undefined,
        automationRuleId: 'rule_1',
        recordId: 'rec_1',
        initiatedBy: 'user_2',
        createdAt: '2026-04-20T08:00:00.000Z',
        deliveredAt: '2026-04-20T08:00:01.000Z',
      },
    ])
  })

  it('filters automation-scoped deliveries by record id when provided', async () => {
    const queryFn = vi.fn(async () => ({ rows: [] }))

    await listAutomationDingTalkGroupDeliveries(queryFn, 'rule_1', 25, ' rec_42 ')

    expect(queryFn).toHaveBeenCalledWith(
      expect.stringContaining('AND d.record_id = $2'),
      ['rule_1', 'rec_42', 25],
    )
    expect(String(queryFn.mock.calls[0]?.[0] ?? '')).toContain('LIMIT $3')
  })
})
