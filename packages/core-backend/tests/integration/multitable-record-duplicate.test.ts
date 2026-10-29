/**
 * Real-DB integration test for the duplicate / clone record route (design 2026-06-16).
 *
 * `POST /records/:recordId/duplicate` reads the source row SERVER-SIDE and creates a NEW row from the
 * subset of fields the actor can BOTH read AND write, then echoes the clone through the SAME layer-2 ∧
 * layer-3 read mask as POST /records. The security spine:
 *   - read-denied  (field_permissions.visible=false)            → value NOT copied into the clone
 *   - write-denied (field_permissions.read_only=true, visible)  → value NOT copied into the clone
 *   - isFieldAlwaysReadOnly (formula/autoNumber)                → stripped + re-derived by the server
 *   - link ids / attachment ids                                → copied verbatim (validated on create)
 *   - capability gate                                           → 403 when canCreateRecord is false
 *
 * createRecord enforces NEITHER field_permissions case (only isFieldAlwaysReadOnly + canCreateRecord — see
 * the F4 create-echo note in univer-meta.ts), so THIS route is the only thing stripping read/write-denied
 * fields. The assertions therefore read the NEW row's UNMASKED stored `meta_records.data` (via `dbField`) —
 * NOT the masked echo, which would hide a leak even if the value had been written.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { usePinnedServer } from '../utils/pinned-server'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_dup_${TS}`
const SHEET_ID = `sheet_dup_${TS}`
const FSHEET_ID = `sheet_dup_foreign_${TS}`

const FLD_VISIBLE = `fld_dup_vis_${TS}` // string, readable+writable — positive control (copied)
const FLD_SECRET = `fld_dup_secret_${TS}` // string, read-denied (visible=false) — NOT copied
const FLD_RO = `fld_dup_ro_${TS}` // string, write-denied (read_only=true, visible) — NOT copied
const FLD_SELECT = `fld_dup_sel_${TS}` // select — copied
const FLD_MULTI = `fld_dup_multi_${TS}` // multiSelect — copied
const FLD_FORMULA = `fld_dup_formula_${TS}` // formula (isFieldAlwaysReadOnly) — stripped + recomputed
const FLD_AUTONUM = `fld_dup_auto_${TS}` // autoNumber (isFieldAlwaysReadOnly) — fresh server value
const FLD_LINK = `fld_dup_link_${TS}` // link → FSHEET — ids copied verbatim
const FLD_ATT = `fld_dup_att_${TS}` // attachment — ids copied verbatim

const FOREIGN_REC = `rec_dup_foreign_${TS}`
const SOURCE_REC = `rec_dup_source_${TS}`
const ATT_ID = `att_dup_${TS}`

const USER_OK = `u_dup_ok_${TS}` // write user, FLD_SECRET + FLD_RO denied — the duplicating actor
const USER_RO = `u_dup_readonly_${TS}` // read-only user — canCreateRecord=false (403 path)

let app: Express
let currentUser: { id: string; roles: string[]; perms: string[] } = { id: USER_OK, roles: ['member'], perms: ['multitable:write'] }

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const dupReq = (recordId: string, body: Record<string, unknown> = { sheetId: SHEET_ID }) =>
  request(app).post(`/api/multitable/records/${recordId}/duplicate`).send(body)
const dbData = async (recordId: string): Promise<Record<string, unknown>> => {
  const r = await q('SELECT data FROM meta_records WHERE id = $1', [recordId])
  return (r.rows[0]?.data ?? {}) as Record<string, unknown>
}

describeIfDatabase('duplicate / clone record route (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = currentUser; next() })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'Dup Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'Dup Sheet'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [FSHEET_ID, BASE_ID, 'Dup Foreign'])

    const mkField = (id: string, name: string, type: string, property: Record<string, unknown>, order: number) =>
      q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        [id, SHEET_ID, name, type, JSON.stringify(property), order])

    await mkField(FLD_VISIBLE, 'Visible', 'string', {}, 1)
    await mkField(FLD_SECRET, 'Secret', 'string', {}, 2)
    await mkField(FLD_RO, 'ReadOnlyForActor', 'string', {}, 3)
    await mkField(FLD_SELECT, 'Sel', 'select', { options: [{ value: 'A' }, { value: 'B' }] }, 4)
    await mkField(FLD_MULTI, 'Multi', 'multiSelect', { options: [{ value: 'x' }, { value: 'y' }, { value: 'z' }] }, 5)
    await mkField(FLD_FORMULA, 'Formula', 'formula', { expression: '=1+1' }, 6)
    await mkField(FLD_AUTONUM, 'Auto', 'autoNumber', {}, 7)
    await mkField(FLD_LINK, 'Link', 'link', { foreignSheetId: FSHEET_ID }, 8)
    await mkField(FLD_ATT, 'Att', 'attachment', {}, 9)

    // Foreign sheet needs at least one field for the foreign record to be valid; the link only validates
    // foreign-record existence.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [`fld_dup_fkey_${TS}`, FSHEET_ID, 'FKey', 'string', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, version, data) VALUES ($1,$2,$3,$4::jsonb)',
      [FOREIGN_REC, FSHEET_ID, 1, JSON.stringify({})])

    // layer-3 field permissions for USER_OK: FLD_SECRET read-denied, FLD_RO write-denied (still readable).
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
      [SHEET_ID, FLD_SECRET, 'user', USER_OK, false, false])
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
      [SHEET_ID, FLD_RO, 'user', USER_OK, true, true])

    // Source record. Includes raw denied values (FLD_SECRET / FLD_RO) the duplicate MUST NOT carry over.
    // Inserted BEFORE the attachment row (which FK-references it).
    await q('INSERT INTO meta_records (id, sheet_id, version, data) VALUES ($1,$2,$3,$4::jsonb)', [
      SOURCE_REC, SHEET_ID, 1,
      JSON.stringify({
        [FLD_VISIBLE]: 'hello-clone',
        [FLD_SECRET]: 'TOP-SECRET-do-not-clone',
        [FLD_RO]: 'readonly-do-not-clone',
        [FLD_SELECT]: 'B',
        [FLD_MULTI]: ['x', 'z'],
        [FLD_FORMULA]: 'stale-formula',
        [FLD_AUTONUM]: 9999,
        [FLD_LINK]: [FOREIGN_REC],
        [FLD_ATT]: [ATT_ID],
      }),
    ])
    // Link state is authoritative in meta_links — seed the forward edge so the overlay reads it.
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [FLD_LINK, SOURCE_REC, FOREIGN_REC])

    // Attachment blob owned by SOURCE_REC + FLD_ATT (the same-field check passes for the clone since the
    // clone shares FLD_ATT; the copy is a shared reference, not a deep file copy).
    await q(
      `INSERT INTO multitable_attachments
         (id, sheet_id, record_id, field_id, storage_file_id, filename, original_name, mime_type, size, storage_path, storage_provider, metadata, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
      [ATT_ID, SHEET_ID, SOURCE_REC, FLD_ATT, `sf_${ATT_ID}`, 'f.txt', 'f.txt', 'text/plain', 3, `/tmp/${ATT_ID}`, 'local', '{}', USER_OK],
    )
  })

  afterAll(async () => {
    await q('DELETE FROM meta_field_auto_number_sequences WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_links WHERE record_id IN (SELECT id FROM meta_records WHERE sheet_id = $1)', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM multitable_attachments WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[SHEET_ID, FSHEET_ID]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SHEET_ID, FSHEET_ID]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SHEET_ID, FSHEET_ID]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('happy path: writable scalar/select/multiSelect + link + attachment values are copied into a NEW row', async () => {
    currentUser = { id: USER_OK, roles: ['member'], perms: ['multitable:write'] }
    const res = await dupReq(SOURCE_REC)
    expect(res.status).toBe(200)
    const newId = res.body.data.record.id
    expect(typeof newId).toBe('string')
    expect(newId).not.toBe(SOURCE_REC) // a NEW row, not the source

    const stored = await dbData(newId)
    expect(stored[FLD_VISIBLE]).toBe('hello-clone')
    expect(stored[FLD_SELECT]).toBe('B')
    expect(stored[FLD_MULTI]).toEqual(['x', 'z'])
    expect(stored[FLD_LINK]).toEqual([FOREIGN_REC]) // link ids copied verbatim
    expect(stored[FLD_ATT]).toEqual([ATT_ID]) // attachment ids copied (shared reference)

    // The link edge is materialized for the clone (createRecord syncs meta_links).
    const edge = await q('SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2', [FLD_LINK, newId])
    expect((edge.rows[0] as { foreign_record_id: string } | undefined)?.foreign_record_id).toBe(FOREIGN_REC)
  })

  test('SECURITY (read-denied): a field the actor CANNOT READ (visible=false) is NOT copied into the clone', async () => {
    currentUser = { id: USER_OK, roles: ['member'], perms: ['multitable:write'] }
    const res = await dupReq(SOURCE_REC)
    expect(res.status).toBe(200)
    const newId = res.body.data.record.id
    const stored = await dbData(newId) // UNMASKED — proves the value never reached storage
    expect(stored[FLD_SECRET]).toBeUndefined()
    // ...and obviously not in the (masked) echo either.
    expect(JSON.stringify(res.body)).not.toContain('TOP-SECRET-do-not-clone')
  })

  test('SECURITY (write-denied): a field the actor can READ but CANNOT WRITE (read_only=true) is NOT copied', async () => {
    // This is the case createRecord does NOT catch (it never consults field_permissions.read_only). The
    // route is the only guard; this asserts against the NEW row's stored data, so it fails loudly if the
    // write-mask regresses.
    currentUser = { id: USER_OK, roles: ['member'], perms: ['multitable:write'] }
    const res = await dupReq(SOURCE_REC)
    expect(res.status).toBe(200)
    const newId = res.body.data.record.id
    const stored = await dbData(newId)
    expect(stored[FLD_RO]).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain('readonly-do-not-clone')
  })

  test('derived fields: formula stripped+recomputed (not the stale source) and auto-number gets a FRESH value', async () => {
    currentUser = { id: USER_OK, roles: ['member'], perms: ['multitable:write'] }
    const res = await dupReq(SOURCE_REC)
    expect(res.status).toBe(200)
    const newId = res.body.data.record.id
    const stored = await dbData(newId)
    expect(stored[FLD_FORMULA]).not.toBe('stale-formula') // the stale source string was NOT carried over
    expect(stored[FLD_AUTONUM]).toBeDefined()
    expect(stored[FLD_AUTONUM]).not.toBe(9999) // server-reallocated, not the source's
  })

  test('SECURITY (capability gate): a read-only actor (canCreateRecord=false) gets 403', async () => {
    currentUser = { id: USER_RO, roles: ['member'], perms: ['multitable:read'] }
    const res = await dupReq(SOURCE_REC)
    expect(res.status).toBe(403)
    currentUser = { id: USER_OK, roles: ['member'], perms: ['multitable:write'] }
  })

  test('404: duplicating a missing source record', async () => {
    currentUser = { id: USER_OK, roles: ['member'], perms: ['multitable:write'] }
    const res = await dupReq(`rec_dup_missing_${TS}`)
    expect(res.status).toBe(404)
  })

  test('401: unauthenticated request', async () => {
    currentUser = { id: '', roles: [], perms: [] }
    const res = await dupReq(SOURCE_REC)
    expect(res.status).toBe(401)
    currentUser = { id: USER_OK, roles: ['member'], perms: ['multitable:write'] }
  })
})

// ── Customer feedback 2026-10-27: refusal on sheets whose rows the stock-preparation plugin maintains ─────────
//
// multitable/record-duplicate-guard.ts: a sheet with a `stockPreparation*` field namespace AND a
// `plugin_multitable_object_registry` row refuses the generic duplicate with a values-free 409 before any write,
// and /context tells a creating actor (`capabilities.recordDuplicateBlocked`). A tagged sheet WITHOUT a registry
// row (a user's「复制数据表」copy) and an ordinary sheet keep the duplicate exactly as before. Real DB: the
// property is stored as jsonb and read back through the route's own serializer, the registry row is a real FK
// row. Own pinned listener (new supertest cases go through usePinnedServer only).
const describeRefusalIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

describeRefusalIfDatabase('duplicate refusal on plugin-maintained sheets (real DB, customer feedback 2026-10-27)', () => {
  const RC = `rc_${TS}`
  const RC_BASE = `base_${RC}`
  const SHEET_PM = `sheet_${RC}_pm` // registered ∧ tagged (project / env sheet)
  const SHEET_LEDGER = `sheet_${RC}_ledger` // registered, only the confirmation-ledger namespace (prefix pin)
  const SHEET_TAGCOPY = `sheet_${RC}_tagcopy` // tagged, NOT registered (a user's 复制数据表 copy)
  const SHEET_PLAIN = `sheet_${RC}_plain` // ordinary
  const ALL_SHEETS = [SHEET_PM, SHEET_LEDGER, SHEET_TAGCOPY, SHEET_PLAIN]
  const keyField = (sheetId: string) => `fld_${sheetId}_key`
  const noteField = (sheetId: string) => `fld_${sheetId}_note`
  const sourceRec = (sheetId: string) => `rec_${sheetId}_src`
  const WRITER = { id: `u_${RC}_writer`, roles: ['member'], perms: ['multitable:write'] }
  const READER = { id: `u_${RC}_reader`, roles: ['member'], perms: ['multitable:read'] }
  const OUTSIDER = { id: `u_${RC}_outsider`, roles: ['member'], perms: ['files:read'] }
  let actor: { id: string; roles: string[]; perms: string[] } = WRITER

  const pinned = usePinnedServer()
  const countRows = async (sheetId: string) =>
    Number((await q('SELECT count(*)::int AS c FROM meta_records WHERE sheet_id = $1', [sheetId])).rows[0]?.c ?? -1)
  const dup = (sheetId: string) =>
    request(pinned.url()).post(`/api/multitable/records/${sourceRec(sheetId)}/duplicate`).send({ sheetId })
  const context = (sheetId: string) => request(pinned.url()).get('/api/multitable/context').query({ sheetId })

  beforeAll(async () => {
    const refusalApp = express()
    refusalApp.use(express.json())
    refusalApp.use((req, _res, next) => { ;(req as any).user = actor; next() })
    refusalApp.use('/api/multitable', univerMetaRouter())
    pinned.setApp(refusalApp)

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [RC_BASE, 'RC Base'])
    const keyProperty: Record<string, Record<string, unknown>> = {
      [SHEET_PM]: { validation: [{ type: 'required' }], stockPreparation: { ownership: 'plm_system', preserveOnRefresh: false, required: true, key: true } },
      [SHEET_LEDGER]: { stockPreparationConfirmationDecision: { role: 'decision' } },
      [SHEET_TAGCOPY]: { validation: [{ type: 'required' }], stockPreparation: { ownership: 'plm_system', preserveOnRefresh: false, required: true, key: true } },
      [SHEET_PLAIN]: {},
    }
    for (const sheetId of ALL_SHEETS) {
      await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [sheetId, RC_BASE, `RC ${sheetId.slice(-6)}`])
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        [keyField(sheetId), sheetId, 'Key', 'string', JSON.stringify(keyProperty[sheetId]), 1])
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        [noteField(sheetId), sheetId, 'Note', 'string', '{}', 2])
      await q('INSERT INTO meta_records (id, sheet_id, version, data) VALUES ($1,$2,$3,$4::jsonb)',
        [sourceRec(sheetId), sheetId, 1, JSON.stringify({ [keyField(sheetId)]: 'KEY-1', [noteField(sheetId)]: 'note-1' })])
    }
    for (const sheetId of [SHEET_PM, SHEET_LEDGER]) {
      await q('INSERT INTO plugin_multitable_object_registry (sheet_id, project_id, object_id, plugin_name) VALUES ($1,$2,$3,$4)',
        [sheetId, `project_${RC}`, `object_${sheetId}`, 'plugin-integration-core'])
    }
  })

  afterAll(async () => {
    await q('DELETE FROM plugin_multitable_object_registry WHERE sheet_id = ANY($1::text[])', [ALL_SHEETS]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [ALL_SHEETS]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [ALL_SHEETS]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [ALL_SHEETS]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [RC_BASE]).catch(() => {})
  })

  test('registered ∧ stockPreparation-tagged: 409 RECORD_DUPLICATE_REFUSED_PLUGIN_MAINTAINED_SHEET, values-free, no row written', async () => {
    actor = WRITER
    const before = await countRows(SHEET_PM)
    const res = await dup(SHEET_PM)
    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'RECORD_DUPLICATE_REFUSED_PLUGIN_MAINTAINED_SHEET', message: '这张表的行由备料插件（PLM 拉取）维护，不能复制为新行。' },
    })
    for (const value of [SHEET_PM, sourceRec(SHEET_PM), keyField(SHEET_PM), 'KEY-1', 'plugin-integration-core']) {
      expect(res.text).not.toContain(value)
    }
    expect(await countRows(SHEET_PM)).toBe(before)
  })

  test('prefix rule: a registered sheet whose only namespace is stockPreparationConfirmationDecision is refused too', async () => {
    actor = WRITER
    const before = await countRows(SHEET_LEDGER)
    const res = await dup(SHEET_LEDGER)
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe('RECORD_DUPLICATE_REFUSED_PLUGIN_MAINTAINED_SHEET')
    expect(await countRows(SHEET_LEDGER)).toBe(before)
  })

  test('a non-reader is refused by the read gate first and learns nothing about the sheet', async () => {
    actor = OUTSIDER
    const res = await dup(SHEET_PM)
    expect([403, 404]).toContain(res.status)
    expect(res.body?.error?.code).not.toBe('RECORD_DUPLICATE_REFUSED_PLUGIN_MAINTAINED_SHEET')
    actor = WRITER
  })

  test('tagged but NOT registered (a user’s 复制数据表 copy): duplicates exactly as before', async () => {
    actor = WRITER
    const before = await countRows(SHEET_TAGCOPY)
    const res = await dup(SHEET_TAGCOPY)
    expect(res.status).toBe(200)
    const stored = await dbData(res.body.data.record.id)
    expect(stored[keyField(SHEET_TAGCOPY)]).toBe('KEY-1')
    expect(stored[noteField(SHEET_TAGCOPY)]).toBe('note-1')
    expect(await countRows(SHEET_TAGCOPY)).toBe(before + 1)
  })

  test('ordinary sheet: duplicates exactly as before', async () => {
    actor = WRITER
    const before = await countRows(SHEET_PLAIN)
    const res = await dup(SHEET_PLAIN)
    expect(res.status).toBe(200)
    const stored = await dbData(res.body.data.record.id)
    expect(stored[keyField(SHEET_PLAIN)]).toBe('KEY-1')
    expect(await countRows(SHEET_PLAIN)).toBe(before + 1)
  })

  test('/context: recordDuplicateBlocked only on the registered ∧ tagged sheets, and only for an actor who can create', async () => {
    actor = WRITER
    for (const sheetId of [SHEET_PM, SHEET_LEDGER]) {
      const res = await context(sheetId)
      expect(res.status, sheetId).toBe(200)
      expect(res.body.data.capabilities.canCreateRecord, sheetId).toBe(true)
      expect(res.body.data.capabilities.recordDuplicateBlocked, sheetId).toBe(true)
    }
    for (const sheetId of [SHEET_TAGCOPY, SHEET_PLAIN]) {
      const res = await context(sheetId)
      expect(res.status, sheetId).toBe(200)
      expect('recordDuplicateBlocked' in res.body.data.capabilities, sheetId).toBe(false)
    }
    actor = READER
    const readerRes = await context(SHEET_PM)
    expect(readerRes.status).toBe(200)
    expect(readerRes.body.data.capabilities.canCreateRecord).not.toBe(true)
    expect('recordDuplicateBlocked' in readerRes.body.data.capabilities).toBe(false)
    actor = WRITER
  })
})

// ── R-66 ① (owner ruling 2026-10-28「管理员也不能删 PLM 行」): PLM rows cannot be deleted by anyone ─────────────
//
// multitable/plm-row-delete-guard.ts: on a sheet with the EXACT `property.stockPreparation` stanza AND a
// `plugin_multitable_object_registry` row, a row whose `stockPreparation.key === true` column is non-empty is refused
// by DELETE /records/:recordId for a writer AND a platform admin (409 RECORD_DELETE_REFUSED_PLM_ROW, values-free, row
// intact); a keyless row, a tagged-but-unregistered copy, an ordinary sheet and another plugin namespace delete as
// before; no resolvable key column fails closed. Restore from the trash is refused while a live row holds the key.
// Real DB: jsonb property / data, real registry and trash rows, the route's own serializer. Own pinned listener.
const describePlmDeleteIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

describePlmDeleteIfDatabase('R-66: PLM rows on stock-preparation template sheets cannot be deleted (real DB)', () => {
  const PD = `pd_${TS}`
  const PD_BASE = `base_${PD}`
  const SHEET_PM = `sheet_${PD}_pm` // registered ∧ exact stanza with the key column
  const SHEET_NOKEY = `sheet_${PD}_nokey` // registered ∧ exact stanza, no key:true column (fail closed)
  const SHEET_LEDGER = `sheet_${PD}_ledger` // registered, only the confirmation-ledger namespace (out of the guard)
  const SHEET_TAGCOPY = `sheet_${PD}_tagcopy` // exact stanza, NOT registered (a user's 复制数据表 copy)
  const SHEET_PLAIN = `sheet_${PD}_plain` // ordinary
  const ALL_SHEETS = [SHEET_PM, SHEET_NOKEY, SHEET_LEDGER, SHEET_TAGCOPY, SHEET_PLAIN]
  const keyField = (sheetId: string) => `fld_${sheetId}_key`
  const noteField = (sheetId: string) => `fld_${sheetId}_note`
  const rec = (sheetId: string, name: string) => `rec_${sheetId}_${name}`
  const WRITER = { id: `u_${PD}_writer`, roles: ['member'], perms: ['multitable:write'] }
  const ADMIN = { id: `u_${PD}_admin`, roles: ['admin'], perms: [] as string[] }
  let actor: { id: string; roles: string[]; perms: string[] } = WRITER

  const pinned = usePinnedServer()
  const del = (recordId: string) => request(pinned.url()).delete(`/api/multitable/records/${recordId}`)
  const restore = (recordId: string) => request(pinned.url()).post(`/api/multitable/records/${recordId}/restore`).send({})
  const exists = async (recordId: string) => (await q('SELECT 1 FROM meta_records WHERE id = $1', [recordId])).rows.length > 0
  const trashCount = async (recordId: string) =>
    Number((await q('SELECT count(*)::int AS c FROM meta_records_trash WHERE record_id = $1', [recordId])).rows[0]?.c ?? -1)

  const STANZA_KEY = { ownership: 'plm_system', preserveOnRefresh: false, required: true, key: true }
  const STANZA_NOKEY = { ownership: 'human_preserved', preserveOnRefresh: true, required: false, key: false }

  beforeAll(async () => {
    const plmApp = express()
    plmApp.use(express.json())
    plmApp.use((req, _res, next) => { ;(req as any).user = actor; next() })
    plmApp.use('/api/multitable', univerMetaRouter())
    pinned.setApp(plmApp)

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [PD_BASE, 'PD Base'])
    const keyProperty: Record<string, Record<string, unknown>> = {
      [SHEET_PM]: { validation: [{ type: 'required' }], stockPreparation: STANZA_KEY },
      [SHEET_NOKEY]: { stockPreparation: STANZA_NOKEY },
      [SHEET_LEDGER]: { stockPreparationConfirmationDecision: { role: 'decision' } },
      [SHEET_TAGCOPY]: { validation: [{ type: 'required' }], stockPreparation: STANZA_KEY },
      [SHEET_PLAIN]: {},
    }
    for (const sheetId of ALL_SHEETS) {
      await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [sheetId, PD_BASE, `PD ${sheetId.slice(-6)}`])
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        [keyField(sheetId), sheetId, 'Key', 'string', JSON.stringify(keyProperty[sheetId]), 1])
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        // A human-preserved template column (exact stanza, key:false) on the stanza sheets; none on the others.
        [noteField(sheetId), sheetId, 'Note', 'string', JSON.stringify(sheetId === SHEET_PLAIN || sheetId === SHEET_LEDGER ? {} : { stockPreparation: STANZA_NOKEY }), 2])
      await q('INSERT INTO meta_records (id, sheet_id, version, data) VALUES ($1,$2,$3,$4::jsonb)',
        [rec(sheetId, 'keyed'), sheetId, 1, JSON.stringify({ [keyField(sheetId)]: 'KEY-1', [noteField(sheetId)]: 'human note' })])
    }
    // PM: a keyless hand row and a second keyed row whose key a trash row also carries.
    await q('INSERT INTO meta_records (id, sheet_id, version, data) VALUES ($1,$2,$3,$4::jsonb)',
      [rec(SHEET_PM, 'keyless'), SHEET_PM, 1, JSON.stringify({ [keyField(SHEET_PM)]: '', [noteField(SHEET_PM)]: 'hand row' })])
    await q('INSERT INTO meta_records (id, sheet_id, version, data) VALUES ($1,$2,$3,$4::jsonb)',
      [rec(SHEET_PM, 'live'), SHEET_PM, 1, JSON.stringify({ [keyField(SHEET_PM)]: 'KEY-LIVE' })])
    for (const sheetId of [SHEET_PM, SHEET_NOKEY, SHEET_LEDGER]) {
      await q('INSERT INTO plugin_multitable_object_registry (sheet_id, project_id, object_id, plugin_name) VALUES ($1,$2,$3,$4)',
        [sheetId, `project_${PD}`, `object_${sheetId}`, 'plugin-integration-core'])
    }
    // Trash rows (as an earlier delete would have left them): one whose key a live row holds now (the next pull
    // re-added it), one whose key nobody holds, one on the key-less sheet.
    const trash = (recordId: string, sheetId: string, key: string) => q(
      'INSERT INTO meta_records_trash (record_id, sheet_id, base_id, data, original_version, created_by, deleted_by) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)',
      [recordId, sheetId, PD_BASE, JSON.stringify({ [keyField(sheetId)]: key, [noteField(sheetId)]: 'kept human note' }), 1, null, WRITER.id],
    )
    await trash(rec(SHEET_PM, 'trash_live'), SHEET_PM, 'KEY-LIVE')
    await trash(rec(SHEET_PM, 'trash_gone'), SHEET_PM, 'KEY-GONE')
    await trash(rec(SHEET_NOKEY, 'trash'), SHEET_NOKEY, 'KEY-9')
  })

  afterAll(async () => {
    await q('DELETE FROM meta_records_trash WHERE sheet_id = ANY($1::text[])', [ALL_SHEETS]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = ANY($1::text[])', [ALL_SHEETS]).catch(() => {})
    await q('DELETE FROM plugin_multitable_object_registry WHERE sheet_id = ANY($1::text[])', [ALL_SHEETS]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [ALL_SHEETS]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [ALL_SHEETS]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [ALL_SHEETS]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [PD_BASE]).catch(() => {})
  })

  test.each([
    ['a writer', WRITER],
    ['a platform admin', ADMIN],
  ])('a keyed PLM row: %s gets 409 RECORD_DELETE_REFUSED_PLM_ROW, values-free; the row and its cells are intact, nothing trashed', async (_label, who) => {
    actor = who
    const res = await del(rec(SHEET_PM, 'keyed'))
    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'RECORD_DELETE_REFUSED_PLM_ROW',
        message: '这一行由备料插件（PLM 拉取）维护，不能删除；请在 PLM 里处理后重新拉取。',
        details: { reason: 'plm_row' },
      },
    })
    for (const value of [SHEET_PM, rec(SHEET_PM, 'keyed'), keyField(SHEET_PM), 'KEY-1', 'plugin-integration-core']) {
      expect(res.text).not.toContain(value)
    }
    expect(await exists(rec(SHEET_PM, 'keyed'))).toBe(true)
    expect(await dbData(rec(SHEET_PM, 'keyed'))).toEqual({ [keyField(SHEET_PM)]: 'KEY-1', [noteField(SHEET_PM)]: 'human note' })
    expect(await trashCount(rec(SHEET_PM, 'keyed'))).toBe(0)
    actor = WRITER
  })

  test('the keyless hand row on the same sheet is deleted (and lands in the trash) as before', async () => {
    actor = WRITER
    const res = await del(rec(SHEET_PM, 'keyless'))
    expect(res.status).toBe(200)
    expect(await exists(rec(SHEET_PM, 'keyless'))).toBe(false)
    expect(await trashCount(rec(SHEET_PM, 'keyless'))).toBe(1)
  })

  test.each([
    ['a tagged but NOT registered copy', () => SHEET_TAGCOPY],
    ['an ordinary sheet', () => SHEET_PLAIN],
    ['a registered sheet of another plugin namespace (confirmation ledger)', () => SHEET_LEDGER],
  ])('%s: a keyed row is deleted as before', async (_label, sheetOf) => {
    actor = WRITER
    const sheetId = sheetOf()
    const res = await del(rec(sheetId, 'keyed'))
    expect(res.status, sheetId).toBe(200)
    expect(await exists(rec(sheetId, 'keyed'))).toBe(false)
  })

  test('registered stanza sheet without a resolvable key column: refused for an admin too, reason key_column_missing', async () => {
    actor = ADMIN
    const res = await del(rec(SHEET_NOKEY, 'keyed'))
    expect(res.status).toBe(409)
    expect(res.body?.error?.code).toBe('RECORD_DELETE_REFUSED_PLM_ROW')
    expect(res.body?.error?.details).toEqual({ reason: 'key_column_missing' })
    expect(await exists(rec(SHEET_NOKEY, 'keyed'))).toBe(true)
    actor = WRITER
  })

  test('GET /view: keyed PLM rows carry canDelete=false + deleteBlockedReason; the default and other rows are unchanged', async () => {
    actor = WRITER
    const res = await request(pinned.url()).get('/api/multitable/view').query({ sheetId: SHEET_PM })
    expect(res.status).toBe(200)
    const { rowActions, rowActionOverrides } = res.body.data.meta.permissions
    expect(rowActions.canDelete).toBe(true)
    expect('deleteBlockedReason' in rowActions).toBe(false)
    expect(Object.keys(rowActionOverrides).sort()).toEqual([rec(SHEET_PM, 'keyed'), rec(SHEET_PM, 'live')].sort())
    for (const id of Object.keys(rowActionOverrides)) {
      expect(rowActionOverrides[id]).toEqual({ ...rowActions, canDelete: false, deleteBlockedReason: 'plm_row' })
    }
    const plain = await request(pinned.url()).get('/api/multitable/view').query({ sheetId: SHEET_TAGCOPY })
    expect(plain.status).toBe(200)
    expect('rowActionOverrides' in plain.body.data.meta.permissions).toBe(false)
  })

  test('trash list: restoreBlocked only on the row whose key a live row holds', async () => {
    actor = WRITER
    const res = await request(pinned.url()).get(`/api/multitable/sheets/${SHEET_PM}/trash`)
    expect(res.status).toBe(200)
    const byId = Object.fromEntries((res.body.data.records as Array<{ recordId: string }>).map((r) => [r.recordId, r]))
    expect((byId[rec(SHEET_PM, 'trash_live')] as any).restoreBlocked).toBe('plm_key_active')
    expect('restoreBlocked' in byId[rec(SHEET_PM, 'trash_gone')]).toBe(false)
    expect('restoreBlocked' in byId[rec(SHEET_PM, 'keyless')]).toBe(false)
    const nokey = await request(pinned.url()).get(`/api/multitable/sheets/${SHEET_NOKEY}/trash`)
    expect(nokey.status).toBe(200)
    expect((nokey.body.data.records as Array<{ restoreBlocked?: string }>).map((r) => r.restoreBlocked)).toEqual(['plm_key_unresolved'])
  })

  test.each([
    ['a writer', WRITER],
    ['a platform admin', ADMIN],
  ])('restore while a live row holds the key: %s gets 409 RECORD_RESTORE_REFUSED_PLM_KEY_ACTIVE; no second row with that key', async (_label, who) => {
    actor = who
    const res = await restore(rec(SHEET_PM, 'trash_live'))
    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'RECORD_RESTORE_REFUSED_PLM_KEY_ACTIVE',
        message: '表里已有同一唯一键的有效行，这条已删除的 PLM 行不能恢复（恢复会造成同键两行，拉取会被卡住）。',
        details: { reason: 'key_active' },
      },
    })
    expect(res.text).not.toContain('KEY-LIVE')
    expect(await exists(rec(SHEET_PM, 'trash_live'))).toBe(false)
    expect(await trashCount(rec(SHEET_PM, 'trash_live'))).toBe(1)
    const sameKey = await q("SELECT count(*)::int AS c FROM meta_records WHERE sheet_id = $1 AND data ->> $2 = 'KEY-LIVE'", [SHEET_PM, keyField(SHEET_PM)])
    expect(sameKey.rows[0]?.c).toBe(1)
    actor = WRITER
  })

  test('restore when no live row holds the key: restored with its human cells', async () => {
    actor = WRITER
    const res = await restore(rec(SHEET_PM, 'trash_gone'))
    expect(res.status).toBe(200)
    expect(await dbData(rec(SHEET_PM, 'trash_gone'))).toEqual({ [keyField(SHEET_PM)]: 'KEY-GONE', [noteField(SHEET_PM)]: 'kept human note' })
    expect(await trashCount(rec(SHEET_PM, 'trash_gone'))).toBe(0)
  })

  test('restore on the sheet without a resolvable key column: refused, key_column_missing; the trash row stays', async () => {
    actor = ADMIN
    const res = await restore(rec(SHEET_NOKEY, 'trash'))
    expect(res.status).toBe(409)
    expect(res.body?.error).toMatchObject({ code: 'RECORD_RESTORE_REFUSED_PLM_KEY_ACTIVE', details: { reason: 'key_column_missing' } })
    expect(await trashCount(rec(SHEET_NOKEY, 'trash'))).toBe(1)
    actor = WRITER
  })
})
