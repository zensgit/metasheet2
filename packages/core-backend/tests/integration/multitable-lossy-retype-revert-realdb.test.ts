/**
 * 4c-1 LOSSY / value-transform field retype revert (real DB) — golden matrix L1..L11 of the design-lock
 * (`multitable-global-history-4c1-lossy-retype-revert-design-lock-20260707.md`), as amended by the owner's
 * R6 ratification decision (`…-r6-ratification-decision-record-20260708.md` §2: **U-L8 = full-read gate**;
 * the lock's scoped-oracle alternative (ii) is void, so there are no scoped counts and no `undisclosedPresent`).
 *
 * ENVELOPE (fail-closed — see lossy-retype-oracle.ts's header and the PR body): the lossy path opens ONLY
 * property-only field reverts (`changed_keys ⊆ {name,order,property}` ∋ `property`, NO `type`) on a field whose
 * LIVE type is a Batch-1 codec type. A scalar-safe TYPE revert keeps its shipped schema-only, zero-value-rewrite
 * path even with the lossy flag on (L2). Everything else stays 422 / 403 exactly as today (L1).
 *
 * | # | scenario                                                                             |
 * |---|--------------------------------------------------------------------------------------|
 * | L1 | both flags off / lossy-only / base-only → 403 · 403 · today's gated-preview + 422    |
 * | L2 | scalar-safe type revert with BOTH flags on → schema-only, ZERO value rewrite         |
 * | L3 | oracle three buckets exact (incl. a rating case that pins `before.property` as input)|
 * | L4 | no full-table read (row-deny switch OR field mask) → 403 preview AND execute, 0 leak |
 * | L5 | a cell moves bucket after preview → execute 409 PLAN_DRIFT, DB untouched             |
 * | L5b| a cell moves WITHIN its bucket → no drift (the token binds MAGNITUDE, §2.3) — regression |
 * | L6 | over `SHEET_REVERT_MAX_RECORDS` → 413 on BOTH sides, DB untouched                    |
 * | L7 | injected mid-execute failure → field config AND cell values fully rolled back        |
 * | L8 | one record revision per coerced/dropped cell; unchanged cells get none; changedFieldIds exact |
 * | L9 | missing / wrong typed confirm → refused, DB untouched                                |
 * | L10| (mutation, run out-of-band — see PR body) neuter oracle/cap/bucket/gate → L5/L6/L3/L4 red |
 * | L11| 4c-2 pre-image: reason='lossy_retype' rows anchored to THIS revert's own config revision |
 *
 * Runs only with DATABASE_URL. All fixture ids are file-namespaced (`lrr_`) per the shared-DB bundle rule, and
 * afterAll deletes every child row this file creates.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_lrr_${TS}`
const SHEET = `sheet_lrr_${TS}`
const FIELD = `fld_lrr_${TS}`
const OTHER_FIELD = `fld_lrr_other_${TS}`
const ERA_FIELD = `fld_lrr_era_${TS}`
const U_FULL = `u_lrr_full_${TS}` // multitable:write -> canManageFields
const BASE_FLAG = 'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT'
const LOSSY_FLAG = 'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY'
const CAP_ENV = 'MULTITABLE_SHEET_REVERT_MAX_RECORDS'
const CAPTURE_FLAG = 'MULTITABLE_TOMBSTONE_CAPTURE_ENABLED'
const CONFIRM = 'revert-retype-lossy'

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let actor: { id: string; roles: string[]; perms: string[] }
const FULL = { id: U_FULL, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }

const rid = (n: number) => `rec_lrr_${TS}_${n}`

const preview = (revisionId: string) => { actor = FULL; return request(app).post(`/api/multitable/sheets/${SHEET}/config-restore-preview`).send({ revisionId }) }
/** `confirm: null` OMITS the key entirely (an explicit `undefined` would re-trigger the default parameter). */
const execute = (revisionId: string, previewToken: string, confirm: string | null = CONFIRM) => {
  actor = FULL
  const body: Record<string, unknown> = { revisionId, previewToken }
  if (confirm !== null) body.confirm = confirm
  return request(app).post(`/api/multitable/sheets/${SHEET}/config-restore-execute`).send(body)
}

const fieldProperty = async (): Promise<Record<string, unknown>> => ((await q('SELECT property FROM meta_fields WHERE id=$1', [FIELD])).rows[0] as { property: Record<string, unknown> }).property
const cellValues = async (): Promise<Record<string, unknown>> => {
  const rows = (await q('SELECT id, data->$2 AS v FROM meta_records WHERE sheet_id=$1 ORDER BY id', [SHEET, FIELD])).rows as Array<{ id: string; v: unknown }>
  return Object.fromEntries(rows.map((r) => [r.id, r.v]))
}
const versions = async (): Promise<Record<string, number>> => {
  const rows = (await q('SELECT id, version FROM meta_records WHERE sheet_id=$1 ORDER BY id', [SHEET])).rows as Array<{ id: string; version: number }>
  return Object.fromEntries(rows.map((r) => [r.id, Number(r.version)]))
}
const restoreConfigRevisions = async () => (await q(`SELECT id, source, restored_from_id FROM meta_config_revisions WHERE sheet_id=$1 AND source='restore'`, [SHEET])).rows as Array<{ id: string; source: string; restored_from_id: string | null }>
const recordRevisions = async () => (await q(`SELECT record_id, version, action, source, changed_field_ids, patch, snapshot, batch_id FROM meta_record_revisions WHERE sheet_id=$1 ORDER BY record_id`, [SHEET])).rows as Array<{ record_id: string; version: number; action: string; source: string; changed_field_ids: string[]; patch: Record<string, unknown>; snapshot: Record<string, unknown>; batch_id: string }>
const tombstones = async () => (await q(`SELECT record_id, value, reason, config_revision_id FROM meta_field_value_tombstones WHERE sheet_id=$1 ORDER BY record_id`, [SHEET])).rows as Array<{ record_id: string; value: unknown; reason: string; config_revision_id: string | null }>

/** A field config revision. `source` defaults to 'mutation'. */
const craftRev = async (changedKeys: string[], before: unknown, after: unknown): Promise<string> =>
  ((await q(
    `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, before, after, changed_keys, actor_id)
     VALUES ($1,'field',$2,'update',$3::jsonb,$4::jsonb,$5,$6) RETURNING id`,
    [SHEET, FIELD, JSON.stringify(before), JSON.stringify(after), changedKeys, U_FULL],
  )).rows[0] as { id: string }).id

/** The property-only revert this slice opens: live property === `after.property`, revert restores `before.property`. */
const craftPropertyRev = (beforeProperty: unknown, afterProperty: unknown) =>
  craftRev(['property'], { property: beforeProperty }, { property: afterProperty })

const seedField = async (type: string, liveProperty: unknown, values: Array<[number, unknown]>) => {
  await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FIELD, SHEET, 'F', type, JSON.stringify(liveProperty), 1])
  for (const [n, value] of values) {
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [rid(n), SHEET, JSON.stringify({ [FIELD]: value })])
  }
}
/** A record that has NO cell for the field — nothing to lose, so it must not land in any bucket. */
const seedKeylessRecord = async (n: number) => q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [rid(n), SHEET, JSON.stringify({ someOtherKey: 1 })])

const setCell = (n: number, value: unknown) => q('UPDATE meta_records SET data = jsonb_set(data, ARRAY[$2::text], $3::jsonb, true) WHERE id=$1', [rid(n), FIELD, JSON.stringify(value)])

describeIfDatabase('4c-1 lossy retype revert (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as { user?: unknown }).user = actor; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'LRR Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, SHEET])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [U_FULL])
  })
  afterAll(async () => {
    await q('DELETE FROM meta_field_value_tombstones WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_link_tombstones WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [U_FULL]).catch(() => {})
  })
  afterEach(async () => {
    delete process.env[BASE_FLAG]
    delete process.env[LOSSY_FLAG]
    delete process.env[CAP_ENV]
    delete process.env[CAPTURE_FLAG]
    await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = false WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET]).catch(() => {})
  })
  beforeEach(async () => {
    await q('DELETE FROM meta_field_value_tombstones WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
  })

  const bothFlagsOn = () => { process.env[BASE_FLAG] = 'true'; process.env[LOSSY_FLAG] = 'true' }
  /** The canonical L3 fixture: one cell per bucket (+ a null cell and a keyless record). */
  const seedCurrencyFixture = async () => {
    await seedField('currency', { precision: 0 }, [[1, 9], [2, '12.5'], [3, 'abc'], [4, ''], [5, null]])
    await seedKeylessRecord(6)
    return craftPropertyRev({ precision: 2 }, { precision: 0 })
  }
  const EXPECTED_SUMMARY = { unchanged: 2, coerced: 1, dropped: 2 } // 9 & null · '12.5'→12.5 · 'abc' throws & '' empties

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // ── L1 ────────────────────────────────────────────────────────────────────────────────────────────────────
  test('L1a both flags off -> preview AND execute 403 (base-tier flag governs the whole surface)', async () => {
    const rev = await seedCurrencyFixture()
    const before = await cellValues()
    const p = await preview(rev)
    expect(p.status).toBe(403)
    expect(p.body?.error?.code).toBe('FIELD_RETYPE_REVERT_DISABLED')
    const x = await execute(rev, 'tok')
    expect(x.status).toBe(403)
    expect(x.body?.error?.code).toBe('FIELD_RETYPE_REVERT_DISABLED')
    expect(await cellValues()).toEqual(before)
    expect(await restoreConfigRevisions()).toEqual([])
  })

  test('L1b lossy flag ON but base flag OFF -> 403 (double gate, series-wired: base off = whole surface off)', async () => {
    process.env[LOSSY_FLAG] = 'true'
    const rev = await seedCurrencyFixture()
    const p = await preview(rev)
    expect(p.status).toBe(403)
    expect(p.body?.error?.code).toBe('FIELD_RETYPE_REVERT_DISABLED')
    const x = await execute(rev, 'tok')
    expect(x.status).toBe(403)
    expect(x.body?.error?.code).toBe('FIELD_RETYPE_REVERT_DISABLED')
  })

  test('L1c base flag ON, lossy flag OFF -> byte-for-byte today: gated preview (no lossSummary) + execute 422', async () => {
    process.env[BASE_FLAG] = 'true'
    const rev = await seedCurrencyFixture()
    const before = await cellValues()
    const p = await preview(rev)
    expect(p.status).toBe(200)
    expect(p.body?.data?.preview?.opKind).toBe('gated')
    expect(typeof p.body?.data?.preview?.gatedReason).toBe('string')
    expect(p.body?.data).not.toHaveProperty('lossSummary')
    expect(p.body?.data).not.toHaveProperty('lossNote')
    const x = await execute(rev, p.body.data.previewToken)
    expect(x.status).toBe(422)
    expect(x.body?.error?.code).toBe('RESTORE_NOT_SUPPORTED')
    expect(await cellValues()).toEqual(before)
    expect(await fieldProperty()).toEqual({ precision: 0 })
    expect(await restoreConfigRevisions()).toEqual([])
  })

  // ── L2 ────────────────────────────────────────────────────────────────────────────────────────────────────
  test('L2 scalar-safe TYPE revert with BOTH flags on -> existing schema-only path, ZERO value rewrite', async () => {
    bothFlagsOn()
    await seedField('number', {}, [[1, 'hello']])
    const rev = await craftRev(['type'], { type: 'string' }, { type: 'number' })
    const p = await preview(rev)
    expect(p.status).toBe(200)
    expect(p.body?.data?.preview?.opKind).toBe('safe')
    expect(p.body?.data).not.toHaveProperty('lossSummary') // the lossy branch must not claim a type revert
    const x = await execute(rev, p.body.data.previewToken, null) // no typed confirm on the schema-only tier
    expect(x.status).toBe(200)
    expect(((await q('SELECT type FROM meta_fields WHERE id=$1', [FIELD])).rows[0] as { type: string }).type).toBe('string')
    expect(await cellValues()).toEqual({ [rid(1)]: 'hello' }) // the value that does NOT fit `string`… is kept raw
    expect(await recordRevisions()).toEqual([]) // ZERO value rewrite ⇒ zero record revisions
  })

  // ── L3 ────────────────────────────────────────────────────────────────────────────────────────────────────
  test('L3a oracle three buckets exact; a keyless record is in no bucket', async () => {
    bothFlagsOn()
    const rev = await seedCurrencyFixture()
    const p = await preview(rev)
    expect(p.status).toBe(200)
    expect(p.body?.data?.lossSummary).toEqual(EXPECTED_SUMMARY)
    expect(p.body?.data?.preview?.opKind).toBe('safe')
    expect(p.body?.data?.confirm).toBe(CONFIRM)
    expect(typeof p.body?.data?.lossNote).toBe('string')
    // preview is a pure read
    expect(await fieldProperty()).toEqual({ precision: 0 })
    expect(await recordRevisions()).toEqual([])
  })

  test('L3b oracle coerces against the REVISION\'s before.property, not the live property (rating max 10 -> 5)', async () => {
    bothFlagsOn()
    // live max=10 (8 is legal); the revert restores max=5, under which 8 is NOT representable -> dropped.
    await seedField('rating', { max: 10 }, [[1, 8], [2, 3]])
    const rev = await craftPropertyRev({ max: 5 }, { max: 10 })
    const p = await preview(rev)
    expect(p.status).toBe(200)
    expect(p.body?.data?.lossSummary).toEqual({ unchanged: 1, coerced: 0, dropped: 1 })
  })

  // ── L4 (U-L8 full-read gate, owner ruling) ────────────────────────────────────────────────────────────────
  const expectNoLeak = (body: unknown) => {
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('lossSummary')
    expect(serialized).not.toContain('undisclosed')
    expect(serialized).not.toMatch(/\b(unchanged|coerced|dropped)\b/)
  }

  test('L4a row-level read-deny switch on (non-admin) -> 403 on preview AND execute, zero count leakage', async () => {
    bothFlagsOn()
    const rev = await seedCurrencyFixture()
    const before = await cellValues()
    await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = true WHERE id = $1', [SHEET])
    const p = await preview(rev)
    expect(p.status).toBe(403)
    expect(p.body?.error?.code).toBe('FULL_TABLE_READ_REQUIRED')
    expectNoLeak(p.body)
    const x = await execute(rev, 'tok')
    expect(x.status).toBe(403)
    expect(x.body?.error?.code).toBe('FULL_TABLE_READ_REQUIRED')
    expectNoLeak(x.body)
    expect(await cellValues()).toEqual(before)
    expect(await fieldProperty()).toEqual({ precision: 0 })
    expect(await restoreConfigRevisions()).toEqual([])
  })

  test('L4b a field-permission mask on ANY field of the sheet -> 403 on preview AND execute', async () => {
    bothFlagsOn()
    const rev = await seedCurrencyFixture()
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [OTHER_FIELD, SHEET, 'Other', 'string', '{}', 2])
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,false,false)', [SHEET, OTHER_FIELD, 'user', U_FULL])
    const p = await preview(rev)
    expect(p.status).toBe(403)
    expect(p.body?.error?.code).toBe('FULL_TABLE_READ_REQUIRED')
    expectNoLeak(p.body)
    const x = await execute(rev, 'tok')
    expect(x.status).toBe(403)
    expect(x.body?.error?.code).toBe('FULL_TABLE_READ_REQUIRED')
    expect(await restoreConfigRevisions()).toEqual([])
  })

  // ── L5 / L5b ──────────────────────────────────────────────────────────────────────────────────────────────
  test('L5 a cell CHANGES BUCKET after preview -> execute 409 PLAN_DRIFT, DB untouched', async () => {
    bothFlagsOn()
    const rev = await seedCurrencyFixture()
    const p = await preview(rev)
    expect(p.body?.data?.lossSummary).toEqual(EXPECTED_SUMMARY)
    await setCell(3, '7') // 'abc' (dropped) -> '7' (coerced): the magnitude the actor confirmed is now stale
    const before = await cellValues()
    const x = await execute(rev, p.body.data.previewToken)
    expect(x.status).toBe(409)
    expect(x.body?.error?.code).toBe('PLAN_DRIFT')
    expect(await cellValues()).toEqual(before)
    expect(await fieldProperty()).toEqual({ precision: 0 })
    expect(await restoreConfigRevisions()).toEqual([])
    expect(await recordRevisions()).toEqual([])
  })

  test('L5b a cell moves WITHIN its bucket -> no drift (§2.3 binds the loss MAGNITUDE, not per-cell values)', async () => {
    bothFlagsOn()
    const rev = await seedCurrencyFixture()
    const p = await preview(rev)
    await setCell(3, 'xyz') // 'abc' -> 'xyz': still `dropped`, so the magnitude is unchanged
    const x = await execute(rev, p.body.data.previewToken)
    expect(x.status).toBe(200)
    expect(x.body?.data?.lossSummary).toEqual(EXPECTED_SUMMARY)
  })

  // ── L6 ────────────────────────────────────────────────────────────────────────────────────────────────────
  test('L6 over the write-symmetric cap -> 413 on preview AND execute, DB untouched', async () => {
    bothFlagsOn()
    const rev = await seedCurrencyFixture() // 6 records
    process.env[CAP_ENV] = '2'
    const before = await cellValues()
    const p = await preview(rev)
    expect(p.status).toBe(413)
    expect(p.body?.error?.code).toBe('SHEET_TOO_LARGE')
    const x = await execute(rev, 'tok')
    expect(x.status).toBe(413)
    expect(x.body?.error?.code).toBe('SHEET_TOO_LARGE')
    expect(await cellValues()).toEqual(before)
    expect(await fieldProperty()).toEqual({ precision: 0 })
    expect(await restoreConfigRevisions()).toEqual([])
  })

  // ── L7 ────────────────────────────────────────────────────────────────────────────────────────────────────
  test('L7 atomicity: a failure injected mid-execute rolls back BOTH the field config and every cell value', async () => {
    bothFlagsOn()
    const rev = await seedCurrencyFixture()
    const p = await preview(rev)
    const before = await cellValues()
    const beforeVersions = await versions()
    // Sheet-scoped so a shared-DB bundle's other test files are unaffected.
    await q(`CREATE OR REPLACE FUNCTION ms_lrr_boom_${TS}() RETURNS trigger AS $fn$ BEGIN IF NEW.sheet_id = '${SHEET}' THEN RAISE EXCEPTION 'ms-4c1 injected failure'; END IF; RETURN NEW; END; $fn$ LANGUAGE plpgsql`, [])
    await q(`CREATE TRIGGER ms_lrr_boom_trg_${TS} BEFORE INSERT ON meta_record_revisions FOR EACH ROW EXECUTE FUNCTION ms_lrr_boom_${TS}()`, [])
    try {
      const x = await execute(rev, p.body.data.previewToken)
      expect(x.status).toBe(500)
      expect(await fieldProperty()).toEqual({ precision: 0 }) // NOT reverted to {precision:2}
      expect(await cellValues()).toEqual(before)
      expect(await versions()).toEqual(beforeVersions)
      expect(await recordRevisions()).toEqual([])
      expect(await restoreConfigRevisions()).toEqual([])
      expect(await tombstones()).toEqual([])
    } finally {
      await q(`DROP TRIGGER IF EXISTS ms_lrr_boom_trg_${TS} ON meta_record_revisions`, [])
      await q(`DROP FUNCTION IF EXISTS ms_lrr_boom_${TS}()`, [])
    }
  })

  // ── L8 ────────────────────────────────────────────────────────────────────────────────────────────────────
  test('L8 happy path: config reverted, cells transformed, ONE record revision per coerced/dropped cell', async () => {
    bothFlagsOn()
    const rev = await seedCurrencyFixture()
    const p = await preview(rev)
    const x = await execute(rev, p.body.data.previewToken)
    expect(x.status).toBe(200)
    expect(x.body?.data?.lossSummary).toEqual(EXPECTED_SUMMARY)

    expect(await fieldProperty()).toEqual({ precision: 2 }) // the reverted-to config
    expect(await cellValues()).toEqual({
      [rid(1)]: 9,      // unchanged
      [rid(2)]: 12.5,   // coerced: the string was re-formatted by the codec
      [rid(3)]: null,   // dropped: not representable
      [rid(4)]: null,   // dropped: emptied
      [rid(5)]: null,   // unchanged (was already null)
      [rid(6)]: null,   // keyless record: `data->field` is SQL NULL — never touched
    })
    // versions bumped ONLY on rewritten records
    expect(await versions()).toEqual({ [rid(1)]: 1, [rid(2)]: 2, [rid(3)]: 2, [rid(4)]: 2, [rid(5)]: 1, [rid(6)]: 1 })

    const revisions = await recordRevisions()
    expect(revisions.map((r) => r.record_id)).toEqual([rid(2), rid(3), rid(4)]) // exactly the changed cells
    expect(new Set(revisions.map((r) => r.batch_id)).size).toBe(1) // LOCK-12: one user action = one batch
    for (const r of revisions) {
      expect(r.action).toBe('update')
      expect(r.source).toBe('restore')
      expect(r.changed_field_ids).toEqual([FIELD]) // exact — no over-reporting of untouched fields
      expect(Object.keys(r.patch)).toEqual([FIELD])
    }
    expect(revisions.find((r) => r.record_id === rid(2))?.patch).toEqual({ [FIELD]: 12.5 })
    expect(revisions.find((r) => r.record_id === rid(2))?.snapshot).toEqual({ [FIELD]: 12.5 })
    expect(revisions.find((r) => r.record_id === rid(3))?.patch).toEqual({ [FIELD]: null })
    expect(revisions.find((r) => r.record_id === rid(2))?.version).toBe(2)

    const restores = await restoreConfigRevisions()
    expect(restores).toHaveLength(1)
    expect(restores[0].restored_from_id).toBe(rev)
  })

  // ── L9 ────────────────────────────────────────────────────────────────────────────────────────────────────
  // NOTE the design-lock's §4 table shorthand says 422 for a bad confirm; §2.4's normative text says "mirror
  // uncreate/undelete", and BOTH of those (plus permission-revert) answer 400 CONFIRM_REQUIRED on this very
  // endpoint. Same-endpoint consistency wins; see the PR body. What the golden truly locks is: refused, 0 writes.
  test('L9 missing / wrong typed confirm -> refused with CONFIRM_REQUIRED, DB untouched', async () => {
    bothFlagsOn()
    const rev = await seedCurrencyFixture()
    const p = await preview(rev)
    const before = await cellValues()
    for (const confirm of [null, '', 'uncreate', 'revert-retype', 'REVERT-RETYPE-LOSSY']) {
      const x = await execute(rev, p.body.data.previewToken, confirm)
      expect(x.status).toBe(400)
      expect(x.body?.error?.code).toBe('CONFIRM_REQUIRED')
    }
    expect(await cellValues()).toEqual(before)
    expect(await fieldProperty()).toEqual({ precision: 0 })
    expect(await restoreConfigRevisions()).toEqual([])
    expect(await recordRevisions()).toEqual([])
  })

  test('L9b a preview token minted for a DIFFERENT field cannot drive this execute (401), DB untouched', async () => {
    bothFlagsOn()
    const rev = await seedCurrencyFixture()
    const x = await execute(rev, 'not-a-server-minted-token')
    expect(x.status).toBe(401)
    expect(x.body?.error?.code).toBe('PREVIEW_IDENTITY_INVALID')
    expect(await restoreConfigRevisions()).toEqual([])
  })

  // ── L11 (4c-2 pre-image linkage) ──────────────────────────────────────────────────────────────────────────
  test('L11a capture flag ON -> one lossy_retype tombstone per coerced/dropped cell, anchored to THIS revert\'s revision', async () => {
    bothFlagsOn()
    process.env[CAPTURE_FLAG] = 'true'
    const rev = await seedCurrencyFixture()
    const p = await preview(rev)
    const x = await execute(rev, p.body.data.previewToken)
    expect(x.status).toBe(200)

    const rows = await tombstones()
    expect(rows.map((r) => r.record_id)).toEqual([rid(2), rid(3), rid(4)]) // only the cells that lost something
    expect(rows.every((r) => r.reason === 'lossy_retype')).toBe(true)
    // the PRE-image (the true value), not the coerced result — this is what a revert-of-revert recovers
    expect(rows.find((r) => r.record_id === rid(2))?.value).toBe('12.5')
    expect(rows.find((r) => r.record_id === rid(3))?.value).toBe('abc')
    expect(rows.find((r) => r.record_id === rid(4))?.value).toBe('')
    // the anchor is THIS lossy revert's OWN config revision ("回指触发行"), not the reverted-from revision
    const restores = await restoreConfigRevisions()
    expect(restores).toHaveLength(1)
    expect(new Set(rows.map((r) => r.config_revision_id))).toEqual(new Set([restores[0].id]))
    expect(rows.every((r) => r.config_revision_id !== rev)).toBe(true)
  })

  // ── P1-1 TYPE-ERA GUARD (adversarial-review finding: a real, end-to-end data-destruction path) ─────────────
  // Built ENTIRELY through the normal forward pipeline (POST /fields, PATCH /fields) — no hand-crafted revision.
  // The exploit: `changed_keys` for a property-only revert is ['property'], and BOTH drift controls key off
  // `changed_keys` (driftConflict compares current vs `after`; baselineHash hashes only those keys). A `type`
  // change in between is therefore invisible to them. It is REACHABLE because sanitizeFieldProperty is the
  // identity for url/email/phone/barcode/qrcode/location, so a `string -> url` type-only PATCH preserves
  // `property` byte-for-byte and the stale `string`-era property revision does not drift. Reverting it would
  // coerce every cell under the NEW type = a forward `text -> url` value migration smuggled in through the
  // revert door, which lock §7 puts explicitly out of bounds.
  const eraQ = {
    type: async (): Promise<string> => ((await q('SELECT type FROM meta_fields WHERE id=$1', [ERA_FIELD])).rows[0] as { type: string }).type,
    property: async (): Promise<unknown> => ((await q('SELECT property FROM meta_fields WHERE id=$1', [ERA_FIELD])).rows[0] as { property: unknown }).property,
    cells: async (): Promise<Record<string, unknown>> => Object.fromEntries(((await q('SELECT id, data->$2 AS v FROM meta_records WHERE sheet_id=$1 ORDER BY id', [SHEET, ERA_FIELD])).rows as Array<{ id: string; v: unknown }>).map((r) => [r.id, r.v])),
  }
  /** Drives the REAL forward routes so the revision chain is exactly what production would record. */
  const seedTypeEraExploit = async (): Promise<{ propertyRevisionId: string; typeRevisionKeys: string[] }> => {
    actor = FULL
    await request(app).post('/api/multitable/fields').send({ id: ERA_FIELD, sheetId: SHEET, name: 'EraF', type: 'string', property: {} }).expect(201)
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [rid(11), SHEET, JSON.stringify({ [ERA_FIELD]: 'hello world' })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [rid(12), SHEET, JSON.stringify({ [ERA_FIELD]: 'https://ok.example' })])
    // (1) a plain property edit while the field is still `string` -> revision with changed_keys = ['property']
    await request(app).patch(`/api/multitable/fields/${ERA_FIELD}`).send({ property: { note: 'a' } }).expect(200)
    // (2) a type-only PATCH -> `url`. The url sanitizer is the identity, so `property` survives byte-for-byte
    //     and this revision's changed_keys is ['type'] ALONE.
    await request(app).patch(`/api/multitable/fields/${ERA_FIELD}`).send({ type: 'url' }).expect(200)
    const revs = (await q(`SELECT id, changed_keys FROM meta_config_revisions WHERE sheet_id=$1 AND entity_id=$2 AND action='update' ORDER BY created_at ASC, id ASC`, [SHEET, ERA_FIELD])).rows as Array<{ id: string; changed_keys: string[] }>
    const propertyRev = revs.find((r) => r.changed_keys.length === 1 && r.changed_keys[0] === 'property')
    const typeRev = revs.find((r) => r.changed_keys.includes('type'))
    if (!propertyRev || !typeRev) throw new Error(`fixture did not produce the expected revisions: ${JSON.stringify(revs)}`)
    return { propertyRevisionId: propertyRev.id, typeRevisionKeys: typeRev.changed_keys }
  }

  test('P1-1 a property revert from an EARLIER type era -> 422 on preview AND execute, DB untouched', async () => {
    bothFlagsOn()
    process.env[CAPTURE_FLAG] = 'true'
    const { propertyRevisionId, typeRevisionKeys } = await seedTypeEraExploit()

    // the exploit's premise, asserted: the type change is invisible to `changed_keys`-based drift control
    expect(typeRevisionKeys).toEqual(['type'])
    expect(await eraQ.type()).toBe('url')
    expect(await eraQ.property()).toEqual({ note: 'a' }) // preserved byte-for-byte across the type PATCH

    const beforeCells = await eraQ.cells()
    expect(beforeCells).toEqual({ [rid(11)]: 'hello world', [rid(12)]: 'https://ok.example' })

    const p = await preview(propertyRevisionId)
    expect(p.status).toBe(422)
    expect(p.body?.error?.code).toBe('FIELD_TYPE_ERA_MISMATCH')
    expectNoLeak(p.body)
    const x = await execute(propertyRevisionId, 'tok')
    expect(x.status).toBe(422)
    expect(x.body?.error?.code).toBe('FIELD_TYPE_ERA_MISMATCH')
    expectNoLeak(x.body)

    // zero destruction: 'hello world' (an invalid url) is NOT dropped, and nothing else moved
    expect(await eraQ.cells()).toEqual(beforeCells)
    expect(await eraQ.type()).toBe('url')
    expect(await eraQ.property()).toEqual({ note: 'a' })
    expect(await restoreConfigRevisions()).toEqual([])
    expect(await recordRevisions()).toEqual([])
    expect(await tombstones()).toEqual([])
  })

  test('P1-1b a SAME-era property revert is unaffected by the guard (the guard refuses eras, not property reverts)', async () => {
    bothFlagsOn()
    actor = FULL
    await request(app).post('/api/multitable/fields').send({ id: ERA_FIELD, sheetId: SHEET, name: 'EraF', type: 'url', property: {} }).expect(201)
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [rid(11), SHEET, JSON.stringify({ [ERA_FIELD]: 'https://ok.example' })])
    await request(app).patch(`/api/multitable/fields/${ERA_FIELD}`).send({ property: { note: 'a' } }).expect(200)
    const propertyRev = ((await q(`SELECT id FROM meta_config_revisions WHERE sheet_id=$1 AND entity_id=$2 AND changed_keys = ARRAY['property']::text[] LIMIT 1`, [SHEET, ERA_FIELD])).rows[0] as { id: string }).id
    const p = await preview(propertyRev)
    expect(p.status).toBe(200)
    expect(p.body?.data?.lossSummary).toEqual({ unchanged: 1, coerced: 0, dropped: 0 })
  })

  test('P1-1c the property written is the sanitizer-normalized one the preview DISCLOSED (no silent downgrade)', async () => {
    bothFlagsOn()
    // A hand-crafted revision whose `before.property` carries a MALFORMED cross-cutting rule. `applyConfigRevert`
    // writes `before[k]` raw, so without the derived-revision normalization the field would end up holding it.
    await seedField('url', { note: 'a' }, [[1, 'https://ok.example']])
    const rev = await craftPropertyRev({ visibilityRule: { bogus: 1 } }, { note: 'a' })
    const p = await preview(rev)
    expect(p.status).toBe(200)
    const disclosedTarget = p.body?.data?.preview?.target?.property
    expect(disclosedTarget).toEqual({}) // the malformed rule is stripped, and the actor SEES the stripped target
    const x = await execute(rev, p.body.data.previewToken)
    expect(x.status).toBe(200)
    expect(await fieldProperty()).toEqual(disclosedTarget) // written === disclosed
  })

  test('P1-1d TOCTOU: a type change AFTER a passing preview is caught by the EXECUTE-side guard, with a REAL token', async () => {
    // Fixing the review's NIT-1 (P1-1 used a fake 'tok' so it only exercised the preview guard) and P3-B (the
    // execute guard's IN-LOCK position was untested). Here the preview passes and mints a genuine token BEFORE
    // any type change exists; the type-only PATCH lands in the window between preview and execute. Only the
    // execute-side re-check (inside the FOR UPDATE txn) can catch this — the preview guard already passed, and it
    // surfaces as FIELD_TYPE_ERA_MISMATCH rather than PLAN_DRIFT precisely because the era guard runs BEFORE the
    // lossSummary recompute, i.e. it is the first line of defence for this whole class, not a drift side-effect.
    // (Mutation-confirmed: neuter the execute-side guard and this returns 409 PLAN_DRIFT here — the lossHash
    // recompute is a genuine second line for the *drifting* case. The reviewer separately proved the era guard is
    // the SOLE defence for the count-conserving email<->url case, where lossHash is blind — see
    // /tmp/pr3922-4c1-fix-review-claude-20260708.md MB. This golden pins the guard's existence + ordering.)
    bothFlagsOn()
    process.env[CAPTURE_FLAG] = 'true'
    actor = FULL
    await request(app).post('/api/multitable/fields').send({ id: ERA_FIELD, sheetId: SHEET, name: 'EraF', type: 'string', property: {} }).expect(201)
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [rid(11), SHEET, JSON.stringify({ [ERA_FIELD]: 'hello world' })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [rid(12), SHEET, JSON.stringify({ [ERA_FIELD]: 'https://ok.example' })])
    // A plain property edit while the field is still `string` -> the revision we will try to revert.
    await request(app).patch(`/api/multitable/fields/${ERA_FIELD}`).send({ property: { note: 'a' } }).expect(200)
    const propertyRev = ((await q(`SELECT id FROM meta_config_revisions WHERE sheet_id=$1 AND entity_id=$2 AND changed_keys = ARRAY['property']::text[] ORDER BY created_at DESC, id DESC LIMIT 1`, [SHEET, ERA_FIELD])).rows[0] as { id: string }).id

    // (1) preview passes NOW (field is still `string`, no later type change) and mints a genuine token.
    const p = await preview(propertyRev)
    expect(p.status).toBe(200)
    const realToken = p.body?.data?.previewToken as string
    expect(typeof realToken).toBe('string')
    const beforeCells = await eraQ.cells()

    // (2) TOCTOU: a type-only PATCH -> `url` lands in the window. The url sanitizer is the identity, so `property`
    //     survives byte-for-byte and this type revision is invisible to the changed_keys-based drift controls.
    await request(app).patch(`/api/multitable/fields/${ERA_FIELD}`).send({ type: 'url' }).expect(200)

    // (3) execute with the REAL token -> the execute-side era guard refuses, and nothing is coerced under `url`.
    const x = await execute(propertyRev, realToken)
    expect(x.status).toBe(422)
    expect(x.body?.error?.code).toBe('FIELD_TYPE_ERA_MISMATCH')
    expectNoLeak(x.body)
    expect(await eraQ.cells()).toEqual(beforeCells) // 'hello world' NOT dropped
    expect(await eraQ.type()).toBe('url')
    expect(await eraQ.property()).toEqual({ note: 'a' })
    expect(await restoreConfigRevisions()).toEqual([])
    expect(await recordRevisions()).toEqual([])
    expect(await tombstones()).toEqual([])
  })

  // ── P2-1 route-level Batch-1 type gate (was behaviourally correct but had ZERO wire coverage) ──────────────
  test('P2-1 a property revert on a NON-Batch-1 field (select) stays gated: no lossSummary + execute 422', async () => {
    bothFlagsOn()
    // `select`'s lossiness (an option removal) is invisible to coerceBatch1Value, which is the identity for it —
    // admitting it would preview "zero loss" and then leave orphaned values. Fail-closed: it must stay 422.
    await seedField('select', { options: [{ value: 'a' }, { value: 'b' }] }, [[1, 'b']])
    const rev = await craftPropertyRev({ options: [{ value: 'a' }] }, { options: [{ value: 'a' }, { value: 'b' }] })
    const before = await cellValues()
    const p = await preview(rev)
    expect(p.status).toBe(200)
    expect(p.body?.data?.preview?.opKind).toBe('gated')
    expect(p.body?.data).not.toHaveProperty('lossSummary')
    expect(p.body?.data).not.toHaveProperty('lossNote')
    const x = await execute(rev, p.body.data.previewToken)
    expect(x.status).toBe(422)
    expect(x.body?.error?.code).toBe('RESTORE_NOT_SUPPORTED')
    expect(await cellValues()).toEqual(before)
    expect(await fieldProperty()).toEqual({ options: [{ value: 'a' }, { value: 'b' }] })
    expect(await restoreConfigRevisions()).toEqual([])
    expect(await recordRevisions()).toEqual([])
  })

  test('L11b capture flag OFF -> zero tombstones captured, and the revert still succeeds', async () => {
    bothFlagsOn()
    const rev = await seedCurrencyFixture()
    const p = await preview(rev)
    const x = await execute(rev, p.body.data.previewToken)
    expect(x.status).toBe(200)
    expect(await tombstones()).toEqual([])
    expect(await fieldProperty()).toEqual({ precision: 2 })
  })

  test('L11c capture flag ON but over the tombstone cap -> the REVERT ITSELF is refused (422), DB untouched', async () => {
    bothFlagsOn()
    process.env[CAPTURE_FLAG] = 'true'
    process.env.MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS = '1' // 3 cells would be captured
    try {
      const rev = await seedCurrencyFixture()
      const p = await preview(rev)
      const before = await cellValues()
      const x = await execute(rev, p.body.data.previewToken)
      expect(x.status).toBe(422)
      expect(x.body?.error?.code).toBe('TOMBSTONE_CAPTURE_CAP_EXCEEDED')
      expect(await cellValues()).toEqual(before)
      expect(await fieldProperty()).toEqual({ precision: 0 })
      expect(await tombstones()).toEqual([])
      expect(await restoreConfigRevisions()).toEqual([])
    } finally {
      delete process.env.MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS
    }
  })
})
