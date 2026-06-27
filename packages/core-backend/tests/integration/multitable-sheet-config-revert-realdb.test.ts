/**
 * T9-W Tier 1 — sheet_config revert (real DB). The first UNSAFE config-restore slice, behind the per-tier flag
 * MULTITABLE_ENABLE_SHEET_CONFIG_REVERT (default off). classifyRevert stays PURE (sheet_config = intrinsically
 * gated); with the flag on the ROUTE opens ONLY the Tier-1 subset (isSupportedSheetConfigRevert: an `update` whose
 * changed keys ⊆ {conditionalReadRules, rowLevelReadPermissionsEnabled}) and surfaces THAT as confirmable
 * (opKind:'safe') — a create/delete or unknown-key sheet_config stays gated.
 *
 * Goldens: (a) flag-OFF → preview AND execute 403 RESET... no: SHEET_CONFIG_REVERT_DISABLED · (b) gate: a
 * write-but-not-share actor → 403 · (c) fail-closed: a revision whose entity_id != sheet_id → 400 INVALID_REVISION ·
 * (d) flag-ON happy path: preview is confirmable (opKind:'safe', no drift) and execute SUCCEEDS (rules reverted,
 * forward source=restore revision) · (e) drift: rules edited after preview → execute 409 · (f) U-L6 redaction: a
 * field-denied canManageSheetAccess reader does NOT see the secret rule literal in the preview; fully-allowed does ·
 * (g) U-L4 atomicity: a forced revision-insert failure rolls back the config UPDATE (nothing written) · (h) scope:
 * flag-ON sheet_config create/delete/unknown-key stays gated (preview not confirmable, execute 422, no write).
 * Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_scr_${TS}`
const SHEET = `sheet_scr_${TS}`
const OTHER_SHEET = `sheet_scr_other_${TS}`
const FLD_VISIBLE = `fld_scr_visible_${TS}`
const FLD_SECRET = `fld_scr_secret_${TS}`
const VISIBLE_LIT = 'scr-visible-keepme'
const SECRET_LIT = 'scr-secret-do-not-leak'
const U_FULL = `u_scr_full_${TS}`
const U_WRITER = `u_scr_writer_${TS}`   // write but NOT share → no canManageSheetAccess
const U_SHAREDENIED = `u_scr_sdenied_${TS}` // share but FLD_SECRET denied

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let actor: { id: string; roles: string[]; perms: string[] }
const FULL = { id: U_FULL, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:share'] }
const WRITER = { id: U_WRITER, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
const SHAREDENIED = { id: U_SHAREDENIED, roles: ['member'], perms: ['multitable:read', 'multitable:share'] }
const FLAG = 'MULTITABLE_ENABLE_SHEET_CONFIG_REVERT'

const setRules = (rules: unknown[], as = FULL) => { actor = as; return request(app).put(`/api/multitable/sheets/${SHEET}/conditional-rules`).send({ rules }) }
const preview = (revisionId: string, as: typeof FULL) => { actor = as; return request(app).post(`/api/multitable/sheets/${SHEET}/config-restore-preview`).send({ revisionId }) }
const execute = (revisionId: string, previewToken: string, as: typeof FULL) => { actor = as; return request(app).post(`/api/multitable/sheets/${SHEET}/config-restore-execute`).send({ revisionId, previewToken }) }
const rule = (id: string, fieldId: string, value: string) => ({ id, fieldId, operator: 'eq', value, effect: 'deny_read' })
const latestRevId = async (): Promise<string> => ((await q(`SELECT id FROM meta_config_revisions WHERE sheet_id=$1 AND entity_type='sheet_config' ORDER BY created_at DESC, id DESC LIMIT 1`, [SHEET])).rows[0] as { id: string }).id
const liveRules = async (): Promise<any[]> => (((await q('SELECT conditional_read_rules AS r FROM meta_sheets WHERE id=$1', [SHEET])).rows[0] as { r: any }).r) ?? []
const restoreRevCount = async (): Promise<number> => ((await q(`SELECT count(*)::int AS n FROM meta_config_revisions WHERE sheet_id=$1 AND source='restore'`, [SHEET])).rows[0] as { n: number }).n
// craft a raw sheet_config revision (entity_id===sheet to pass the entity_id guard; source defaults to 'mutation')
const craftSheetConfigRev = async (action: string, changedKeys: string[], before: unknown, after: unknown): Promise<string> => ((await q(`INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, before, after, changed_keys, actor_id) VALUES ($1,'sheet_config',$1,$2,$3::jsonb,$4::jsonb,$5,$6) RETURNING id`, [SHEET, action, JSON.stringify(before), JSON.stringify(after), changedKeys, U_FULL])).rows[0] as { id: string }).id

describeIfDatabase('multitable sheet_config revert — T9-W Tier 1 (real DB)', () => {
  let revToRevert = '' // R2: before=[visible,secret], after=[visible] → revert restores the secret rule
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = actor; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'SCR Base'])
    for (const s of [SHEET, OTHER_SHEET]) await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [s, BASE, s])
    for (const [fid, name, order] of [[FLD_VISIBLE, 'Visible', 1], [FLD_SECRET, 'Secret', 2]] as const) {
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [fid, SHEET, name, 'string', '{}', order])
    }
    for (const u of [U_FULL, U_WRITER, U_SHAREDENIED]) await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [u])
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET, FLD_SECRET, 'user', U_SHAREDENIED, false, false])
    // R1: add both rules. R2: drop the secret rule → reverting R2 restores [visible, secret].
    const r1 = await setRules([rule('rv', FLD_VISIBLE, VISIBLE_LIT), rule('rs', FLD_SECRET, SECRET_LIT)])
    const r2 = await setRules([rule('rv', FLD_VISIBLE, VISIBLE_LIT)])
    if (r1.status !== 200 || r2.status !== 200) throw new Error(`rule setup failed: ${r1.status}/${r2.status}`)
    revToRevert = await latestRevId() // R2
  })
  afterAll(async () => {
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = ANY($1)', [[SHEET, OTHER_SHEET]]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1)', [[SHEET, OTHER_SHEET]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    for (const u of [U_FULL, U_WRITER, U_SHAREDENIED]) await q('DELETE FROM users WHERE id = $1', [u]).catch(() => {})
  })
  afterEach(() => { delete process.env[FLAG] })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('(a) flag OFF → preview AND execute 403 SHEET_CONFIG_REVERT_DISABLED', async () => {
    delete process.env[FLAG]
    const p = await preview(revToRevert, FULL)
    expect(p.status).toBe(403)
    expect(p.body?.error?.code).toBe('SHEET_CONFIG_REVERT_DISABLED')
    const x = await execute(revToRevert, 'any-token', FULL)
    expect(x.status).toBe(403)
    expect(x.body?.error?.code).toBe('SHEET_CONFIG_REVERT_DISABLED')
  })

  test('(b) gate: write-but-not-share actor → 403 (canManageSheetAccess required)', async () => {
    process.env[FLAG] = 'true'
    const p = await preview(revToRevert, WRITER)
    expect(p.status).toBe(403)
  })

  test('(c) fail-closed: a sheet_config revision whose entity_id != sheet_id → 400 INVALID_REVISION', async () => {
    process.env[FLAG] = 'true'
    // forge a malformed revision on SHEET but pointing entity_id at OTHER_SHEET
    const bad = (await q(
      `INSERT INTO meta_config_revisions (id, sheet_id, entity_type, entity_id, action, before, after, changed_keys, batch_id, actor_id, created_at)
       VALUES (gen_random_uuid(), $1, 'sheet_config', $2, 'update', $3::jsonb, $4::jsonb, ARRAY['conditionalReadRules']::text[], gen_random_uuid(), $5, now()) RETURNING id`,
      [SHEET, OTHER_SHEET, JSON.stringify({ conditionalReadRules: [] }), JSON.stringify({ conditionalReadRules: [] }), U_FULL],
    )).rows[0] as { id: string }
    const p = await preview(bad.id, FULL)
    expect(p.status).toBe(400)
    expect(p.body?.error?.code).toBe('INVALID_REVISION')
    const x = await execute(bad.id, 'any-token', FULL)
    expect(x.status).toBe(400)
    expect(x.body?.error?.code).toBe('INVALID_REVISION')
  })

  test('(d) flag ON happy path: preview confirmable (opKind safe, no drift) → execute restores the rules', async () => {
    process.env[FLAG] = 'true'
    // two DISTINCT states so a fresh revision is recorded (a no-op PUT records nothing): before=[d1], after=[d2].
    await setRules([rule('rv', FLD_VISIBLE, 'd1-restore-target')])
    await setRules([rule('rv', FLD_VISIBLE, 'd2-current')])
    const rev = await latestRevId() // revert → restores [d1]
    const p = await preview(rev, FULL)
    expect(p.status).toBe(200)
    expect(p.body?.data?.preview?.opKind).toBe('safe') // route override → FE shows confirm
    expect(p.body?.data?.preview?.gatedReason).toBeUndefined()
    expect(p.body?.data?.preview?.driftConflict).toBe(false)
    const token = p.body?.data?.previewToken
    const x = await execute(rev, token, FULL)
    expect(x.status).toBe(200)
    const live = await liveRules()
    expect(JSON.stringify(live)).toContain('d1-restore-target') // restored the revision's `before`
    expect(JSON.stringify(live)).not.toContain('d2-current') // the reverted-away state is gone
    // a forward source=restore revision was appended (append-only / U-L5)
    const restoreRevs = await q(`SELECT count(*)::int AS n FROM meta_config_revisions WHERE sheet_id=$1 AND source='restore'`, [SHEET])
    expect((restoreRevs.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(1)
  })

  test('(e) drift: rules edited between preview and execute → execute 409', async () => {
    process.env[FLAG] = 'true'
    await setRules([rule('rv', FLD_VISIBLE, 'e1')])
    await setRules([rule('rv', FLD_VISIBLE, 'e2')]) // fresh revision
    const rev = await latestRevId()
    const p = await preview(rev, FULL)
    expect(p.status).toBe(200)
    const token = p.body?.data?.previewToken
    await setRules([rule('rv', FLD_VISIBLE, 'e3-moved-since-preview')]) // live moved after preview
    const x = await execute(rev, token, FULL)
    expect(x.status).toBe(409)
  })

  test('(f) U-L6: field-denied canManageSheetAccess reader does NOT see the secret rule literal; opKind still safe', async () => {
    process.env[FLAG] = 'true'
    // restore to a state whose revert target contains the secret rule: set [visible, secret] then drop secret
    await setRules([rule('rv', FLD_VISIBLE, VISIBLE_LIT), rule('rs', FLD_SECRET, SECRET_LIT)])
    await setRules([rule('rv', FLD_VISIBLE, VISIBLE_LIT)])
    const rev = await latestRevId() // before=[visible,secret], after=[visible]
    const denied = await preview(rev, SHAREDENIED)
    expect(denied.status).toBe(200)
    expect(denied.body?.data?.preview?.opKind).toBe('safe') // confirmable for the share actor
    expect(JSON.stringify(denied.body)).not.toContain(SECRET_LIT) // U-L6 redaction on the preview target
    expect(JSON.stringify(denied.body)).toContain(VISIBLE_LIT) // no over-redaction

    const full = await preview(rev, FULL)
    expect(JSON.stringify(full.body)).toContain(SECRET_LIT) // fully-allowed sees it
  })

  // (g) U-L4 atomicity: execute applies the config UPDATE (applyConfigRevert) and the forward source=restore
  // revision (recordConfigRevision) inside ONE pool.transaction. Force the revision INSERT to fail AFTER the
  // UPDATE has run, and assert the sheet is byte-for-byte unchanged + no revision was added → single-transaction
  // all-or-nothing (not revert-first/record-second with a half-write). The trigger is scoped to THIS sheet and
  // source='restore', so it fires only on this restore insert — never on setRules or any parallel suite's row.
  test('(g) U-L4 atomicity: a forced revision-insert failure rolls back the config UPDATE — nothing written', async () => {
    process.env[FLAG] = 'true'
    // two DISTINCT states so a fresh revision is recorded: before=[g1], after=[g2]; reverting would restore [g1].
    await setRules([rule('rv', FLD_VISIBLE, 'g1-restore-target')])
    await setRules([rule('rv', FLD_VISIBLE, 'g2-current')])
    const rev = await latestRevId()
    const p = await preview(rev, FULL)
    expect(p.status).toBe(200)
    const token = p.body?.data?.previewToken
    const liveBefore = JSON.stringify(await liveRules())
    const countBefore = ((await q('SELECT count(*)::int AS n FROM meta_config_revisions WHERE sheet_id=$1', [SHEET])).rows[0] as { n: number }).n
    const FN = `scr_atomic_fail_${TS}`
    const TRG = `scr_atomic_fail_trg_${TS}`
    await q(`CREATE OR REPLACE FUNCTION ${FN}() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'forced restore-revision insert failure (atomicity golden)'; END; $fn$`, [])
    await q(`DROP TRIGGER IF EXISTS ${TRG} ON meta_config_revisions`, [])
    await q(`CREATE TRIGGER ${TRG} BEFORE INSERT ON meta_config_revisions FOR EACH ROW WHEN (NEW.sheet_id = '${SHEET}' AND NEW.source = 'restore') EXECUTE FUNCTION ${FN}()`, [])
    try {
      const x = await execute(rev, token, FULL)
      expect(x.status).toBe(500) // forced failure aborts the txn → INTERNAL
      expect(x.body?.error?.code).toBe('INTERNAL')
      // the config UPDATE rolled back: live rules byte-for-byte unchanged (still g2), NOT reverted to g1
      const liveAfter = JSON.stringify(await liveRules())
      expect(liveAfter).toBe(liveBefore)
      expect(liveAfter).toContain('g2-current')
      expect(liveAfter).not.toContain('g1-restore-target')
      // and NO forward restore revision was committed (count unchanged)
      const countAfter = ((await q('SELECT count(*)::int AS n FROM meta_config_revisions WHERE sheet_id=$1', [SHEET])).rows[0] as { n: number }).n
      expect(countAfter).toBe(countBefore)
    } finally {
      await q(`DROP TRIGGER IF EXISTS ${TRG} ON meta_config_revisions`, []).catch(() => {})
      await q(`DROP FUNCTION IF EXISTS ${FN}()`, []).catch(() => {})
    }
  })

  // (h) U-L1/scope ([P1] fix): the flag opens ONLY Tier 1 — an `update` whose changed keys ⊆ {conditionalReadRules,
  // rowLevelReadPermissionsEnabled}. A flag-ON sheet_config create / delete (un-create / undelete = Tier 3/4, #3254
  // HOLD) or an `update` with an unknown changed_key must STAY gated: preview is NOT confirmable (opKind !== 'safe')
  // and execute 422s RESTORE_NOT_SUPPORTED with NO config write and NO forward restore revision. Guards the earlier
  // blanket `entity_type === 'sheet_config'` bypass that wrongly treated these Tier-3/4 ops as confirmable/executable.
  const outOfTier1: Array<{ name: string; action: string; keys: string[]; before: unknown; after: unknown }> = [
    { name: 'create (un-create / Tier 3)', action: 'create', keys: ['conditionalReadRules'], before: null, after: { conditionalReadRules: [rule('rc', FLD_VISIBLE, 'created-lit')] } },
    { name: 'delete (undelete / Tier 4)', action: 'delete', keys: ['conditionalReadRules'], before: { conditionalReadRules: [rule('rd', FLD_VISIBLE, 'deleted-lit')] }, after: null },
    { name: 'update with an unknown changed_key', action: 'update', keys: ['rowLevelReadPermissionsEnabledX'], before: { rowLevelReadPermissionsEnabledX: false }, after: { rowLevelReadPermissionsEnabledX: true } },
  ]
  for (const c of outOfTier1) {
    test(`(h) flag-ON sheet_config OUTSIDE Tier 1 — ${c.name} → gated preview + 422 execute, nothing written`, async () => {
      process.env[FLAG] = 'true'
      const revId = await craftSheetConfigRev(c.action, c.keys, c.before, c.after)
      const p = await preview(revId, FULL)
      expect(p.status).toBe(200)
      expect(p.body?.data?.preview?.opKind).not.toBe('safe') // NOT confirmable — Tier 3/4 HOLD honored
      const token = p.body?.data?.previewToken
      const liveBefore = JSON.stringify(await liveRules())
      const restoreBefore = await restoreRevCount()
      const x = await execute(revId, token, FULL)
      expect(x.status).toBe(422)
      expect(x.body?.error?.code).toBe('RESTORE_NOT_SUPPORTED')
      expect(JSON.stringify(await liveRules())).toBe(liveBefore) // no config write
      expect(await restoreRevCount()).toBe(restoreBefore)        // no forward restore revision
    })
  }
})
