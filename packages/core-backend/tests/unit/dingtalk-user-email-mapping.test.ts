import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getDingTalkUserDetail,
  listDingTalkDepartmentUsers,
  pickDingTalkUserEmail,
} from '../../src/integrations/dingtalk/client'

/**
 * Owner call (2026-10-15): "如果用户的钉钉上有邮箱，应该要把邮箱获取过来，
 * 如果钉钉没有邮箱，可以为空" — take the personal `email`, fall back to the
 * enterprise `org_email` when the personal one is absent/blank, otherwise
 * leave the field unset (never persist an empty string as "the email").
 */
describe('pickDingTalkUserEmail', () => {
  it('uses the personal email when present', () => {
    expect(pickDingTalkUserEmail({ email: 'alice@example.com' })).toBe('alice@example.com')
  })

  it('falls back to org_email when email is an empty string', () => {
    expect(pickDingTalkUserEmail({ email: '', org_email: 'alice@corp.example.com' })).toBe(
      'alice@corp.example.com',
    )
  })

  it('falls back to org_email when email is whitespace-only', () => {
    expect(pickDingTalkUserEmail({ email: '   ', org_email: 'alice@corp.example.com' })).toBe(
      'alice@corp.example.com',
    )
  })

  it('falls back to org_email when email is absent entirely', () => {
    expect(pickDingTalkUserEmail({ org_email: 'alice@corp.example.com' })).toBe(
      'alice@corp.example.com',
    )
  })

  it('prefers email over org_email when both are present', () => {
    expect(
      pickDingTalkUserEmail({ email: 'alice@example.com', org_email: 'alice@corp.example.com' }),
    ).toBe('alice@example.com')
  })

  it('returns undefined when neither field is set', () => {
    expect(pickDingTalkUserEmail({})).toBeUndefined()
  })

  it('returns undefined when both fields are empty/blank', () => {
    expect(pickDingTalkUserEmail({ email: '', org_email: '   ' })).toBeUndefined()
  })

  it('also recognizes the camelCase orgEmail key', () => {
    expect(pickDingTalkUserEmail({ orgEmail: 'alice@corp.example.com' })).toBe(
      'alice@corp.example.com',
    )
  })
})

describe('DingTalk directory member mapping — email fallback wiring', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('getDingTalkUserDetail falls back to org_email when email is blank', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        errcode: 0,
        errmsg: 'ok',
        result: {
          userid: 'u1',
          name: 'Alice',
          email: '',
          org_email: 'alice@corp.example.com',
        },
      }),
    })
    global.fetch = fetchMock as typeof fetch

    const detail = await getDingTalkUserDetail('token-123', 'u1')

    expect(detail.email).toBe('alice@corp.example.com')
  })

  it('getDingTalkUserDetail leaves email unset when neither field is present', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        errcode: 0,
        errmsg: 'ok',
        result: {
          userid: 'u2',
          name: 'Bob',
        },
      }),
    })
    global.fetch = fetchMock as typeof fetch

    const detail = await getDingTalkUserDetail('token-123', 'u2')

    expect(detail.email).toBeUndefined()
  })

  it('listDingTalkDepartmentUsers falls back to org_email when email is blank', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        errcode: 0,
        errmsg: 'ok',
        result: {
          list: [
            {
              userid: 'u1',
              name: 'Alice',
              email: '',
              org_email: 'alice@corp.example.com',
            },
          ],
        },
      }),
    })
    global.fetch = fetchMock as typeof fetch

    const { users } = await listDingTalkDepartmentUsers('token-123', '1', 0, 50)

    expect(users).toHaveLength(1)
    expect(users[0]?.email).toBe('alice@corp.example.com')
  })
})
