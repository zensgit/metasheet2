/**
 * T9-W permission-revert (de-escalation-only, design-lock #3342) — real DB. Reverting a `permission` revision
 * re-applies its `before` grant, but ONLY when restoring `before` REDUCES the subject's access on the entity's single
 * total-order access rank (field hidden<read-only<read-write; view none<read<write<admin; sheet none<read<write-own<
 * write<admin). Escalation / noop is refused fail-closed (422). Behind the default-off flag
 * MULTITABLE_ENABLE_PERMISSION_REVERT, on TOP of the canManageSheetAccess floor (the route cap block) + the typed
 * confirm `revert-permission`. Routes: POST /sheets/:id/config-restore-preview {revisionId} and
 * POST /sheets/:id/config-restore-execute {revisionId, previewToken, confirm}.
 *
 * The LOAD-BEARING never-escalate guard re-checks `permissionRevertDirection(before, LIVE)` INSIDE the execute txn —
 * against the CURRENT live grant, NOT the recorded `after`. The previewToken binds the live grant via an HMAC
 * `currentGrantHash`, so a grant changed between preview and execute → 409 GRANT_DRIFT (this drift verdict runs
 * BEFORE the direction re-check). Apply mirrors the forward grant write (target=null ⇒ revoke) and records a
 * source='restore' permission revision (live → target).
 *
 * Goldens (a)-(l): (a) flag-off 403 (preview+execute) · (b) canManageSheetAccess floor 403 · (c) happy SHEET
 * de-escalation (admin→read + restore revision) · (d) happy REVOKE (revert a `create`, before=null) · (e) escalation
 * refused 422 · (f) noop refused 422 · (g) LIVE re-check load-bearing 422 (uses live, not recorded after) · (h) grant
 * drift 409 · (i) FIELD de-escalation (read-write→read-only) · (j) VIEW de-escalation (admin→read) · (k) typed-confirm
 * 400/200 · (l) no-oracle preview shape. Runs only with DATABASE_URL.
 *
 * NOTE on case (g): the design's "lower the live grant after preview → 422" is UNREACHABLE in the runtime — lowering
 * live changes its derived grant ⇒ changes `hashPermissionGrant(live)` ⇒ the drift verdict (→409) fires BEFORE the
 * 422 direction re-check, and (rank-change ⟺ hash-change) for every scope. The 422 direction-guard is reachable ONLY
 * with a STABLE live grant whose direction-vs-`before` is non-de-escalation. (g) therefore isolates that guard with a
 * stable live=read while the recorded `after`=admin is deceptively HIGH: if the guard trusted `after` it would
 * de-escalate (allow); it consults LIVE and refuses (422). A "lower live → 409" is the SAME drift guard as (h), so it
 * is not duplicated as a separate case.
 *
 * NOTE on the flag: MULTITABLE_ENABLE_PERMISSION_REVERT is read PER-REQUEST inside the handlers, so — exactly like the
 * sibling config-undelete golden — ONE app + a per-test env toggle + an afterEach delete is correct and sufficient.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_pr_${TS}`
const FLAG = 'MULTITABLE_ENABLE_PERMISSION_REVERT'

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)

type Actor = { id: string; roles: string[]; perms: string[] }
// canManageSheetAccess === isAdminRole || perms∋'multitable:share' (deriveCapabilities). ADMIN holds share = the
// permission-revert FLOOR; FLOOR holds write but NOT share → NO canManageSheetAccess (the route cap block 403s it).
const ADMIN: Actor = { id: `u_pr_admin_${TS}`, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:share'] }
const FLOOR: Actor = { id: `u_pr_floor_${TS}`, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }

let app: Express
let actor: Actor = ADMIN

const CREATED_SHEETS: string[] = []
const CREATED_VIEW_IDS: string[] = [] // meta_view_permissions has no sheet_id → clean by tracked view_id
let seq = 0
const mkSubject = (tag: string) => `subj_pr_${tag}_${TS}_${seq++}`
const mkFieldId = () => `fld_pr_${TS}_${seq++}`
const mkViewId = () => { const v = `view_pr_${TS}_${seq++}`; CREATED_VIEW_IDS.push(v); return v }

async function freshSheet(tag: string): Promise<string> {
  const id = `sheet_pr_${tag}_${TS}`
  await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [id, BASE, id])
  CREATED_SHEETS.push(id)
  return id
}

// entity_id format = `${scope}:${JSON.stringify(parts)}` (permissionConfigEntityId ≡ parsePermissionEntityId).
// parts per scope: sheet=[subjectType,subjectId]; field=[fieldId,subjectType,subjectId]; view=[viewId,subjectType,subjectId].
const sheetEntityId = (subj: string) => `sheet:${JSON.stringify(['user', subj])}`
const fieldEntityId = (fld: string, subj: string) => `field:${JSON.stringify([fld, 'user', subj])}`
const viewEntityId = (view: string, subj: string) => `view:${JSON.stringify([view, 'user', subj])}`

// --- live grant seeders (mirror the forward grant routes' exact INSERTs) ---
const seedSheetGrant = (s: string, subj: string, level: 'read' | 'write' | 'admin') =>
  q(`INSERT INTO spreadsheet_permissions(sheet_id, user_id, subject_type, subject_id, perm_code) VALUES ($1,$2,'user',$2,$3)`, [s, subj, `spreadsheet:${level}`])
const seedFieldGrant = (s: string, fld: string, subj: string, visible: boolean, readOnly: boolean) =>
  q(`INSERT INTO field_permissions(sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,'user',$3,$4,$5)`, [s, fld, subj, visible, readOnly])
const seedViewGrant = (view: string, subj: string, permission: 'read' | 'write' | 'admin') =>
  q(`INSERT INTO meta_view_permissions(view_id, subject_type, subject_id, permission) VALUES ($1,'user',$2,$3)`, [view, subj, permission])

// before/after grant snapshots (the shape the forward recorder stores; the direction oracle reads accessLevel /
// visible+readOnly / permission off these).
const sheetSnap = (subj: string, accessLevel: string) => ({ subjectType: 'user', subjectId: subj, accessLevel })
const fieldSnap = (fld: string, subj: string, visible: boolean, readOnly: boolean) => ({ fieldId: fld, subjectType: 'user', subjectId: subj, visible, readOnly })
const viewSnap = (view: string, subj: string, permission: string) => ({ viewId: view, subjectType: 'user', subjectId: subj, permission })
const SHEET_KEYS = ['subjectType', 'subjectId', 'accessLevel']
const FIELD_KEYS = ['fieldId', 'subjectType', 'subjectId', 'visible', 'readOnly']
const VIEW_KEYS = ['viewId', 'subjectType', 'subjectId', 'permission']

/** Seed a forward (source='mutation') permission revision; before/after = grant snapshots (null = create/revoke). */
async function insertPermissionRev(
  s: string,
  entityId: string,
  opts: { action: 'create' | 'update' | 'delete'; before: Record<string, unknown> | null; after: Record<string, unknown> | null; changedKeys: string[] },
): Promise<string> {
  const r = await q(
    `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, before, after, changed_keys, batch_id, actor_id, source)
     VALUES ($1,'permission',$2,$3,$4::jsonb,$5::jsonb,$6::text[],gen_random_uuid(),$7,'mutation') RETURNING id`,
    [s, entityId, opts.action, opts.before ? JSON.stringify(opts.before) : null, opts.after ? JSON.stringify(opts.after) : null, opts.changedKeys, ADMIN.id],
  )
  return ((r.rows[0]) as { id: string }).id
}

const preview = (sheetId: string, revisionId: string, as: Actor = ADMIN) => { actor = as; return request(app).post(`/api/multitable/sheets/${sheetId}/config-restore-preview`).send({ revisionId }) }
const execute = (sheetId: string, body: Record<string, unknown>, as: Actor = ADMIN) => { actor = as; return request(app).post(`/api/multitable/sheets/${sheetId}/config-restore-execute`).send(body) }

// live-grant readers
const sheetCodes = async (s: string, subj: string): Promise<string[]> =>
  ((await q(`SELECT perm_code FROM spreadsheet_permissions WHERE sheet_id=$1 AND subject_type='user' AND subject_id=$2 ORDER BY perm_code`, [s, subj])).rows as Array<{ perm_code: string }>).map((r) => r.perm_code)
const fieldGrantRow = async (s: string, fld: string, subj: string): Promise<{ visible: boolean; read_only: boolean } | undefined> =>
  (await q(`SELECT visible, read_only FROM field_permissions WHERE sheet_id=$1 AND field_id=$2 AND subject_type='user' AND subject_id=$3`, [s, fld, subj])).rows[0] as { visible: boolean; read_only: boolean } | undefined
const viewPerm = async (view: string, subj: string): Promise<string | undefined> =>
  ((await q(`SELECT permission FROM meta_view_permissions WHERE view_id=$1 AND subject_type='user' AND subject_id=$2`, [view, subj])).rows[0] as { permission: string } | undefined)?.permission
const restoreRevCount = async (s: string, entityId: string, fromId: string): Promise<number> =>
  ((await q(`SELECT count(*)::int AS n FROM meta_config_revisions WHERE sheet_id=$1 AND entity_type='permission' AND entity_id=$2 AND source='restore' AND restored_from_id=$3`, [s, entityId, fromId])).rows[0] as { n: number }).n

describeIfDatabase('multitable permission-revert — T9-W de-escalation-only (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as unknown as { user?: Actor }).user = actor; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'PR Base'])
  })
  afterAll(async () => {
    for (const s of CREATED_SHEETS) {
      await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM field_permissions WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [s]).catch(() => {}) // also FK-cascades on meta_sheets delete
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_views WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [s]).catch(() => {})
    }
    // meta_view_permissions has NO sheet_id column → clean by the view ids we minted.
    if (CREATED_VIEW_IDS.length > 0) await q('DELETE FROM meta_view_permissions WHERE view_id = ANY($1::text[])', [CREATED_VIEW_IDS]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })
  afterEach(() => { delete process.env[FLAG] })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('(a) flag OFF → preview AND execute both 403 PERMISSION_REVERT_DISABLED', async () => {
    delete process.env[FLAG] // read per-request → unset = off
    const s = await freshSheet('a')
    const subj = mkSubject('a')
    // ADMIN so the canManageSheetAccess cap block (which PRECEDES the flag check) passes → we actually reach the flag.
    const rev = await insertPermissionRev(s, sheetEntityId(subj), { action: 'update', before: sheetSnap(subj, 'read'), after: sheetSnap(subj, 'admin'), changedKeys: SHEET_KEYS })
    const p = await preview(s, rev, ADMIN)
    expect(p.status).toBe(403)
    expect(p.body?.error?.code).toBe('PERMISSION_REVERT_DISABLED')
    // execute needs a non-empty previewToken to pass body-validation before the flag check fires.
    const x = await execute(s, { revisionId: rev, previewToken: 'any-token' }, ADMIN)
    expect(x.status).toBe(403)
    expect(x.body?.error?.code).toBe('PERMISSION_REVERT_DISABLED')
  })

  test('(b) floor: actor WITHOUT canManageSheetAccess → 403 (preview + execute), even with flag ON', async () => {
    process.env[FLAG] = 'true' // flag ON → proves the 403 is the CAPABILITY floor (which precedes the flag check), not the flag
    const s = await freshSheet('b')
    const subj = mkSubject('b')
    await seedSheetGrant(s, subj, 'admin')
    const rev = await insertPermissionRev(s, sheetEntityId(subj), { action: 'update', before: sheetSnap(subj, 'read'), after: sheetSnap(subj, 'admin'), changedKeys: SHEET_KEYS })
    expect((await preview(s, rev, FLOOR)).status).toBe(403) // generic sendForbidden (no specific code)
    expect((await execute(s, { revisionId: rev, previewToken: 'any-token', confirm: 'revert-permission' }, FLOOR)).status).toBe(403)
  })

  test('(c) happy SHEET de-escalation: live=admin, before=read → execute lowers grant to read + records a restore revision', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('c')
    const subj = mkSubject('c')
    await seedSheetGrant(s, subj, 'admin') // LIVE = admin (rank 4)
    const eid = sheetEntityId(subj)
    const rev = await insertPermissionRev(s, eid, { action: 'update', before: sheetSnap(subj, 'read'), after: sheetSnap(subj, 'admin'), changedKeys: SHEET_KEYS })

    const p = await preview(s, rev)
    expect(p.status).toBe(200)
    expect(p.body?.data?.permissionRevert).toMatchObject({ scope: 'sheet', direction: 'de-escalation', supported: true })
    const ok = await execute(s, { revisionId: rev, previewToken: p.body.data.previewToken, confirm: 'revert-permission' })
    expect(ok.status).toBe(200)
    expect(ok.body?.data?.permissionReverted).toMatchObject({ scope: 'sheet', entityId: eid })
    // grant LOWERED admin → read (the single managed code is now spreadsheet:read = deriveSheetAccessLevel 'read').
    expect(await sheetCodes(s, subj)).toEqual(['spreadsheet:read'])
    // a source='restore' permission revision back-references the reverted revision (assert it so a silent no-diff regresses).
    expect(await restoreRevCount(s, eid, rev)).toBe(1)
  })

  test('(d) happy REVOKE: revert a permission `create` (before=null), live=some grant → execute REVOKES the grant row', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('d')
    const subj = mkSubject('d')
    await seedSheetGrant(s, subj, 'read') // LIVE = read (rank 1)
    const eid = sheetEntityId(subj)
    // a forward `create` recorded before=null, after=the new grant. Reverting restores before=null = no access = revoke.
    const rev = await insertPermissionRev(s, eid, { action: 'create', before: null, after: sheetSnap(subj, 'read'), changedKeys: SHEET_KEYS })
    const p = await preview(s, rev)
    expect(p.status).toBe(200)
    expect(p.body?.data?.permissionRevert).toMatchObject({ scope: 'sheet', direction: 'de-escalation', supported: true }) // null(0) < read(1)
    const ok = await execute(s, { revisionId: rev, previewToken: p.body.data.previewToken, confirm: 'revert-permission' })
    expect(ok.status).toBe(200)
    expect(ok.body?.data?.permissionReverted).toMatchObject({ scope: 'sheet', entityId: eid })
    expect(await sheetCodes(s, subj)).toEqual([]) // grant row removed (revoked)
  })

  test('(e) escalation refused: before=admin, live=read (before rank > live) → execute 422, grant UNCHANGED', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('e')
    const subj = mkSubject('e')
    await seedSheetGrant(s, subj, 'read') // LIVE = read (rank 1)
    const rev = await insertPermissionRev(s, sheetEntityId(subj), { action: 'update', before: sheetSnap(subj, 'admin'), after: sheetSnap(subj, 'read'), changedKeys: SHEET_KEYS })
    const p = await preview(s, rev)
    expect(p.status).toBe(200)
    expect(p.body?.data?.permissionRevert).toMatchObject({ direction: 'escalation', supported: false })
    // REAL token (live unchanged → token valid → we reach the direction guard; a garbage token would 401 first).
    const x = await execute(s, { revisionId: rev, previewToken: p.body.data.previewToken, confirm: 'revert-permission' })
    expect(x.status).toBe(422)
    expect(x.body?.error?.code).toBe('RESTORE_NOT_SUPPORTED')
    expect(await sheetCodes(s, subj)).toEqual(['spreadsheet:read']) // never escalated
  })

  test('(f) noop refused: before == live (same rank) → execute 422, grant UNCHANGED', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('f')
    const subj = mkSubject('f')
    await seedSheetGrant(s, subj, 'read') // LIVE = read (rank 1)
    const rev = await insertPermissionRev(s, sheetEntityId(subj), { action: 'update', before: sheetSnap(subj, 'read'), after: sheetSnap(subj, 'admin'), changedKeys: SHEET_KEYS })
    const p = await preview(s, rev)
    expect(p.status).toBe(200)
    expect(p.body?.data?.permissionRevert).toMatchObject({ direction: 'noop', supported: false }) // read(1) == read(1)
    const x = await execute(s, { revisionId: rev, previewToken: p.body.data.previewToken, confirm: 'revert-permission' })
    expect(x.status).toBe(422)
    expect(x.body?.error?.code).toBe('RESTORE_NOT_SUPPORTED')
    expect(await sheetCodes(s, subj)).toEqual(['spreadsheet:read'])
  })

  test('(g) LIVE re-check (load-bearing): before=write, after=admin (deceptively high), live=read → execute 422 via LIVE, grant UNCHANGED', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('g')
    const subj = mkSubject('g')
    await seedSheetGrant(s, subj, 'read') // LIVE = read (rank 1), STABLE across preview→execute (token stays valid)
    // before=write(3); after=admin(4). If the guard trusted the recorded `after`: direction(write, admin)=de-escalation
    // ⇒ it would APPLY. It re-checks LIVE=read: direction(write, read)=escalation ⇒ refuse. THIS is the never-escalate proof.
    const rev = await insertPermissionRev(s, sheetEntityId(subj), { action: 'update', before: sheetSnap(subj, 'write'), after: sheetSnap(subj, 'admin'), changedKeys: SHEET_KEYS })
    const p = await preview(s, rev)
    expect(p.status).toBe(200)
    expect(p.body?.data?.permissionRevert).toMatchObject({ direction: 'escalation', supported: false }) // vs LIVE=read, not `after`
    // live UNCHANGED → currentGrantHash matches → we pass the drift verdict and reach the direction re-check (→422),
    // not 409. (Lowering live to force this would instead trip the drift guard = the SAME path as case (h).)
    const x = await execute(s, { revisionId: rev, previewToken: p.body.data.previewToken, confirm: 'revert-permission' })
    expect(x.status).toBe(422)
    expect(x.body?.error?.code).toBe('RESTORE_NOT_SUPPORTED')
    expect(await sheetCodes(s, subj)).toEqual(['spreadsheet:read']) // NOT raised toward the recorded after=admin
  })

  test('(h) grant drift: live changed after preview (admin→write, still ≥ before by value) → execute 409 GRANT_DRIFT, no apply', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('h')
    const subj = mkSubject('h')
    await seedSheetGrant(s, subj, 'admin') // LIVE = admin at preview
    const rev = await insertPermissionRev(s, sheetEntityId(subj), { action: 'update', before: sheetSnap(subj, 'read'), after: sheetSnap(subj, 'admin'), changedKeys: SHEET_KEYS })
    const p = await preview(s, rev)
    expect(p.status).toBe(200)
    expect(p.body?.data?.permissionRevert).toMatchObject({ direction: 'de-escalation', supported: true })
    // CHANGE the live grant after preview to a DIFFERENT but still-not-lower-than-before level (admin→write): the
    // de-escalation is still valid BY VALUE (read < write), but the previewToken's grant hash no longer matches.
    await q(`UPDATE spreadsheet_permissions SET perm_code='spreadsheet:write' WHERE sheet_id=$1 AND subject_type='user' AND subject_id=$2`, [s, subj])
    const x = await execute(s, { revisionId: rev, previewToken: p.body.data.previewToken, confirm: 'revert-permission' })
    expect(x.status).toBe(409)
    expect(x.body?.error?.code).toBe('GRANT_DRIFT')
    expect(await sheetCodes(s, subj)).toEqual(['spreadsheet:write']) // not lowered to read — the revert did NOT apply
  })

  test('(i) FIELD de-escalation: live=read-write (visible,!readOnly), before=read-only → execute sets read_only=true', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('i')
    const subj = mkSubject('i')
    const fld = mkFieldId()
    await seedFieldGrant(s, fld, subj, true, false) // LIVE = visible + read-write (rank 2)
    const eid = fieldEntityId(fld, subj)
    const rev = await insertPermissionRev(s, eid, { action: 'update', before: fieldSnap(fld, subj, true, true), after: fieldSnap(fld, subj, true, false), changedKeys: FIELD_KEYS })
    const p = await preview(s, rev)
    expect(p.status).toBe(200)
    expect(p.body?.data?.permissionRevert).toMatchObject({ scope: 'field', direction: 'de-escalation', supported: true }) // read-only(1) < read-write(2)
    const ok = await execute(s, { revisionId: rev, previewToken: p.body.data.previewToken, confirm: 'revert-permission' })
    expect(ok.status).toBe(200)
    expect(ok.body?.data?.permissionReverted).toMatchObject({ scope: 'field', entityId: eid })
    expect(await fieldGrantRow(s, fld, subj)).toMatchObject({ visible: true, read_only: true }) // narrowed to read-only
  })

  test('(j) VIEW de-escalation: live=admin, before=read → execute lowers meta_view_permissions to read', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('j')
    const subj = mkSubject('j')
    const view = mkViewId()
    await seedViewGrant(view, subj, 'admin') // LIVE = admin (rank 3)
    const eid = viewEntityId(view, subj)
    const rev = await insertPermissionRev(s, eid, { action: 'update', before: viewSnap(view, subj, 'read'), after: viewSnap(view, subj, 'admin'), changedKeys: VIEW_KEYS })
    const p = await preview(s, rev)
    expect(p.status).toBe(200)
    expect(p.body?.data?.permissionRevert).toMatchObject({ scope: 'view', direction: 'de-escalation', supported: true }) // read(1) < admin(3)
    const ok = await execute(s, { revisionId: rev, previewToken: p.body.data.previewToken, confirm: 'revert-permission' })
    expect(ok.status).toBe(200)
    expect(ok.body?.data?.permissionReverted).toMatchObject({ scope: 'view', entityId: eid })
    expect(await viewPerm(view, subj)).toBe('read')
  })

  test('(k) typed-confirm: missing/wrong → 400 CONFIRM_REQUIRED; "revert-permission" → 200 applied', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('k')
    const subj = mkSubject('k')
    await seedSheetGrant(s, subj, 'admin')
    const rev = await insertPermissionRev(s, sheetEntityId(subj), { action: 'update', before: sheetSnap(subj, 'read'), after: sheetSnap(subj, 'admin'), changedKeys: SHEET_KEYS })
    const p = await preview(s, rev); expect(p.status).toBe(200)
    const token: string = p.body.data.previewToken
    // confirm check precedes (and is outside) the txn, so a valid token without the typed confirm still 400s here.
    const miss = await execute(s, { revisionId: rev, previewToken: token })
    expect(miss.status).toBe(400)
    expect(miss.body?.error?.code).toBe('CONFIRM_REQUIRED')
    const wrong = await execute(s, { revisionId: rev, previewToken: token, confirm: 'revert' })
    expect(wrong.status).toBe(400)
    expect(wrong.body?.error?.code).toBe('CONFIRM_REQUIRED')
    // the two rejected attempts wrote nothing → the same token still verifies → typed confirm applies.
    const ok = await execute(s, { revisionId: rev, previewToken: token, confirm: 'revert-permission' })
    expect(ok.status).toBe(200)
    expect(await sheetCodes(s, subj)).toEqual(['spreadsheet:read'])
  })

  test('(l) no-oracle: preview carries only { scope, direction, supported, note } (+ token) — no other subject grant, no count', async () => {
    process.env[FLAG] = 'true'
    const s = await freshSheet('l')
    const subj = mkSubject('l')
    const other = `subjB_pr_leakcanary_${TS}` // a DIFFERENT subject whose grant must NEVER surface in the preview
    await seedSheetGrant(s, subj, 'admin')
    await seedSheetGrant(s, other, 'write') // co-resident grant on the same sheet
    const rev = await insertPermissionRev(s, sheetEntityId(subj), { action: 'update', before: sheetSnap(subj, 'read'), after: sheetSnap(subj, 'admin'), changedKeys: SHEET_KEYS })
    const p = await preview(s, rev)
    expect(p.status).toBe(200)
    const pr = p.body.data.permissionRevert as Record<string, unknown>
    expect(Object.keys(pr).sort()).toEqual(['direction', 'note', 'scope', 'supported']) // exactly these 4 — nothing else
    expect(pr).toMatchObject({ scope: 'sheet', direction: 'de-escalation', supported: true })
    expect(Object.values(pr).some((v) => typeof v === 'number')).toBe(false) // no numeric count of subjects/grants anywhere
    expect(String(pr.note)).not.toMatch(/\d/) // the consequence text names no count
    // the OTHER subject's id (and thus its grant) never appears in the response (token is HMAC/base64 over subj only).
    expect(JSON.stringify(p.body)).not.toContain(other)
  })
})
