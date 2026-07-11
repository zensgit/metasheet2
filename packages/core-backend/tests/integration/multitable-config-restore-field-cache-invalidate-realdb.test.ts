/**
 * D-6 (docs/development/multitable-global-history-destruction-path-coverage-gap-audit-20260708.md §4)
 * — config-restore EXECUTE success path was never invalidating `metaFieldCache`.
 *
 * `metaFieldCache` (univer-meta.ts, module-scoped `Map`, no TTL, process-lifetime) is fed by
 * `loadSheetFields` and consulted by several call sites (GET /view field list, the create/patch echo
 * mask, `recalcNewRecordFormulas`). The un-create (U-3) and undelete (U-4) branches of
 * `POST /sheets/:sheetId/config-restore-execute` both call `invalidateFieldCache(sheetId)` on their
 * success path — but the GENERIC Tier-1 (sheet_config) / Tier-2 (field name/order/type/property)
 * success path fell through to `return res.json(...)` with NO invalidation, even though it runs a real
 * `UPDATE meta_fields` (`applyConfigRevert`). Once any caller had warmed the cache for a sheet, a
 * Tier-2 field type/property revert would commit to the DB but the process would keep serving the
 * PRE-revert field definition to every `loadSheetFields` consumer until something else happened to
 * evict that sheet's cache entry.
 *
 * This golden proves the defect end-to-end over the real DB and the real in-process cache (no mocks):
 *  1. GET /view warms `metaFieldCache` for the sheet with the field's CURRENT type ('string').
 *  2. A Tier-2 field-retype config-restore is previewed + executed, reverting the field's type back to
 *     'number' — a real `meta_fields` UPDATE plus a forward `source='restore'` config revision.
 *  3. GET /view is called again on the SAME app/cache instance (no restart, no unrelated eviction).
 *     Post-fix it must report the FRESH, reverted type ('number'); pre-fix it would still report the
 *     STALE cached type ('string') even though the database already says 'number'.
 *
 * Mutation check performed manually: deleting the `invalidateFieldCache(sheetId)` call added to the
 * generic config-restore-execute success path (univer-meta.ts, config-restore-execute route) turns
 * this test red (assertion 3 sees the stale 'string'); restoring it turns the file green again with a
 * no-op `git diff`.
 *
 * Runs only with DATABASE_URL (describeIfDatabase) via the plugin-tests.yml step.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_d6fc_${TS}`
const SHEET = `sheet_d6fc_${TS}`
const FIELD = `fld_d6fc_${TS}`
const U_FULL = `u_d6fc_full_${TS}`
const FLAG = 'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT'

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let actor: { id: string; roles: string[]; perms: string[] }
const FULL = { id: U_FULL, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }

type ViewField = { id: string; type: string }

describeIfDatabase('D-6 — config-restore execute invalidates metaFieldCache (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as { user?: unknown }).user = actor; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'D6FC Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, SHEET])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [U_FULL])
  })
  afterAll(async () => {
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [U_FULL]).catch(() => {})
  })
  afterEach(() => { delete process.env[FLAG] })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('Tier-2 field-retype revert execute invalidates metaFieldCache: a warm GET /view stops serving the pre-revert type', async () => {
    actor = FULL
    process.env[FLAG] = 'true'

    // Field is CURRENTLY 'string' (this is what the forward PATCH /fields route recorded as `after`;
    // `before` is what a revert restores — 'number').
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FIELD, SHEET, 'F', 'string', '{}', 1])
    const revRes = await q(
      `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, before, after, changed_keys, actor_id)
       VALUES ($1,'field',$2,'update',$3::jsonb,$4::jsonb,$5,$6) RETURNING id`,
      [SHEET, FIELD, JSON.stringify({ type: 'number' }), JSON.stringify({ type: 'string' }), ['type'], U_FULL],
    )
    const revisionId = (revRes.rows[0] as { id: string }).id

    // 1) Warm metaFieldCache for this sheet with the PRE-revert field list.
    const warm = await request(app).get(`/api/multitable/view?sheetId=${SHEET}`)
    expect(warm.status).toBe(200)
    expect((warm.body.data.fields as ViewField[]).find((f) => f.id === FIELD)?.type).toBe('string')

    // 2) Preview + execute the Tier-2 revert (type: string -> number).
    const preview = await request(app)
      .post(`/api/multitable/sheets/${SHEET}/config-restore-preview`)
      .send({ revisionId })
    expect(preview.status).toBe(200)
    expect(preview.body?.data?.preview?.opKind).toBe('safe')
    const previewToken = preview.body?.data?.previewToken
    const exec = await request(app)
      .post(`/api/multitable/sheets/${SHEET}/config-restore-execute`)
      .send({ revisionId, previewToken })
    expect(exec.status).toBe(200)
    expect(exec.body?.data?.restored?.entityId).toBe(FIELD)

    // DB ground truth: the type really did revert.
    const dbType = ((await q('SELECT type FROM meta_fields WHERE id=$1', [FIELD])).rows[0] as { type: string }).type
    expect(dbType).toBe('number')

    // 3) Same in-process cache, no restart, no unrelated eviction: GET /view must now report the FRESH
    // ('number') type. Pre-fix this would still return the STALE cached 'string' from step 1.
    const after = await request(app).get(`/api/multitable/view?sheetId=${SHEET}`)
    expect(after.status).toBe(200)
    expect((after.body.data.fields as ViewField[]).find((f) => f.id === FIELD)?.type).toBe('number')
  })
})
