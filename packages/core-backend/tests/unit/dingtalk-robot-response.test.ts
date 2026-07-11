import { describe, expect, it } from 'vitest'
import {
  DingTalkRobotResponseError,
  validateDingTalkRobotResponse,
} from '../../src/integrations/dingtalk/robot'

describe('validateDingTalkRobotResponse', () => {
  it('accepts a genuine success body (numeric errcode 0)', () => {
    expect(() => validateDingTalkRobotResponse({ errcode: 0, errmsg: 'ok' })).not.toThrow()
  })

  it('accepts a success body with no errmsg', () => {
    expect(() => validateDingTalkRobotResponse({ errcode: 0 })).not.toThrow()
  })

  it('rejects a non-zero numeric errcode', () => {
    expect(() => validateDingTalkRobotResponse({ errcode: 310000, errmsg: 'keyword not in content' }))
      .toThrow(DingTalkRobotResponseError)
    expect(() => validateDingTalkRobotResponse({ errcode: 310000, errmsg: 'keyword not in content' }))
      .toThrow(/310000/)
  })

  it('rejects null (e.g. a 200 HTML page from a hijacking proxy that failed JSON parsing)', () => {
    expect(() => validateDingTalkRobotResponse(null)).toThrow(DingTalkRobotResponseError)
  })

  it('rejects undefined', () => {
    expect(() => validateDingTalkRobotResponse(undefined)).toThrow(DingTalkRobotResponseError)
  })

  it('rejects a raw string body (unparsed HTML/text, not a JSON object)', () => {
    expect(() => validateDingTalkRobotResponse('<html><body>captive portal</body></html>')).toThrow(DingTalkRobotResponseError)
  })

  it('rejects a JSON array body', () => {
    expect(() => validateDingTalkRobotResponse([])).toThrow(DingTalkRobotResponseError)
  })

  it('rejects a body with a string errcode instead of a number', () => {
    expect(() => validateDingTalkRobotResponse({ errcode: '0', errmsg: 'ok' })).toThrow(DingTalkRobotResponseError)
  })

  it('rejects a body with no errcode field at all', () => {
    expect(() => validateDingTalkRobotResponse({ errmsg: 'ok' })).toThrow(DingTalkRobotResponseError)
  })

  it('rejects an empty object body', () => {
    expect(() => validateDingTalkRobotResponse({})).toThrow(DingTalkRobotResponseError)
  })
})
