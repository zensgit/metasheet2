/**
 * T1-2 inbound webhook trigger — real mounted route + real DB.
 *
 * Drives the public unauthenticated route end to end:
 *   POST /api/multitable/automation/webhooks/:ruleId
 *     → raw-body HMAC verification
 *     → AutomationService.handleInboundWebhook
 *     → executeRule
 *     → durable multitable_automation_executions row.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { db } from '../../src/db/db'
import { EventBus } from '../../src/integration/events/event-bus'
import { AutomationService, type AutomationRule } from '../../src/multitable/automation-service'
import { automationWebhookJsonParser, createAutomationRoutes } from '../../src/routes/automation'
import { signInboundWebhookBody } from '../../src/multitable/automation-inbound-webhook'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE = `base_iwh_${TS}`
const SHEET = `sheet_iwh_${TS}`
const CREATOR = `u_iwh_${TS}`
const SECRET = 'inbound-secret'

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const queryFn = ((sql: string, params?: unknown[]) => poolManager.get().query(sql, params)) as never

let app: Express
let svc: AutomationService
const ruleIds: string[] = []
const notifications: Array<Record<string, unknown>> = []

function bodyBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value))
}

function signedHeaders(rawBody: Buffer, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-MS-Webhook-Timestamp': String(timestamp),
    'X-MS-Webhook-Signature': signInboundWebhookBody(rawBody, secret, timestamp),
  }
}

async function createWebhookRule(name: string, overrides: Partial<Parameters<AutomationService['createRule']>[1]> = {}): Promise<AutomationRule> {
  const rule = await svc.createRule(SHEET, {
    name,
    triggerType: 'webhook.received',
    triggerConfig: { secret: SECRET },
    actionType: 'send_notification',
    actionConfig: { userIds: [CREATOR], message: name },
    createdBy: CREATOR,
    ...overrides,
  })
  ruleIds.push(rule.id)
  return rule
}

async function executionRows(ruleId: string): Promise<Array<Record<string, unknown>>> {
  const res = await q(
    `SELECT id, status, trigger_event
       FROM multitable_automation_executions
      WHERE rule_id = $1
      ORDER BY created_at ASC`,
    [ruleId],
  )
  return res.rows as Array<Record<string, unknown>>
}

describeIfDatabase('T1-2 inbound webhook trigger (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'Inbound Webhook Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'Inbound Webhook Sheet'])
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET is_active = TRUE`,
      [CREATOR, `${CREATOR}@iwh.test`],
    )

    const bus = new EventBus()
    bus.subscribe('automation.notification', (payload) => notifications.push(payload as Record<string, unknown>))
    svc = new AutomationService(bus, db as never, queryFn)

    app = express()
    // Mirrors production: this prefix captures raw bytes before the general JSON parser.
    app.use('/api/multitable/automation/webhooks', automationWebhookJsonParser)
    app.use(express.json())
    app.use('/api/multitable', createAutomationRoutes(svc))
  })

  afterAll(async () => {
    try { svc?.shutdown() } catch { /* noop */ }
    if (ruleIds.length > 0) {
      await q('DELETE FROM multitable_automation_executions WHERE rule_id = ANY($1::text[])', [ruleIds]).catch(() => {})
      await q('DELETE FROM automation_rules WHERE id = ANY($1::text[])', [ruleIds]).catch(() => {})
    }
    await q('DELETE FROM users WHERE id = $1', [CREATOR]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('save gate rejects webhook.received rules without a secret on create and any later edit', async () => {
    await expect(svc.createRule(SHEET, {
      name: 'missing secret',
      triggerType: 'webhook.received',
      triggerConfig: {},
      actionType: 'send_notification',
      actionConfig: { userIds: [CREATOR], message: 'x' },
      createdBy: CREATOR,
    })).rejects.toThrow(/webhook\.received requires trigger_config\.secret/)

    const dirtyId = `atr_iwh_dirty_${TS}`
    ruleIds.push(dirtyId)
    await q(
      `INSERT INTO automation_rules
        (id, sheet_id, name, trigger_type, trigger_config, action_type, action_config, enabled, created_by)
       VALUES ($1,$2,$3,'webhook.received',$4::jsonb,'send_notification',$5::jsonb,TRUE,$6)`,
      [dirtyId, SHEET, 'dirty', '{}', JSON.stringify({ userIds: [CREATOR], message: 'dirty' }), CREATOR],
    )

    await expect(svc.updateRule(dirtyId, SHEET, { name: 'dirty edited' }))
      .rejects.toThrow(/webhook\.received requires trigger_config\.secret/)
  })

  test('mounted route rejects arrays, primitives, and empty body', async () => {
    for (const value of [[1], 'x', 42, true]) {
      const raw = bodyBuffer(value)
      const res = await request(app)
        .post('/api/multitable/automation/webhooks/atr_missing')
        .set(signedHeaders(raw))
        .send(raw.toString('utf8'))
      expect(res.status).toBe(401)
      expect(res.body).toEqual({ ok: false })
    }

    const empty = await request(app)
      .post('/api/multitable/automation/webhooks/atr_missing')
      .set('Content-Type', 'application/json')
      .send('')
    expect(empty.status).toBe(401)
    expect(empty.body).toEqual({ ok: false })
  })

  test('uniform 401 rejects unknown rule, wrong trigger, disabled, bad signature, stale timestamp, and missing secret', async () => {
    const raw = bodyBuffer({ event: 'x' })
    await request(app)
      .post('/api/multitable/automation/webhooks/atr_unknown')
      .set(signedHeaders(raw))
      .send(raw.toString('utf8'))
      .expect(401, { ok: false })

    const wrong = await svc.createRule(SHEET, {
      name: 'wrong trigger',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'send_notification',
      actionConfig: { userIds: [CREATOR], message: 'wrong' },
      createdBy: CREATOR,
    })
    ruleIds.push(wrong.id)
    await request(app)
      .post(`/api/multitable/automation/webhooks/${wrong.id}`)
      .set(signedHeaders(raw))
      .send(raw.toString('utf8'))
      .expect(401, { ok: false })

    const disabled = await createWebhookRule('disabled', { enabled: false })
    await request(app)
      .post(`/api/multitable/automation/webhooks/${disabled.id}`)
      .set(signedHeaders(raw))
      .send(raw.toString('utf8'))
      .expect(401, { ok: false })

    const ok = await createWebhookRule('reject matrix')
    await request(app)
      .post(`/api/multitable/automation/webhooks/${ok.id}`)
      .set({ ...signedHeaders(raw), 'X-MS-Webhook-Signature': 'sha256='.padEnd(71, '0') })
      .send(raw.toString('utf8'))
      .expect(401, { ok: false })

    const staleTs = Math.floor(Date.now() / 1000) - 301
    await request(app)
      .post(`/api/multitable/automation/webhooks/${ok.id}`)
      .set(signedHeaders(raw, SECRET, staleTs))
      .send(raw.toString('utf8'))
      .expect(401, { ok: false })

    const secretlessId = `atr_iwh_secretless_${TS}`
    ruleIds.push(secretlessId)
    await q(
      `INSERT INTO automation_rules
        (id, sheet_id, name, trigger_type, trigger_config, action_type, action_config, enabled, created_by)
       VALUES ($1,$2,$3,'webhook.received',$4::jsonb,'send_notification',$5::jsonb,TRUE,$6)`,
      [secretlessId, SHEET, 'secretless', '{}', JSON.stringify({ userIds: [CREATOR], message: 'secretless' }), CREATOR],
    )
    await request(app)
      .post(`/api/multitable/automation/webhooks/${secretlessId}`)
      .set(signedHeaders(raw))
      .send(raw.toString('utf8'))
      .expect(401, { ok: false })
  })

  test('accepted signed request executes once and cannot spoof record, sheet, or actor context from body', async () => {
    const rule = await createWebhookRule('accepted')
    const raw = bodyBuffer({
      event: 'external.created',
      recordId: 'rec_attacker',
      sheetId: 'sheet_attacker',
      actorId: 'u_attacker',
      value: 123,
    })

    const res = await request(app)
      .post(`/api/multitable/automation/webhooks/${rule.id}`)
      .set(signedHeaders(raw))
      .send(raw.toString('utf8'))
      .expect(202)
    expect(res.body).toMatchObject({ ok: true, status: 'success' })

    const rows = await executionRows(rule.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('success')
    const event = rows[0].trigger_event as Record<string, unknown>
    expect(event.sheetId).toBe(SHEET)
    expect(event.recordId).toBe('')
    expect(event.actorId).toBeNull()
    expect(event.data).toMatchObject({
      recordId: 'rec_attacker',
      sheetId: 'sheet_attacker',
      actorId: 'u_attacker',
      value: 123,
    })
    expect(notifications.some((n) => n.message === 'accepted')).toBe(true)
  })
})
