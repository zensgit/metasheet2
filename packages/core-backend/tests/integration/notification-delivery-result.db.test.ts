/**
 * Delivery-result truthfulness — real-DB goldens for the Class-B two-phase send_email path and the
 * execution-stats aggregate.
 *
 * Proves against a REAL Postgres schema, with the REAL `EmailNotificationChannel` (env-controlled, tripwired
 * transport factory) behind the REAL `NotificationServiceImpl` and the REAL `AutomationExecutor`:
 *   - a simulated (mock) send lands the ledger row as `failed` (retryable) with `last_error`
 *     email_transport_simulated, attempts 0, a `skipped` step, and no transport call;
 *   - a replay of that intent re-arms (attempts 1, new attempt_token), sends again, is again `failed`;
 *   - a disabled transport lands `failed` / email_transport_disabled;
 *   - an accepting SMTP transport lands `sent`, a `success` step, and a replay is skip_sent / alreadyApplied
 *     with no second sendMail;
 *   - a rejecting SMTP transport lands `outcome_unknown` / email_send_failed and a replay never resends;
 *   - after the transport is switched from mock to SMTP, the SAME simulated intent row is re-attempted
 *     exactly once (failed → sent) and a further replay is skip_sent;
 *   - `AutomationLogService.getStats` counts a simulated execution as `skipped`, not `success`.
 *
 * The ledger goes to a dedicated pg connection; every other executor SQL is the zero-DB stub the unit
 * harness uses; the stats aggregate uses the package's Kysely `db`. Two-point wired (plugin-tests.yml +
 * vitest.config.ts exclude) and guarded by tests/unit/notification-delivery-result-ci-wiring.test.ts.
 */
import { randomUUID } from 'node:crypto'

import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import { Logger } from '../../src/core/logger'
import { db } from '../../src/db/db'
import { EventBus } from '../../src/integration/events/event-bus'
import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationRule,
} from '../../src/multitable/automation-executor'
import { AutomationLogService } from '../../src/multitable/automation-log-service'
import { EMAIL_TRANSPORT_ENV } from '../../src/services/email-transport-readiness'
import { EmailNotificationChannel, NotificationServiceImpl } from '../../src/services/NotificationService'

if (process.env.EXPECT_DB !== '1') {
  throw new Error('notification-delivery-result.db.test.ts requires EXPECT_DB=1')
}
// With EXPECT_DB=1 a missing DATABASE_URL must fail loudly instead of skipping the whole suite.
if (!process.env.DATABASE_URL) {
  throw new Error('notification-delivery-result.db.test.ts requires DATABASE_URL when EXPECT_DB=1')
}

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const RUN = randomUUID()
const FLAG = 'AUTOMATION_CLASSB_OUTBOUND_ENABLED'
const COMPLETE_SMTP_ENV = {
  [EMAIL_TRANSPORT_ENV]: 'smtp',
  MULTITABLE_EMAIL_SMTP_HOST: 'smtp.example.test',
  MULTITABLE_EMAIL_SMTP_PORT: '587',
  MULTITABLE_EMAIL_SMTP_USER: 'smtp-user',
  MULTITABLE_EMAIL_SMTP_PASSWORD: 'smtp-password-secret',
  MULTITABLE_EMAIL_SMTP_FROM: 'ops@example.test',
}
const TRIGGER = { recordId: 'rec_1', sheetId: 'sheet_1', actorId: 'user_1', data: { title: 'X' } }

interface LedgerRow {
  status: string
  attempts: number
  last_error: string | null
  attempt_token: string | null
}

function emailRule(suffix: string): AutomationRule {
  return {
    id: `rule_${RUN}_${suffix}`, name: 'delivery-result rule', sheetId: 'sheet_1',
    trigger: { type: 'record.created', config: {} },
    actions: [{ type: 'send_email', config: { recipients: ['ops@example.test', 'owner@example.test'], subjectTemplate: 'Subject', bodyTemplate: 'Body' } }] as never,
    enabled: true, createdBy: 'user_1', createdAt: '2026-01-01T00:00:00Z',
  } as AutomationRule
}

function tripwireService(env: Record<string, string>) {
  const service = new NotificationServiceImpl()
  const createTransport = vi.fn(() => { throw new Error('tripwire: smtp transport factory must not be called') })
  service.registerChannel(new EmailNotificationChannel({ env, smtpTransportFactory: { createTransport } }))
  const send = vi.spyOn(service, 'send')
  return { service, createTransport, send }
}

function smtpService(sendMail: ReturnType<typeof vi.fn>) {
  const service = new NotificationServiceImpl()
  service.registerChannel(new EmailNotificationChannel({
    env: COMPLETE_SMTP_ENV,
    smtpTransportFactory: { createTransport: vi.fn(() => ({ sendMail })) },
  }))
  return { service, sendMail }
}

describeIfDatabase('delivery-result truthfulness: two-phase send_email against the real ledger (real DB)', () => {
  let client: Client
  const savedFlag = process.env[FLAG]

  const rowOf = async (root: string): Promise<LedgerRow | undefined> => {
    const { rows } = await client.query(
      `SELECT status, attempts, last_error, attempt_token FROM meta_automation_outbound_intent WHERE root_execution_id = $1`,
      [root],
    )
    expect(rows.length).toBeLessThanOrEqual(1)
    return rows[0] as LedgerRow | undefined
  }
  const executorOver = (service: NotificationServiceImpl) => {
    const queryFn: AutomationDeps['queryFn'] = async (sqlText, params = []) => {
      if (/meta_automation_outbound_intent/i.test(String(sqlText))) return client.query(String(sqlText), params as unknown[])
      return { rows: [], rowCount: 1 }
    }
    return new AutomationExecutor({ eventBus: new EventBus(), queryFn, notificationService: service })
  }
  const root = (suffix: string) => `exec_${RUN}_${suffix}`

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
  })
  beforeEach(() => {
    process.env[FLAG] = 'true'
    vi.spyOn(Logger.prototype, 'info').mockImplementation(() => undefined)
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    if (savedFlag === undefined) delete process.env[FLAG]
    else process.env[FLAG] = savedFlag
    vi.restoreAllMocks()
  })
  afterAll(async () => {
    await client.query(`DELETE FROM meta_automation_outbound_intent WHERE root_execution_id LIKE $1`, [`%${RUN}%`]).catch(() => {})
    await client.query(`DELETE FROM multitable_automation_executions WHERE rule_id LIKE $1`, [`%${RUN}%`]).catch(() => {})
    await client.end().catch(() => {})
    await db.destroy().catch(() => {})
  })

  test('sentinel: DATABASE_URL set and the ledger table is reachable', async () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
    const { rows } = await client.query(`SELECT to_regclass('meta_automation_outbound_intent') AS t`)
    expect((rows[0] as { t: string | null }).t).toBeTruthy()
  })

  test('D1 mock transport: ledger failed / email_transport_simulated / attempts 0, skipped step, no transport call', async () => {
    const { service, createTransport } = tripwireService({})
    const exec = await executorOver(service).execute(emailRule('d1'), TRIGGER, undefined, root('d1'))
    expect(exec.status).toBe('skipped')
    expect(exec.steps[0]?.status).toBe('skipped')
    expect(exec.steps[0]?.output).toMatchObject({ outcome: 'not_sent', reason: 'email_transport_simulated', notificationStatus: 'simulated', recipientCount: 2 })
    expect(exec.steps[0]?.output).not.toHaveProperty('terminalWriteConfirmed')
    expect(await rowOf(root('d1'))).toMatchObject({ status: 'failed', last_error: 'email_transport_simulated', attempts: 0 })
    expect((await rowOf(root('d1')))?.attempt_token).toBeTruthy()
    expect(createTransport).not.toHaveBeenCalled()
  })

  test('D2 replay of a simulated intent: re-armed (attempts 1, new token), sent again through the channel, still failed / skipped', async () => {
    const { service, createTransport, send } = tripwireService({})
    const executor = executorOver(service)
    await executor.execute(emailRule('d2'), TRIGGER, undefined, root('d2'))
    const first = await rowOf(root('d2'))
    expect(first).toMatchObject({ status: 'failed', attempts: 0 })

    const replay = await executor.execute(emailRule('d2'), TRIGGER, undefined, root('d2'))
    expect(replay.steps[0]?.status).toBe('skipped')
    expect(replay.steps[0]?.alreadyApplied).toBeUndefined()
    expect(send).toHaveBeenCalledTimes(2)
    const second = await rowOf(root('d2'))
    expect(second).toMatchObject({ status: 'failed', last_error: 'email_transport_simulated', attempts: 1 })
    expect(second?.attempt_token).not.toBe(first?.attempt_token)
    expect(createTransport).not.toHaveBeenCalled()
  })

  test('D3 accepting SMTP transport: ledger sent, success step; replay is skip_sent / alreadyApplied with no second sendMail', async () => {
    const sendMail = vi.fn(async () => ({ messageId: 'msg' }))
    const { service } = smtpService(sendMail)
    const executor = executorOver(service)
    const exec = await executor.execute(emailRule('d3'), TRIGGER, undefined, root('d3'))
    expect(exec.status).toBe('success')
    expect(exec.steps[0]?.status).toBe('success')
    expect(exec.steps[0]?.output).toMatchObject({ outcome: 'sent', notificationStatus: 'sent', recipientCount: 2 })
    expect(sendMail).toHaveBeenCalledTimes(2) // one per recipient
    expect(await rowOf(root('d3'))).toMatchObject({ status: 'sent', last_error: 'sent', attempts: 0 })

    const replay = await executor.execute(emailRule('d3'), TRIGGER, undefined, root('d3'))
    expect(replay.steps[0]?.status).toBe('success')
    expect(replay.steps[0]?.alreadyApplied).toBe(true)
    expect(sendMail).toHaveBeenCalledTimes(2) // not re-sent
  })

  test('D4 rejecting SMTP transport: ledger outcome_unknown / email_send_failed, failed step; replay never resends', async () => {
    const sendMail = vi.fn(async () => { throw new Error('Connection timeout') })
    const { service } = smtpService(sendMail)
    const executor = executorOver(service)
    const exec = await executor.execute(emailRule('d4'), TRIGGER, undefined, root('d4'))
    expect(exec.steps[0]?.status).toBe('failed')
    expect(exec.steps[0]?.error).toMatch(/outcome_unknown/)
    expect(await rowOf(root('d4'))).toMatchObject({ status: 'outcome_unknown', last_error: 'email_send_failed', attempts: 0 })

    const replay = await executor.execute(emailRule('d4'), TRIGGER, undefined, root('d4'))
    expect(replay.steps[0]?.status).toBe('failed')
    expect(sendMail).toHaveBeenCalledTimes(1)
  })

  test('D5 disabled transport: ledger failed / email_transport_disabled, skipped step with notificationStatus cancelled', async () => {
    const { service, createTransport } = tripwireService({ [EMAIL_TRANSPORT_ENV]: 'disabled' })
    const exec = await executorOver(service).execute(emailRule('d5'), TRIGGER, undefined, root('d5'))
    expect(exec.steps[0]?.status).toBe('skipped')
    expect(exec.steps[0]?.output).toMatchObject({ outcome: 'not_sent', reason: 'email_transport_disabled', notificationStatus: 'cancelled' })
    expect(await rowOf(root('d5'))).toMatchObject({ status: 'failed', last_error: 'email_transport_disabled', attempts: 0 })
    expect(createTransport).not.toHaveBeenCalled()
  })

  test('D6 transport switched mock → SMTP: the same simulated intent is re-attempted ONCE (failed → sent); a further replay is skip_sent', async () => {
    const mock = tripwireService({})
    await executorOver(mock.service).execute(emailRule('d6'), TRIGGER, undefined, root('d6'))
    expect(await rowOf(root('d6'))).toMatchObject({ status: 'failed', last_error: 'email_transport_simulated' })

    const sendMail = vi.fn(async () => ({ messageId: 'msg' }))
    const smtp = smtpService(sendMail)
    const retried = await executorOver(smtp.service).execute(emailRule('d6'), TRIGGER, undefined, root('d6'))
    expect(retried.steps[0]?.status).toBe('success')
    expect(retried.steps[0]?.alreadyApplied).toBeUndefined()
    expect(sendMail).toHaveBeenCalledTimes(2) // the two recipients, once each
    expect(await rowOf(root('d6'))).toMatchObject({ status: 'sent', last_error: 'sent', attempts: 1 })

    const again = await executorOver(smtp.service).execute(emailRule('d6'), TRIGGER, undefined, root('d6'))
    expect(again.steps[0]?.alreadyApplied).toBe(true)
    expect(sendMail).toHaveBeenCalledTimes(2)
  })

  test('stats: a simulated execution persisted through AutomationLogService counts as skipped, not success', async () => {
    const { service } = tripwireService({})
    const rule = emailRule('stats')
    const exec = await executorOver(service).execute(rule, TRIGGER, undefined, root('stats'))
    expect(exec.status).toBe('skipped')
    const logs = new AutomationLogService()
    await logs.record(exec)
    const stats = await logs.getStats(rule.id)
    expect(stats).toMatchObject({ total: 1, success: 0, failed: 0, skipped: 1 })
    const stored = await logs.getById(exec.id)
    expect(stored?.status).toBe('skipped')
    expect(stored?.steps?.[0]?.status).toBe('skipped')
    expect(stored?.steps?.[0]?.output).toMatchObject({ outcome: 'not_sent', reason: 'email_transport_simulated', notificationStatus: 'simulated' })
  })
})
