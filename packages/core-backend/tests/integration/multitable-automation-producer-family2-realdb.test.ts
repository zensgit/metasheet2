/**
 * P2 durable-delivery P1#2c — producer family 2 (executor Class-A record actions) REPLACE goldens (real DB).
 *
 * Family 3's goldens covered the shared seam (`enqueueRecordEventIfDurable`); THESE goldens prove the
 * executor SITE wiring through the REAL production path — `AutomationService.executeRule(...)` with the
 * constructor's real `deps.transaction` — for all three Class-A record events:
 *
 *   F2-G1  flag ON  + create_record  → ONE outbox row (`multitable.record.created`) fanned out to exactly
 *          [automation-record-trigger, webhook-event-bridge] (pending), committed WITH the record; the
 *          legacy bus emit is SUPPRESSED (spy sees nothing).
 *   F2-G2  flag ON  + update_record  → same for `multitable.record.updated`.
 *   F2-G3  flag ON  + delete_record  → same for `multitable.record.deleted`.
 *   F2-G4  flag OFF → the legacy post-commit emit fires with the same payload shape (byte-identical legacy
 *          path) and ZERO outbox rows exist — the REPLACE guard's other leg.
 *   F2-G5  ATOMICITY: a Postgres-level failure injected into the revision INSERT rolls back the WHOLE
 *          transaction — the record write AND the outbox enqueue vanish together (no half-delivery).
 *   F2-G6  REPLAY: with the Class-A claim flag also ON, a replay on the same lineage root short-circuits as
 *          `alreadyApplied` — and enqueues NO second outbox row (a replayed action must produce zero
 *          downstream deliveries, mirroring how the legacy emit is skipped).
 *
 * Rows are asserted by this run's own record ids (payload->>'recordId') — never drained — so this suite
 * cannot claim a sibling suite's rows on the shared CI DB. Two-point wired (vitest.config exclude +
 * plugin-tests.yml run-list).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { EventBus } from '../../src/integration/events/event-bus'
import { AutomationService } from '../../src/multitable/automation-service'
import { db } from '../../src/db/db'
import type { AutomationExecution, AutomationRule } from '../../src/multitable/automation-executor'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const DURABLE_FLAG = 'AUTOMATION_DURABLE_DELIVERY_ENABLED'
const CLASSA_FLAG = 'AUTOMATION_CLASSA_CLAIM_ENABLED'
const TS = Date.now()
const OWNER = `u_f2_owner_${TS}`
const BASE = `base_f2_${TS}`
const SHEET = `sheet_f2_${TS}`
const FLD = `fld_f2_title_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

/** Real production wiring — mirrors index.ts (real queryFn; constructor hard-wires deps.transaction). The
 * bus is OURS so the suppression spy observes exactly what production subscribers would receive. */
function realService(bus: EventBus): AutomationService {
  const pool = poolManager.get()
  return new AutomationService(bus, db as never, pool.query.bind(pool))
}

function ruleFor(
  sheetId: string,
  action: { type: 'create_record' | 'update_record' | 'delete_record'; config: Record<string, unknown> },
): AutomationRule {
  return {
    id: `atr_f2_${TS}_${Math.random().toString(36).slice(2, 8)}`,
    name: 'Family-2 rule',
    sheetId,
    trigger: { type: 'record.created', config: {} },
    actions: [action as never],
    enabled: true,
    createdBy: OWNER,
    createdAt: new Date().toISOString(),
  } as unknown as AutomationRule
}

interface OutboxRow {
  id: string
  event_type: string
  payload: Record<string, unknown>
  consumers: string[]
}

/** This run's outbox rows for a record id — joined to their consumer fan-out, never drained. */
const outboxRowsForRecord = async (recordId: string): Promise<OutboxRow[]> =>
  (
    await q(
      `SELECT o.id, o.event_type, o.payload,
              ARRAY(SELECT c.consumer_key FROM meta_automation_outbox_consumer c
                     WHERE c.outbox_id = o.id ORDER BY c.consumer_key) AS consumers
         FROM meta_automation_outbox o
        WHERE o.payload->>'recordId' = $1
        ORDER BY o.created_at`,
      [recordId],
    )
  ).rows as unknown as OutboxRow[]

const consumerStatuses = async (outboxId: string): Promise<string[]> =>
  (
    (await q('SELECT status FROM meta_automation_outbox_consumer WHERE outbox_id = $1', [outboxId])).rows as Array<{
      status: string
    }>
  ).map((r) => r.status)

/** Record-event spy on the REAL bus the service emits into. */
function spyRecordEvents(bus: EventBus): Array<{ type: string; payload: Record<string, unknown> }> {
  const seen: Array<{ type: string; payload: Record<string, unknown> }> = []
  for (const t of ['multitable.record.created', 'multitable.record.updated', 'multitable.record.deleted']) {
    bus.subscribe(t, (p: unknown) => {
      seen.push({ type: t, payload: p as Record<string, unknown> })
    })
  }
  return seen
}

async function createViaRule(svc: AutomationService, title: string): Promise<{ recordId: string; execution: AutomationExecution }> {
  const execution = await svc.executeRule(
    ruleFor(SHEET, { type: 'create_record', config: { sheetId: SHEET, data: { [FLD]: title } } }),
    { actorId: OWNER, data: {} },
  )
  expect(execution.status).toBe('success')
  return { recordId: (execution.steps[0]?.output as { recordId: string }).recordId, execution }
}

describeIfDatabase('P1#2c — producer family 2: executor Class-A record events REPLACE (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE, 'F2 Base', OWNER])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'F2 Sheet'])
    await q(`INSERT INTO meta_fields (id, sheet_id, name, type, "order") VALUES ($1,$2,'Title','string',0)`, [FLD, SHEET])
  })

  afterEach(() => {
    delete process.env[DURABLE_FLAG]
    delete process.env[CLASSA_FLAG]
  })

  afterAll(async () => {
    await q(
      `DELETE FROM meta_automation_outbox
        WHERE payload->>'recordId' IN (SELECT id FROM meta_records WHERE sheet_id = $1)
           OR payload->>'sheetId' = $1`,
      [SHEET],
    ).catch(() => {})
    await q(
      'DELETE FROM meta_record_revisions WHERE record_id IN (SELECT id FROM meta_records WHERE sheet_id = $1)',
      [SHEET],
    ).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  test('sentinel: DATABASE_URL is set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // F2-G1 — create_record ──────────────────────────────────────────────────────────────────────────────
  test('F2-G1 flag ON create_record: same-txn outbox row + exact fan-out; legacy emit SUPPRESSED', async () => {
    process.env[DURABLE_FLAG] = 'true'
    const bus = new EventBus()
    const seen = spyRecordEvents(bus)
    const { recordId } = await createViaRule(realService(bus), 'g1')

    const rows = await outboxRowsForRecord(recordId)
    expect(rows).toHaveLength(1)
    expect(rows[0].event_type).toBe('multitable.record.created')
    expect(rows[0].consumers).toEqual(['automation-record-trigger', 'webhook-event-bridge'])
    expect(await consumerStatuses(rows[0].id)).toEqual(['pending', 'pending'])
    expect(rows[0].payload).toMatchObject({ sheetId: SHEET, recordId, actorId: OWNER })
    expect(typeof rows[0].payload._eventId).toBe('string')
    // REPLACE leg: the durable enqueue is the ONLY path — the legacy post-commit emit stayed silent.
    expect(seen).toHaveLength(0)
  })

  // F2-G2 — update_record ──────────────────────────────────────────────────────────────────────────────
  test('F2-G2 flag ON update_record: same-txn outbox row + exact fan-out; legacy emit SUPPRESSED', async () => {
    const { recordId } = await createViaRule(realService(new EventBus()), 'g2-v1') // setup create runs flag-OFF
    process.env[DURABLE_FLAG] = 'true'
    const bus = new EventBus()
    const seen = spyRecordEvents(bus)
    const exec = await realService(bus).executeRule(
      ruleFor(SHEET, { type: 'update_record', config: { fields: { [FLD]: 'g2-v2' } } }),
      { recordId, actorId: OWNER, data: {} },
    )
    expect(exec.status).toBe('success')

    const rows = (await outboxRowsForRecord(recordId)).filter((r) => r.event_type === 'multitable.record.updated')
    expect(rows).toHaveLength(1)
    expect(rows[0].consumers).toEqual(['automation-record-trigger', 'webhook-event-bridge'])
    expect(rows[0].payload).toMatchObject({ sheetId: SHEET, recordId, changes: { [FLD]: 'g2-v2' } })
    expect(seen).toHaveLength(0)
  })

  // F2-G3 — delete_record ──────────────────────────────────────────────────────────────────────────────
  test('F2-G3 flag ON delete_record: same-txn outbox row + exact fan-out; legacy emit SUPPRESSED', async () => {
    const { recordId } = await createViaRule(realService(new EventBus()), 'g3')
    process.env[DURABLE_FLAG] = 'true'
    const bus = new EventBus()
    const seen = spyRecordEvents(bus)
    const exec = await realService(bus).executeRule(
      ruleFor(SHEET, { type: 'delete_record', config: {} }),
      { recordId, actorId: OWNER, data: {} },
    )
    expect(exec.status).toBe('success')

    const rows = (await outboxRowsForRecord(recordId)).filter((r) => r.event_type === 'multitable.record.deleted')
    expect(rows).toHaveLength(1)
    expect(rows[0].consumers).toEqual(['automation-record-trigger', 'webhook-event-bridge'])
    expect(seen).toHaveLength(0)
  })

  // F2-G4 — flag OFF: byte-identical legacy path ───────────────────────────────────────────────────────
  test('F2-G4 flag OFF: legacy post-commit emit fires (same shape) and ZERO outbox rows exist', async () => {
    const bus = new EventBus()
    const seen = spyRecordEvents(bus)
    const { recordId } = await createViaRule(realService(bus), 'g4')

    expect(seen).toHaveLength(1)
    expect(seen[0].type).toBe('multitable.record.created')
    expect(seen[0].payload).toMatchObject({ sheetId: SHEET, recordId, actorId: OWNER })
    expect(typeof seen[0].payload._eventId).toBe('string')
    expect(seen[0].payload._automationDepth).toBe(1)
    expect(await outboxRowsForRecord(recordId)).toHaveLength(0)
  })

  // F2-G5 — atomicity under genuine Postgres failure ───────────────────────────────────────────────────
  test('F2-G5 flag ON: a revision-INSERT failure rolls back record AND outbox together (no half-delivery)', async () => {
    process.env[DURABLE_FLAG] = 'true'
    const marker = `g5-crash-${TS}`
    await q(`CREATE OR REPLACE FUNCTION f2_g5_fail() RETURNS trigger AS $fn$
             BEGIN
               RAISE EXCEPTION 'f2 g5 injected revision failure' USING ERRCODE = 'P0001';
             END $fn$ LANGUAGE plpgsql`)
    await q(`CREATE TRIGGER f2_g5_fail_trg BEFORE INSERT ON meta_record_revisions
             FOR EACH ROW WHEN (NEW.snapshot->>'${FLD}' = '${marker}') EXECUTE FUNCTION f2_g5_fail()`)
    try {
      const exec = await realService(new EventBus()).executeRule(
        ruleFor(SHEET, { type: 'create_record', config: { sheetId: SHEET, data: { [FLD]: marker } } }),
        { actorId: OWNER, data: {} },
      )
      expect(exec.steps[0]?.status).toBe('failed')
      // The whole transaction — record, revision, AND the durable enqueue — rolled back together. Scoped
      // to THIS test's marker (earlier goldens in this suite legitimately committed sheet-scoped rows).
      const orphaned = await q(
        `SELECT o.id FROM meta_automation_outbox o WHERE o.payload->'data'->>'${FLD}' = $1`,
        [marker],
      )
      const half = await q(`SELECT id FROM meta_records WHERE sheet_id = $1 AND data->>'${FLD}' = $2`, [SHEET, marker])
      expect(orphaned.rows.length + half.rows.length).toBe(0)
    } finally {
      await q('DROP TRIGGER IF EXISTS f2_g5_fail_trg ON meta_record_revisions').catch(() => {})
      await q('DROP FUNCTION IF EXISTS f2_g5_fail()').catch(() => {})
    }
  })

  // F2-G6 — replay produces zero second delivery ───────────────────────────────────────────────────────
  test('F2-G6 flag ON + Class-A claim ON: a replay on the same root enqueues NO second outbox row', async () => {
    process.env[DURABLE_FLAG] = 'true'
    process.env[CLASSA_FLAG] = 'true'
    const svc = realService(new EventBus())
    const rule = ruleFor(SHEET, { type: 'create_record', config: { sheetId: SHEET, data: { [FLD]: 'g6' } } })
    const first = await svc.executeRule(rule, { actorId: OWNER, data: {} })
    expect(first.status).toBe('success')
    const recordId = (first.steps[0]?.output as { recordId: string }).recordId
    expect(await outboxRowsForRecord(recordId)).toHaveLength(1)

    const second = await svc.executeRule(rule, {
      actorId: OWNER,
      data: {},
    }, {
      rerunOfExecutionId: first.id,
      initiatedBy: OWNER,
      rootExecutionId: first.id,
    })
    expect(second.status).toBe('success')
    expect(second.steps[0]?.alreadyApplied).toBe(true)
    // The duplicate-claim early-return skipped the enqueue exactly as it skips the legacy emit.
    expect(await outboxRowsForRecord(recordId)).toHaveLength(1)
  })
})
