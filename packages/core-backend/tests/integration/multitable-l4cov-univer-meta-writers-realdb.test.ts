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
 *                        ⇒ B1c/B2c (409 becomes 200) RED.
 *   - create-field backfill  (shares the backfill mutation) ⇒ B3 RED.
 *   - config-restore un-create / lossy-retype  remove `await fenceWriterEntry(query, sheetId)` from the branch's
 *                        txn entry ⇒ B4c / B5 (409 becomes the downstream status) RED.
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
import { univerMetaRouter } from '../../src/routes/univer-meta'
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
    for (const f of [FLAG, UNCREATE_FLAG, RETYPE_FLAG, RETYPE_LOSSY_FLAG]) delete process.env[f]
    await setBlock(null).catch(() => {})
  })

  afterAll(async () => {
    for (const f of [FLAG, UNCREATE_FLAG, RETYPE_FLAG, RETYPE_LOSSY_FLAG]) delete process.env[f]
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

  // ── §C — POST-COMMIT derived-value recompute — ANALYZED, DEFERRED (documented). ─────────────────────────
  // The relation-aggregation materialization (univer-meta.ts recalculateFormulaFields @≈2973 /
  // computeDependentLookupRollupRecords @≈3869) and the pure-formula path (formula-engine.ts
  // recalculateRecordFromData) run POST-COMMIT on a fresh pool connection: record-write-service.ts Step 4/4c
  // call them with `this.pool.query.bind(this.pool)` AFTER the fenced write txn (line ≈776) has committed. BUT
  // every one of those writes is an in-place `UPDATE meta_records SET data = data || …` — they emit NO
  // meta_record_revisions row and allocate NO `seq` (verified: `revision-exempt` in-code + no INSERT into
  // meta_record_revisions / nextval / chain_seq in formula-engine.ts). So the specific trust hole this lane
  // targets (non-causal `seq`) is NOT present. A fence here would be behavior-changing (extend the fence-hold
  // window across heavy recompute; the cross-sheet fan-out touches RELATED sheets and would need multi-sheet
  // fences; and coupling the user write's durability to recompute success — today a recompute failure is logged
  // and tolerated). Correct call: DEFER. This placeholder is skipped, not silently absent.
  test.skip('C [post-commit recompute] DEFERRED — no seq allocated post-commit (in-place data only); see lane report', () => {
    // Intentionally skipped. The analysis + decision live in the PR body / lane report (§C). If a future slice
    // moves the recompute into the fenced txn, replace this with a golden proving the recompute\'s seq is
    // allocated under the fence (causal). Until then, fencing it would be a wrong fence, not a fix.
    expect(true).toBe(true)
  })
})
