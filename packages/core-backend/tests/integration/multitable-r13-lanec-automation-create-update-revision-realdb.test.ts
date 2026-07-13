/**
 * R13 Lane C (automation create/update + result-writeback) — sites 1 & 2:
 *
 *   1. `automation-executor.ts` `executeCreateRecord` (`create_record` action) — bare INSERT, no revision.
 *   2. `automation-executor.ts` `executeUpdateRecord` (`update_record` action) — bare UPDATE, no revision.
 *
 * Per the RATIFIED design-lock (docs/development/multitable-global-history-d1c-form-submit-edit-
 * uncaptured-revision-design-lock-20260712.md, §0.5 OD-1..OD-6) these are 2 of the 8 "bucket-A" content
 * paths that mutate `meta_records` with NO `meta_record_revisions` row — so `reconstructRecordsAtT` (the
 * primitive under PIT view / revert / reset) never learns these writes happened. An automation-created
 * record is invisible to PIT forever (D-1c §0/§7a A4); an automation-updated record reverts to its stale
 * pre-update value under Reset-to-T (same class as D-1c's form-submit EDIT bug).
 *
 * Fix (mirrors D-1's `executeDeleteRecord`): `recordRecordRevision(...)` now runs in the SAME
 * `withTransaction(...)` as the INSERT/UPDATE — source='automation' (OD-2), actorId=context.actorId
 * (OD-3), full post-write snapshot (not the patch).
 *
 * Harness fidelity: `makeExecutor()` wires `deps.transaction` to a REAL `poolManager.get().transaction(...)`
 * (mirrors `multitable-d1-delete-revisions-realdb.test.ts`'s pattern) — this is the production shape
 * (`AutomationService`'s constructor hard-wires the identical adapter), so the atomicity goldens below
 * exercise a REAL Postgres transaction, not merely a sequential no-op fallback.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { EventBus } from '../../src/integration/events/event-bus'
import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationRule,
} from '../../src/multitable/automation-executor'
import { reconstructRecordsAtT } from '../../src/multitable/record-reconstructor'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE = `base_r13c_cu_${TS}`
const SHEET = `sheet_r13c_cu_${TS}`
const FIELD_A = `fld_r13c_cu_a_${TS}`
const FIELD_B = `fld_r13c_cu_b_${TS}`
const ACTOR = `u_r13c_cu_${TS}`

const q = (sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params)

function transaction<T>(handler: (client: { query: typeof q }) => Promise<T>): Promise<T> {
  return poolManager.get().transaction(async ({ query }) => handler({ query: (sqlText, params) => query(sqlText, params) as never }))
}

function makeExecutor(): AutomationExecutor {
  const deps: AutomationDeps = {
    eventBus: new EventBus(),
    queryFn: (sqlText, params) => q(sqlText, params),
    transaction: async (handler) => transaction((client) => handler(client)),
  }
  return new AutomationExecutor(deps)
}

function createRule(data: Record<string, unknown>, config: Record<string, unknown> = {}): AutomationRule {
  return {
    id: `axr_r13c_create_${TS}_${Math.random().toString(36).slice(2, 8)}`,
    name: 'R13C create rule',
    sheetId: SHEET,
    trigger: { type: 'record.created', config: {} },
    actions: [{ type: 'create_record', config: { data, ...config } } as never],
    enabled: true,
    createdBy: ACTOR,
    createdAt: new Date().toISOString(),
  } as unknown as AutomationRule
}

function updateRule(fields: Record<string, unknown>): AutomationRule {
  return {
    id: `axr_r13c_update_${TS}_${Math.random().toString(36).slice(2, 8)}`,
    name: 'R13C update rule',
    sheetId: SHEET,
    trigger: { type: 'record.updated', config: {} },
    actions: [{ type: 'update_record', config: { fields } } as never],
    enabled: true,
    createdBy: ACTOR,
    createdAt: new Date().toISOString(),
  } as unknown as AutomationRule
}

async function insertRecord(recordId: string, data: Record<string, unknown>, version = 1): Promise<void> {
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,$4)', [
    recordId,
    SHEET,
    JSON.stringify(data),
    version,
  ])
}

async function seedCreateRevision(recordId: string, data: Record<string, unknown>, version = 1): Promise<void> {
  await q(
    `INSERT INTO meta_record_revisions
       (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'create', 'rest', ARRAY[]::text[], '{}'::jsonb, $4::jsonb, $5)`,
    [SHEET, recordId, version, JSON.stringify(data), '2026-01-01T00:00:00.000Z'],
  )
}

async function revisionsFor(recordId: string): Promise<Array<{ action: string; source: string; version: number; actor_id: string | null; changed_field_ids: string[]; snapshot: Record<string, unknown> | null }>> {
  const res = await q(
    `SELECT action, source, version, actor_id, changed_field_ids, snapshot
       FROM meta_record_revisions
      WHERE sheet_id = $1 AND record_id = $2
      ORDER BY created_at ASC, id ASC`,
    [SHEET, recordId],
  )
  return res.rows as never[]
}

async function recordRow(recordId: string): Promise<{ version: number; data: Record<string, unknown> } | undefined> {
  const res = await q('SELECT version, data FROM meta_records WHERE id = $1 AND sheet_id = $2', [recordId, SHEET])
  return res.rows[0] as never
}

// Derive PIT cutoffs from the DATABASE's own clock (never the test process's `Date.now()`) — mirrors
// `multitable-d1-delete-revisions-realdb.test.ts`'s `revisionCutoffAfter`. A JS-side timestamp captured
// "just before" an action races the DB's `now()` (container clock skew, scheduling jitter) and can land
// on either side of the revision's actual `created_at`, making a PIT before/after assertion flaky.
async function revisionCutoffAfter(recordId: string, action: 'create' | 'update'): Promise<string> {
  const res = await q(
    `SELECT (created_at + interval '1 microsecond')::text AS as_of
       FROM meta_record_revisions
      WHERE sheet_id = $1 AND record_id = $2 AND action = $3
      ORDER BY created_at DESC, version DESC, id DESC
      LIMIT 1`,
    [SHEET, recordId, action],
  )
  expect(res.rows).toHaveLength(1)
  return String((res.rows[0] as { as_of: string }).as_of)
}

// A fixed point safely before any revision this suite ever writes (all fixtures are TS-suffixed to the
// current run) — used for "no history existed yet" assertions where deriving from the DB clock isn't
// applicable (there is no revision at all to derive a cutoff from).
const FAR_PAST = '2020-01-01T00:00:00.000Z'

describeIfDatabase('R13 Lane C — automation create_record/update_record now emit same-txn revisions (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE, 'R13C Base', ACTOR])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'R13C Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, "order") VALUES ($1,$2,$3,$4,$5)', [FIELD_A, SHEET, 'A', 'text', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, "order") VALUES ($1,$2,$3,$4,$5)', [FIELD_B, SHEET, 'B', 'text', 2])

    // Atomicity trigger #1 (CREATE): create_record generates its OWN record id (randomUUID), so it
    // cannot be targeted by id like D-1's delete goldens. Key off a MARKER inside the snapshot content
    // instead (the create's own `data` payload, which becomes the revision snapshot) — fires ONLY for
    // the dedicated atomicity-fail case below, never for the positive-path create golden.
    await q(
      `CREATE OR REPLACE FUNCTION r13c_create_revision_fail_${TS}()
       RETURNS trigger AS $$
       BEGIN
         IF NEW.action = 'create' AND NEW.snapshot->>'marker' = 'r13c_create_atomicity_fail_${TS}' THEN
           RAISE EXCEPTION 'forced R13C create-revision failure';
         END IF;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`,
    )
    await q(`DROP TRIGGER IF EXISTS r13c_create_revision_fail_trigger ON meta_record_revisions`)
    await q(
      `CREATE TRIGGER r13c_create_revision_fail_trigger
       BEFORE INSERT ON meta_record_revisions
       FOR EACH ROW EXECUTE FUNCTION r13c_create_revision_fail_${TS}()`,
    )

    // Atomicity trigger #2 (UPDATE): update_record acts on a PRE-EXISTING, test-controlled record id, so
    // this one keys off `record_id LIKE` exactly like D-1's D1-5b golden.
    await q(
      `CREATE OR REPLACE FUNCTION r13c_update_revision_fail_${TS}()
       RETURNS trigger AS $$
       BEGIN
         IF NEW.action = 'update' AND NEW.record_id LIKE 'rec_r13c_update_txfail_${TS}_%' THEN
           RAISE EXCEPTION 'forced R13C update-revision failure';
         END IF;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`,
    )
    await q(`DROP TRIGGER IF EXISTS r13c_update_revision_fail_trigger ON meta_record_revisions`)
    await q(
      `CREATE TRIGGER r13c_update_revision_fail_trigger
       BEFORE INSERT ON meta_record_revisions
       FOR EACH ROW EXECUTE FUNCTION r13c_update_revision_fail_${TS}()`,
    )
  })

  afterEach(async () => {
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
  })

  afterAll(async () => {
    await q(`DROP TRIGGER IF EXISTS r13c_create_revision_fail_trigger ON meta_record_revisions`).catch(() => {})
    await q(`DROP FUNCTION IF EXISTS r13c_create_revision_fail_${TS}()`).catch(() => {})
    await q(`DROP TRIGGER IF EXISTS r13c_update_revision_fail_trigger ON meta_record_revisions`).catch(() => {})
    await q(`DROP FUNCTION IF EXISTS r13c_update_revision_fail_${TS}()`).catch(() => {})
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

  // ── CREATE (site 1: executeCreateRecord) ──────────────────────────────────────────────────────────

  test('CREATE-1: create_record writes a same-txn action=create source=automation revision with actor + full snapshot', async () => {
    const rule = createRule({ [FIELD_A]: 'auto-created', [FIELD_B]: 'second' })
    const exec = await makeExecutor().execute(rule, { sheetId: SHEET, recordId: '', actorId: ACTOR, data: {} })
    expect(exec.steps[0]?.status).toBe('success')
    const recordId = (exec.steps[0]?.output as { recordId?: string } | undefined)?.recordId
    expect(recordId).toBeTruthy()

    const revs = await revisionsFor(recordId!)
    expect(revs).toHaveLength(1)
    expect(revs[0]).toMatchObject({
      action: 'create',
      source: 'automation',
      version: 1,
      actor_id: ACTOR,
      snapshot: { [FIELD_A]: 'auto-created', [FIELD_B]: 'second' },
    })

    // PIT: before the create, the record did not exist. This is the D-1c §0/§7a A4 defect — an
    // automation-created record was invisible to reconstructRecordsAtT FOREVER (no revision at all).
    const before = await reconstructRecordsAtT(q, SHEET, FAR_PAST, [recordId!])
    expect(before.get(recordId!)?.exists).not.toBe(true)

    // PIT: after the create, reconstructRecordsAtT now sees it — the NEW (only) value, at version 1.
    // Cutoff derived from the DB's own clock (never the test process's), so there is no clock-skew race.
    const afterIso = await revisionCutoffAfter(recordId!, 'create')
    const after = await reconstructRecordsAtT(q, SHEET, afterIso, [recordId!])
    expect(after.get(recordId!)).toMatchObject({
      exists: true,
      version: 1,
      data: { [FIELD_A]: 'auto-created', [FIELD_B]: 'second' },
    })
  })

  test('CREATE-2: cross-base create_record ALSO writes the same-txn create revision, on the TARGET sheet', async () => {
    // Same-base create is exercised above; this pins that the transactional fix is not accidentally
    // scoped only to the same-base branch — the INSERT + revision run identically regardless of which
    // sheet resolves as the write target (both branches share ONE code path in executeCreateRecord).
    const BASE_T = `base_r13c_create_target_${TS}`
    const SHEET_T = `sheet_r13c_create_target_${TS}`
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE_T, 'R13C Create Target Base', ACTOR])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_T, BASE_T, 'R13C Create Target Sheet'])

    const rule: AutomationRule = {
      id: `axr_r13c_xbcreate_${TS}`,
      name: 'R13C xbase create rule',
      sheetId: SHEET,
      trigger: { type: 'record.created', config: {} },
      actions: [{
        type: 'create_record',
        config: { data: { [FIELD_A]: 'auto-created-xbase' }, sheetId: SHEET_T, targetBaseId: BASE_T },
      } as never],
      enabled: true,
      createdBy: ACTOR,
      createdAt: new Date().toISOString(),
    } as unknown as AutomationRule

    const triggerRecordId = `rec_r13c_xbcreate_trigger_${TS}`
    await insertRecord(triggerRecordId, { [FIELD_A]: 'trigger' }, 1)

    const exec = await makeExecutor().execute(rule, { sheetId: SHEET, recordId: triggerRecordId, actorId: ACTOR, data: {} })
    expect(exec.steps[0]?.status).toBe('success')
    const recordId = (exec.steps[0]?.output as { recordId?: string } | undefined)?.recordId
    expect(recordId).toBeTruthy()

    const res = await q(
      `SELECT action, source, version, actor_id, snapshot FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2`,
      [SHEET_T, recordId],
    )
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0]).toMatchObject({
      action: 'create',
      source: 'automation',
      version: 1,
      actor_id: ACTOR,
      snapshot: { [FIELD_A]: 'auto-created-xbase' },
    })

    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_T]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_T]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_T]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_T]).catch(() => {})
  })

  test('CREATE-3 (atomicity, mirrors D1-5b): revision-insert failure rolls back the record INSERT — no half-write', async () => {
    const rule = createRule({ [FIELD_A]: 'should-not-exist', marker: `r13c_create_atomicity_fail_${TS}` })
    const exec = await makeExecutor().execute(rule, { sheetId: SHEET, recordId: '', actorId: ACTOR, data: {} })
    expect(exec.steps[0]?.status).toBe('failed')
    expect(exec.steps[0]?.error).toContain('forced R13C create-revision failure')

    // The INSERT ran inside the SAME transaction as the (failed) revision insert — it must be rolled
    // back. Assert on the WHOLE sheet (the record's id was never returned to the test, by design: this
    // proves NOTHING with the marker payload persisted, not just "the specific id we expected").
    const marked = await q(
      `SELECT COUNT(*)::int AS n FROM meta_records WHERE sheet_id = $1 AND data->>'marker' = $2`,
      [SHEET, `r13c_create_atomicity_fail_${TS}`],
    )
    expect(Number((marked.rows[0] as { n: number }).n)).toBe(0)

    const markedRevisions = await q(
      `SELECT COUNT(*)::int AS n FROM meta_record_revisions WHERE sheet_id = $1 AND snapshot->>'marker' = $2`,
      [SHEET, `r13c_create_atomicity_fail_${TS}`],
    )
    expect(Number((markedRevisions.rows[0] as { n: number }).n)).toBe(0)
  })

  // ── UPDATE (site 2: executeUpdateRecord) ──────────────────────────────────────────────────────────

  test('UPDATE-1: update_record writes a same-txn action=update source=automation revision — snapshot is the FULL merged row, not the patch', async () => {
    const recordId = `rec_r13c_update_${TS}_main`
    await insertRecord(recordId, { [FIELD_A]: 'v1-a', [FIELD_B]: 'v1-b' }, 1)
    await seedCreateRevision(recordId, { [FIELD_A]: 'v1-a', [FIELD_B]: 'v1-b' }, 1)
    // Cutoff derived from the DB's own clock (the seeded create revision's actual stored `created_at`),
    // never the test process's — avoids racing container clock skew.
    const beforeIso = await revisionCutoffAfter(recordId, 'create')

    // Update ONLY field A — pins the D-1c §4.2 merge trap: a naive `snapshot: patch` would truncate
    // field B out of the revision entirely.
    const rule = updateRule({ [FIELD_A]: 'v2-a' })
    const exec = await makeExecutor().execute(rule, { sheetId: SHEET, recordId, actorId: ACTOR, data: {} })
    expect(exec.steps[0]?.status).toBe('success')

    const revs = await revisionsFor(recordId)
    expect(revs).toHaveLength(2) // seeded create + the new update
    const updateRev = revs[1]!
    expect(updateRev).toMatchObject({
      action: 'update',
      source: 'automation',
      version: 2,
      actor_id: ACTOR,
    })
    expect(updateRev.changed_field_ids).toEqual([FIELD_A])
    // THE merge-trap golden: both fields present in the snapshot, not just the patched one.
    expect(updateRev.snapshot).toEqual({ [FIELD_A]: 'v2-a', [FIELD_B]: 'v1-b' })

    // PIT: T before the update still shows the OLD value (new revision must not corrupt earlier T).
    const before = await reconstructRecordsAtT(q, SHEET, beforeIso, [recordId])
    expect(before.get(recordId)).toMatchObject({ exists: true, version: 1, data: { [FIELD_A]: 'v1-a', [FIELD_B]: 'v1-b' } })

    // PIT: T after the update shows the NEW value + NEW version — this is the actual PIT-lie fix. Before
    // this change, reconstructRecordsAtT stayed pinned at v1 forever (the D-1c-class defect).
    const afterIso = await revisionCutoffAfter(recordId, 'update')
    const after = await reconstructRecordsAtT(q, SHEET, afterIso, [recordId])
    expect(after.get(recordId)).toMatchObject({ exists: true, version: 2, data: { [FIELD_A]: 'v2-a', [FIELD_B]: 'v1-b' } })
  })

  test('UPDATE-2: cross-base update_record ALSO writes the same-txn update revision on the TARGET sheet', async () => {
    const BASE_T = `base_r13c_cu_target_${TS}`
    const SHEET_T = `sheet_r13c_cu_target_${TS}`
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE_T, 'R13C Target Base', ACTOR])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_T, BASE_T, 'R13C Target Sheet'])
    const targetRecordId = `rec_r13c_xb_target_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
      targetRecordId,
      SHEET_T,
      JSON.stringify({ [FIELD_A]: 'target-v1' }),
    ])

    const rule: AutomationRule = {
      id: `axr_r13c_xbupdate_${TS}`,
      name: 'R13C xbase update rule',
      sheetId: SHEET,
      trigger: { type: 'record.updated', config: {} },
      actions: [{
        type: 'update_record',
        config: {
          fields: { [FIELD_A]: 'target-v2' },
          targetBaseId: BASE_T,
          targetSheetId: SHEET_T,
          targetRecordId,
        },
      } as never],
      enabled: true,
      createdBy: ACTOR,
      createdAt: new Date().toISOString(),
    } as unknown as AutomationRule

    // ②b cross-base write gate requires trigger-actor base-write on the TARGET base — ACTOR owns BASE_T.
    const triggerRecordId = `rec_r13c_xb_trigger_${TS}`
    await insertRecord(triggerRecordId, { [FIELD_A]: 'trigger' }, 1)

    const exec = await makeExecutor().execute(rule, { sheetId: SHEET, recordId: triggerRecordId, actorId: ACTOR, data: {} })
    expect(exec.steps[0]?.status).toBe('success')

    const res = await q(
      `SELECT action, source, version, actor_id, snapshot FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2`,
      [SHEET_T, targetRecordId],
    )
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0]).toMatchObject({ action: 'update', source: 'automation', version: 2, actor_id: ACTOR })

    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_T]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_T]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_T]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_T]).catch(() => {})
  })

  test('UPDATE-3 (atomicity, mirrors D1-5b): revision-insert failure rolls back the UPDATE — version/data unchanged, no half-write', async () => {
    const recordId = `rec_r13c_update_txfail_${TS}_main`
    await insertRecord(recordId, { [FIELD_A]: 'unchanged' }, 1)
    await seedCreateRevision(recordId, { [FIELD_A]: 'unchanged' }, 1)

    const rule = updateRule({ [FIELD_A]: 'attempted-change' })
    const exec = await makeExecutor().execute(rule, { sheetId: SHEET, recordId, actorId: ACTOR, data: {} })
    expect(exec.steps[0]?.status).toBe('failed')
    expect(exec.steps[0]?.error).toContain('forced R13C update-revision failure')

    const row = await recordRow(recordId)
    expect(row).toMatchObject({ version: 1, data: { [FIELD_A]: 'unchanged' } })

    const updateRevs = await q(
      `SELECT COUNT(*)::int AS n FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2 AND action = 'update'`,
      [SHEET, recordId],
    )
    expect(Number((updateRevs.rows[0] as { n: number }).n)).toBe(0)
  })

  test('BEHAVIOR PRESERVED: same-base update_record of a missing record keeps its 0-row success — and fabricates NO revision', async () => {
    const ghost = `rec_r13c_ghost_${TS}`
    const rule = updateRule({ [FIELD_A]: 'ghost-value' })
    const exec = await makeExecutor().execute(rule, { sheetId: SHEET, recordId: ghost, actorId: ACTOR, data: {} })
    expect(exec.steps[0]?.status).toBe('success')
    expect(await revisionsFor(ghost)).toHaveLength(0)
  })
})
