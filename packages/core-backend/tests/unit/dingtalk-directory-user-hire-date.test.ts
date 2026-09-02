import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  getDingTalkUserDetail,
  normalizeDingTalkHiredDate,
} from '../../src/integrations/dingtalk/client'

describe('DingTalk directory hire date', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('normalizes the documented millisecond field to a canonical calendar date', () => {
    expect(normalizeDingTalkHiredDate(1788134400000)).toBe('2026-08-31')
    expect(normalizeDingTalkHiredDate('1788134400000')).toBe('2026-08-31')
    // 2026-08-31 00:00:00 in Asia/Shanghai is the previous UTC day.
    expect(normalizeDingTalkHiredDate(1788105600000)).toBe('2026-08-31')
  })

  it.each([
    undefined,
    null,
    0,
    1_788_134_400,
    '1788134400',
    'not-a-date',
    Number.POSITIVE_INFINITY,
  ])('leaves missing or non-millisecond values unavailable', (value) => {
    expect(normalizeDingTalkHiredDate(value)).toBeUndefined()
  })

  it('carries hired_date from the user-detail response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        errcode: 0,
        result: {
          userid: 'employee-1',
          name: 'Employee',
          hired_date: 1788105600000,
          dept_id_list: [1],
        },
      }),
    }) as typeof fetch

    await expect(getDingTalkUserDetail('token', 'employee-1')).resolves.toMatchObject({
      userId: 'employee-1',
      hiredDate: '2026-08-31',
    })
  })
})
