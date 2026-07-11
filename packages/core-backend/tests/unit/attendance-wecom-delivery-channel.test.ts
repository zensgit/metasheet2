/**
 * S4 — WeCom (企业微信) attendance delivery channel (design-lock:
 * attendance-wecom-delivery-channel-s4-design-lock-20260710). Unit-level: query + config + token +
 * send functions are all injected (no real DB / no real WeCom network). Covers recipient resolution,
 * textcard-vs-text wiring, 42001/40014 single-retry, error classification buckets, PII scrub, field
 * clamping, and the env-gate registration (a THIRD, independent channel beside DingTalk/email).
 */
import { describe, it, expect, vi } from 'vitest'
import {
  WeComAttendanceDeliveryChannel,
  WECOM_WORK_NOTIFICATION_CHANNEL_NAME,
  DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME,
  EMAIL_SMTP_CHANNEL_NAME,
  createAttendanceDeliveryChannelsFromEnv,
  resolveAttendanceDefaultDeliveryChannel,
  type AttendanceDeliveryMessage,
} from '../../src/services/AttendanceNotificationDeliveryWorker'
import {
  WeComBusinessError,
  WeComRequestError,
  WECOM_TEXTCARD_DESCRIPTION_MAX_CHARS,
  WECOM_TEXTCARD_TITLE_MAX_CHARS,
  WECOM_TEXT_CONTENT_MAX_BYTES,
  type WeComMessageConfig,
  type WeComSendMessageResult,
} from '../../src/integrations/wecom/client'

const CONFIG: WeComMessageConfig = { corpId: 'corp-1', corpSecret: 'corpsecret-value', agentId: '1000002' }

const MESSAGE: AttendanceDeliveryMessage = {
  id: 'dlv1',
  orgId: 'org1',
  sourceType: 'unscheduled_reminder',
  sourceId: 'src1',
  sourceKey: 'key1',
  recipientUserId: 'u1',
  recipientRole: 'member',
  channel: WECOM_WORK_NOTIFICATION_CHANNEL_NAME,
  payload: { title: 'Punch reminder', body: 'You have an unscheduled shift today.' },
}

function okResult(overrides: Partial<WeComSendMessageResult> = {}): WeComSendMessageResult {
  return { errcode: 0, errmsg: 'ok', invalidUserIds: [], raw: {}, ...overrides }
}

function makeChannel(opts: {
  rows?: Array<{ integration_id: string; external_user_id: string }>
  queryThrows?: boolean
  // H1 hardening (review #3920 P3-1, parity slice): the 0-row cold path now issues a SECOND query
  // (an EXISTS check against directory_integrations) before deciding skip vs retryable. Default true
  // preserves every pre-H1 fixture's behavior (org has an active integration -> stays skip) without
  // needing to touch them; only the new H1 tests below set this to false.
  orgHasActiveIntegration?: boolean
  readConfig?: () => Promise<WeComMessageConfig>
  fetchAccessToken?: () => Promise<string>
  sendTextMessage?: ReturnType<typeof vi.fn>
  sendTextCardMessage?: ReturnType<typeof vi.fn>
}) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (opts.queryThrows) throw new Error('db connection lost')
    if (sql.includes('directory_account_links')) {
      return { rows: opts.rows ?? [{ integration_id: 'integ-1', external_user_id: 'we-user-1' }] }
    }
    // The org-level EXISTS check (only reached from the 0-row recipient path).
    return { rows: [{ org_has_active_integration: opts.orgHasActiveIntegration ?? true }] }
  })
  const sendTextMessage = opts.sendTextMessage ?? vi.fn(async () => okResult())
  const sendTextCardMessage = opts.sendTextCardMessage ?? vi.fn(async () => okResult())
  const channel = new WeComAttendanceDeliveryChannel({
    query: query as never,
    readConfig: opts.readConfig ?? (async () => CONFIG),
    fetchAccessToken: opts.fetchAccessToken ?? (async () => 'access-token'),
    sendTextMessage,
    sendTextCardMessage,
  })
  return { channel, query, sendTextMessage, sendTextCardMessage }
}

describe('WeComAttendanceDeliveryChannel.resolveRecipient (via send) — three-table JOIN, provider=wecom', () => {
  it('0 rows + org HAS an active integration -> skip wecom_recipient_not_bound; provider=wecom scoped in the SQL', async () => {
    // Behavior-unchanged case (H1 hardening — review #3920 P3-1): org-level integration exists, so
    // this really is just "this one user is not onboarded yet".
    const { channel, query, sendTextMessage } = makeChannel({ rows: [], orgHasActiveIntegration: true })
    const result = await channel.send(MESSAGE)
    expect(result).toEqual({ ok: false, retryable: false, skip: true, error: 'wecom_recipient_not_bound' })
    expect(query).toHaveBeenCalledWith(expect.stringContaining("a.provider = 'wecom'"), [MESSAGE.recipientUserId, MESSAGE.orgId])
    expect(query).toHaveBeenCalledWith(expect.stringContaining("i.provider = 'wecom'"), expect.anything())
    expect(sendTextMessage).not.toHaveBeenCalled()
  })

  it('H1 (review #3920 P3-1): 0 rows + org has NO active integration -> retryable failure, NOT skip (org-level recoverable outage)', async () => {
    const { channel, query, sendTextMessage } = makeChannel({ rows: [], orgHasActiveIntegration: false })
    const result = await channel.send(MESSAGE)
    expect(result).toEqual({ ok: false, retryable: true, error: 'wecom_org_integration_inactive' })
    expect(sendTextMessage).not.toHaveBeenCalled()
    // Pin both queries: the recipient JOIN AND the org-level existence check, scoped by
    // provider='wecom' + status='active', parameterized by orgId only.
    expect(query).toHaveBeenCalledWith(expect.stringContaining('directory_account_links'), [MESSAGE.recipientUserId, MESSAGE.orgId])
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/FROM directory_integrations[\s\S]*provider = 'wecom'[\s\S]*status = 'active'/),
      [MESSAGE.orgId],
    )
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('>1 rows -> wecom_recipient_ambiguous, retryable:false, NOT skip (dead-letter, not skip)', async () => {
    const { channel, sendTextMessage } = makeChannel({
      rows: [
        { integration_id: 'integ-1', external_user_id: 'we-user-1' },
        { integration_id: 'integ-2', external_user_id: 'we-user-2' },
      ],
    })
    const result = await channel.send(MESSAGE)
    expect(result).toEqual({ ok: false, retryable: false, error: 'wecom_recipient_ambiguous' })
    expect(sendTextMessage).not.toHaveBeenCalled()
  })

  it('blank external_user_id -> skip wecom_recipient_external_user_id_missing', async () => {
    const { channel, sendTextMessage } = makeChannel({ rows: [{ integration_id: 'integ-1', external_user_id: '   ' }] })
    const result = await channel.send(MESSAGE)
    expect(result).toEqual({ ok: false, retryable: false, skip: true, error: 'wecom_recipient_external_user_id_missing' })
    expect(sendTextMessage).not.toHaveBeenCalled()
  })

  it('query throws -> propagates (worker catches and treats as a retryable send failure)', async () => {
    const { channel } = makeChannel({ queryThrows: true })
    await expect(channel.send(MESSAGE)).rejects.toThrow('db connection lost')
  })
})

describe('WeComAttendanceDeliveryChannel.send — textcard vs text wiring (design-lock G4)', () => {
  const envSnapshot = {
    flag: process.env.ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED,
    publicUrl: process.env.PUBLIC_APP_URL,
    baseUrl: process.env.APP_BASE_URL,
  }
  function restoreEnv() {
    if (envSnapshot.flag === undefined) delete process.env.ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED
    else process.env.ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED = envSnapshot.flag
    if (envSnapshot.publicUrl === undefined) delete process.env.PUBLIC_APP_URL
    else process.env.PUBLIC_APP_URL = envSnapshot.publicUrl
    if (envSnapshot.baseUrl === undefined) delete process.env.APP_BASE_URL
    else process.env.APP_BASE_URL = envSnapshot.baseUrl
  }

  it('deep-link flag+baseUrl present -> textcard with title/description/url/btnTxt="打开考勤"; text NOT called', async () => {
    process.env.ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED = 'true'
    process.env.PUBLIC_APP_URL = 'https://app.example.test'
    delete process.env.APP_BASE_URL
    try {
      const { channel, sendTextMessage, sendTextCardMessage } = makeChannel({})
      const result = await channel.send(MESSAGE)
      expect(result).toEqual({ ok: true })
      expect(sendTextMessage).not.toHaveBeenCalled()
      expect(sendTextCardMessage).toHaveBeenCalledWith(
        'access-token',
        {
          userIds: ['we-user-1'],
          title: 'Punch reminder',
          description: 'You have an unscheduled shift today.',
          url: 'https://app.example.test/attendance?noticeSource=unscheduled_reminder',
          btnTxt: '打开考勤',
        },
        CONFIG,
      )
    } finally {
      restoreEnv()
    }
  })

  it('deep-link flag OFF (default) -> plain text; textcard NOT called', async () => {
    delete process.env.ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED
    process.env.PUBLIC_APP_URL = 'https://app.example.test'
    try {
      const { channel, sendTextMessage, sendTextCardMessage } = makeChannel({})
      const result = await channel.send(MESSAGE)
      expect(result).toEqual({ ok: true })
      expect(sendTextCardMessage).not.toHaveBeenCalled()
      expect(sendTextMessage).toHaveBeenCalledWith(
        'access-token',
        { userIds: ['we-user-1'], content: 'You have an unscheduled shift today.' },
        CONFIG,
      )
    } finally {
      restoreEnv()
    }
  })

  it('deep-link flag ON but no base URL -> falls back to text (byte-identical fallback, same as DingTalk E3)', async () => {
    process.env.ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED = 'true'
    delete process.env.PUBLIC_APP_URL
    delete process.env.APP_BASE_URL
    try {
      const { channel, sendTextMessage, sendTextCardMessage } = makeChannel({})
      await channel.send(MESSAGE)
      expect(sendTextCardMessage).not.toHaveBeenCalled()
      expect(sendTextMessage).toHaveBeenCalledTimes(1)
    } finally {
      restoreEnv()
    }
  })

  it('title/description are clamped to 128/512 chars BEFORE reaching the (stubbed) sender', async () => {
    process.env.ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED = 'true'
    process.env.PUBLIC_APP_URL = 'https://app.example.test'
    try {
      const longTitle = 't'.repeat(WECOM_TEXTCARD_TITLE_MAX_CHARS + 40)
      const longDescription = 'd'.repeat(WECOM_TEXTCARD_DESCRIPTION_MAX_CHARS + 100)
      const message: AttendanceDeliveryMessage = {
        ...MESSAGE,
        payload: { title: longTitle, body: longDescription },
      }
      const { channel, sendTextCardMessage } = makeChannel({})
      await channel.send(message)
      expect(sendTextCardMessage).toHaveBeenCalledTimes(1)
      const input = sendTextCardMessage.mock.calls[0][1] as { title: string; description: string }
      expect(input.title.length).toBe(WECOM_TEXTCARD_TITLE_MAX_CHARS)
      expect(input.description.length).toBe(WECOM_TEXTCARD_DESCRIPTION_MAX_CHARS)
    } finally {
      restoreEnv()
    }
  })

  it('text content is clamped to 2048 BYTES (multibyte-safe) BEFORE reaching the (stubbed) sender', async () => {
    delete process.env.ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED
    try {
      const longBody = '考'.repeat(1000) // 3000 bytes in UTF-8
      const message: AttendanceDeliveryMessage = { ...MESSAGE, payload: { title: 'T', body: longBody } }
      const { channel, sendTextMessage } = makeChannel({})
      await channel.send(message)
      expect(sendTextMessage).toHaveBeenCalledTimes(1)
      const input = sendTextMessage.mock.calls[0][1] as { content: string }
      expect(Buffer.byteLength(input.content, 'utf8')).toBeLessThanOrEqual(WECOM_TEXT_CONTENT_MAX_BYTES)
      expect(input.content).not.toContain('�')
    } finally {
      restoreEnv()
    }
  })
})

describe('WeComAttendanceDeliveryChannel.send — 42001/40014 single invalidate+retry (design-lock G3)', () => {
  it('42001 on first send -> invalidates cache, refetches token once, retries once, succeeds', async () => {
    let tokenCalls = 0
    const sendTextMessage = vi.fn()
      .mockRejectedValueOnce(new WeComBusinessError('token expired', 42001, { errcode: 42001 }))
      .mockResolvedValueOnce(okResult())
    const { channel } = makeChannel({
      fetchAccessToken: async () => { tokenCalls += 1; return `token-${tokenCalls}` },
      sendTextMessage,
    })
    const result = await channel.send(MESSAGE)
    expect(result).toEqual({ ok: true })
    expect(tokenCalls).toBe(2)
    expect(sendTextMessage).toHaveBeenCalledTimes(2)
    expect(sendTextMessage.mock.calls[0][0]).toBe('token-1')
    expect(sendTextMessage.mock.calls[1][0]).toBe('token-2')
  })

  it('40014 also triggers exactly one retry', async () => {
    let tokenCalls = 0
    const sendTextMessage = vi.fn()
      .mockRejectedValueOnce(new WeComBusinessError('token invalid', 40014, { errcode: 40014 }))
      .mockResolvedValueOnce(okResult())
    const { channel } = makeChannel({
      fetchAccessToken: async () => { tokenCalls += 1; return `token-${tokenCalls}` },
      sendTextMessage,
    })
    await channel.send(MESSAGE)
    expect(tokenCalls).toBe(2)
    expect(sendTextMessage).toHaveBeenCalledTimes(2)
  })

  it('42001 STILL fails after the single retry -> classified (retryable:true), NOT retried a second time', async () => {
    const sendTextMessage = vi.fn()
      .mockRejectedValueOnce(new WeComBusinessError('token expired', 42001, { errcode: 42001 }))
      .mockRejectedValueOnce(new WeComBusinessError('token expired', 42001, { errcode: 42001 }))
    const { channel } = makeChannel({ sendTextMessage })
    const result = await channel.send(MESSAGE)
    expect(result).toMatchObject({ ok: false, retryable: true })
    expect((result as { error: string }).error).toContain('wecom_business_error_42001')
    expect(sendTextMessage).toHaveBeenCalledTimes(2) // exactly one retry, not a loop
  })

  it('non-token business error (e.g. 45009) is classified WITHOUT any retry', async () => {
    const sendTextMessage = vi.fn().mockRejectedValue(new WeComBusinessError('rate limited', 45009, { errcode: 45009 }))
    const { channel } = makeChannel({ sendTextMessage })
    const result = await channel.send(MESSAGE)
    expect(result).toMatchObject({ ok: false, retryable: true })
    expect(sendTextMessage).toHaveBeenCalledTimes(1)
  })
})

describe('WeComAttendanceDeliveryChannel.send — errcode=0 + invaliduser structural skip (design-lock G6)', () => {
  it('overall success (errcode=0) but invaliduser lists THIS recipient -> skip, not sent', async () => {
    const sendTextMessage = vi.fn(async () => okResult({ invalidUserIds: ['we-user-1'] }))
    const { channel } = makeChannel({ sendTextMessage })
    const result = await channel.send(MESSAGE)
    expect(result).toEqual({ ok: false, retryable: false, skip: true, error: 'wecom_recipient_invalid_user' })
  })

  it('overall success and invaliduser does NOT list this recipient -> ok:true', async () => {
    const sendTextMessage = vi.fn(async () => okResult({ invalidUserIds: ['someone-else'] }))
    const { channel } = makeChannel({ sendTextMessage })
    const result = await channel.send(MESSAGE)
    expect(result).toEqual({ ok: true })
  })
})

describe('WeComAttendanceDeliveryChannel.send — error classification table (design-lock G6)', () => {
  const cases: Array<{ name: string; error: unknown; expected: { retryable: boolean; skip?: boolean } }> = [
    { name: 'HTTP 5xx transport', error: new WeComRequestError('bad gateway', 502, null), expected: { retryable: true } },
    { name: 'HTTP 408 timeout-like', error: new WeComRequestError('timeout', 408, null), expected: { retryable: true } },
    { name: 'HTTP 429', error: new WeComRequestError('too many requests', 429, null), expected: { retryable: true } },
    { name: 'HTTP 400 (non-5xx/408/429)', error: new WeComRequestError('bad request', 400, null), expected: { retryable: false } },
    { name: '45009 rate limited', error: new WeComBusinessError('rate limited', 45009, null), expected: { retryable: true } },
    { name: '45033 concurrency limited', error: new WeComBusinessError('concurrency limited', 45033, null), expected: { retryable: true } },
    { name: '81013 all recipients invalid/unauthorized', error: new WeComBusinessError('invalid recipients', 81013, null), expected: { retryable: false, skip: true } },
    { name: '82001 all recipients empty', error: new WeComBusinessError('empty recipients', 82001, null), expected: { retryable: false, skip: true } },
    { name: '40003 invalid UserID', error: new WeComBusinessError('invalid userid', 40003, null), expected: { retryable: false, skip: true } },
    { name: '41001 missing token', error: new WeComBusinessError('missing token', 41001, null), expected: { retryable: false } },
    { name: '40056 invalid agentid', error: new WeComBusinessError('invalid agentid', 40056, null), expected: { retryable: false } },
    { name: '60020 IP not trusted', error: new WeComBusinessError('ip not trusted', 60020, null), expected: { retryable: false } },
    { name: 'unrecognized business errcode', error: new WeComBusinessError('mystery', 99999, null), expected: { retryable: false } },
    { name: 'generic network throw', error: new Error('ECONNRESET'), expected: { retryable: true } },
  ]

  for (const { name, error, expected } of cases) {
    it(`${name} -> retryable:${expected.retryable}${expected.skip ? ' + skip:true' : ''}`, async () => {
      const sendTextMessage = vi.fn().mockRejectedValue(error)
      const { channel } = makeChannel({ sendTextMessage })
      const result = await channel.send(MESSAGE)
      expect(result.ok).toBe(false)
      expect((result as { retryable: boolean }).retryable).toBe(expected.retryable)
      expect((result as { skip?: boolean }).skip).toBe(expected.skip ?? undefined)
    })
  }
})

describe('WeComAttendanceDeliveryChannel.send — config unavailable', () => {
  it('readConfig throws "not configured" -> permanent config error, non-retryable, sender never called', async () => {
    const { channel, sendTextMessage } = makeChannel({
      readConfig: async () => { throw new Error('WECOM_AGENT_ID is not configured') },
    })
    const result = await channel.send(MESSAGE)
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect((result as { error: string }).error).toContain('wecom_work_notification_config_unavailable')
    expect(sendTextMessage).not.toHaveBeenCalled()
  })
})

describe('WeComAttendanceDeliveryChannel.send — PII/secret scrub in persisted last_error (design-lock G6)', () => {
  it('corpsecret query-string value never appears in the persisted error', async () => {
    const leaky = new Error('gettoken?corpid=corp-1&corpsecret=SUPER-SECRET-VALUE failed with 500')
    const sendTextMessage = vi.fn().mockRejectedValue(leaky)
    const { channel } = makeChannel({ sendTextMessage })
    const result = await channel.send(MESSAGE)
    const error = (result as { error: string }).error
    expect(error).not.toContain('SUPER-SECRET-VALUE')
    expect(error).toContain('[redacted')
  })

  it('access_token query-string value never appears in the persisted error', async () => {
    const leaky = new Error('message/send?access_token=LEAKED-TOKEN-VALUE returned 500')
    const sendTextMessage = vi.fn().mockRejectedValue(leaky)
    const { channel } = makeChannel({ sendTextMessage })
    const result = await channel.send(MESSAGE)
    const error = (result as { error: string }).error
    expect(error).not.toContain('LEAKED-TOKEN-VALUE')
    expect(error).toContain('[redacted')
  })
})

describe('createAttendanceDeliveryChannelsFromEnv — WeCom env-gate (design-lock G2)', () => {
  const READY_WECOM_ENV = {
    ATTENDANCE_NOTIFICATION_WECOM_ENABLED: 'true',
    WECOM_CORP_ID: 'corp-1',
    WECOM_CORP_SECRET: 'secret-1',
    WECOM_AGENT_ID: '1000002',
  } as NodeJS.ProcessEnv

  it('no flag -> WeCom channel NOT registered', () => {
    const channels = createAttendanceDeliveryChannelsFromEnv({} as NodeJS.ProcessEnv)
    expect(channels.some((c) => c.name === WECOM_WORK_NOTIFICATION_CHANNEL_NAME)).toBe(false)
  })

  it('flag true but config incomplete (missing agentid) -> NOT registered (register-nothing, no spin)', () => {
    const channels = createAttendanceDeliveryChannelsFromEnv({
      ATTENDANCE_NOTIFICATION_WECOM_ENABLED: 'true',
      WECOM_CORP_ID: 'corp-1',
      WECOM_CORP_SECRET: 'secret-1',
      // WECOM_AGENT_ID intentionally omitted
    } as NodeJS.ProcessEnv)
    expect(channels.some((c) => c.name === WECOM_WORK_NOTIFICATION_CHANNEL_NAME)).toBe(false)
  })

  it('flag true + config complete -> registered', () => {
    const channels = createAttendanceDeliveryChannelsFromEnv(READY_WECOM_ENV)
    expect(channels.some((c) => c.name === WECOM_WORK_NOTIFICATION_CHANNEL_NAME)).toBe(true)
  })

  it('config complete but flag NOT "true" (e.g. "1") -> NOT registered (strict enum-shaped gate)', () => {
    const channels = createAttendanceDeliveryChannelsFromEnv({
      ...READY_WECOM_ENV,
      ATTENDANCE_NOTIFICATION_WECOM_ENABLED: '1',
    } as NodeJS.ProcessEnv)
    expect(channels.some((c) => c.name === WECOM_WORK_NOTIFICATION_CHANNEL_NAME)).toBe(false)
  })

  it('WeCom + DingTalk + email all enabled -> all THREE coexist via name-routing', () => {
    const channels = createAttendanceDeliveryChannelsFromEnv({
      ...READY_WECOM_ENV,
      ATTENDANCE_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED: 'true',
      ATTENDANCE_NOTIFICATION_EMAIL_ENABLED: 'true',
      MULTITABLE_EMAIL_TRANSPORT: 'smtp',
      MULTITABLE_EMAIL_SMTP_HOST: 'smtp.example.com',
      MULTITABLE_EMAIL_SMTP_PORT: '587',
      MULTITABLE_EMAIL_SMTP_USER: 'smtp-user',
      MULTITABLE_EMAIL_SMTP_PASSWORD: 'smtp-password',
      MULTITABLE_EMAIL_SMTP_FROM: 'ops@example.com',
    } as NodeJS.ProcessEnv)
    const names = channels.map((c) => c.name)
    expect(names).toContain(WECOM_WORK_NOTIFICATION_CHANNEL_NAME)
    expect(names).toContain(DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME)
    expect(names).toContain(EMAIL_SMTP_CHANNEL_NAME)
  })
})

describe('resolveAttendanceDefaultDeliveryChannel — wecom_work_notification is an allowlisted value (S2 producer default)', () => {
  it('configured to wecom_work_notification -> producers stamp it', () => {
    expect(resolveAttendanceDefaultDeliveryChannel({ ATTENDANCE_NOTIFICATION_DEFAULT_CHANNEL: WECOM_WORK_NOTIFICATION_CHANNEL_NAME } as NodeJS.ProcessEnv))
      .toBe(WECOM_WORK_NOTIFICATION_CHANNEL_NAME)
  })

  it('no env -> still defaults to the in-app DingTalk channel (WeCom does not change the default)', () => {
    expect(resolveAttendanceDefaultDeliveryChannel({} as NodeJS.ProcessEnv)).toBe(DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME)
  })
})
