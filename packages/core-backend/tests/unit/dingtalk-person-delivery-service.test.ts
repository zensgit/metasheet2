import { describe, expect, it, vi } from 'vitest'
import { listAutomationDingTalkPersonDeliveries, parseDingTalkPersonDeliveryStatusFilter } from '../../src/multitable/dingtalk-person-delivery-service'

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
          local_user_exists: true,
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
          local_user_exists: true,
        },
      ],
    }))

    const deliveries = await listAutomationDingTalkPersonDeliveries(queryFn, 'rule_1', 500)

    expect(queryFn).toHaveBeenCalledWith(expect.stringContaining('FROM dingtalk_person_deliveries d'), ['rule_1', 200])
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
        localUserExists: true,
        localUserIsActive: true,
        localUserDingTalkLinked: false,
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
        localUserExists: true,
        localUserIsActive: true,
        localUserDingTalkLinked: false,
      },
    ])
  })

  it("passes 'outcome_unknown' through UNFOLDED (PR #4046 Phase B) while unknown junk still folds by success", async () => {
    const base = {
      local_user_id: 'user_1',
      dingtalk_user_id: 'dt_1',
      source_type: 'automation',
      subject: 'S',
      content: 'C',
      http_status: null,
      response_body: null,
      error_message: 'dingtalk_send_outcome_unknown: fetch failed',
      automation_rule_id: 'rule_1',
      record_id: 'rec_1',
      initiated_by: 'user_2',
      created_at: '2026-07-10T12:00:00.000Z',
      delivered_at: null,
      local_user_name: 'Lin Lan',
      local_user_email: null,
      local_user_is_active: true,
    }
    const queryFn = vi.fn(async () => ({
      rows: [
        { ...base, id: 'dpd_ou', success: false, status: 'outcome_unknown' },
        // legacy/garbage status still folds by the success boolean (unchanged behavior)
        { ...base, id: 'dpd_junk', success: false, status: 'totally_bogus', error_message: 'x' },
      ],
    }))
    const deliveries = await listAutomationDingTalkPersonDeliveries(queryFn, 'rule_1')
    // Folding outcome_unknown into 'failed' would erase the reconciliation signal the
    // distinct state exists for — the API surface must carry it verbatim.
    expect(deliveries.map((d) => ({ id: d.id, status: d.status }))).toEqual([
      { id: 'dpd_ou', status: 'outcome_unknown' },
      { id: 'dpd_junk', status: 'failed' },
    ])
  })

  // 客户反馈 2026-10-21 item 1 (review round 2): a row whose id has no user is "not found", not "inactive".
  it('reports whether the user exists; active is null (unknown) for an id with no user', async () => {
    const row = {
      id: 'dpd_missing',
      local_user_id: 'user_fake_typo',
      dingtalk_user_id: null,
      source_type: 'automation',
      subject: 'S',
      content: 'C',
      success: false,
      status: 'skipped',
      http_status: null,
      response_body: null,
      error_message: 'DingTalk account is not linked or user is inactive',
      automation_rule_id: 'rule_1',
      record_id: 'rec_1',
      initiated_by: 'user_2',
      created_at: '2026-10-21T10:00:00.000Z',
      delivered_at: null,
      local_user_name: null,
      local_user_email: null,
      local_user_is_active: null,
      local_user_exists: false,
    }
    const queryFn = vi.fn(async () => ({ rows: [row, { ...row, id: 'dpd_inactive', local_user_id: 'user_fake_off', local_user_is_active: false, local_user_exists: true }] }))
    const [missing, inactive] = await listAutomationDingTalkPersonDeliveries(queryFn, 'rule_1')
    expect(missing).toMatchObject({ localUserExists: false, localUserIsActive: null, localUserDingTalkLinked: null })
    expect(inactive).toMatchObject({ localUserExists: true, localUserIsActive: false, localUserDingTalkLinked: false })
    expect(queryFn.mock.calls[0][0]).toContain('(u.id IS NOT NULL) AS local_user_exists')
  })

  // Codex review P2: the user's CURRENT DingTalk link (same conditions as the sender), reported as a current fact.
  it('reports the current DingTalk link with the sender link conditions; null for a missing user', async () => {
    const row = {
      id: 'dpd_relinked', local_user_id: 'user_fake_back', dingtalk_user_id: null, source_type: 'automation', subject: 'S', content: 'C',
      success: false, status: 'skipped', http_status: null, response_body: null,
      error_message: 'DingTalk account is not linked or user is inactive', automation_rule_id: 'rule_1', record_id: 'rec_1',
      initiated_by: 'user_2', created_at: '2026-10-21T10:00:00.000Z', delivered_at: null, local_user_name: 'Fake Back',
      local_user_email: null, local_user_is_active: true, local_user_exists: true, local_user_dingtalk_linked: true,
    }
    const queryFn = vi.fn(async () => ({ rows: [row, { ...row, id: 'dpd_gone', local_user_exists: false, local_user_is_active: null, local_user_dingtalk_linked: false }] }))
    const [relinked, gone] = await listAutomationDingTalkPersonDeliveries(queryFn, 'rule_1')
    expect(relinked).toMatchObject({ localUserExists: true, localUserIsActive: true, localUserDingTalkLinked: true })
    expect(gone).toMatchObject({ localUserExists: false, localUserIsActive: null, localUserDingTalkLinked: null })
    const sql = queryFn.mock.calls[0][0] as unknown as string
    for (const condition of ["l.link_status = 'linked'", "a.provider = 'dingtalk'", 'a.is_active = TRUE', 'AS local_user_dingtalk_linked']) {
      expect(sql).toContain(condition)
    }
  })

  it('filters by status in SQL, before the LIMIT, with a bound parameter; no filter keeps the old query shape', async () => {
    const queryFn = vi.fn(async () => ({ rows: [] }))
    await listAutomationDingTalkPersonDeliveries(queryFn, 'rule_1', 50, { status: 'skipped' })
    const [sql, params] = queryFn.mock.calls[0] as unknown as [string, unknown[]]
    expect(params).toEqual(['rule_1', 50, 'skipped'])
    expect(sql).toMatch(/END\) = \$3\s+ORDER BY d\.created_at DESC\s+LIMIT \$2/)
    expect(sql).not.toContain("'skipped' AS")

    queryFn.mockClear()
    await listAutomationDingTalkPersonDeliveries(queryFn, 'rule_1', 50)
    const [plainSql, plainParams] = queryFn.mock.calls[0] as unknown as [string, unknown[]]
    expect(plainParams).toEqual(['rule_1', 50])
    expect(plainSql).not.toContain('$3')

    // an unknown value never reaches SQL
    queryFn.mockClear()
    await listAutomationDingTalkPersonDeliveries(queryFn, 'rule_1', 50, { status: "skipped' OR 1=1 --" as never })
    expect((queryFn.mock.calls[0] as unknown as [string, unknown[]])[1]).toEqual(['rule_1', 50])
  })

  it('parses the status filter from the fixed value set only', () => {
    expect(parseDingTalkPersonDeliveryStatusFilter(undefined)).toBeUndefined()
    expect(parseDingTalkPersonDeliveryStatusFilter('')).toBeUndefined()
    for (const value of ['success', 'failed', 'skipped', 'outcome_unknown']) expect(parseDingTalkPersonDeliveryStatusFilter(value)).toBe(value)
    for (const value of ['SKIPPED', 'pending', ['skipped'], 1]) expect(parseDingTalkPersonDeliveryStatusFilter(value)).toBeNull()
  })
})
