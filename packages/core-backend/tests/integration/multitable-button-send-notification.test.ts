/**
 * Real-DB integration for B1-S1 D0-A — send_notification button (first
 * side-effecting button action). Design-lock:
 * docs/development/multitable-button-side-effect-1-send-notification-designlock-20260616.md
 *
 * Exercises the parts a mock pool CANNOT verify (the wire-vs-fixture trap):
 *  - the real `UNIQUE(dedup_key)` + `ON CONFLICT DO NOTHING` at-most-once guard
 *  - the real recipient HARD-REJECT (loadSheetMemberUserIdSet against real users):
 *    ANY non-member rejects the whole run, nothing written
 *  - a `notification.sent` row surviving the widened event_type CHECK + round-tripping
 *    its `message` back through the list serializer
 *  - the durable, in-transaction `triggered_by='button'` audit row
 *  - the §2 HARD-AUDIT rollback: a failing audit insert rolls back the notification
 *    (true rollback only provable on a real DB — a mock can't roll back its own state)
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { createMultitableButtonRoutes } from '../../src/routes/multitable-button'
import { listRecordSubscriptionNotifications } from '../../src/multitable/record-subscription-service'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_btnsn_${TS}`
const SHEET_ID = `sheet_btnsn_${TS}`
const REC_ID = `rec_btnsn_${TS}`
const FLD_NOTIFY = `fld_btnsn_notify_${TS}` // recipients = members only (delivers)
const FLD_NOTIFY_BAD = `fld_btnsn_notify_bad_${TS}` // recipients include a non-member (hard-reject)
const USER_EDITOR = `u_btnsn_editor_${TS}`
const USER_MEMBER = `u_btnsn_member_${TS}`
const USER_OUTSIDER = `u_btnsn_outsider_${TS}`

let app: Express
let actorPerms: string[] = ['multitable:read', 'multitable:write']

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const runUrl = `/api/multitable/sheets/${SHEET_ID}/records/${REC_ID}/fields/${FLD_NOTIFY}/button/run`
const runBadUrl = `/api/multitable/sheets/${SHEET_ID}/records/${REC_ID}/fields/${FLD_NOTIFY_BAD}/button/run`

describeIfDatabase('B1-S1 D0-A send_notification button (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = { id: USER_EDITOR, roles: [], perms: actorPerms }
      next()
    })
    app.use('/api/multitable', createMultitableButtonRoutes())

    // Users: editor + member are multitable-eligible (members); outsider is NOT.
    const seedUser = (id: string, perms: string[]) =>
      q(
        `INSERT INTO users (id, email, password_hash, name, role, is_active, permissions)
         VALUES ($1,$2,'hash',$3,'user',true,$4::jsonb)
         ON CONFLICT (id) DO UPDATE SET is_active = EXCLUDED.is_active, permissions = EXCLUDED.permissions`,
        [id, `${id}@example.test`, id, JSON.stringify(perms)],
      )
    await seedUser(USER_EDITOR, ['multitable:read', 'multitable:write'])
    await seedUser(USER_MEMBER, ['multitable:read'])
    await seedUser(USER_OUTSIDER, []) // not multitable-eligible → excluded from member set

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'BtnSN Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'BtnSN Sheet'])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_ID, SHEET_ID, '{}'])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [
        FLD_NOTIFY, SHEET_ID, 'Notify', 'button',
        JSON.stringify({
          actionType: 'send_notification',
          label: 'Notify',
          // members-only recipients → delivers.
          actionConfig: { userIds: [USER_MEMBER], message: 'Ship the release' },
        }),
        1,
      ],
    )
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [
        FLD_NOTIFY_BAD, SHEET_ID, 'NotifyBad', 'button',
        JSON.stringify({
          actionType: 'send_notification',
          label: 'NotifyBad',
          // member + outsider authored; the outsider must HARD-REJECT the whole run.
          actionConfig: { userIds: [USER_MEMBER, USER_OUTSIDER], message: 'Ship the release' },
        }),
        2,
      ],
    )
  })

  beforeEach(async () => {
    actorPerms = ['multitable:read', 'multitable:write']
    // Self-scope every test: clear prior notifications + dedup markers for this sheet so
    // length/count assertions are exact regardless of test order.
    await q('DELETE FROM meta_record_subscription_notifications WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM multitable_button_run_dedup WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
  })

  afterAll(async () => {
    await q('DELETE FROM multitable_button_run_dedup WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_record_subscription_notifications WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM multitable_automation_executions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[USER_EDITOR, USER_MEMBER, USER_OUTSIDER]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('members-only recipients + notification.sent round-trip: member delivered with message', async () => {
    const res = await request(app).post(runUrl).send({ requestId: `req-deliver-${TS}` })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('succeeded')

    // The member got a durable notification.sent row carrying the message (survives the
    // widened CHECK + round-trips through the list serializer).
    const memberInbox = await listRecordSubscriptionNotifications(
      (sql, params) => poolManager.get().query(sql, params),
      { userId: USER_MEMBER, sheetId: SHEET_ID },
    )
    expect(memberInbox).toHaveLength(1)
    expect(memberInbox[0]).toMatchObject({ eventType: 'notification.sent', message: 'Ship the release' })
  })

  test('§3.1 recipient HARD-REJECT: a configured non-member rejects the whole run → 400, NOTHING written', async () => {
    const requestId = `req-reject-${TS}`
    const res = await request(app).post(runBadUrl).send({ requestId })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('RECIPIENT_NOT_AUTHORIZED')

    // No notification for ANYONE (the member in the list is NOT delivered to).
    const memberInbox = await listRecordSubscriptionNotifications(
      (sql, params) => poolManager.get().query(sql, params),
      { userId: USER_MEMBER, sheetId: SHEET_ID },
    )
    expect(memberInbox).toHaveLength(0)
    // requestId NOT consumed: no dedup marker, no audit row.
    const markers = await q('SELECT count(*)::int AS n FROM multitable_button_run_dedup WHERE request_id = $1', [requestId])
    expect((markers.rows[0] as { n: number }).n).toBe(0)
  })

  test('§2 HARD AUDIT rollback (real DB): a failing audit insert rolls back the notification — fail-closed', async () => {
    const { AutomationLogService } = await import('../../src/multitable/automation-log-service')
    const spy = vi
      .spyOn(AutomationLogService.prototype, 'recordWithQuery')
      .mockRejectedValue(new Error('audit boom'))
    try {
      const requestId = `req-failclosed-${TS}`
      const res = await request(app).post(runUrl).send({ requestId })
      // Fail-closed: the run does NOT report success.
      expect(res.status).toBe(500)
      expect(res.body.ok).toBe(false)

      // TRUE rollback: the notification the seam wrote inside the tx is GONE.
      const memberInbox = await listRecordSubscriptionNotifications(
        (sql, params) => poolManager.get().query(sql, params),
        { userId: USER_MEMBER, sheetId: SHEET_ID },
      )
      expect(memberInbox).toHaveLength(0)
      // dedup marker also rolled back → requestId NOT consumed.
      const markers = await q('SELECT count(*)::int AS n FROM multitable_button_run_dedup WHERE request_id = $1', [requestId])
      expect((markers.rows[0] as { n: number }).n).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })

  test('at-most-once: replaying the same requestId writes the notification only once', async () => {
    const requestId = `req-dedup-${TS}`
    const first = await request(app).post(runUrl).send({ requestId })
    expect(first.status).toBe(200)
    const replay = await request(app).post(runUrl).send({ requestId })
    expect(replay.status).toBe(200)
    expect(replay.body.data.deduplicated).toBe(true)

    // Exactly ONE dedup marker AND exactly ONE notification — single effect despite two
    // requests (beforeEach self-scopes the sheet, so the count is exact).
    const markers = await q('SELECT count(*)::int AS n FROM multitable_button_run_dedup WHERE request_id = $1', [requestId])
    expect((markers.rows[0] as { n: number }).n).toBe(1)
    const notes = await q(
      `SELECT count(*)::int AS n FROM meta_record_subscription_notifications
       WHERE sheet_id = $1 AND user_id = $2 AND event_type = 'notification.sent'`,
      [SHEET_ID, USER_MEMBER],
    )
    expect((notes.rows[0] as { n: number }).n).toBe(1)
  })

  test('durable audit: triggered_by=button row written, excluded from rule reads, retrievable by id', async () => {
    const res = await request(app).post(runUrl).send({ requestId: `req-audit-${TS}` })
    expect(res.status).toBe(200)
    const executionId = res.body.data.executionId as string

    const row = await q('SELECT triggered_by, status, steps FROM multitable_automation_executions WHERE id = $1', [executionId])
    expect(row.rows).toHaveLength(1)
    expect((row.rows[0] as { triggered_by: string }).triggered_by).toBe('button')
    // The steps jsonb persists the REAL redacted step content — NOT empty {} (guards
    // against a RawBuilder-stringify regression that would store empty audit content).
    const persistedSteps = (row.rows[0] as { steps: unknown }).steps
    const steps = typeof persistedSteps === 'string' ? JSON.parse(persistedSteps) : persistedSteps
    expect(Array.isArray(steps)).toBe(true)
    expect(steps[0]).toMatchObject({ actionType: 'send_notification', status: 'success' })

    const { AutomationLogService } = await import('../../src/multitable/automation-log-service')
    const logService = new AutomationLogService()
    // getById retrievable; getRecent / listExecutions exclude triggered_by='button'.
    expect(await logService.getById(executionId)).toBeTruthy()
    const recent = await logService.getRecent(200)
    expect(recent.find((e) => e.id === executionId)).toBeUndefined()
    const listed = await logService.listExecutions({ sheetId: SHEET_ID, limit: 200 })
    expect(listed.find((e) => e.id === executionId)).toBeUndefined()
  })

  test('side-effecting action requires a requestId', async () => {
    const res = await request(app).post(runUrl).send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('REQUEST_ID_REQUIRED')
  })

  test('actor gate: a read-only actor cannot run send_notification', async () => {
    actorPerms = ['multitable:read']
    const res = await request(app).post(runUrl).send({ requestId: `req-ro-${TS}` })
    expect(res.status).toBe(403)
  })
})
