/**
 * W0-1 Lane L4-coverage — univer-meta / records / auto-number writer families. Real-DB goldens.
 *
 * Stacked on L4 (`multitable-l4-canonical-fence-realdb.test.ts`). L4 converged the core writers onto the
 * canonical per-sheet fence and left three PARTIAL families (canonical advisory fence for seq-ordering, but NO
 * durable-block check) plus several in-txn config-restore writers unfenced. This lane closes those holes; this
 * file is the behavioral proof.
 *
 * WHAT THIS PROVES (per newly-fenced writer): (1) a BLOCK-REFUSAL golden — with the L4 flag ON and a durable
 * `applying` block, the writer REFUSES (409 `RECOVERY_IN_PROGRESS` at the HTTP boundary, or throws
 * `SheetWriterBlockedError` at the library boundary) instead of proceeding; (2) a POSITIVE CONTROL — the SAME
 * request with NO block proceeds (200/created/throws-a-different-error), so the refusal is a genuine block
 * effect, not a plumbing artifact; (3) FLAG-OFF PARITY — with the fence flag OFF the durable block is inert and
 * the writer behaves byte-identically to pre-L4 (the PARTIAL families KEEP their pre-existing UNCONDITIONAL
 * canonical fence — it is the auto-number allocation-serialization lock — so flag-off is "fence still taken,
 * block ignored", NOT "no fence at all"; §AF proves the unconditional fence survives via a constructed park).
 *
 * MUTATION LOG (each asserted in the lane report; every one was run RED→restore→green):
 *   - plugin-create      remove `if (isWriterFenceEnabled()) await assertNoActiveWriterBlock(...)` from
 *                        records.ts::createRecord     ⇒ A1 (block still proceeds) RED.
 *   - auto-number backfill  same removal in auto-number-service.ts::backfillAutoNumberField ⇒ A2 RED.
 *   - form-submit        remove the block-check after `acquireAutoNumberSheetWriteLock` in the submit txn
 *                        ⇒ B1 (409 becomes 200) RED (B1c is the flag-off parity leg).
 *   - create-field backfill  (shares the backfill mutation) ⇒ B3 RED.
 *   - config-restore un-create / lossy-retype  remove `await fenceWriterEntry(query, sheetId)` from the branch's
 *                        txn entry ⇒ B4c / B5 (409 becomes the downstream status) RED.
 *   - FORWARD field-delete route (`DELETE /fields/:fieldId`)  remove `await fenceWriterEntry(query, sheetId)`
 *                        from the delete-field txn ⇒ B6 (409 becomes 200) RED. [re-gate P1: this route shared
 *                        dropFieldCascade with un-create but was the ONE unfenced sibling — hole now closed + tested.]
 *   - config-restore UNDELETE branch  remove `await fenceWriterEntry(query, sheetId)` from the undelete txn
 *                        ⇒ B7 (409 becomes the downstream status) RED. [re-gate P2: the undelete fence was
 *                        present but untested; B7 covers it. config-undelete stays flag-HOLD — this golden is
 *                        the precondition to un-holding it.]
 *
 * P2-C hygiene (v3.7): all fixtures are isolated synthetic rows with unique ids; this file NEVER calls `setval`
 * on the shared `meta_record_chain_seq`; `afterAll` cleans up ONLY this suite's own rows. Locally the whole
 * suite is run against a throwaway database `metasheet_l4cov_gate` (created, migrated, dropped) so the shared
 * chain sequence is never touched — see the lane report. Two-point wiring: plugin-tests.yml real-DB run list +
 * vitest.integration.config.ts default include glob. Runs only with DATABASE_URL; the sentinel fails-not-skips.
 */
import { EventEmitter } from 'events'
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import type { EventBus } from '../../src/integration/events/event-bus'
import { RecordService } from '../../src/multitable/record-service'
import { recalculateFormulaFieldsForActor, univerMetaRouter } from '../../src/routes/univer-meta'
import { deriveCapabilities } from '../../src/multitable/sheet-capabilities'
import { createRecord as pluginCreateRecord } from '../../src/multitable/records'
import { backfillAutoNumberField } from '../../src/multitable/auto-number-service'
import {
  SheetWriterBlockedError,
  canonicalSheetFenceKey,
  __resetRecoveryWriterStateColumnProbe,
  type WriterBlockState,
} from '../../src/multitable/canonical-sheet-fence'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'
const UNCREATE_FLAG = 'MULTITABLE_ENABLE_CONFIG_UNCREATE'
const UNDELETE_FLAG = 'MULTITABLE_ENABLE_CONFIG_UNDELETE'
const RETYPE_FLAG = 'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT'
const RETYPE_LOSSY_FLAG = 'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY'

const TS = Date.now()
const BASE = `base_l4cov_${TS}`
const SHEET = `sheet_l4cov_${TS}`
const VIEW = `view_l4cov_${TS}`
const F_STR = `fld_l4cov_str_${TS}`
const ACTOR = `u_l4cov_actor_${TS}`

let seq = 0
const mkRecord = (tag: string) => `rec_l4cov_${tag}_${TS}_${seq++}`
const mkField = (tag: string) => `fld_l4cov_${tag}_${TS}_${seq++}`

const eventBus = new EventEmitter() as unknown as EventBus
const capabilities = deriveCapabilities(['multitable:read', 'multitable:write'], false)
const mkRecordService = () =>
  new RecordService(
    poolManager.get() as unknown as ConstructorParameters<typeof RecordService>[0],
    eventBus,
  )

const setBlock = async (state: WriterBlockState | null) =>
  q('UPDATE meta_sheets SET recovery_writer_state = $2 WHERE id = $1', [SHEET, state])
const readBlock = async (): Promise<unknown> =>
  ((await q('SELECT recovery_writer_state FROM meta_sheets WHERE id = $1', [SHEET])).rows[0] as
    | { recovery_writer_state: unknown }
    | undefined)?.recovery_writer_state ?? null
const recordData = async (id: string): Promise<Record<string, unknown> | undefined> =>
  ((await q('SELECT data FROM meta_records WHERE id = $1', [id])).rows[0] as { data: Record<string, unknown> } | undefined)?.data
const recordExists = async (id: string): Promise<boolean> =>
  (await q('SELECT 1 FROM meta_records WHERE id = $1', [id])).rows.length > 0
const fieldExists = async (id: string): Promise<boolean> =>
  (await q('SELECT 1 FROM meta_fields WHERE id = $1', [id])).rows.length > 0
const seedRecord = async (id: string, data: Record<string, unknown> = { [F_STR]: 'orig' }): Promise<void> => {
  await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [
    id, SHEET, JSON.stringify(data), ACTOR,
  ])
}

// ── HTTP harness (real univerMetaRouter). A mutable actor + middleware, per the sibling config-restore suites.
let app: Express
let actor: { id: string; roles: string[]; perms: string[] }
const MEMBER = { id: ACTOR, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:share'] }
const submit = (body: Record<string, unknown>) => {
  actor = MEMBER
  return request(app).post(`/api/multitable/views/${VIEW}/submit`).send(body)
}
const createField = (body: Record<string, unknown>) => {
  actor = MEMBER
  return request(app).post('/api/multitable/fields').send(body)
}
const restorePreview = (revisionId: string) => {
  actor = MEMBER
  return request(app).post(`/api/multitable/sheets/${SHEET}/config-restore-preview`).send({ revisionId })
}
const restoreExecute = (body: Record<string, unknown>) => {
  actor = MEMBER
  return request(app).post(`/api/multitable/sheets/${SHEET}/config-restore-execute`).send(body)
}
const deleteField = (fieldId: string) => {
  actor = MEMBER
  return request(app).delete(`/api/multitable/fields/${fieldId}`)
}

/** Seed a field `create` config revision (un-create eligible: isSupportedUncreate). */
const insertFieldCreateRev = async (fieldId: string, name: string): Promise<string> => {
  const after = JSON.stringify({ name, type: 'string', property: {}, order: 9 })
  const r = await q(
    `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, before, after, changed_keys, batch_id, actor_id, source)
     VALUES ($1,'field',$2,'create',NULL,$3::jsonb,$4::text[],gen_random_uuid(),$5,'mutation') RETURNING id`,
    [SHEET, fieldId, after, ['name', 'type', 'property', 'order'], ACTOR],
  )
  return (r.rows[0] as { id: string }).id
}
/** Seed a field `delete` config revision (undelete eligible: isSupportedUndelete = action 'delete' + field). */
const insertFieldDeleteRev = async (fieldId: string, name: string): Promise<string> => {
  const before = JSON.stringify({ name, type: 'string', property: {}, order: 9 })
  const r = await q(
    `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, before, after, changed_keys, batch_id, actor_id, source)
     VALUES ($1,'field',$2,'delete',$3::jsonb,NULL,$4::text[],gen_random_uuid(),$5,'mutation') RETURNING id`,
    [SHEET, fieldId, before, ['name', 'type', 'property', 'order'], ACTOR],
  )
  return (r.rows[0] as { id: string }).id
}
/** Seed a property-only field `update` config revision (lossy-retype eligible: isLossyPropertyRetypeRevertShape). */
const insertLossyPropertyRev = async (fieldId: string): Promise<string> => {
  const r = await q(
    `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, before, after, changed_keys, batch_id, actor_id, source)
     VALUES ($1,'field',$2,'update',$3::jsonb,$4::jsonb,$5::text[],gen_random_uuid(),$6,'mutation') RETURNING id`,
    [SHEET, fieldId, JSON.stringify({ property: { max: 5 } }), JSON.stringify({ property: { max: 3 } }), ['property'], ACTOR],
  )
  return (r.rows[0] as { id: string }).id
}

describeIfDatabase('W0-1 L4cov — univer-meta/records/auto-number writer fence coverage (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as { user?: typeof actor }).user = actor; next() })
    app.use('/api/multitable', univerMetaRouter())

    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'L4cov Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'L4cov Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
      F_STR, SHEET, 'Note', 'string', '{}', 1,
    ])
    await q(
      `INSERT INTO meta_views (id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config)
       VALUES ($1,$2,$3,'grid','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb)`,
      [VIEW, SHEET, 'L4cov View'],
    )
  })

  afterEach(async () => {
    for (const f of [FLAG, UNCREATE_FLAG, UNDELETE_FLAG, RETYPE_FLAG, RETYPE_LOSSY_FLAG]) delete process.env[f]
    await setBlock(null).catch(() => {})
  })

  afterAll(async () => {
    for (const f of [FLAG, UNCREATE_FLAG, UNDELETE_FLAG, RETYPE_FLAG, RETYPE_LOSSY_FLAG]) delete process.env[f]
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_field_auto_number_sequences WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id IN (SELECT id FROM meta_fields WHERE sheet_id = $1)', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })

  beforeEach(() => {
    __resetRecoveryWriterStateColumnProbe()
  })

  test('sentinel: DATABASE_URL is set (this suite must RUN, never skip-green)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
      throw new Error('real-DB allowlist step is missing DATABASE_URL')
    }
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── §A — PARTIAL families (plugin-create + auto-number backfill) at the LIBRARY boundary ────────────────
  // These hold the canonical fence UNCONDITIONALLY (the auto-number allocation-serialization lock). L4cov adds
  // a FLAG-GATED durable-block check. Under an `applying` block with the flag ON they now THROW instead of
  // slipping past (the gap L4's GX1/GX2 exposed, now flipped to refusal in the L4 file).

  test('A1 [plugin-create] createRecord under an applying block THROWS SheetWriterBlockedError; no insert (flag ON)', async () => {
    process.env[FLAG] = 'true'
    await setBlock('applying')
    const before = (await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id=$1', [SHEET])).rows[0] as { n: number }
    const err = await poolManager
      .get()
      .transaction(async ({ query }) =>
        pluginCreateRecord({ query: query as never, sheetId: SHEET, data: { [F_STR]: 'blocked-create' } }),
      )
      .catch((e) => e)
    expect(err).toBeInstanceOf(SheetWriterBlockedError)
    const after = (await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id=$1', [SHEET])).rows[0] as { n: number }
    expect(after.n).toBe(before.n) // refused BEFORE the INSERT
    expect(await readBlock()).toBe('applying') // block untouched
  })

  test('A1-off [plugin-create] FLAG OFF: an applying block is INERT — create PROCEEDS (byte-identical pre-L4)', async () => {
    delete process.env[FLAG] // OFF
    await setBlock('applying')
    const created = await poolManager
      .get()
      .transaction(async ({ query }) =>
        pluginCreateRecord({ query: query as never, sheetId: SHEET, data: { [F_STR]: 'flag-off-create' } }),
      )
    expect((created as { id: string }).id).toBeTruthy()
    expect(await recordExists((created as { id: string }).id)).toBe(true) // committed despite the block
    await q('DELETE FROM meta_records WHERE id = $1', [(created as { id: string }).id]).catch(() => {})
    await setBlock(null)
  })

  test('A2 [auto-number backfill] backfillAutoNumberField under an applying block THROWS (flag ON); block untouched', async () => {
    const F_AN = mkField('a2an')
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
      F_AN, SHEET, 'Seq', 'autoNumber', JSON.stringify({ prefix: '', digits: 3 }), 2,
    ])
    process.env[FLAG] = 'true'
    await setBlock('applying')
    const err = await backfillAutoNumberField(q as never, SHEET, F_AN, { prefix: '', digits: 3 } as never, { overwrite: true }).catch((e) => e)
    expect(err).toBeInstanceOf(SheetWriterBlockedError)
    expect(await readBlock()).toBe('applying')
    await q('DELETE FROM meta_fields WHERE id = $1', [F_AN]).catch(() => {})
  })

  test('A2-off [auto-number backfill] FLAG OFF: backfill IGNORES an applying block and runs (byte-identical)', async () => {
    const F_AN = mkField('a2offan')
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
      F_AN, SHEET, 'Seq2', 'autoNumber', JSON.stringify({ prefix: '', digits: 3 }), 3,
    ])
    delete process.env[FLAG] // OFF
    await setBlock('applying')
    const res = await backfillAutoNumberField(q as never, SHEET, F_AN, { prefix: '', digits: 3 } as never, { overwrite: true })
    expect(res).toBeTruthy() // ran despite the block
    expect(await readBlock()).toBe('applying')
    await q('DELETE FROM meta_field_auto_number_sequences WHERE field_id = $1', [F_AN]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE id = $1', [F_AN]).catch(() => {})
  })

  // ── §AF — the UNCONDITIONAL fence is PRESERVED even with the flag off. A constructed park proves plugin-create
  // still parks on a concurrently-held canonical fence regardless of the flag (so flag-off did NOT drop the
  // auto-number serialization lock — the correctness reason we split fence-acquire from block-check). Throw-if-
  // never-parked keeps this non-vacuous.
  async function waitUntilBlockedOnFence(blockerPid: number, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const r = await q(
        `SELECT COUNT(*)::int AS c FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND $1 = ANY(pg_blocking_pids(pid))
            AND query ILIKE '%pg_advisory_xact_lock%'`,
        [blockerPid],
      )
      if ((r.rows[0] as { c: number }).c >= 1) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('plugin-create never parked on the held canonical fence — the unconditional fence is gone')
  }

  test('AF [flag OFF] plugin-create STILL parks on a held canonical fence (the unconditional auto-number lock survives)', async () => {
    delete process.env[FLAG] // OFF — block-check disabled, but the fence acquire must remain
    await setBlock(null)
    const b = await poolManager.get().getInternalPool().connect()
    const a = await poolManager.get().getInternalPool().connect()
    let parked = false
    try {
      await b.query('BEGIN')
      const bPid = Number((await b.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid)
      await b.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(SHEET)]) // hold the fence

      await a.query('BEGIN')
      const aQuery = (sql: string, params?: unknown[]) => a.query(sql, params) as unknown as Promise<{ rows: unknown[]; rowCount?: number | null }>
      let createdId: string | undefined
      const aRun = (async () => {
        const rec = await pluginCreateRecord({ query: aQuery as never, sheetId: SHEET, data: { [F_STR]: 'af-parks' } })
        createdId = (rec as { id: string }).id
      })()
      await waitUntilBlockedOnFence(bPid) // THROWS if A did not park ⇒ the unconditional fence was removed
      parked = true
      await b.query('COMMIT') // release the fence
      await aRun // A now proceeds (flag off ⇒ no block-check) and creates
      await a.query('COMMIT')
      expect(createdId).toBeTruthy()
      await q('DELETE FROM meta_records WHERE id = $1', [createdId!]).catch(() => {})
    } finally {
      await a.query('ROLLBACK').catch(() => {})
      a.release()
      b.release()
    }
    expect(parked).toBe(true)
  })

  // ── §B — HTTP writers via the real univerMetaRouter (production wiring + 409 mapping) ────────────────────

  test('B1 [form-submit CREATE] applying block ⇒ 409 RECOVERY_IN_PROGRESS, no record inserted (flag ON)', async () => {
    process.env[FLAG] = 'true'
    await setBlock('applying')
    const before = (await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id=$1', [SHEET])).rows[0] as { n: number }
    const res = await submit({ data: { [F_STR]: 'form-blocked' } })
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe('RECOVERY_IN_PROGRESS')
    const after = (await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id=$1', [SHEET])).rows[0] as { n: number }
    expect(after.n).toBe(before.n) // zero writes
  })

  test('B1b [form-submit CREATE] POSITIVE CONTROL: NO block ⇒ 200 create (proves 409 is the block, not plumbing)', async () => {
    process.env[FLAG] = 'true'
    await setBlock(null)
    const res = await submit({ data: { [F_STR]: 'form-ok' } })
    expect(res.status).toBe(200)
    expect(res.body?.data?.mode).toBe('create')
    const id = res.body?.data?.record?.id as string
    expect(id).toBeTruthy()
    await q('DELETE FROM meta_record_revisions WHERE record_id = $1', [id]).catch(() => {})
    await q('DELETE FROM meta_records WHERE id = $1', [id]).catch(() => {})
  })

  test('B1c [form-submit CREATE] FLAG OFF: an applying block is INERT ⇒ 200 create (byte-identical pre-L4)', async () => {
    delete process.env[FLAG] // OFF
    await setBlock('applying')
    const res = await submit({ data: { [F_STR]: 'form-flag-off' } })
    expect(res.status).toBe(200) // committed despite the block
    const id = res.body?.data?.record?.id as string
    await q('DELETE FROM meta_record_revisions WHERE record_id = $1', [id]).catch(() => {})
    await q('DELETE FROM meta_records WHERE id = $1', [id]).catch(() => {})
    await setBlock(null)
  })

  test('B2 [form-submit EDIT] applying block ⇒ 409, record data unchanged (flag ON)', async () => {
    const R = mkRecord('b2')
    await seedRecord(R)
    process.env[FLAG] = 'true'
    await setBlock('applying')
    const res = await submit({ recordId: R, data: { [F_STR]: 'edit-blocked' } })
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe('RECOVERY_IN_PROGRESS')
    expect(await recordData(R)).toMatchObject({ [F_STR]: 'orig' }) // unchanged
  })

  test('B2b [form-submit EDIT] POSITIVE CONTROL: NO block ⇒ 200 edit applied', async () => {
    const R = mkRecord('b2b')
    await seedRecord(R)
    process.env[FLAG] = 'true'
    await setBlock(null)
    const res = await submit({ recordId: R, data: { [F_STR]: 'edit-ok' } })
    expect(res.status).toBe(200)
    expect(await recordData(R)).toMatchObject({ [F_STR]: 'edit-ok' })
  })

  test('B3 [create-field autoNumber → backfill] applying block ⇒ 409, field NOT created (flag ON)', async () => {
    await seedRecord(mkRecord('b3seed')) // an existing record so backfill has scan rows (not required, but realistic)
    const F_NEW = mkField('b3an')
    process.env[FLAG] = 'true'
    await setBlock('applying')
    const res = await createField({ id: F_NEW, sheetId: SHEET, name: 'B3 Seq', type: 'autoNumber', order: 7 })
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe('RECOVERY_IN_PROGRESS')
    expect(await fieldExists(F_NEW)).toBe(false) // whole txn rolled back
  })

  test('B3b [create-field autoNumber] POSITIVE CONTROL: NO block ⇒ 201 field created', async () => {
    const F_NEW = mkField('b3ban')
    process.env[FLAG] = 'true'
    await setBlock(null)
    const res = await createField({ id: F_NEW, sheetId: SHEET, name: 'B3b Seq', type: 'autoNumber', order: 8 })
    expect(res.status).toBe(201)
    expect(await fieldExists(F_NEW)).toBe(true)
    await q('DELETE FROM meta_config_revisions WHERE entity_id = $1', [F_NEW]).catch(() => {})
    await q('DELETE FROM meta_field_auto_number_sequences WHERE field_id = $1', [F_NEW]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE id = $1', [F_NEW]).catch(() => {})
  })

  // ── config-restore-execute record writers (B) ──────────────────────────────────────────────────────────

  test('B4 [config-restore un-create] applying block ⇒ 409, field survives (flag ON)', async () => {
    const F = mkField('b4')
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F, SHEET, 'B4F', 'string', '{}', 9])
    const rev = await insertFieldCreateRev(F, 'B4F')
    process.env[FLAG] = 'true'
    process.env[UNCREATE_FLAG] = 'true'
    // The fence is the FIRST statement of the un-create txn (before the preview-token verify), so a dummy token
    // still 409s at the fence under a block — no valid token needed on the refusal path.
    await setBlock('applying')
    const res = await restoreExecute({ revisionId: rev, previewToken: 'dummy-token', confirm: 'uncreate' })
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe('RECOVERY_IN_PROGRESS')
    expect(await fieldExists(F)).toBe(true) // NOT dropped
    await q('DELETE FROM meta_config_revisions WHERE entity_id = $1', [F]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE id = $1', [F]).catch(() => {})
  })

  test('B4b [config-restore un-create] POSITIVE CONTROL: NO block ⇒ 200 drops the field (with a real preview token)', async () => {
    const F = mkField('b4b')
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F, SHEET, 'B4bF', 'string', '{}', 9])
    const rev = await insertFieldCreateRev(F, 'B4bF')
    process.env[FLAG] = 'true'
    process.env[UNCREATE_FLAG] = 'true'
    await setBlock(null)
    const pv = await restorePreview(rev)
    expect(pv.status).toBe(200)
    const res = await restoreExecute({ revisionId: rev, previewToken: pv.body.data.previewToken, confirm: 'uncreate' })
    expect(res.status).toBe(200)
    expect(await fieldExists(F)).toBe(false) // dropped — the fence did NOT block (no active recovery)
    await q('DELETE FROM meta_config_revisions WHERE entity_id = $1', [F]).catch(() => {})
  })

  test('B4c [config-restore un-create] FLAG OFF: an applying block is INERT ⇒ NOT 409 RECOVERY (fence no-op)', async () => {
    const F = mkField('b4c')
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F, SHEET, 'B4cF', 'string', '{}', 9])
    const rev = await insertFieldCreateRev(F, 'B4cF')
    delete process.env[FLAG] // fence OFF
    process.env[UNCREATE_FLAG] = 'true'
    await setBlock('applying')
    // Fence no-op ⇒ the request proceeds PAST the fence into the (dummy) token verify → PREVIEW_IDENTITY_INVALID,
    // NOT the fence's 409 RECOVERY_IN_PROGRESS. Proves the block-refusal is flag-gated.
    const res = await restoreExecute({ revisionId: rev, previewToken: 'dummy-token', confirm: 'uncreate' })
    expect(res.body?.error?.code).not.toBe('RECOVERY_IN_PROGRESS')
    await q('DELETE FROM meta_config_revisions WHERE entity_id = $1', [F]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE id = $1', [F]).catch(() => {})
    await setBlock(null)
  })

  test('B5 [config-restore lossy retype-revert — the SEQ-allocating writer] applying block ⇒ 409; flag-off ⇒ not 409 RECOVERY', async () => {
    // Highest-value config-restore fence: applyLossyRetypeCellRewrite emits one recordRecordRevision per changed
    // cell (allocates seq). The fence is the FIRST statement of its txn, so with a dummy token a block 409s at the
    // fence; with the fence flag OFF the request slips past into the downstream lossy machinery (≠ 409 RECOVERY).
    const F = mkField('b5rating')
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
      F, SHEET, 'B5Rating', 'rating', JSON.stringify({ max: 3 }), 10,
    ])
    const rev = await insertLossyPropertyRev(F)
    process.env[RETYPE_FLAG] = 'true'
    process.env[RETYPE_LOSSY_FLAG] = 'true'

    process.env[FLAG] = 'true' // fence ON
    await setBlock('applying')
    const blocked = await restoreExecute({ revisionId: rev, previewToken: 'dummy-token', confirm: 'revert-retype-lossy' })
    expect(blocked.status).toBe(409)
    expect(blocked.body?.error?.code).toBe('RECOVERY_IN_PROGRESS')

    delete process.env[FLAG] // fence OFF — positive control: block is inert, the fence's 409 must NOT appear
    __resetRecoveryWriterStateColumnProbe()
    await setBlock('applying')
    const passed = await restoreExecute({ revisionId: rev, previewToken: 'dummy-token', confirm: 'revert-retype-lossy' })
    expect(passed.body?.error?.code).not.toBe('RECOVERY_IN_PROGRESS')

    await setBlock(null)
    await q('DELETE FROM meta_config_revisions WHERE entity_id = $1', [F]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE id = $1', [F]).catch(() => {})
  })

  // ── §B6 — the FORWARD field-delete route (`DELETE /fields/:fieldId`). Its txn calls the SAME dropFieldCascade
  // as the un-create sibling (B4) but was UNFENCED (the P1 coverage hole this rung's re-gate found: 200 under an
  // applying block where the sibling 409s). Now fenced-first. Same three legs as B4: block⇒409, no-block⇒200
  // (positive control it isn't just always-refusing), flag-off⇒block inert. MUTATION: remove
  // `await fenceWriterEntry(query, sheetId)` from the delete-field route txn ⇒ B6 (409 becomes 200) RED.
  test('B6 [forward field-delete route] applying block ⇒ 409 RECOVERY_IN_PROGRESS, field survives (flag ON)', async () => {
    const F = mkField('b6')
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F, SHEET, 'B6F', 'string', '{}', 9])
    process.env[FLAG] = 'true'
    await setBlock('applying')
    const res = await deleteField(F)
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe('RECOVERY_IN_PROGRESS')
    expect(await fieldExists(F)).toBe(true) // NOT dropped — the forward route now fences like its un-create sibling
    expect(await readBlock()).toBe('applying') // block untouched
    await q('DELETE FROM meta_fields WHERE id = $1', [F]).catch(() => {})
  })

  test('B6b [forward field-delete route] POSITIVE CONTROL: NO block ⇒ 200 drops the field + strips its key from records (flag ON)', async () => {
    const F = mkField('b6b')
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F, SHEET, 'B6bF', 'string', '{}', 9])
    const R = mkRecord('b6b')
    await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [R, SHEET, JSON.stringify({ [F]: 'carried' }), ACTOR])
    process.env[FLAG] = 'true'
    await setBlock(null)
    const res = await deleteField(F)
    expect(res.status).toBe(200)
    expect(await fieldExists(F)).toBe(false) // dropped — no active recovery blocked it
    const rowAfter = await q('SELECT data FROM meta_records WHERE id = $1', [R])
    expect(((rowAfter.rows[0] as { data: Record<string, unknown> }).data)[F]).toBeUndefined() // the cascade stripped the key
    await q('DELETE FROM meta_records WHERE id = $1', [R]).catch(() => {})
  })

  test('B6c [forward field-delete route] FLAG OFF: an applying block is INERT ⇒ the delete PROCEEDS (byte-identical pre-L4cov)', async () => {
    const F = mkField('b6c')
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F, SHEET, 'B6cF', 'string', '{}', 9])
    delete process.env[FLAG] // fence OFF
    await setBlock('applying')
    const res = await deleteField(F)
    expect(res.status).toBe(200) // fence no-op ⇒ delete proceeds despite the block — the refusal is flag-gated
    expect(await fieldExists(F)).toBe(false)
  })

  // ── §B7 — the config-restore UNDELETE branch (re-gate P2: the fence was present but untested). A field DELETE
  // config revision is undelete-eligible (isSupportedUndelete); the undelete txn fences as its FIRST statement
  // (before the id-occupied FOR UPDATE + preview-token verify), so a dummy token still 409s at the fence under a
  // block — exactly like un-create (B4). MUTATION: remove `await fenceWriterEntry(query, sheetId)` from the
  // undelete txn ⇒ B7 (409 becomes the downstream PREVIEW_IDENTITY_INVALID) RED. config-undelete stays flag-HOLD.
  test('B7 [config-restore undelete] applying block ⇒ 409 RECOVERY_IN_PROGRESS (fence FIRST), field stays deleted (flag ON)', async () => {
    const F = mkField('b7')
    const rev = await insertFieldDeleteRev(F, 'B7F')
    process.env[FLAG] = 'true'
    process.env[UNDELETE_FLAG] = 'true'
    await setBlock('applying')
    const res = await restoreExecute({ revisionId: rev, previewToken: 'dummy-token', confirm: 'undelete' })
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe('RECOVERY_IN_PROGRESS')
    expect(await fieldExists(F)).toBe(false) // NOT recreated — the fence refused before the undelete plan ran
    expect(await readBlock()).toBe('applying') // block untouched
    await q('DELETE FROM meta_config_revisions WHERE entity_id = $1', [F]).catch(() => {})
  })

  test('B7c [config-restore undelete] FLAG OFF: an applying block is INERT ⇒ NOT 409 RECOVERY (fence no-op)', async () => {
    const F = mkField('b7c')
    const rev = await insertFieldDeleteRev(F, 'B7cF')
    delete process.env[FLAG] // fence OFF
    process.env[UNDELETE_FLAG] = 'true'
    await setBlock('applying')
    // Fence no-op ⇒ the request proceeds PAST the fence into the (dummy) token verify → a NON-fence status,
    // NOT the fence's 409 RECOVERY_IN_PROGRESS. Proves the block-refusal is flag-gated.
    const res = await restoreExecute({ revisionId: rev, previewToken: 'dummy-token', confirm: 'undelete' })
    expect(res.body?.error?.code).not.toBe('RECOVERY_IN_PROGRESS')
    await q('DELETE FROM meta_config_revisions WHERE entity_id = $1', [F]).catch(() => {})
  })

  // ── §R — CONSTRUCTED RACE on a NEWLY-fenced writer (plugin-create). Two raw pg clients + pg_blocking_pids.
  // A (plugin-create) races recovery B claiming the durable block under the canonical fence. plugin-create takes
  // the SAME fence key, so A parks behind B (proven via pg_blocking_pids — never a timer), then once A proceeds
  // it OBSERVES B's committed block (its flag-gated fence-before-check) and throws. throw-if-never-parked keeps
  // it non-vacuous; removing the block-check (or the durable block) makes A miss B's block ⇒ this reds.
  test('R1 [plugin-create] fence serialises the writer against a recovery claim; A observes B\'s durable block', async () => {
    process.env[FLAG] = 'true'
    await setBlock(null)
    const b = await poolManager.get().getInternalPool().connect()
    const a = await poolManager.get().getInternalPool().connect()
    let aOutcome: 'blocked' | 'proceeded' = 'proceeded'
    let aErr: unknown
    let createdId: string | undefined
    try {
      await b.query('BEGIN')
      const bPid = Number((await b.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid)
      await b.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(SHEET)])
      await b.query("UPDATE meta_sheets SET recovery_writer_state = 'applying' WHERE id = $1", [SHEET])

      await a.query('BEGIN')
      const aQuery = (sql: string, params?: unknown[]) => a.query(sql, params) as unknown as Promise<{ rows: unknown[]; rowCount?: number | null }>
      const aRun = (async () => {
        try {
          const rec = await pluginCreateRecord({ query: aQuery as never, sheetId: SHEET, data: { [F_STR]: 'race-create' } })
          createdId = (rec as { id: string }).id
          aOutcome = 'proceeded'
        } catch (e) {
          aErr = e
          aOutcome = 'blocked'
        }
      })()

      await waitUntilBlockedOnFence(bPid) // deterministic proof A is parked on B's fence, not racing free
      await b.query('COMMIT') // B releases the fence AND commits `applying`
      await aRun
      await a.query('ROLLBACK').catch(() => {})
    } finally {
      a.release()
      b.release()
    }
    expect(aOutcome).toBe('blocked')
    expect(aErr).toBeInstanceOf(SheetWriterBlockedError)
    expect((aErr as SheetWriterBlockedError).state).toBe('applying')
    expect(createdId).toBeUndefined() // never inserted
    expect(await readBlock()).toBe('applying')
    await setBlock(null)
  })

  // ── §C — POST-COMMIT derived-value recompute JOINS THE FENCE (relation-aggregation). ────────────────────
  // Replaces the former DEFERRED skip. The post-merge review of #4438 ruled the deferral inconsistent: the
  // engine's v2 fenced txn had already closed the pure-formula path, leaving the two relation-agg sites
  // (same-record materialization in recalculateFormulaFields; dependent-sheet fan-out in
  // computeDependentLookupRollupRecords) as the ONLY derived writers that could land inside a recovery's
  // applying window and clobber just-recovered data. Both now route through the shared seam
  // (`src/multitable/derived-write-fence.ts`); these are the behavioral proofs. Refusal semantics: a durable
  // block on the sheet being written ⇒ SKIP the materialization AND its echo/invalidation ids (DB unchanged
  // ⇒ nothing to invalidate), never fail the already-committed primary write; other dependent sheets keep
  // materializing. The PRIMARY fence refusal (the write txn entry itself) maps to 409 RECOVERY_IN_PROGRESS
  // at POST /patch (C3).
  // Honest residuals (named, still true — deliberately NOT covered by these goldens):
  //  (a) reads-outside-txn: the aggregation is computed from reads taken BEFORE the fenced write txn; a
  //      recovery that starts AND finishes inside that gap clears the block, so a stale pre-recovery-derived
  //      value can still commit (same engine-v2 posture, documented at the seam).
  //  (b) no post-recovery re-trigger: a refused materialization stays stale until the next source edit
  //      (relation-agg is materialize-model, not computed-on-read); includes the cliff `#ERROR!` writes that
  //      ride the same UPDATE.
  //  (c) these writes remain revision-exempt / no-seq — the lane's non-causal-seq trust hole is still absent
  //      here; the fence closes the recovered-data CLOBBER hazard, not a history hazard.
  //  (d) each fence+UPDATE is its own single-sheet short txn, so there is no multi-sheet fence ordering
  //      today; if fan-out batching is ever introduced, the ordering question reopens.
  describe('§C — relation-agg materialization joins the fence (shared derived-write seam)', () => {
    const C_SRC = `sheet_l4cov_csrc_${TS}`
    const C_DEP = `sheet_l4cov_cdep_${TS}`
    const C_DEP2 = `sheet_l4cov_cdep2_${TS}`
    const F_SRC_AMT = `fld_l4cov_camt_${TS}`
    const F_SRC_STATUS = `fld_l4cov_cstat_${TS}`
    const F_DEP_LINK = `fld_l4cov_cdlink_${TS}`
    const F_DEP_CURVAL = `fld_l4cov_cdcur_${TS}`
    const F_DEP_SUM = `fld_l4cov_cdsum_${TS}`
    const F_DEP2_LINK = `fld_l4cov_cd2link_${TS}`
    const F_DEP2_CURVAL = `fld_l4cov_cd2cur_${TS}`
    const F_DEP2_SUM = `fld_l4cov_cd2sum_${TS}`
    // The DIRECT recompute call (C1) resolves the actor DB-authoritatively (buildWriterTaintContext carries
    // only the id — the Yjs-bridge shape), so this actor needs REAL stored perms, not req-carried ones:
    // legacy users.permissions JSONB path, same as the w11 bridge-freshness suite.
    const C_ACTOR = `u_l4cov_cactor_${TS}`

    const relSumExpr = (linkFieldId: string, curvalFieldId: string) =>
      `RELSUMIF("${linkFieldId}","${F_SRC_AMT}","${F_SRC_STATUS}","is",{${curvalFieldId}})`

    const setBlockFor = async (sheetId: string, state: WriterBlockState | null) =>
      q('UPDATE meta_sheets SET recovery_writer_state = $2 WHERE id = $1', [sheetId, state])
    const rowOf = async (id: string): Promise<{ data: Record<string, unknown>; version: number; updatedAt: string }> => {
      const r = await q('SELECT data, version, updated_at FROM meta_records WHERE id = $1', [id])
      const row = r.rows[0] as { data: Record<string, unknown>; version: unknown; updated_at: Date }
      expect(row).toBeTruthy()
      return { data: row.data ?? {}, version: Number(row.version), updatedAt: new Date(row.updated_at).toISOString() }
    }
    const seedSrc = async (id: string, amt: number): Promise<void> => {
      await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [
        id, C_SRC, JSON.stringify({ [F_SRC_AMT]: amt, [F_SRC_STATUS]: 'paid' }), ACTOR,
      ])
    }
    const seedDep = async (id: string, sheetId: string, linkFieldId: string, curvalFieldId: string, linkedIds: string[]): Promise<void> => {
      await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [
        id, sheetId, JSON.stringify({ [linkFieldId]: linkedIds, [curvalFieldId]: 'paid' }), ACTOR,
      ])
      for (const fr of linkedIds) {
        await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [
          `lnk_l4cov_${id}_${fr}`, linkFieldId, id, fr,
        ])
      }
    }
    const depFields = [
      { id: F_DEP_LINK, name: 'CLink', type: 'link', property: { foreignSheetId: C_SRC }, order: 1 },
      { id: F_DEP_CURVAL, name: 'CCur', type: 'string', property: {}, order: 2 },
      { id: F_DEP_SUM, name: 'CSum', type: 'formula', property: { expression: relSumExpr(F_DEP_LINK, F_DEP_CURVAL) }, order: 3 },
    ] as never
    const patchVia = async (sheetId: string, recordId: string, fieldId: string, value: unknown) => {
      actor = MEMBER
      const cur = await q('SELECT version FROM meta_records WHERE id = $1', [recordId])
      const expectedVersion = Number((cur.rows[0] as { version: unknown } | undefined)?.version ?? 1)
      return request(app).post('/api/multitable/patch').send({
        sheetId,
        changes: [{ recordId, fieldId, value, expectedVersion }],
      })
    }

    beforeAll(async () => {
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1,$2,$1,'x','member',$3::jsonb, TRUE, FALSE)
         ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
        [C_ACTOR, `${C_ACTOR}@example.test`, JSON.stringify(['multitable:read', 'multitable:write'])],
      )
      for (const [sid, name] of [[C_SRC, 'L4cov C Source'], [C_DEP, 'L4cov C Dependent'], [C_DEP2, 'L4cov C Dependent 2']] as const) {
        await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [sid, BASE, name])
      }
      for (const [fid, sid, name, type, property, order] of [
        [F_SRC_AMT, C_SRC, 'CAmt', 'number', '{}', 1],
        [F_SRC_STATUS, C_SRC, 'CStatus', 'string', '{}', 2],
        [F_DEP_LINK, C_DEP, 'CLink', 'link', JSON.stringify({ foreignSheetId: C_SRC }), 1],
        [F_DEP_CURVAL, C_DEP, 'CCur', 'string', '{}', 2],
        [F_DEP_SUM, C_DEP, 'CSum', 'formula', JSON.stringify({ expression: relSumExpr(F_DEP_LINK, F_DEP_CURVAL) }), 3],
        [F_DEP2_LINK, C_DEP2, 'C2Link', 'link', JSON.stringify({ foreignSheetId: C_SRC }), 1],
        [F_DEP2_CURVAL, C_DEP2, 'C2Cur', 'string', '{}', 2],
        [F_DEP2_SUM, C_DEP2, 'C2Sum', 'formula', JSON.stringify({ expression: relSumExpr(F_DEP2_LINK, F_DEP2_CURVAL) }), 3],
      ] as const) {
        await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
          fid, sid, name, type, property, order,
        ])
      }
      // Same-record recompute trigger (C1): the RELSUMIF depends on the current-record criteria field.
      await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,NULL)', [C_DEP, F_DEP_SUM, F_DEP_CURVAL])
      await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,NULL)', [C_DEP2, F_DEP2_SUM, F_DEP2_CURVAL])
    })

    afterEach(async () => {
      for (const s of [C_SRC, C_DEP, C_DEP2]) await setBlockFor(s, null).catch(() => {})
    })

    afterAll(async () => {
      await q('DELETE FROM formula_dependencies WHERE sheet_id = ANY($1::text[])', [[C_DEP, C_DEP2]]).catch(() => {})
      await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[F_DEP_LINK, F_DEP2_LINK]]).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[C_SRC, C_DEP, C_DEP2]]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[C_SRC, C_DEP, C_DEP2]]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[C_SRC, C_DEP, C_DEP2]]).catch(() => {})
      await q('DELETE FROM users WHERE id = $1', [C_ACTOR]).catch(() => {})
    })

    test('C1 same-record: block ⇒ silent skip (no throw, no write, no echo); positive control materializes; flag-off parity', async () => {
      const SR1 = mkRecord('c1s1')
      const SR2 = mkRecord('c1s2')
      const DR = mkRecord('c1d')
      const DRB = mkRecord('c1db')
      await seedSrc(SR1, 10)
      await seedSrc(SR2, 20)
      await seedDep(DR, C_DEP, F_DEP_LINK, F_DEP_CURVAL, [SR1, SR2])
      await seedDep(DRB, C_DEP, F_DEP_LINK, F_DEP_CURVAL, [SR1])

      // Leg 1 — flag ON + durable block on the DEP sheet: the DIRECT recompute entry (the Yjs-bridge shape,
      // and the deterministic stand-in for the commit→recompute gap race) must NOT throw, NOT write, NOT echo.
      process.env[FLAG] = 'true'
      await setBlockFor(C_DEP, 'applying')
      const before = await rowOf(DR)
      expect(before.data).not.toHaveProperty(F_DEP_SUM)
      const blocked = await recalculateFormulaFieldsForActor(
        C_ACTOR, q as never, C_DEP, depFields, [DR], [F_DEP_CURVAL],
      )
      expect(blocked).toEqual([]) // no echo entry for a refused materialization
      const afterBlocked = await rowOf(DR)
      expect(afterBlocked.data).not.toHaveProperty(F_DEP_SUM) // zero write…
      expect(afterBlocked.updatedAt).toBe(before.updatedAt) // …not even a touch (updated_at = now() is in the UPDATE)

      // Leg 2 — positive control (flag ON, no block): the SAME call materializes 10+20=30. This also proves
      // the direct-call chain is non-vacuous (C_ACTOR's DB-authoritative read really resolves — a taint-skip
      // or perm failure would yield no value / '#PERM!' here, not 30).
      await setBlockFor(C_DEP, null)
      const ok = await recalculateFormulaFieldsForActor(
        C_ACTOR, q as never, C_DEP, depFields, [DR], [F_DEP_CURVAL],
      )
      expect(ok).toEqual([{ recordId: DR, data: { [F_DEP_SUM]: 30 } }])
      expect((await rowOf(DR)).data[F_DEP_SUM]).toBe(30)

      // Leg 3 — flag-off parity: block present but flag OFF ⇒ byte-identical legacy write proceeds.
      delete process.env[FLAG]
      await setBlockFor(C_DEP, 'applying')
      const parity = await recalculateFormulaFieldsForActor(
        C_ACTOR, q as never, C_DEP, depFields, [DRB], [F_DEP_CURVAL],
      )
      expect(parity).toEqual([{ recordId: DRB, data: { [F_DEP_SUM]: 10 } }])
      expect((await rowOf(DRB)).data[F_DEP_SUM]).toBe(10)
    })

    test('C2 fan-out: block on ONE dependent sheet skips ONLY that sheet (200, source applied, healthy sheet materializes); flag-off parity', async () => {
      const SR1 = mkRecord('c2s1')
      const SR2 = mkRecord('c2s2')
      const DR = mkRecord('c2d')
      const DR2 = mkRecord('c2d2')
      await seedSrc(SR1, 10)
      await seedSrc(SR2, 20)
      await seedDep(DR, C_DEP, F_DEP_LINK, F_DEP_CURVAL, [SR1, SR2])
      await seedDep(DR2, C_DEP2, F_DEP2_LINK, F_DEP2_CURVAL, [SR1, SR2])

      // Leg 1 — positive control (flag ON, no block): editing the foreign TARGET field fans out to BOTH
      // dependent sheets. 30+20 = 50.
      process.env[FLAG] = 'true'
      const res1 = await patchVia(C_SRC, SR1, F_SRC_AMT, 30)
      expect(res1.status).toBe(200)
      expect((await rowOf(DR)).data[F_DEP_SUM]).toBe(50)
      expect((await rowOf(DR2)).data[F_DEP2_SUM]).toBe(50)

      // Leg 2 — durable block on C_DEP ONLY: the source PATCH still succeeds (its own sheet is unblocked),
      // the BLOCKED dependent sheet's materialization is refused (stale value + updated_at untouched, and
      // its field id absent from the echo), while the HEALTHY dependent sheet still materializes. This leg
      // also kills the wrong-sheet-key mutation (fencing sourceSheetId instead of the written sheet would
      // see no block on C_SRC and write through).
      await setBlockFor(C_DEP, 'applying')
      const beforeDR = await rowOf(DR)
      const res2 = await patchVia(C_SRC, SR2, F_SRC_AMT, 200)
      expect(res2.status).toBe(200)
      expect((await rowOf(SR2)).data[F_SRC_AMT]).toBe(200) // primary write applied
      const afterDR = await rowOf(DR)
      expect(afterDR.data[F_DEP_SUM]).toBe(50) // stale (30+200=230 was refused)
      expect(afterDR.updatedAt).toBe(beforeDR.updatedAt) // zero write on the blocked sheet
      expect((await rowOf(DR2)).data[F_DEP2_SUM]).toBe(230) // healthy sheet materialized
      // Echo contract: the HTTP `relatedRecords` shape is {sheetId, recordId, data} (affectedFieldIds is
      // internal fan-out metadata, "never part of the response contract" — record-write-service Step 5).
      // The healthy sheet's record echoes its freshly materialized value; the BLOCKED sheet's record must
      // NOT carry one (the DB did not change — a carried value would revert on reload).
      const related = (res2.body?.data?.relatedRecords ?? []) as Array<{ recordId: string; data?: Record<string, unknown> }>
      const echoDR = related.find((r) => r.recordId === DR)
      if (echoDR) {
        expect(echoDR.data ?? {}).not.toHaveProperty(F_DEP_SUM)
      }
      const echoDR2 = related.find((r) => r.recordId === DR2)
      expect(echoDR2?.data?.[F_DEP2_SUM]).toBe(230)

      // Leg 3 — flag-off parity: block still on C_DEP, flag OFF ⇒ the legacy bare write proceeds anyway.
      delete process.env[FLAG]
      const res3 = await patchVia(C_SRC, SR1, F_SRC_AMT, 31)
      expect(res3.status).toBe(200)
      expect((await rowOf(DR)).data[F_DEP_SUM]).toBe(231) // 31+200, despite the (inert) block
    })

    test('C3 POST /patch primary-fence refusal maps to 409 RECOVERY_IN_PROGRESS (not 500); positive control; flag-off parity', async () => {
      const SR = mkRecord('c3s')
      await seedSrc(SR, 5)

      // Leg 1 — flag ON + durable block on the SOURCE sheet: the PRIMARY fenced write refuses at txn entry
      // and the route maps it (previously an unmapped 500 INTERNAL_ERROR — the pre-existing gap the review
      // named). Zero write.
      process.env[FLAG] = 'true'
      await setBlockFor(C_SRC, 'applying')
      const before = await rowOf(SR)
      const res1 = await patchVia(C_SRC, SR, F_SRC_AMT, 7)
      expect(res1.status).toBe(409)
      expect(res1.body?.error?.code).toBe('RECOVERY_IN_PROGRESS')
      const after = await rowOf(SR)
      expect(after.data[F_SRC_AMT]).toBe(5)
      expect(after.version).toBe(before.version)

      // Leg 2 — positive control: clear the block ⇒ the same patch succeeds.
      await setBlockFor(C_SRC, null)
      const res2 = await patchVia(C_SRC, SR, F_SRC_AMT, 7)
      expect(res2.status).toBe(200)
      expect((await rowOf(SR)).data[F_SRC_AMT]).toBe(7)

      // Leg 3 — flag-off parity: block present but flag OFF ⇒ inert, the write proceeds.
      delete process.env[FLAG]
      await setBlockFor(C_SRC, 'applying')
      const res3 = await patchVia(C_SRC, SR, F_SRC_AMT, 9)
      expect(res3.status).toBe(200)
      expect((await rowOf(SR)).data[F_SRC_AMT]).toBe(9)
    })
  })
})
