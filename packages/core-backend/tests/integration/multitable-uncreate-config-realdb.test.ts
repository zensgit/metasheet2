/**
 * T9-W Tier 3 (U-3) — config UN-CREATE (revert a field/view `create` = DROP the created entity) — real DB. Behind the
 * default-off flag MULTITABLE_ENABLE_CONFIG_UNCREATE. Routes: POST /sheets/:id/config-restore-preview {revisionId} and
 * POST /sheets/:id/config-restore-execute {revisionId, previewToken, confirm}. Un-create applies ONLY to a `create`
 * revision whose entity_type ∈ {field,view} (isSupportedUncreate); classifyRevert stays gated for every create.
 *
 * Preview is read-only and UNDISCLOSED (U3-L5): it names the entity + the destructive consequence and binds an OPAQUE
 * HMAC planHash (U3-L4) over the blast-radius plan (entityAlive / cascade view-id set / order-shift set / field
 * column-data presence) — NO counts, NO raw plan fields ever reach the response or the JWT. Execute re-locks, recomputes
 * the plan, compares the single planHash → ONE generic 409 PLAN_DRIFT, then drops via the SHARED forward-delete cascade
 * (dropFieldCascade / dropViewCascade, U3-L2) inside ONE pool.transaction recording a `delete` revision
 * (source='restore', restored_from_id).
 *
 * Goldens (a)-(l): (a) flag-off 403 · (b) permission gate · (c) happy FIELD un-create full cascade · (d) happy VIEW
 * un-create · (e) sink-reuse parity with the FORWARD delete route · (f) plan-drift (3 axes → one PLAN_DRIFT) · (g) no
 * benign-rename false-409 · (h) token/response opacity · (i) no-oracle count · (j) typed-confirm · (k) single-txn
 * atomicity · (l) audit revision. Runs only with DATABASE_URL.
 *
 * NOTE on the flag: MULTITABLE_ENABLE_CONFIG_UNCREATE is read PER-REQUEST inside the handlers (not captured at router
 * build), so — exactly like the multitable-sheet-config-revert golden — ONE app + a per-test env toggle + afterEach
 * delete is both correct and sufficient (a "separate flag-off app" cannot isolate a global process.env flag).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_uc_${TS}`
const FLAG = 'MULTITABLE_ENABLE_CONFIG_UNCREATE'

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)

type Actor = { id: string; roles: string[]; perms: string[] }
// canManageFields === canManageViews === canWrite (deriveCapabilities: both derive from multitable:write, and the
// sheet-scope grant sets both together) — so MANAGER (read+write) holds BOTH field+view manage caps, and a read-only
// actor holds NEITHER. There is no perm that yields "canManageViews but not canManageFields".
const MANAGER: Actor = { id: `u_uc_mgr_${TS}`, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
const READER: Actor = { id: `u_uc_reader_${TS}`, roles: ['member'], perms: ['multitable:read'] }

let app: Express
let actor: Actor = MANAGER

const CREATED_SHEETS: string[] = []
let seq = 0
const mkFieldId = () => `fld_uc_${TS}_${seq++}`
const mkViewId = () => `view_uc_${TS}_${seq++}`

async function freshSheet(tag: string): Promise<string> {
  const id = `sheet_uc_${tag}_${TS}`
  await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [id, BASE, id])
  CREATED_SHEETS.push(id)
  return id
}
async function insertField(sheetId: string, fieldId: string, name: string, type: string, order: number): Promise<void> {
  await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [fieldId, sheetId, name, type, '{}', order])
}
/** Seed the `create` revision a forward field-create records (fieldCreateDiff shape): after = full config, source='mutation'. */
async function insertFieldCreateRev(sheetId: string, fieldId: string, name: string, type: string, order: number): Promise<string> {
  const after = JSON.stringify({ name, type, property: {}, order })
  const r = await q(
    `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, before, after, changed_keys, batch_id, actor_id, source)
     VALUES ($1,'field',$2,'create',NULL,$3::jsonb,$4::text[],gen_random_uuid(),$5,'mutation') RETURNING id`,
    [sheetId, fieldId, after, ['name', 'type', 'property', 'order'], MANAGER.id],
  )
  return ((r.rows[0]) as { id: string }).id
}
async function insertView(sheetId: string, viewId: string, name: string, hidden: string[]): Promise<void> {
  await q(
    `INSERT INTO meta_views (id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config)
     VALUES ($1,$2,$3,'grid','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$4::jsonb,'{}'::jsonb)`,
    [viewId, sheetId, name, JSON.stringify(hidden)],
  )
}
async function insertViewCreateRev(sheetId: string, viewId: string, name: string): Promise<string> {
  const after = JSON.stringify({ name, type: 'grid', filterInfo: {}, sortInfo: {}, groupInfo: {}, hiddenFieldIds: [], config: {} })
  const r = await q(
    `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, before, after, changed_keys, batch_id, actor_id, source)
     VALUES ($1,'view',$2,'create',NULL,$3::jsonb,$4::text[],gen_random_uuid(),$5,'mutation') RETURNING id`,
    [sheetId, viewId, after, ['name', 'type', 'filterInfo', 'sortInfo', 'groupInfo', 'hiddenFieldIds', 'config'], MANAGER.id],
  )
  return ((r.rows[0]) as { id: string }).id
}
async function insertRecord(sheetId: string, data: Record<string, unknown>): Promise<string> {
  const r = await q('INSERT INTO meta_records (sheet_id, data) VALUES ($1,$2::jsonb) RETURNING id', [sheetId, JSON.stringify(data)])
  return ((r.rows[0]) as { id: string }).id
}
async function insertLink(fieldId: string, recordId: string, foreignId: string): Promise<void> {
  await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [fieldId, recordId, foreignId])
}
async function insertAutoNumber(fieldId: string, sheetId: string): Promise<void> {
  await q('INSERT INTO meta_field_auto_number_sequences (field_id, sheet_id, next_value) VALUES ($1,$2,$3)', [fieldId, sheetId, 5])
}
const countColumnData = async (sheetId: string, fieldId: string): Promise<number> =>
  ((await q(`SELECT count(*)::int AS n FROM meta_records WHERE sheet_id=$1 AND data->>$2 IS NOT NULL`, [sheetId, fieldId])).rows[0] as { n: number }).n
const rowCount = async (sql: string, params: unknown[]): Promise<number> => (await q(sql, params)).rows.length

const preview = (sheetId: string, revisionId: string, as: Actor = MANAGER) => { actor = as; return request(app).post(`/api/multitable/sheets/${sheetId}/config-restore-preview`).send({ revisionId }) }
const execute = (sheetId: string, body: Record<string, unknown>, as: Actor = MANAGER) => { actor = as; return request(app).post(`/api/multitable/sheets/${sheetId}/config-restore-execute`).send(body) }
const forwardDeleteField = (fieldId: string, as: Actor = MANAGER) => { actor = as; return request(app).delete(`/api/multitable/fields/${fieldId}`).send() }

describeIfDatabase('multitable config un-create — T9-W Tier 3 / U-3 (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as { user?: Actor }).user = actor; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'UC Base'])
  })
  afterAll(async () => {
    for (const s of CREATED_SHEETS) {
      await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [s]).catch(() => {})
      // meta_links has NO sheet_id column — delete by field_id, BEFORE the fields it references are removed.
      await q('DELETE FROM meta_links WHERE field_id IN (SELECT id FROM meta_fields WHERE sheet_id = $1)', [s]).catch(() => {})
      await q('DELETE FROM meta_field_auto_number_sequences WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_views WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [s]).catch(() => {})
    }
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })
  afterEach(() => { delete process.env[FLAG] })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('(a) flag OFF → preview AND execute both 403 CONFIG_UNCREATE_DISABLED', async () => {
    delete process.env[FLAG] // flag read per-request → unset = off (no separate app needed)
    const s = await freshSheet('a')
    const F = mkFieldId(); await insertField(s, F, 'AField', 'string', 1)
    const rev = await insertFieldCreateRev(s, F, 'AField', 'string', 1)
    // MANAGER so the capability gate (which precedes the flag gate) passes → we actually reach the flag check.
    const p = await preview(s, rev, MANAGER)
    expect(p.status).toBe(403)
    expect(p.body?.error?.code).toBe('CONFIG_UNCREATE_DISABLED')
    // execute needs a non-empty previewToken to pass body-validation before the flag check fires.
    const x = await execute(s, { revisionId: rev, previewToken: 'any-token' }, MANAGER)
    expect(x.status).toBe(403)
    expect(x.body?.error?.code).toBe('CONFIG_UNCREATE_DISABLED')
  })

  test('(b) permission: actor lacking field-manage capability → 403 on field un-create (preview + execute)', async () => {
    // "canManageViews but NOT canManageFields" is unconstructable (both === canWrite); the field gate is exercised with
    // a read-only actor that holds NEITHER cap (mirrors the config-restore READER→403). Flag is ON to prove the 403 is
    // the CAPABILITY gate (which precedes the flag check), not the flag.
    process.env[FLAG] = 'true'
    const s = await freshSheet('b')
    const F = mkFieldId(); await insertField(s, F, 'BField', 'string', 1)
    const rev = await insertFieldCreateRev(s, F, 'BField', 'string', 1)
    expect((await preview(s, rev, READER)).status).toBe(403) // generic sendForbidden (no specific code)
    expect((await execute(s, { revisionId: rev, previewToken: 'any-token', confirm: 'uncreate' }, READER)).status).toBe(403)
  })

  test('(c) happy FIELD un-create: full cascade + restore delete revision sharing ONE batch_id', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('c')
    const F = mkFieldId(); await insertField(s, F, 'CField', 'string', 1)
    const T = mkFieldId(); await insertField(s, T, 'CTrailing', 'string', 2) // trailing → order shifts on drop
    const createRev = await insertFieldCreateRev(s, F, 'CField', 'string', 1)
    const r1 = await insertRecord(s, { [F]: 'v1', keep: 'x' })
    await insertRecord(s, { [F]: 'v2', keep: 'y' })
    await insertLink(F, r1, 'foreign-1')
    await insertAutoNumber(F, s)
    const V = mkViewId(); await insertView(s, V, 'CView', [F]) // references F in hidden_field_ids → cascade cleanup
    expect(await countColumnData(s, F)).toBe(2) // F's key is PRESENT before the drop

    const p = await preview(s, createRev)
    expect(p.status).toBe(200)
    const ok = await execute(s, { revisionId: createRev, previewToken: p.body.data.previewToken, confirm: 'uncreate' })
    expect(ok.status).toBe(200)
    expect(ok.body?.data?.uncreated).toMatchObject({ entityType: 'field', entityId: F })

    expect(await rowCount('SELECT 1 FROM meta_fields WHERE id=$1', [F])).toBe(0) // field gone
    expect(await countColumnData(s, F)).toBe(0) // F's key stripped from every record.data
    expect(await rowCount('SELECT 1 FROM meta_records WHERE sheet_id=$1', [s])).toBe(2) // records themselves survive
    expect(await rowCount('SELECT 1 FROM meta_links WHERE field_id=$1', [F])).toBe(0) // links for F gone
    expect(await rowCount('SELECT 1 FROM meta_field_auto_number_sequences WHERE field_id=$1', [F])).toBe(0) // seq gone
    expect(((await q('SELECT "order" FROM meta_fields WHERE id=$1', [T])).rows[0] as { order: number }).order).toBe(1) // 2 → 1
    const vh = (await q('SELECT hidden_field_ids FROM meta_views WHERE id=$1', [V])).rows[0] as { hidden_field_ids: unknown }
    expect(JSON.stringify(vh.hidden_field_ids)).not.toContain(F) // referencing view no longer mentions F

    const del = (await q(
      `SELECT id, batch_id FROM meta_config_revisions WHERE sheet_id=$1 AND entity_type='field' AND entity_id=$2 AND action='delete' AND source='restore' AND restored_from_id=$3`,
      [s, F, createRev],
    )).rows[0] as { id: string; batch_id: string } | undefined
    expect(del).toBeTruthy()
    const batchId = (del as { batch_id: string }).batch_id
    const shift = (await q(`SELECT batch_id FROM meta_config_revisions WHERE sheet_id=$1 AND entity_type='field' AND entity_id=$2 AND action='update'`, [s, T])).rows[0] as { batch_id: string }
    expect(shift.batch_id).toBe(batchId) // order-shift cascade shares the field-delete batch_id
    const vcas = (await q(`SELECT batch_id FROM meta_config_revisions WHERE sheet_id=$1 AND entity_type='view' AND entity_id=$2 AND action='update'`, [s, V])).rows[0] as { batch_id: string }
    expect(vcas.batch_id).toBe(batchId) // view-cleanup cascade shares it too
  })

  test('(d) happy VIEW un-create: view gone + restore delete revision', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('d')
    const V = mkViewId(); await insertView(s, V, 'DView', [])
    const createRev = await insertViewCreateRev(s, V, 'DView')
    const p = await preview(s, createRev)
    expect(p.status).toBe(200)
    expect(p.body?.data?.uncreate).toMatchObject({ entityType: 'view', entityId: V })
    const ok = await execute(s, { revisionId: createRev, previewToken: p.body.data.previewToken, confirm: 'uncreate' })
    expect(ok.status).toBe(200)
    expect(ok.body?.data?.uncreated).toMatchObject({ entityType: 'view', entityId: V })
    expect(await rowCount('SELECT 1 FROM meta_views WHERE id=$1', [V])).toBe(0)
    const del = (await q(
      `SELECT count(*)::int AS n FROM meta_config_revisions WHERE sheet_id=$1 AND entity_type='view' AND entity_id=$2 AND action='delete' AND source='restore' AND restored_from_id=$3`,
      [s, V, createRev],
    )).rows[0] as { n: number }
    expect(del.n).toBe(1)
  })

  test('(e) sink-reuse parity: forward DELETE /fields/:id drives the SAME cascade (delete rev + column strip + view cleanup)', async () => {
    // The forward delete route is NOT flag-gated; it exercises dropFieldCascade for the FORWARD caller, proving the
    // extracted helper is shared with un-create. Only difference: source='mutation' (vs the un-create's 'restore').
    const s = await freshSheet('e')
    const F = mkFieldId(); await insertField(s, F, 'EField', 'string', 1)
    await insertField(s, mkFieldId(), 'ETrailing', 'string', 2)
    const r1 = await insertRecord(s, { [F]: 'v1', keep: 'x' })
    await insertLink(F, r1, 'foreign-e')
    await insertAutoNumber(F, s)
    const V = mkViewId(); await insertView(s, V, 'EView', [F])

    const del = await forwardDeleteField(F, MANAGER)
    expect(del.status).toBe(200)
    expect(del.body?.data?.deleted).toBe(F)

    expect(await rowCount('SELECT 1 FROM meta_fields WHERE id=$1', [F])).toBe(0) // field gone
    expect(await countColumnData(s, F)).toBe(0) // column stripped
    const vh = (await q('SELECT hidden_field_ids FROM meta_views WHERE id=$1', [V])).rows[0] as { hidden_field_ids: unknown }
    expect(JSON.stringify(vh.hidden_field_ids)).not.toContain(F) // view cleaned
    const rev = (await q(`SELECT source, restored_from_id FROM meta_config_revisions WHERE sheet_id=$1 AND entity_type='field' AND entity_id=$2 AND action='delete'`, [s, F])).rows[0] as { source: string; restored_from_id: string | null }
    expect(rev.source).toBe('mutation') // forward op — NOT a restore
    expect(rev.restored_from_id).toBeNull()
  })

  test('(f) plan-drift: new view ref / new column data / new trailing field — all one generic 409 PLAN_DRIFT', async () => {
    process.env[FLAG] = 'true'
    // (i) a NEW view referencing F appears after preview → cascade view-id set changes → plan drift.
    {
      const s = await freshSheet('f1')
      const F = mkFieldId(); await insertField(s, F, 'Ff1', 'string', 1)
      const rev = await insertFieldCreateRev(s, F, 'Ff1', 'string', 1)
      const p = await preview(s, rev); expect(p.status).toBe(200)
      const V = mkViewId(); await insertView(s, V, 'drift-view', [F])
      const x = await execute(s, { revisionId: rev, previewToken: p.body.data.previewToken, confirm: 'uncreate' })
      expect(x.status).toBe(409)
      expect(x.body?.error?.code).toBe('PLAN_DRIFT')
    }
    // (ii) new column data written for F after preview → column-data presence flips false→true → plan drift.
    {
      const s = await freshSheet('f2')
      const F = mkFieldId(); await insertField(s, F, 'Ff2', 'string', 1)
      const rev = await insertFieldCreateRev(s, F, 'Ff2', 'string', 1)
      const p = await preview(s, rev); expect(p.status).toBe(200)
      await insertRecord(s, { [F]: 'late-value' })
      const x = await execute(s, { revisionId: rev, previewToken: p.body.data.previewToken, confirm: 'uncreate' })
      expect(x.status).toBe(409)
      expect(x.body?.error?.code).toBe('PLAN_DRIFT')
    }
    // (iii) a new trailing field appears after preview → order-shift set changes → plan drift.
    {
      const s = await freshSheet('f3')
      const F = mkFieldId(); await insertField(s, F, 'Ff3', 'string', 1)
      const rev = await insertFieldCreateRev(s, F, 'Ff3', 'string', 1)
      const p = await preview(s, rev); expect(p.status).toBe(200)
      await insertField(s, mkFieldId(), 'late-trailing', 'string', 5)
      const x = await execute(s, { revisionId: rev, previewToken: p.body.data.previewToken, confirm: 'uncreate' })
      expect(x.status).toBe(409)
      expect(x.body?.error?.code).toBe('PLAN_DRIFT')
    }
  })

  test('(g) NO benign-rename false-409: a post-preview rename does not drift the plan → un-create proceeds', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('g')
    const F = mkFieldId(); await insertField(s, F, 'GField', 'string', 1)
    const rev = await insertFieldCreateRev(s, F, 'GField', 'string', 1)
    await insertRecord(s, { [F]: 'v1' }) // non-trivial plan
    const p = await preview(s, rev); expect(p.status).toBe(200)
    await q(`UPDATE meta_fields SET name='renamed-after-preview' WHERE id=$1`, [F]) // cosmetic — NOT a planHash input
    const x = await execute(s, { revisionId: rev, previewToken: p.body.data.previewToken, confirm: 'uncreate' })
    expect(x.status).toBe(200)
    expect(await rowCount('SELECT 1 FROM meta_fields WHERE id=$1', [F])).toBe(0) // dropped, not 409'd
  })

  test('(h) token/response opacity: JWT carries only an opaque planHash; response carries no raw plan fields/counts', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('h')
    const F = mkFieldId(); await insertField(s, F, 'HField', 'string', 1)
    await insertField(s, mkFieldId(), 'HTrailing', 'string', 2) // order-shift plan input
    const rev = await insertFieldCreateRev(s, F, 'HField', 'string', 1)
    await insertRecord(s, { [F]: 'v1' }) // column-data plan input
    const V = mkViewId(); await insertView(s, V, 'HView', [F]) // cascade plan input
    const p = await preview(s, rev); expect(p.status).toBe(200)
    const token: string = p.body.data.previewToken

    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
    expect(typeof payload.planHash).toBe('string')
    expect(payload).not.toHaveProperty('cascadeViewIds')
    expect(payload).not.toHaveProperty('orderShiftIds')
    expect(payload).not.toHaveProperty('columnDataPresent')

    const uncreate = p.body.data.uncreate as Record<string, unknown>
    expect(Object.keys(uncreate).sort()).toEqual(['entityId', 'entityName', 'entityType', 'note'])
    const raw = JSON.stringify(p.body)
    expect(raw).not.toContain('cascadeViewIds')
    expect(raw).not.toContain('orderShiftIds')
    expect(raw).not.toContain('columnDataPresent')
    expect(raw).not.toContain('planHash') // base64 JWT does not surface the claim name in plaintext
    expect(JSON.stringify(uncreate)).not.toMatch(/:\s*\d/) // no numeric-valued field anywhere in the summary
  })

  test('(i) no-oracle: with several records of column data, the preview still leaks NO records-affected count', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('i')
    const F = mkFieldId(); await insertField(s, F, 'IField', 'string', 1)
    const rev = await insertFieldCreateRev(s, F, 'IField', 'string', 1)
    for (let i = 0; i < 5; i++) await insertRecord(s, { [F]: `val-${i}` })
    const p = await preview(s, rev); expect(p.status).toBe(200)
    const uncreate = p.body.data.uncreate as Record<string, unknown>
    expect(Object.keys(uncreate).sort()).toEqual(['entityId', 'entityName', 'entityType', 'note'])
    expect(JSON.stringify(uncreate)).not.toMatch(/:\s*\d/) // no numeric-valued property → no count of records/cells
    expect(String(uncreate.note)).not.toMatch(/\d/) // the consequence text names no count
  })

  test('(j) typed-confirm: missing/wrong confirm → 400 CONFIRM_REQUIRED; "uncreate" → 200 drops', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('j')
    const F = mkFieldId(); await insertField(s, F, 'JField', 'string', 1)
    const rev = await insertFieldCreateRev(s, F, 'JField', 'string', 1)
    const p = await preview(s, rev); expect(p.status).toBe(200)
    const token: string = p.body.data.previewToken
    // confirm check precedes (and is outside) the txn token-verify, so a valid token without confirm still 400s here.
    const miss = await execute(s, { revisionId: rev, previewToken: token })
    expect(miss.status).toBe(400)
    expect(miss.body?.error?.code).toBe('CONFIRM_REQUIRED')
    const wrong = await execute(s, { revisionId: rev, previewToken: token, confirm: 'yes' })
    expect(wrong.status).toBe(400)
    expect(wrong.body?.error?.code).toBe('CONFIRM_REQUIRED')
    // the two rejected attempts wrote nothing → the same token still verifies → typed confirm drops.
    const ok = await execute(s, { revisionId: rev, previewToken: token, confirm: 'uncreate' })
    expect(ok.status).toBe(200)
    expect(await rowCount('SELECT 1 FROM meta_fields WHERE id=$1', [F])).toBe(0)
  })

  test('(k) early-drop atomicity: failure at the delete-revision insert (right after DELETE meta_fields) rolls the drop back', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('k')
    const F = mkFieldId(); await insertField(s, F, 'KField', 'string', 1)
    await insertField(s, mkFieldId(), 'KTrailing', 'string', 2)
    const rev = await insertFieldCreateRev(s, F, 'KField', 'string', 1)
    await insertRecord(s, { [F]: 'v1' })
    const p = await preview(s, rev); expect(p.status).toBe(200)
    const token: string = p.body.data.previewToken
    // Fails at the EARLY step — the restore delete-revision insert, right after DELETE meta_fields and BEFORE the
    // later cascade writes (links delete / column strip / order shift / view cleanup). Golden (n) forces a LATER step
    // to prove the full cascade is atomic. Trigger scoped to THIS sheet's restore-delete row (never setup/parallel).
    const FN = `uc_atomic_fail_${TS}`
    const TRG = `uc_atomic_fail_trg_${TS}`
    await q(`CREATE OR REPLACE FUNCTION ${FN}() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'forced un-create cascade failure (atomicity golden)'; END; $fn$`, [])
    await q(`DROP TRIGGER IF EXISTS ${TRG} ON meta_config_revisions`, [])
    await q(`CREATE TRIGGER ${TRG} BEFORE INSERT ON meta_config_revisions FOR EACH ROW WHEN (NEW.sheet_id = '${s}' AND NEW.action = 'delete' AND NEW.source = 'restore') EXECUTE FUNCTION ${FN}()`, [])
    try {
      const x = await execute(s, { revisionId: rev, previewToken: token, confirm: 'uncreate' })
      expect(x.status).toBeGreaterThanOrEqual(500) // forced failure aborts the txn → INTERNAL
      expect(await rowCount('SELECT 1 FROM meta_fields WHERE id=$1', [F])).toBe(1) // F STILL present (drop rolled back)
      expect(await countColumnData(s, F)).toBeGreaterThan(0) // column data intact
      expect(await rowCount(`SELECT 1 FROM meta_config_revisions WHERE sheet_id=$1 AND action='delete' AND source='restore'`, [s])).toBe(0) // no delete revision committed
    } finally {
      await q(`DROP TRIGGER IF EXISTS ${TRG} ON meta_config_revisions`, []).catch(() => {})
      await q(`DROP FUNCTION IF EXISTS ${FN}()`, []).catch(() => {})
    }
  })

  test('(l) audit: a happy field un-create records EXACTLY ONE field delete revision (source=restore, restored_from_id)', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('l')
    const F = mkFieldId(); await insertField(s, F, 'LField', 'string', 1)
    const createRev = await insertFieldCreateRev(s, F, 'LField', 'string', 1)
    const p = await preview(s, createRev); expect(p.status).toBe(200)
    const ok = await execute(s, { revisionId: createRev, previewToken: p.body.data.previewToken, confirm: 'uncreate' })
    expect(ok.status).toBe(200)
    const audit = (await q(
      `SELECT count(*)::int AS n FROM meta_config_revisions WHERE sheet_id=$1 AND entity_type='field' AND entity_id=$2 AND action='delete' AND source='restore' AND restored_from_id=$3`,
      [s, F, createRev],
    )).rows[0] as { n: number }
    expect(audit.n).toBe(1)
  })

  test('(m) sheet-consistency guard: a revision whose entity lives on ANOTHER sheet → 400 INVALID_REVISION, zero drops', async () => {
    process.env[FLAG] = 'true'
    const sOther = await freshSheet('m-other')
    const sUrl = await freshSheet('m-url')
    const F = mkFieldId(); await insertField(sOther, F, 'MField', 'string', 1) // the field actually lives on sOther
    await insertRecord(sOther, { [F]: 'keep' })
    // a malformed create revision recorded under sUrl but pointing at F (which belongs to sOther). The revision is
    // findable on sUrl (sheet_id matches the URL), but the entity's own sheet_id diverges → the execute guard fires.
    const rev = await insertFieldCreateRev(sUrl, F, 'MField', 'string', 1)
    const x = await execute(sUrl, { revisionId: rev, previewToken: 'any-token', confirm: 'uncreate' })
    expect(x.status).toBe(400)
    expect(x.body?.error?.code).toBe('INVALID_REVISION') // guard runs BEFORE the planHash verify, so the token is moot
    expect(await rowCount('SELECT 1 FROM meta_fields WHERE id=$1', [F])).toBe(1) // F NOT dropped
    expect(await countColumnData(sOther, F)).toBe(1) // sOther's column data untouched
  })

  test('(n) late-cascade atomicity: a failure at the column-strip (AFTER field+links delete) rolls the WHOLE cascade back', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('n')
    const F = mkFieldId(); await insertField(s, F, 'NField', 'string', 1)
    await insertField(s, mkFieldId(), 'NTrailing', 'string', 2) // order-shift target
    const rev = await insertFieldCreateRev(s, F, 'NField', 'string', 1)
    const r1 = await insertRecord(s, { [F]: 'v1' })
    await insertLink(F, r1, 'foreign-n')
    const p = await preview(s, rev); expect(p.status).toBe(200)
    const token: string = p.body.data.previewToken
    // Fail at the column-strip (UPDATE meta_records) — which runs AFTER DELETE meta_fields, DELETE auto-number, the
    // delete-revision insert, AND DELETE meta_links. A clean rollback past (k)'s early point must restore ALL of those.
    const FN = `uc_late_fail_${TS}`
    const TRG = `uc_late_fail_trg_${TS}`
    await q(`CREATE OR REPLACE FUNCTION ${FN}() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'forced late-cascade failure (atomicity golden n)'; END; $fn$`, [])
    await q(`DROP TRIGGER IF EXISTS ${TRG} ON meta_records`, [])
    await q(`CREATE TRIGGER ${TRG} BEFORE UPDATE ON meta_records FOR EACH ROW WHEN (OLD.sheet_id = '${s}') EXECUTE FUNCTION ${FN}()`, [])
    try {
      const x = await execute(s, { revisionId: rev, previewToken: token, confirm: 'uncreate' })
      expect(x.status).toBeGreaterThanOrEqual(500) // forced failure aborts the txn → INTERNAL
      expect(await rowCount('SELECT 1 FROM meta_fields WHERE id=$1', [F])).toBe(1) // field restored (DELETE rolled back)
      expect(await rowCount('SELECT 1 FROM meta_links WHERE field_id=$1', [F])).toBe(1) // links restored (the later DELETE rolled back)
      expect(await countColumnData(s, F)).toBe(1) // column data intact
      expect(await rowCount(`SELECT 1 FROM meta_config_revisions WHERE sheet_id=$1 AND action='delete' AND source='restore'`, [s])).toBe(0) // no delete revision committed
    } finally {
      await q(`DROP TRIGGER IF EXISTS ${TRG} ON meta_records`, []).catch(() => {})
      await q(`DROP FUNCTION IF EXISTS ${FN}()`, []).catch(() => {})
    }
  })
})
