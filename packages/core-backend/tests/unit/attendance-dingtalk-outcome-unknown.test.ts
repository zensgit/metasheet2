/**
 * PR #4046 Phase B — the attendance DingTalk channel CONSUMES the transport's outcome-unknown
 * marker (isDingTalkOutcomeUnknown): a send whose outcome is unknowable becomes a NON-retryable
 * result carrying `outcomeUnknown: true`, so the outbox worker terminates it as the distinct
 * `outcome_unknown` status instead of RESENDING it (the pre-existing duplicate hazard: these
 * errors used to classify retryable). Definite rejections and read-tier failures keep their
 * pre-Phase-B classification — pinned here so the widening is provably surgical.
 *
 * Unit-level DI (query/config/token/send injected) mirrors the WeCom channel suite; the real
 * transport's marking behavior is pinned in dingtalk-transport-resilience.test.ts, and the
 * worker's terminal-state/no-reclaim behavior against real Postgres lives in
 * tests/integration/attendance-notification-deliveries.test.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DingTalkAttendanceDeliveryChannel,
  DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME,
  type AttendanceDeliveryMessage,
} from '../../src/services/AttendanceNotificationDeliveryWorker'
import {
  DingTalkBusinessError,
  DingTalkRequestError,
  type DingTalkMessageConfig,
} from '../../src/integrations/dingtalk/client'

const CONFIG: DingTalkMessageConfig = { appKey: 'k', appSecret: 's', agentId: '42' }

const MESSAGE: AttendanceDeliveryMessage = {
  id: 'dlv1',
  orgId: 'org1',
  sourceType: 'unscheduled_reminder',
  sourceId: 'src1',
  sourceKey: 'key1',
  recipientUserId: 'u1',
  recipientRole: 'subject',
  channel: DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME,
  payload: { title: 'Punch reminder', body: 'You have an unscheduled shift today.' },
}

function makeChannel(sendError: unknown) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('directory_account_links')) {
      return { rows: [{ integration_id: 'integ-1', external_user_id: 'dd-user-1' }] }
    }
    return { rows: [{ org_has_active_integration: true }] }
  })
  const sendWorkNotification = vi.fn(async () => { throw sendError })
  const channel = new DingTalkAttendanceDeliveryChannel({
    query: query as never,
    readConfig: async () => CONFIG,
    fetchAccessToken: async () => 'access-token',
    sendWorkNotification,
  })
  return { channel, sendWorkNotification }
}

/** The transport marks outcome-unknown sends with an enumerable `outcomeUnknown: true` property. */
function markedError(base: Error): Error {
  return Object.assign(base, { outcomeUnknown: true })
}

describe('DingTalk attendance channel — outcome-unknown consumption (PR #4046 Phase B)', () => {
  it('a marked network error → NON-retryable + outcomeUnknown:true (terminal, never resent), send attempted exactly once', async () => {
    const { channel, sendWorkNotification } = makeChannel(markedError(new TypeError('fetch failed')))
    const result = await channel.send(MESSAGE)
    expect(result).toEqual({
      ok: false,
      retryable: false,
      outcomeUnknown: true,
      error: expect.stringMatching(/^dingtalk_send_outcome_unknown: /),
    })
    expect(sendWorkNotification).toHaveBeenCalledTimes(1)
  })

  it('a marked DingTalkRequestError 502 (send-tier 5xx) → outcome_unknown, NOT the retryable dingtalk_request_502 bucket', async () => {
    const { channel } = makeChannel(markedError(new DingTalkRequestError('bad gateway', 502, null)))
    const result = await channel.send(MESSAGE)
    expect(result).toMatchObject({ ok: false, retryable: false, outcomeUnknown: true })
    expect((result as { error: string }).error).toMatch(/^dingtalk_send_outcome_unknown: /)
  })

  it('PINNED unchanged: an UNMARKED network error stays retryable (ordinary transient failure keeps its backoff path)', async () => {
    const { channel } = makeChannel(new TypeError('socket hang up'))
    const result = await channel.send(MESSAGE)
    expect(result).toMatchObject({ ok: false, retryable: true })
    expect((result as { outcomeUnknown?: boolean }).outcomeUnknown).toBeUndefined()
    expect((result as { error: string }).error).toMatch(/^dingtalk_send_failed: /)
  })

  it('PINNED unchanged: an UNMARKED DingTalkRequestError 500 stays retryable (read-tier/legacy paths do not carry the marker)', async () => {
    const { channel } = makeChannel(new DingTalkRequestError('server error', 500, null))
    const result = await channel.send(MESSAGE)
    expect(result).toMatchObject({ ok: false, retryable: true })
    expect((result as { outcomeUnknown?: boolean }).outcomeUnknown).toBeUndefined()
  })

  it('PINNED unchanged: a definite business rejection (errcode 88, unmarked — the transport never marks HTTP-200 envelopes) stays non-retryable WITHOUT outcomeUnknown', async () => {
    const { channel } = makeChannel(new DingTalkBusinessError('ding: not allowed', { errcode: 88, errmsg: 'not allowed' }))
    const result = await channel.send(MESSAGE)
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect((result as { outcomeUnknown?: boolean }).outcomeUnknown).toBeUndefined()
    expect((result as { error: string }).error).toMatch(/^dingtalk_business_error: /)
  })
})
