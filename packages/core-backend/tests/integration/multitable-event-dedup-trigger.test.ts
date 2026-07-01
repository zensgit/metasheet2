/**
 * T2-6 event-driven dedup ledger — real DB.
 *
 * Runs the real AutomationService handleEvent path and the real update_record action. The event-id key is
 * transport-scoped (`eventType:_eventId`) and claimed per rule before execution, so a redelivery of the same
 * emitted event is at-most-once while legitimate later events still fire.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { db } from '../../src/db/db'
import { EventBus } from '../../src/integration/events/event-bus'
import { AutomationService, type AutomationRule } from '../../src/multitable/automation-service'
import { RecordService } from '../../src/multitable/record-service'
import type { MultitableCapabilities } from '../../src/multitable/access'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE = `base_t26_${TS}`
const SHEET = `sheet_t26_${TS}`
const REC = `rec_t26_${TS}`
const FLD_VALUE = `fld_t26_value_${TS}`
const FLD_MARK = `fld_t26_mark_${TS}`
const ACTOR = `u_t26_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const queryFn = ((sql: string, params?: unknown[]) => poolManager.get().query(sql, params)) as never

const fullCapabilities: MultitableCapabilities = {
  canRead: true,
  canCreateRecord: true,
  canEditRecord: true,
  canDeleteRecord: true,
  canManageFields: false,
  canManageSheetAccess: false,
  canManageViews: false,
  canComment: true,
  canManageAutomation: true,
  canExport: true,
}

type TxClient = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }> }

function recordPoolAdapter() {
  const pg = poolManager.get()
  return {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params),
    transaction: (handler: (client: TxClient) => Promise<unknown>) => pg.transaction(handler as never),
  }
}

async function createRule(svc: AutomationService, name: string, triggerType = 'record.created', triggerConfig: Record<string, unknown> = {}): Promise<AutomationRule> {
  return svc.createRule(SHEET, {
    name,
    triggerType,
    triggerConfig,
    actionType: 'update_record',
    actionConfig: { fields: { [FLD_MARK]: name } },
    createdBy: ACTOR,
  })
}

async function executionCount(ruleId: string): Promise<number> {
  const res = await q('SELECT count(*)::int AS n FROM multitable_automation_executions WHERE rule_id = $1', [ruleId])
  return Number((res.rows[0] as { n?: number | string } | undefined)?.n ?? 0)
}

async function ledgerCount(ruleId: string): Promise<number> {
  const res = await q('SELECT count(*)::int AS n FROM meta_automation_event_fires WHERE rule_id = $1', [ruleId])
  return Number((res.rows[0] as { n?: number | string } | undefined)?.n ?? 0)
}

describeIfDatabase('T2-6 event-driven automation dedup ledger (real DB)', () => {
  let eventBus: EventBus
  let svc: AutomationService
  const ruleIds: string[] = []

  beforeAll(async () => {
    eventBus = new EventBus()
    svc = new AutomationService(eventBus, db as never, queryFn)

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'T2-6 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'T2-6 Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_VALUE, SHEET, 'Value', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_MARK, SHEET, 'Mark', 'string', '{}', 2])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC, SHEET, JSON.stringify({ [FLD_VALUE]: 'initial' })])
  })

  afterAll(async () => {
    try { svc?.shutdown() } catch { /* noop */ }
    await q('DELETE FROM meta_automation_event_fires WHERE rule_id = ANY($1::text[])', [ruleIds]).catch(() => {})
    await q('DELETE FROM multitable_automation_executions WHERE rule_id = ANY($1::text[])', [ruleIds]).catch(() => {})
    await q('DELETE FROM automation_rules WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('redelivery with the same _eventId claims once and executes once', async () => {
    const rule = await createRule(svc, 'same-event')
    ruleIds.push(rule.id)

    const payload = { sheetId: SHEET, recordId: REC, data: { [FLD_VALUE]: 'x' }, actorId: ACTOR, _eventId: 'evt_same' }
    await svc.handleEvent('multitable.record.created', payload)
    await svc.handleEvent('multitable.record.created', payload)

    expect(await ledgerCount(rule.id)).toBe(1)
    expect(await executionCount(rule.id)).toBe(1)
  })

  test('different _eventId values are legitimate new deliveries', async () => {
    const rule = await createRule(svc, 'different-event')
    ruleIds.push(rule.id)

    await svc.handleEvent('multitable.record.created', { sheetId: SHEET, recordId: REC, data: {}, actorId: ACTOR, _eventId: 'evt_a' })
    await svc.handleEvent('multitable.record.created', { sheetId: SHEET, recordId: REC, data: {}, actorId: ACTOR, _eventId: 'evt_b' })

    expect(await ledgerCount(rule.id)).toBe(2)
    expect(await executionCount(rule.id)).toBe(2)
  })

  test('absent _eventId fails open during rollout', async () => {
    const rule = await createRule(svc, 'absent-event-id')
    ruleIds.push(rule.id)

    await svc.handleEvent('multitable.record.created', { sheetId: SHEET, recordId: REC, data: {}, actorId: ACTOR })
    await svc.handleEvent('multitable.record.created', { sheetId: SHEET, recordId: REC, data: {}, actorId: ACTOR })

    expect(await ledgerCount(rule.id)).toBe(0)
    expect(await executionCount(rule.id)).toBe(2)
  })

  test('field.value_changed rides record.updated and dedups on the underlying event id', async () => {
    const rule = await createRule(svc, 'field-value', 'field.value_changed', { fieldId: FLD_VALUE, condition: 'any' })
    ruleIds.push(rule.id)

    const payload = { sheetId: SHEET, recordId: REC, changes: { [FLD_VALUE]: 'changed' }, actorId: ACTOR, _eventId: 'evt_field' }
    await svc.handleEvent('multitable.record.updated', payload)
    await svc.handleEvent('multitable.record.updated', payload)

    expect(await ledgerCount(rule.id)).toBe(1)
    expect(await executionCount(rule.id)).toBe(1)
  })

  test('the same event id claims independently per sibling rule', async () => {
    const first = await createRule(svc, 'sibling-a')
    const second = await createRule(svc, 'sibling-b')
    ruleIds.push(first.id, second.id)

    await svc.handleEvent('multitable.record.created', { sheetId: SHEET, recordId: REC, data: {}, actorId: ACTOR, _eventId: 'evt_sibling' })

    expect(await ledgerCount(first.id)).toBe(1)
    expect(await ledgerCount(second.id)).toBe(1)
    expect(await executionCount(first.id)).toBe(1)
    expect(await executionCount(second.id)).toBe(1)
  })

  test('real record-service emit site stamps _eventId', async () => {
    const captured: unknown[] = []
    const bus = new EventBus()
    bus.subscribe('multitable.record.created', (payload) => captured.push(payload))

    const service = new RecordService(recordPoolAdapter() as never, bus)
    const result = await service.createRecord({
      sheetId: SHEET,
      data: { [FLD_VALUE]: 'wire' },
      actorId: ACTOR,
      capabilities: fullCapabilities,
    })

    expect(result.recordId).toEqual(expect.any(String))
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      sheetId: SHEET,
      recordId: result.recordId,
      data: { [FLD_VALUE]: 'wire' },
      actorId: ACTOR,
      _eventId: expect.any(String),
    })
  })
})
