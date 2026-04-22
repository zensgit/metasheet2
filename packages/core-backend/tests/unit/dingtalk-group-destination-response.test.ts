import { describe, expect, it } from 'vitest'
import { toDingTalkGroupDestinationResponse } from '../../src/multitable/dingtalk-group-destination-response'
import type { DingTalkGroupDestination } from '../../src/multitable/dingtalk-group-destinations'

function destination(overrides: Partial<DingTalkGroupDestination> = {}): DingTalkGroupDestination {
  return {
    id: 'dt_1',
    name: 'Ops DingTalk Group',
    webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=secret-token&timestamp=123&sign=abc',
    secret: 'SECsecret',
    enabled: true,
    sheetId: 'sheet_1',
    createdBy: 'user_1',
    createdAt: '2026-04-22T00:00:00.000Z',
    ...overrides,
  }
}

describe('toDingTalkGroupDestinationResponse', () => {
  it('masks webhook credentials and omits the saved robot secret', () => {
    const response = toDingTalkGroupDestinationResponse(destination())

    expect(response.webhookUrl).toContain('access_token=***')
    expect(response.webhookUrl).toContain('timestamp=***')
    expect(response.webhookUrl).toContain('sign=***')
    expect(response.webhookUrl).not.toContain('secret-token')
    expect(response.hasSecret).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(response, 'secret')).toBe(false)
  })

  it('reports hasSecret=false when no SEC secret is saved', () => {
    const response = toDingTalkGroupDestinationResponse(destination({ secret: undefined }))

    expect(response.hasSecret).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(response, 'secret')).toBe(false)
  })
})
