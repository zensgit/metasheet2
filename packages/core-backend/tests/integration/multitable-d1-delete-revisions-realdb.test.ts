/**
 * Global History D-1 — automation/plugin-SDK hard deletes must append delete revisions (real DB).
 *
 * D-1 is revision-only: it fixes point-in-time correctness for the two hard-delete side doors that
 * previously removed `meta_records` rows without an `action='delete'` row in `meta_record_revisions`.
 * It deliberately does NOT add trash, tombstone capture, or recoverability (those are D-2).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { EventBus } from '../../src/integration/events/event-bus'
import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationRule,
} from '../../src/multitable/automation-executor'
import { deleteRecord, type MultitableRecordsQueryFn } from '../../src/multitable/records'
import { reconstructRecordsAtT } from '../../src/multitable/record-reconstructor'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_d1_del_${TS}`
const SHEET = `sheet_d1_del_${TS}`
const FIELD_NAME = `field_d1_del_${TS}_name`
const ACTOR = `u_d1_del_${TS}`
const CREATE_T = '2026-01-01T00:00:00.000Z'
const BEFORE_DELETE_T = '2026-01-02T00:00:00.000Z'

const q = (sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params)

function wrapQuery(query: (sqlText: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>): MultitableRecordsQueryFn {
  return async (sqlText, params) => {
    const result = await query(sqlText, params)
    return {
      rows: Array.isArray((result as { rows?: unknown[] }).rows) ? (result as { rows: unknown[] }).rows : [],
      rowCount: typeof (result as { rowCount?: number }).rowCount === 'number' ? (result as { rowCount: number }).rowCount : undefined,
    }
  }
}

function transaction<T>(handler: (client: { query: MultitableRecordsQueryFn }) => Promise<T>): Promise<T> {
  return poolManager.get().transaction(async ({ query }) => handler({ query: wrapQuery(query) }))
}

function makeExecutor(): AutomationExecutor {
  const deps: AutomationDeps = {
    eventBus: new EventBus(),
    queryFn: (sqlText, params) => q(sqlText, params),
    transaction: async (handler) => transaction(handler),
  }
  return new AutomationExecutor(deps)
}

function deleteRule(): AutomationRule {
  return {
    id: `rule_d1_del_${TS}_${Math.random().toString(36).slice(2)}`,
    name: 'D1 delete',
    sheetId: SHEET,
    trigger: { type: 'record.updated', config: {} },
    actions: [{ type: 'delete_record', config: {} }],
    enabled: true,
    createdBy: ACTOR,
    createdAt: new Date().toISOString(),
  } as unknown as AutomationRule
}

async function insertRecord(recordId: string, data: Record<string, unknown>, version = 1): Promise<void> {
  await q(
    'INSERT INTO meta_records (id, sheet_id, data, version, locked) VALUES ($1,$2,$3::jsonb,$4,false)',
    [recordId, SHEET, JSON.stringify(data), version],
  )
}

async function seedCreateRevision(recordId: string, data: Record<string, unknown>, version = 1): Promise<void> {
  await q(
    `INSERT INTO meta_record_revisions
       (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'create', 'rest', ARRAY['name']::text[], '{}'::jsonb, $4::jsonb, $5)`,
    [SHEET, recordId, version, JSON.stringify(data), CREATE_T],
  )
}

async function latestRevision(recordId: string): Promise<{ action: string; source: string; version: number; snapshot: Record<string, unknown> | null } | undefined> {
  const res = await q(
    `SELECT action, source, version, snapshot
       FROM meta_record_revisions
      WHERE sheet_id = $1 AND record_id = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [SHEET, recordId],
  )
  return res.rows[0] as { action: string; source: string; version: number; snapshot: Record<string, unknown> | null } | undefined
}

async function recordExists(recordId: string): Promise<boolean> {
  const res = await q('SELECT 1 FROM meta_records WHERE id = $1 AND sheet_id = $2', [recordId, SHEET])
  return Boolean(res.rows[0])
}

async function deleteRevisionCount(recordId: string): Promise<number> {
  const res = await q(
    "SELECT COUNT(*)::int AS n FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2 AND action = 'delete'",
    [SHEET, recordId],
  )
  return Number((res.rows[0] as { n?: number } | undefined)?.n ?? 0)
}

async function afterDeleteState(recordId: string) {
  return reconstructRecordsAtT(q, SHEET, new Date(Date.now() + 1_000).toISOString(), [recordId])
}

async function linkCount(recordId: string): Promise<number> {
  const res = await q(
    'SELECT COUNT(*)::int AS n FROM meta_links WHERE record_id = $1 OR foreign_record_id = $1',
    [recordId],
  )
  return Number((res.rows[0] as { n?: number } | undefined)?.n ?? 0)
}

describeIfDatabase('Global History D-1 uncaptured hard-delete revisions (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE, 'D1 Delete Base', ACTOR])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'D1 Delete Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
      FIELD_NAME,
      SHEET,
      'Name',
      'string',
      '{}',
      1,
    ])
    await q(
      `CREATE OR REPLACE FUNCTION d1_delete_revision_fail_${TS}()
       RETURNS trigger AS $$
       BEGIN
         IF NEW.action = 'delete' AND NEW.record_id LIKE 'rec_d1_${TS}_fail_%' THEN
           RAISE EXCEPTION 'forced D1 delete revision failure';
         END IF;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`,
    )
    await q('DROP TRIGGER IF EXISTS d1_delete_revision_fail_trigger ON meta_record_revisions')
    await q(
      `CREATE TRIGGER d1_delete_revision_fail_trigger
       BEFORE INSERT ON meta_record_revisions
       FOR EACH ROW EXECUTE FUNCTION d1_delete_revision_fail_${TS}()`,
    )
    // D1-5b (review P2-1): fail the RECORD DELETE step itself — the LAST statement of the delete flow —
    // so the earlier same-flow writes (link purge + delete revision) MUST roll back for the golden to
    // pass. The original D1-5 pair injects at the revision INSERT, which precedes the DELETE: nothing
    // after it has run yet, so those tests pass with or without a transaction. This trigger is what makes
    // the withTransaction plumbing observable: neuter it into a sequential fallback and these goldens go
    // red (a delete revision committed for a record that still exists = the exact half-state D-1 must
    // never produce, plus the seeded inbound link vanishes).
    await q(
      `CREATE OR REPLACE FUNCTION d1_record_delete_fail_${TS}()
       RETURNS trigger AS $$
       BEGIN
         IF OLD.id LIKE 'rec_d1_${TS}_txfail_%' THEN
           RAISE EXCEPTION 'forced D1 record delete failure';
         END IF;
         RETURN OLD;
       END;
       $$ LANGUAGE plpgsql`,
    )
    await q('DROP TRIGGER IF EXISTS d1_record_delete_fail_trigger ON meta_records')
    await q(
      `CREATE TRIGGER d1_record_delete_fail_trigger
       BEFORE DELETE ON meta_records
       FOR EACH ROW EXECUTE FUNCTION d1_record_delete_fail_${TS}()`,
    )
  })

  afterEach(async () => {
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_links WHERE record_id LIKE $1 OR foreign_record_id LIKE $1', [`rec_d1_${TS}_%`]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
  })

  afterAll(async () => {
    await q('DROP TRIGGER IF EXISTS d1_delete_revision_fail_trigger ON meta_record_revisions').catch(() => {})
    await q(`DROP FUNCTION IF EXISTS d1_delete_revision_fail_${TS}()`).catch(() => {})
    await q('DROP TRIGGER IF EXISTS d1_record_delete_fail_trigger ON meta_records').catch(() => {})
    await q(`DROP FUNCTION IF EXISTS d1_record_delete_fail_${TS}()`).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
      throw new Error('real-DB allowlist step is missing DATABASE_URL')
    }
    expect(true).toBe(true)
  })

  test('D1-1/D1-3/D1-4: automation delete_record writes source=automation delete revision and PIT excludes it after delete only', async () => {
    const recordId = `rec_d1_${TS}_auto`
    const snapshot = { name: 'automation-delete', value: 7 }
    await insertRecord(recordId, snapshot, 3)
    await seedCreateRevision(recordId, snapshot, 3)

    expect((await reconstructRecordsAtT(q, SHEET, BEFORE_DELETE_T, [recordId])).get(recordId)).toMatchObject({
      exists: true,
      data: snapshot,
    })

    const execution = await makeExecutor().execute(deleteRule(), { sheetId: SHEET, recordId, actorId: ACTOR, data: snapshot })
    expect(execution.steps[0]?.status).toBe('success')
    expect(await recordExists(recordId)).toBe(false)

    expect(await latestRevision(recordId)).toMatchObject({
      action: 'delete',
      source: 'automation',
      version: 3,
      snapshot,
    })
    expect((await afterDeleteState(recordId)).get(recordId)).toMatchObject({ exists: false, data: null })
  })

  test('D1-2/D1-3/D1-4: plugin-SDK deleteRecord writes source=plugin delete revision and PIT excludes it after delete only', async () => {
    const recordId = `rec_d1_${TS}_plugin`
    const snapshot = { name: 'plugin-delete', nested: { ok: true } }
    await insertRecord(recordId, snapshot, 2)
    await seedCreateRevision(recordId, snapshot, 2)

    expect((await reconstructRecordsAtT(q, SHEET, BEFORE_DELETE_T, [recordId])).get(recordId)).toMatchObject({
      exists: true,
      data: snapshot,
    })

    await transaction(({ query }) => deleteRecord({ query, sheetId: SHEET, recordId }))
    expect(await recordExists(recordId)).toBe(false)

    expect(await latestRevision(recordId)).toMatchObject({
      action: 'delete',
      source: 'plugin',
      version: 2,
      snapshot,
    })
    expect((await afterDeleteState(recordId)).get(recordId)).toMatchObject({ exists: false, data: null })
  })

  test('D1-5: automation revision failure rolls back the hard delete and writes no delete revision', async () => {
    const recordId = `rec_d1_${TS}_fail_auto`
    const snapshot = { name: 'automation-atomicity' }
    await insertRecord(recordId, snapshot, 1)
    await seedCreateRevision(recordId, snapshot, 1)

    const execution = await makeExecutor().execute(deleteRule(), { sheetId: SHEET, recordId, actorId: ACTOR, data: snapshot })
    expect(execution.steps[0]?.status).toBe('failed')
    expect(execution.steps[0]?.error).toContain('forced D1 delete revision failure')
    expect(await recordExists(recordId)).toBe(true)
    expect(await deleteRevisionCount(recordId)).toBe(0)
  })

  test('D1-5: plugin-SDK revision failure rolls back the hard delete and writes no delete revision', async () => {
    const recordId = `rec_d1_${TS}_fail_plugin`
    const snapshot = { name: 'plugin-atomicity' }
    await insertRecord(recordId, snapshot, 1)
    await seedCreateRevision(recordId, snapshot, 1)

    await expect(transaction(({ query }) => deleteRecord({ query, sheetId: SHEET, recordId }))).rejects.toThrow('forced D1 delete revision failure')
    expect(await recordExists(recordId)).toBe(true)
    expect(await deleteRevisionCount(recordId)).toBe(0)
  })

  // ── D1-5b (adversarial-review P2-1): the DELETE step itself fails ───────────────────────────────────
  // The D1-5 pair above injects at the revision INSERT, which runs BEFORE the record DELETE — nothing
  // later has executed, so those goldens pass with or without a transaction (mutation-verified: neutering
  // withTransaction left the whole suite green). These two pin the transaction plumbing itself: the
  // failure fires at the LAST statement, so the earlier link purge and delete revision MUST roll back.
  // A sequential (non-transactional) implementation commits both → deleteRevisionCount===1 for a record
  // that still exists (a PIT "record is dead" lie, worse than the original defect) and the link vanishes.

  test('D1-5b: automation record-DELETE failure rolls back the delete revision AND the link purge (true atomicity)', async () => {
    const recordId = `rec_d1_${TS}_txfail_auto`
    const neighborId = `rec_d1_${TS}_nb_auto`
    const snapshot = { name: 'automation-tx-atomicity' }
    await insertRecord(recordId, snapshot, 1)
    await insertRecord(neighborId, { name: 'neighbor' }, 1)
    await seedCreateRevision(recordId, snapshot, 1)
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [
      `lnk_d1_${TS}_auto`,
      FIELD_NAME,
      neighborId,
      recordId,
    ])
    expect(await linkCount(recordId)).toBe(1)

    const execution = await makeExecutor().execute(deleteRule(), { sheetId: SHEET, recordId, actorId: ACTOR, data: snapshot })
    expect(execution.steps[0]?.status).toBe('failed')
    expect(execution.steps[0]?.error).toContain('forced D1 record delete failure')

    expect(await recordExists(recordId)).toBe(true)
    expect(await deleteRevisionCount(recordId)).toBe(0) // revision rolled back with the txn
    expect(await linkCount(recordId)).toBe(1) // link purge rolled back with the txn
  })

  test('D1-5b: plugin-SDK record-DELETE failure rolls back the delete revision AND the link purge (true atomicity)', async () => {
    const recordId = `rec_d1_${TS}_txfail_plugin`
    const neighborId = `rec_d1_${TS}_nb_plugin`
    const snapshot = { name: 'plugin-tx-atomicity' }
    await insertRecord(recordId, snapshot, 1)
    await insertRecord(neighborId, { name: 'neighbor' }, 1)
    await seedCreateRevision(recordId, snapshot, 1)
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [
      `lnk_d1_${TS}_plugin`,
      FIELD_NAME,
      neighborId,
      recordId,
    ])
    expect(await linkCount(recordId)).toBe(1)

    await expect(transaction(({ query }) => deleteRecord({ query, sheetId: SHEET, recordId }))).rejects.toThrow('forced D1 record delete failure')

    expect(await recordExists(recordId)).toBe(true)
    expect(await deleteRevisionCount(recordId)).toBe(0)
    expect(await linkCount(recordId)).toBe(1)
  })
})
