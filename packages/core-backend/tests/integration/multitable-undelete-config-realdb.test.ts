/**
 * T9-W Tier 4 (U-4) — config UNDELETE (revert a field/view `delete` = RECREATE the entity from its `before`) — real DB.
 * Behind the default-off flag MULTITABLE_ENABLE_CONFIG_UNDELETE. Routes: POST /sheets/:id/config-restore-preview
 * {revisionId} and POST /sheets/:id/config-restore-execute {revisionId, previewToken, confirm}. Undelete applies ONLY to
 * a `delete` revision whose entity_type ∈ {field,view} (isSupportedUndelete); a `delete` revision has before={full
 * config}, after=null. classifyRevert stays gated for every delete.
 *
 * RECREATE is DEFINITION-ONLY (U4-L3): it recreates the meta_fields/meta_views row from `before` — a field at
 * `before.order` with trailing fields shifted +1 — and records a `create` revision (source='restore',
 * restored_from_id=the delete rev). It does NOT restore column values / meta_links / auto-number, and does NOT re-add
 * the field to any view config.
 *
 * Preview is read-only and UNDISCLOSED (U4-L5): it names the entity + the definition-only note + a boolean idCollision
 * flag and binds an OPAQUE HMAC undeleteHash (U4-L4) over the recreate plan { idFree / insertOrder / trailingShiftIds /
 * targetConfigHash } — NO counts, NO raw plan fields ever reach the response or the JWT. Execute re-locks, re-checks the
 * id-free guard separately (→ ID_COLLISION) and the single undeleteHash (→ ONE generic 409 PLAN_DRIFT), then recreates
 * inside ONE pool.transaction.
 *
 * Goldens (a)-(n) + (k2): (a) flag-off 403 · (b) permission gate · (c) happy FIELD undelete (definition + trailing shift +
 * create/restore rev) · (d) happy VIEW undelete · (e) definition-only (no values/links/auto-number) · (f)
 * id-collision/idempotency · (g) plan-drift · (h) token/response opacity · (i) no-oracle count · (j) typed-confirm ·
 * (k) single-txn atomicity · (k2) recreate unique-race rollback · (l) audit revision · (m) sheet-scoping · (n)
 * held-surface tripwire. Runs only with DATABASE_URL.
 *
 * NOTE on the flag: MULTITABLE_ENABLE_CONFIG_UNDELETE is read PER-REQUEST inside the handlers (not captured at router
 * build), so — exactly like the sibling multitable-uncreate-config golden — ONE app + a per-test env toggle + afterEach
 * delete is both correct and sufficient (a "separate flag-off app" cannot isolate a global process.env flag).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_ud_${TS}`
const FLAG = 'MULTITABLE_ENABLE_CONFIG_UNDELETE'

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)

type Actor = { id: string; roles: string[]; perms: string[] }
// canManageFields === canManageViews === canWrite (deriveCapabilities: both derive from multitable:write, and the
// sheet-scope grant sets both together) — so MANAGER (read+write) holds BOTH field+view manage caps, and a read-only
// actor holds NEITHER. There is no perm that yields "canManageViews but not canManageFields".
const MANAGER: Actor = { id: `u_ud_mgr_${TS}`, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
const READER: Actor = { id: `u_ud_reader_${TS}`, roles: ['member'], perms: ['multitable:read'] }

let app: Express
let actor: Actor = MANAGER

const CREATED_SHEETS: string[] = []
let seq = 0
const mkFieldId = () => `fld_ud_${TS}_${seq++}`
const mkViewId = () => `view_ud_${TS}_${seq++}`

async function freshSheet(tag: string): Promise<string> {
  const id = `sheet_ud_${tag}_${TS}`
  await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [id, BASE, id])
  CREATED_SHEETS.push(id)
  return id
}
async function insertField(sheetId: string, fieldId: string, name: string, type: string, order: number): Promise<void> {
  await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [fieldId, sheetId, name, type, '{}', order])
}
/** Seed the `delete` revision a forward field-delete records (fieldDeleteDiff shape): before = full config, after = NULL,
 *  source='mutation'. The fieldId must have NO live meta_fields row (it was deleted) for the undelete to recreate it. */
async function insertFieldDeleteRev(sheetId: string, fieldId: string, before: { name: string; type: string; property: unknown; order: number }): Promise<string> {
  const r = await q(
    `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, before, after, changed_keys, batch_id, actor_id, source)
     VALUES ($1,'field',$2,'delete',$3::jsonb,NULL,$4::text[],gen_random_uuid(),$5,'mutation') RETURNING id`,
    [sheetId, fieldId, JSON.stringify(before), ['name', 'type', 'property', 'order'], MANAGER.id],
  )
  return ((r.rows[0]) as { id: string }).id
}
/** Seed a `delete` revision for a view id with no live meta_views row; before = the full view config. */
async function insertViewDeleteRev(sheetId: string, viewId: string, before: Record<string, unknown>): Promise<string> {
  const r = await q(
    `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, before, after, changed_keys, batch_id, actor_id, source)
     VALUES ($1,'view',$2,'delete',$3::jsonb,NULL,$4::text[],gen_random_uuid(),$5,'mutation') RETURNING id`,
    [sheetId, viewId, JSON.stringify(before), ['name', 'type', 'filterInfo', 'sortInfo', 'groupInfo', 'hiddenFieldIds', 'config'], MANAGER.id],
  )
  return ((r.rows[0]) as { id: string }).id
}
async function insertRecord(sheetId: string, data: Record<string, unknown>): Promise<string> {
  const r = await q('INSERT INTO meta_records (sheet_id, data) VALUES ($1,$2::jsonb) RETURNING id', [sheetId, JSON.stringify(data)])
  return ((r.rows[0]) as { id: string }).id
}
const countColumnData = async (sheetId: string, fieldId: string): Promise<number> =>
  ((await q(`SELECT count(*)::int AS n FROM meta_records WHERE sheet_id=$1 AND data->>$2 IS NOT NULL`, [sheetId, fieldId])).rows[0] as { n: number }).n
const rowCount = async (sql: string, params: unknown[]): Promise<number> => (await q(sql, params)).rows.length

const preview = (sheetId: string, revisionId: string, as: Actor = MANAGER) => { actor = as; return request(app).post(`/api/multitable/sheets/${sheetId}/config-restore-preview`).send({ revisionId }) }
const execute = (sheetId: string, body: Record<string, unknown>, as: Actor = MANAGER) => { actor = as; return request(app).post(`/api/multitable/sheets/${sheetId}/config-restore-execute`).send(body) }

describeIfDatabase('multitable config undelete — T9-W Tier 4 / U-4 (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as { user?: Actor }).user = actor; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'UD Base'])
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

  test('(a) flag OFF → preview AND execute both 403 CONFIG_UNDELETE_DISABLED', async () => {
    delete process.env[FLAG] // flag read per-request → unset = off (no separate app needed)
    const s = await freshSheet('a')
    const F = mkFieldId() // deleted field: NO live meta_fields row
    const rev = await insertFieldDeleteRev(s, F, { name: 'AField', type: 'string', property: {}, order: 1 })
    // MANAGER so the capability gate (which precedes the flag gate) passes → we actually reach the flag check.
    const p = await preview(s, rev, MANAGER)
    expect(p.status).toBe(403)
    expect(p.body?.error?.code).toBe('CONFIG_UNDELETE_DISABLED')
    // execute needs a non-empty previewToken to pass body-validation before the flag check fires.
    const x = await execute(s, { revisionId: rev, previewToken: 'any-token' }, MANAGER)
    expect(x.status).toBe(403)
    expect(x.body?.error?.code).toBe('CONFIG_UNDELETE_DISABLED')
  })

  test('(b) permission: actor lacking field-manage capability → 403 on field undelete (preview + execute)', async () => {
    // "canManageViews but NOT canManageFields" is unconstructable (both === canWrite); the field gate is exercised with
    // a read-only actor that holds NEITHER cap (mirrors the config-restore READER→403). Flag is ON to prove the 403 is
    // the CAPABILITY gate (which precedes the flag check), not the flag.
    process.env[FLAG] = 'true'
    const s = await freshSheet('b')
    const F = mkFieldId()
    const rev = await insertFieldDeleteRev(s, F, { name: 'BField', type: 'string', property: {}, order: 1 })
    expect((await preview(s, rev, READER)).status).toBe(403) // generic sendForbidden (no specific code)
    expect((await execute(s, { revisionId: rev, previewToken: 'any-token', confirm: 'undelete' }, READER)).status).toBe(403)
  })

  test('(c) happy FIELD undelete: definition recreated at original order + trailing shifted +1 + create(restore) revision', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('c')
    const F = mkFieldId() // the deleted field (before.order=2); NO live meta_fields row
    const T = mkFieldId(); await insertField(s, T, 'CTrailing', 'string', 3) // live trailing field at order 3 → shifts +1
    const rev = await insertFieldDeleteRev(s, F, { name: 'CField', type: 'number', property: {}, order: 2 })

    const p = await preview(s, rev)
    expect(p.status).toBe(200)
    expect(p.body?.data?.undelete).toMatchObject({ entityType: 'field', entityId: F })
    const ok = await execute(s, { revisionId: rev, previewToken: p.body.data.previewToken, confirm: 'undelete' })
    expect(ok.status).toBe(200)
    expect(ok.body?.data?.undeleted).toMatchObject({ entityType: 'field', entityId: F })

    // field DEFINITION recreated from `before` (name/type/order)
    const f = (await q('SELECT name, type, "order" FROM meta_fields WHERE id=$1', [F])).rows[0] as { name: string; type: string; order: number } | undefined
    expect(f).toBeTruthy()
    expect(f).toMatchObject({ name: 'CField', type: 'number', order: 2 })
    // trailing field shifted +1 (3 → 4)
    expect(((await q('SELECT "order" FROM meta_fields WHERE id=$1', [T])).rows[0] as { order: number }).order).toBe(4)
    // a create(restore) revision back-references the delete revision
    const cr = (await q(
      `SELECT count(*)::int AS n FROM meta_config_revisions WHERE sheet_id=$1 AND entity_type='field' AND entity_id=$2 AND action='create' AND source='restore' AND restored_from_id=$3`,
      [s, F, rev],
    )).rows[0] as { n: number }
    expect(cr.n).toBe(1)
  })

  test('(d) happy VIEW undelete: view recreated from before + create(restore) revision', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('d')
    const V = mkViewId() // the deleted view; NO live meta_views row
    const before = { name: 'DView', type: 'grid', filterInfo: {}, sortInfo: {}, groupInfo: {}, hiddenFieldIds: [], config: {} }
    const rev = await insertViewDeleteRev(s, V, before)
    const p = await preview(s, rev)
    expect(p.status).toBe(200)
    expect(p.body?.data?.undelete).toMatchObject({ entityType: 'view', entityId: V })
    const ok = await execute(s, { revisionId: rev, previewToken: p.body.data.previewToken, confirm: 'undelete' })
    expect(ok.status).toBe(200)
    expect(ok.body?.data?.undeleted).toMatchObject({ entityType: 'view', entityId: V })
    const v = (await q('SELECT name, type FROM meta_views WHERE id=$1', [V])).rows[0] as { name: string; type: string } | undefined
    expect(v).toMatchObject({ name: 'DView', type: 'grid' })
    const cr = (await q(
      `SELECT count(*)::int AS n FROM meta_config_revisions WHERE sheet_id=$1 AND entity_type='view' AND entity_id=$2 AND action='create' AND source='restore' AND restored_from_id=$3`,
      [s, V, rev],
    )).rows[0] as { n: number }
    expect(cr.n).toBe(1)
  })

  test('(e) definition-only: the recreated field has NO restored column values / links / auto-number; records untouched', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('e')
    const F = mkFieldId() // the deleted field
    const rev = await insertFieldDeleteRev(s, F, { name: 'EField', type: 'string', property: {}, order: 1 })
    // records EXIST (with other data) but none carries F's column — F was deleted, its column data is gone.
    await insertRecord(s, { keep: 'x' })
    await insertRecord(s, { keep: 'y' })
    const p = await preview(s, rev); expect(p.status).toBe(200)
    const ok = await execute(s, { revisionId: rev, previewToken: p.body.data.previewToken, confirm: 'undelete' })
    expect(ok.status).toBe(200)
    // definition restored ...
    expect(await rowCount('SELECT 1 FROM meta_fields WHERE id=$1', [F])).toBe(1)
    // ... but the DATA is NOT (definition-only): no record carries F's key, no meta_links, no auto-number for F.
    expect(await countColumnData(s, F)).toBe(0)
    expect(await rowCount('SELECT 1 FROM meta_links WHERE field_id=$1', [F])).toBe(0)
    expect(await rowCount('SELECT 1 FROM meta_field_auto_number_sequences WHERE field_id=$1', [F])).toBe(0)
    // records themselves untouched — still present, still carry their own (non-F) data.
    expect(await rowCount('SELECT 1 FROM meta_records WHERE sheet_id=$1', [s])).toBe(2)
    expect(await countColumnData(s, 'keep')).toBe(2)
  })

  test('(f) id-collision / idempotency: a delete rev whose id is already LIVE → 409 ID_COLLISION, live row unchanged', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('f')
    const X = mkFieldId()
    await insertField(s, X, 'XLive', 'string', 1) // a LIVE field already occupies id X (idempotency: it already exists)
    const rev = await insertFieldDeleteRev(s, X, { name: 'XDeleted', type: 'number', property: {}, order: 1 })
    const p = await preview(s, rev)
    expect(p.status).toBe(200)
    expect(p.body?.data?.undelete?.idCollision).toBe(true) // preview surfaces the collision as a boolean flag (no count)
    // the id-occupied check (FOR UPDATE) runs BEFORE the undeleteHash verify, so even a valid token cannot bypass it.
    const x = await execute(s, { revisionId: rev, previewToken: p.body.data.previewToken, confirm: 'undelete' })
    expect(x.status).toBe(409)
    expect(x.body?.error?.code).toBe('ID_COLLISION')
    // the live row is unchanged — not overwritten, not duplicated
    expect(await rowCount('SELECT 1 FROM meta_fields WHERE id=$1', [X])).toBe(1)
    expect(((await q('SELECT name FROM meta_fields WHERE id=$1', [X])).rows[0] as { name: string }).name).toBe('XLive')
  })

  test('(g) plan-drift: a new field at order>=before.order changes trailingShiftIds → stale token 409 PLAN_DRIFT', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('g')
    const F = mkFieldId() // deleted field, before.order=2; NO live fields yet → preview trailingShiftIds=[]
    const rev = await insertFieldDeleteRev(s, F, { name: 'GField', type: 'string', property: {}, order: 2 })
    const p = await preview(s, rev); expect(p.status).toBe(200)
    // a NEW field appears at order >= before.order AFTER preview → trailingShiftIds []→[new] → undeleteHash diverges.
    await insertField(s, mkFieldId(), 'late-trailing', 'string', 5)
    const x = await execute(s, { revisionId: rev, previewToken: p.body.data.previewToken, confirm: 'undelete' })
    expect(x.status).toBe(409)
    expect(x.body?.error?.code).toBe('PLAN_DRIFT')
    expect(await rowCount('SELECT 1 FROM meta_fields WHERE id=$1', [F])).toBe(0) // not recreated
  })

  test('(h) token/response opacity: JWT carries only an opaque undeleteHash; response carries no raw plan fields/counts', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('h')
    const F = mkFieldId() // deleted field (before.order=1)
    await insertField(s, mkFieldId(), 'HTrailing', 'string', 2) // a live trailing field → non-empty trailingShiftIds plan input
    const rev = await insertFieldDeleteRev(s, F, { name: 'HField', type: 'string', property: {}, order: 1 })
    const p = await preview(s, rev); expect(p.status).toBe(200)
    const token: string = p.body.data.previewToken

    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
    expect(typeof payload.undeleteHash).toBe('string')
    expect(payload).not.toHaveProperty('trailingShiftIds')
    expect(payload).not.toHaveProperty('insertOrder')
    expect(payload).not.toHaveProperty('idFree')
    expect(payload).not.toHaveProperty('targetConfigHash')

    const undelete = p.body.data.undelete as Record<string, unknown>
    expect(Object.keys(undelete).sort()).toEqual(['entityId', 'entityName', 'entityType', 'idCollision', 'note'])
    expect(Object.values(undelete).some((v) => typeof v === 'number')).toBe(false) // no numeric count anywhere in the summary
    const raw = JSON.stringify(p.body)
    expect(raw).not.toContain('trailingShiftIds')
    expect(raw).not.toContain('insertOrder')
    expect(raw).not.toContain('idFree')
    expect(raw).not.toContain('targetConfigHash')
    expect(raw).not.toContain('undeleteHash') // base64 JWT does not surface the claim name in plaintext
  })

  test('(i) no-oracle: with several records present, the preview still leaks NO records-affected count', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('i')
    const F = mkFieldId()
    const rev = await insertFieldDeleteRev(s, F, { name: 'IField', type: 'string', property: {}, order: 1 })
    for (let i = 0; i < 5; i++) await insertRecord(s, { keep: `v-${i}` })
    const p = await preview(s, rev); expect(p.status).toBe(200)
    const undelete = p.body.data.undelete as Record<string, unknown>
    expect(Object.keys(undelete).sort()).toEqual(['entityId', 'entityName', 'entityType', 'idCollision', 'note'])
    expect(Object.values(undelete).some((v) => typeof v === 'number')).toBe(false) // no count of records/cells (undelete touches no record data anyway)
    expect(String(undelete.note)).not.toMatch(/\d/) // the consequence text names no count
  })

  test('(j) typed-confirm: missing/wrong confirm → 400 CONFIRM_REQUIRED; "undelete" → 200 recreates', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('j')
    const F = mkFieldId()
    const rev = await insertFieldDeleteRev(s, F, { name: 'JField', type: 'string', property: {}, order: 1 })
    const p = await preview(s, rev); expect(p.status).toBe(200)
    const token: string = p.body.data.previewToken
    // confirm check precedes (and is outside) the txn token-verify, so a valid token without confirm still 400s here.
    const miss = await execute(s, { revisionId: rev, previewToken: token })
    expect(miss.status).toBe(400)
    expect(miss.body?.error?.code).toBe('CONFIRM_REQUIRED')
    const wrong = await execute(s, { revisionId: rev, previewToken: token, confirm: 'yes' })
    expect(wrong.status).toBe(400)
    expect(wrong.body?.error?.code).toBe('CONFIRM_REQUIRED')
    // the two rejected attempts wrote nothing → the same token still verifies → typed confirm recreates.
    const ok = await execute(s, { revisionId: rev, previewToken: token, confirm: 'undelete' })
    expect(ok.status).toBe(200)
    expect(await rowCount('SELECT 1 FROM meta_fields WHERE id=$1', [F])).toBe(1)
  })

  test('(k) single-txn atomicity: a failure at the create(restore) revision insert rolls the recreate + trailing shift back', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('k')
    const F = mkFieldId() // deleted field, before.order=2
    const T = mkFieldId(); await insertField(s, T, 'KTrailing', 'string', 3) // live trailing at order 3
    const rev = await insertFieldDeleteRev(s, F, { name: 'KField', type: 'string', property: {}, order: 2 })
    const p = await preview(s, rev); expect(p.status).toBe(200)
    const token: string = p.body.data.previewToken
    // The trigger fires on the LATE step — the field-recreate `create`/source='restore' audit insert — which runs AFTER
    // the trailing +1 shift AND the meta_fields F insert. A clean rollback must undo BOTH. The order-shift cascade
    // records action='update' rows so the WHEN never matches them; scoped to THIS sheet's restore-create row.
    const FN = `ud_atomic_fail_${TS}`
    const TRG = `ud_atomic_fail_trg_${TS}`
    await q(`CREATE OR REPLACE FUNCTION ${FN}() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'forced undelete recreate failure (atomicity golden)'; END; $fn$`, [])
    await q(`DROP TRIGGER IF EXISTS ${TRG} ON meta_config_revisions`, [])
    await q(`CREATE TRIGGER ${TRG} BEFORE INSERT ON meta_config_revisions FOR EACH ROW WHEN (NEW.sheet_id = '${s}' AND NEW.action = 'create' AND NEW.source = 'restore') EXECUTE FUNCTION ${FN}()`, [])
    try {
      const x = await execute(s, { revisionId: rev, previewToken: token, confirm: 'undelete' })
      expect(x.status).toBeGreaterThanOrEqual(500) // forced failure aborts the txn → INTERNAL
      expect(await rowCount('SELECT 1 FROM meta_fields WHERE id=$1', [F])).toBe(0) // F NOT recreated (insert rolled back)
      expect(((await q('SELECT "order" FROM meta_fields WHERE id=$1', [T])).rows[0] as { order: number }).order).toBe(3) // trailing +1 shift rolled back (still 3)
      expect(await rowCount(`SELECT 1 FROM meta_config_revisions WHERE sheet_id=$1 AND entity_id=$2 AND action='create' AND source='restore'`, [s, F])).toBe(0) // no create(restore) committed
    } finally {
      await q(`DROP TRIGGER IF EXISTS ${TRG} ON meta_config_revisions`, []).catch(() => {})
      await q(`DROP FUNCTION IF EXISTS ${FN}()`, []).catch(() => {})
    }
  })

  test('(k2) recreate unique-race backstop: 23505 during field insert returns 409 and rolls back trailing shift', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('k2')
    const F = mkFieldId() // deleted field, before.order=2
    const T = mkFieldId(); await insertField(s, T, 'K2Trailing', 'string', 3) // live trailing at order 3
    const rev = await insertFieldDeleteRev(s, F, { name: 'K2Field', type: 'string', property: {}, order: 2 })
    const p = await preview(s, rev); expect(p.status).toBe(200)
    const token: string = p.body.data.previewToken
    // Simulate the concurrency window after the explicit id-free guard but before INSERT: the insert sees a 23505.
    // The route must map that to ID_COLLISION OUTSIDE the transaction so the preceding order shift is rolled back.
    const FN = `ud_unique_race_${TS}`
    const TRG = `ud_unique_race_trg_${TS}`
    await q(`CREATE OR REPLACE FUNCTION ${FN}() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'forced unique race' USING ERRCODE = '23505'; END; $fn$`, [])
    await q(`DROP TRIGGER IF EXISTS ${TRG} ON meta_fields`, [])
    await q(`CREATE TRIGGER ${TRG} BEFORE INSERT ON meta_fields FOR EACH ROW WHEN (NEW.id = '${F}') EXECUTE FUNCTION ${FN}()`, [])
    try {
      const x = await execute(s, { revisionId: rev, previewToken: token, confirm: 'undelete' })
      expect(x.status).toBe(409)
      expect(x.body?.error?.code).toBe('ID_COLLISION')
      expect(await rowCount('SELECT 1 FROM meta_fields WHERE id=$1', [F])).toBe(0)
      expect(((await q('SELECT "order" FROM meta_fields WHERE id=$1', [T])).rows[0] as { order: number }).order).toBe(3)
      expect(await rowCount(`SELECT 1 FROM meta_config_revisions WHERE sheet_id=$1 AND entity_id=$2 AND action='update' AND changed_keys = ARRAY['order']::text[]`, [s, T])).toBe(0)
    } finally {
      await q(`DROP TRIGGER IF EXISTS ${TRG} ON meta_fields`, []).catch(() => {})
      await q(`DROP FUNCTION IF EXISTS ${FN}()`, []).catch(() => {})
    }
  })

  test('(l) audit: a happy field undelete records EXACTLY ONE create revision (source=restore, restored_from_id=delete rev)', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('l')
    const F = mkFieldId()
    const rev = await insertFieldDeleteRev(s, F, { name: 'LField', type: 'string', property: {}, order: 1 })
    const p = await preview(s, rev); expect(p.status).toBe(200)
    const ok = await execute(s, { revisionId: rev, previewToken: p.body.data.previewToken, confirm: 'undelete' })
    expect(ok.status).toBe(200)
    const audit = (await q(
      `SELECT count(*)::int AS n FROM meta_config_revisions WHERE sheet_id=$1 AND entity_type='field' AND entity_id=$2 AND action='create' AND source='restore' AND restored_from_id=$3`,
      [s, F, rev],
    )).rows[0] as { n: number }
    expect(audit.n).toBe(1)
  })

  test('(m) sheet-scoping: the recreate lands on the revision\'s sheet_id', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('m')
    const F = mkFieldId()
    const rev = await insertFieldDeleteRev(s, F, { name: 'MField', type: 'string', property: {}, order: 1 })
    const p = await preview(s, rev); expect(p.status).toBe(200)
    const ok = await execute(s, { revisionId: rev, previewToken: p.body.data.previewToken, confirm: 'undelete' })
    expect(ok.status).toBe(200)
    const row = (await q('SELECT sheet_id FROM meta_fields WHERE id=$1', [F])).rows[0] as { sheet_id: string } | undefined
    expect(row?.sheet_id).toBe(s) // recreated on the delete revision's own sheet_id
  })

  test('(n) held-surface tripwire: the undelete flag does NOT open the permission surface (refused 403)', async () => {
    process.env[FLAG] = 'true' // undelete flag ON
    const s = await freshSheet('n')
    // isSupportedUndelete is field/view-ONLY — the undelete flag must NOT open the permission (or sheet_config) surface.
    // Permission is its own slice (permission-revert, default-off, canManageSheetAccess floor): a write-but-not-share
    // actor (MANAGER, no canManageSheetAccess) is refused at the permission cap → 403, never undeleted.
    const r = await q(
      `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, before, after, changed_keys, batch_id, actor_id, source)
       VALUES ($1,'permission',$2,'delete',$3::jsonb,NULL,$4::text[],gen_random_uuid(),$5,'mutation') RETURNING id`,
      [s, `field:${mkFieldId()}`, JSON.stringify({ subjectType: 'user', subjectId: 'u1', visible: true, readOnly: false }), ['subjectType', 'subjectId', 'visible', 'readOnly'], MANAGER.id],
    )
    const permRev = (r.rows[0] as { id: string }).id
    const x = await execute(s, { revisionId: permRev, previewToken: 'any-token', confirm: 'undelete' })
    expect(x.status).toBe(403) // the undelete flag did not open the permission surface (permission has its own gate)
  })
})
