/**
 * Rollup COUNTALL — non-gating characterization (real DB).
 *
 * Owner-mandated regression lock for the #20 contract decision (B′): record-level read is NON-GATING.
 * record_permissions in this codebase is a write/admin ELEVATION mechanism, not read-deny — so a
 * record_permission pointing at OTHER subjects must NOT change a sheet-readable actor's COUNTALL. This
 * test pins that behavior so a future change can't silently reintroduce record-level row filtering into
 * lookup/rollup (which a past review mistook for a "leak") without turning this red.
 *
 * It also pins the REAL gate that DOES apply: when the foreign TARGET FIELD is masked for the actor
 * (field_permissions), the rollup (incl. countall) returns null — no field-gate bypass.
 *
 * Trigger: GET /records/:recordId computes applyLookupRollup unconditionally for the single record and
 * returns the computed value at res.body.data.record.data[rollupFieldId].
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const ALLOW_USER = `u_ca_allow_${TS}` // sheet-read on both sheets; no field denial
const DENY_USER = `u_ca_deny_${TS}` // denied on the foreign target field (field-mask real gate)
const OTHER_USER = `u_ca_other_${TS}` // the unrelated subject a record_permission points at

const BASE = `base_ca_${TS}` // same base — keeps the cross-base base-read gate out of scope
const FS = `sheet_ca_fs_${TS}` // foreign sheet (linked-to)
const MS = `sheet_ca_main_${TS}` // source sheet (holds the link + rollups)

const FLD_TARGET = `fld_ca_tgt_${TS}` // foreign target value (number)
const FLD_LINK = `fld_ca_lk_${TS}`
const FLD_COUNTALL = `fld_ca_all_${TS}` // rollup aggregation=countall
const FLD_COUNT = `fld_ca_cnt_${TS}` // rollup aggregation=count (non-empty) — contrast vs countall

// 3 foreign records: two with a non-empty target, one with an EMPTY target → countall=3, count=2.
const FR1 = `rec_ca_f1_${TS}`
const FR2 = `rec_ca_f2_${TS}`
const FR3 = `rec_ca_f3_${TS}` // empty target
const REC = `rec_ca_src_${TS}` // the source record linking all three

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function buildApp(userId: string): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as any).user = {
      id: userId,
      roles: ['member'],
      perms: ['multitable:read'],
      permissions: ['multitable:read'],
    }
    next()
  })
  a.use('/api/multitable', univerMetaRouter())
  return a
}

async function readRollup(userId: string, fieldId: string): Promise<unknown> {
  const res = await request(buildApp(userId)).get(`/api/multitable/records/${REC}`)
  expect(res.status).toBe(200)
  return res.body?.data?.record?.data?.[fieldId]
}

describeIfDatabase('multitable rollup countall — record-read non-gating characterization (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE, 'CA Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [FS, BASE, 'CA Foreign'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [MS, BASE, 'CA Main'])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_TARGET, FS, 'Target', 'number', '{}', 1])

    // FR1/FR2 have a non-empty target; FR3 has an EMPTY target (no FLD_TARGET key).
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [FR1, FS, JSON.stringify({ [FLD_TARGET]: 10 })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [FR2, FS, JSON.stringify({ [FLD_TARGET]: 20 })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [FR3, FS, JSON.stringify({})])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LINK, MS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_COUNTALL, MS, 'CountAll', 'rollup',
        JSON.stringify({ linkFieldId: FLD_LINK, targetFieldId: FLD_TARGET, foreignSheetId: FS, aggregation: 'countall' }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_COUNT, MS, 'CountNonEmpty', 'rollup',
        JSON.stringify({ linkFieldId: FLD_LINK, targetFieldId: FLD_TARGET, foreignSheetId: FS, aggregation: 'count' }), 3])

    // Source record links all three foreign records (data + meta_links, mirroring the read path).
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC, MS, JSON.stringify({ [FLD_LINK]: [FR1, FR2, FR3] })])
    for (const fr of [FR1, FR2, FR3]) {
      await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)',
        [`lnk_ca_${fr}`, FLD_LINK, REC, fr])
    }

    // DENY_USER cannot read the foreign target field → the rollup must mask to null for them.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
      [FS, FLD_TARGET, 'user', DENY_USER, false, false])
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = ANY($1::text[])', [[FS, MS]]).catch(() => {})
    await q('DELETE FROM record_permissions WHERE sheet_id = ANY($1::text[])', [[FS, MS]]).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id = $1', [FLD_LINK]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('baseline: sheet-reader sees countall=3 (incl. empty-target row) and count=2 (non-empty only)', async () => {
    expect(await readRollup(ALLOW_USER, FLD_COUNTALL)).toBe(3)
    expect(await readRollup(ALLOW_USER, FLD_COUNT)).toBe(2)
  })

  test('CHARACTERIZATION: a record_permission on a linked row for ANOTHER subject does NOT change the sheet-reader\'s countall', async () => {
    // Grant OTHER_USER an explicit record permission on ONE linked foreign record. Under the non-gating
    // contract this must NOT remove that row from ALLOW_USER's rollup — record_permissions only ELEVATE
    // (write/admin) for the named subject; they never deny read to a sheet-reader.
    await q(
      'INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,$3,$4,$5)',
      [FS, FR1, 'user', OTHER_USER, 'read'],
    )
    expect(await readRollup(ALLOW_USER, FLD_COUNTALL)).toBe(3) // unchanged — non-gating
    expect(await readRollup(ALLOW_USER, FLD_COUNT)).toBe(2)

    // And the actor the grant points at also reads the full count (the grant is additive, not exclusive).
    expect(await readRollup(OTHER_USER, FLD_COUNTALL)).toBe(3)
  })

  test('REAL gate: a field-masked foreign target makes the rollup (incl. countall) null — no field-gate bypass', async () => {
    expect(await readRollup(DENY_USER, FLD_COUNTALL) ?? null).toBeNull()
    expect(await readRollup(DENY_USER, FLD_COUNT) ?? null).toBeNull()
  })
})
