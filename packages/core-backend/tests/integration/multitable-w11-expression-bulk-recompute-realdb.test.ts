/**
 * W1-1 formula freshness — LOCK-B golden matrix (design-lock 2026-07-05, `26af7a560` / #3646),
 * §3 "expression-change bulk recompute". Real-DB.
 *
 * Headline fix: `PATCH /fields/:fieldId` with a `property.expression` change on a formula field
 * previously recomputed NOTHING — every existing record kept the OLD expression's materialized
 * value until its own next write. B1-B6 add a SYNCHRONOUS, pre-commit-COUNT-gated, fail-closed
 * bulk recompute: B1 trigger = the request explicitly carries `property.expression` (fires on
 * both an actual change AND a same-expression re-save); B2 bounds it (env cap, default 1000,
 * over-cap -> 422 + config NOT saved); B3 executes it chunked (200/page) AFTER the config commits,
 * under the editing actor's OWN req (B4, taint skip applies verbatim); B5 write posture = derived
 * raw UPDATE (no version bump, no meta_record_revisions row); B6 = coarse failure reporting +
 * idempotent re-save recovery.
 *
 * Golden coverage (§4 of the lock):
 *  - GF5 (<= cap): ALL live records reflect the new expression; response counts match.
 *  - GF6 (> cap): 422 FORMULA_EXPRESSION_BULK_OVER_CAP; config UNCHANGED; zero rows touched.
 *  - GF7: bulk recompute where the editor is masked on the formula's foreign dependency ->
 *    skipped (taintSkipped == attempted, recomputed == 0), old values preserved; an unmasked
 *    editor's identical PATCH recomputes fully.
 *  - GF8: an injected mid-chunk failure aborts the remaining chunk (failed:true, coarse error)
 *    while whatever already persisted stands; a same-expression re-save (the B1 no-op-resave
 *    trigger) re-runs the recompute and converges to full freshness.
 *  - GF12: a same-expression re-save fires the bulk recompute but records ZERO new
 *    meta_config_revisions rows (the config-revision recorder is diff-first; recompute-trigger
 *    and config-audit-trigger are deliberately decoupled).
 *  - GF11 (bulk part): folded into GF5/GF8 — zero meta_record_revisions rows / no version bump
 *    from the bulk recompute.
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI per the suite convention).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const TS = Date.now()
const BASE_ID = `base_w11bulk_${TS}`

// Sheet ids (meta_sheets.id — no naming constraint).
const SHEET_GF5 = `sheet_w11bulk_gf5_${TS}`
const SHEET_GF6 = `sheet_w11bulk_gf6_${TS}`
const SHEET_GF7 = `sheet_w11bulk_gf7_${TS}`
const SHEET_GF8 = `sheet_w11bulk_gf8_${TS}`
const SHEET_GF12 = `sheet_w11bulk_gf12_${TS}`
const SHEET_FOREIGN = `sheet_w11bulk_foreign_${TS}`

// Field ids — MUST start with `fld_` (multitableFormulaEngine's FIELD_REF_PATTERN only matches
// `{fld_...}` inside an expression; a differently-prefixed id silently fails to resolve as a ref).
const FLD_SHARED_STATUS = `fld_w11bulk_status_${TS}` // on SHEET_FOREIGN, masked for MASKED actor

const FLD_GF5_NAME = `fld_w11bulk_gf5_name_${TS}`
const FLD_GF5_OTHER = `fld_w11bulk_gf5_other_${TS}`
const FLD_GF5_FORMULA = `fld_w11bulk_gf5_formula_${TS}`

const FLD_GF6_NAME = `fld_w11bulk_gf6_name_${TS}`
const FLD_GF6_FORMULA = `fld_w11bulk_gf6_formula_${TS}`

const FLD_GF7_LINK = `fld_w11bulk_gf7_link_${TS}`
const FLD_GF7_FORMULA = `fld_w11bulk_gf7_formula_${TS}`

const FLD_GF8_LINK = `fld_w11bulk_gf8_link_${TS}`
const FLD_GF8_FORMULA = `fld_w11bulk_gf8_formula_${TS}`

const FLD_GF12_NAME = `fld_w11bulk_gf12_name_${TS}`
const FLD_GF12_FORMULA = `fld_w11bulk_gf12_formula_${TS}`

const WRITER = `u_w11bulk_writer_${TS}` // canManageFields, reads everything
const MASKED = `u_w11bulk_masked_${TS}` // canManageFields, denied FLD_SHARED_STATUS

const REC_FOREIGN = `rec_w11bulk_foreign_${TS}` // on SHEET_FOREIGN, status='paid'
const REC_GF5 = [`rec_w11bulk_gf5_1_${TS}`, `rec_w11bulk_gf5_2_${TS}`, `rec_w11bulk_gf5_3_${TS}`]
const REC_GF6 = [`rec_w11bulk_gf6_1_${TS}`, `rec_w11bulk_gf6_2_${TS}`, `rec_w11bulk_gf6_3_${TS}`]
const REC_GF7 = [`rec_w11bulk_gf7_1_${TS}`, `rec_w11bulk_gf7_2_${TS}`]
// Alphabetically ordered (a/b/c) so the route's `ORDER BY id ASC` gives a deterministic
// processing order: rec_a is attempted (and persisted) BEFORE the poisoned rec_b.
const REC_GF8_A = `rec_w11bulk_gf8_a_${TS}`
const REC_GF8_B = `rec_w11bulk_gf8_b_${TS}`
const REC_GF8_C = `rec_w11bulk_gf8_c_${TS}`
const REC_GF12 = [`rec_w11bulk_gf12_1_${TS}`, `rec_w11bulk_gf12_2_${TS}`]

function buildApp(userId: string): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as any).user = { id: userId, roles: ['member'], perms: ['multitable:write'], permissions: ['multitable:write'] }
    next()
  })
  a.use('/api/multitable', univerMetaRouter())
  return a
}
const patchField = (userId: string, fieldId: string, body: Record<string, unknown>) =>
  request(buildApp(userId)).patch(`/api/multitable/fields/${fieldId}`).send(body)

async function readFormulaField(recordId: string, fieldId: string): Promise<unknown> {
  const r = await q('SELECT data FROM meta_records WHERE id = $1', [recordId])
  const data = (r.rows[0] as { data: unknown } | undefined)?.data
  const parsed = typeof data === 'string' ? JSON.parse(data) : data
  return (parsed as Record<string, unknown> | undefined)?.[fieldId]
}
async function fieldExpression(fieldId: string): Promise<string | null> {
  const r = await q('SELECT property FROM meta_fields WHERE id = $1', [fieldId])
  const prop = (r.rows[0] as { property: unknown } | undefined)?.property
  const parsed = typeof prop === 'string' ? JSON.parse(prop) : prop
  return (parsed as { expression?: string } | undefined)?.expression ?? null
}
async function configRevisionCount(sheetId: string, fieldId: string): Promise<number> {
  const r = await q(
    'SELECT COUNT(*)::int AS n FROM meta_config_revisions WHERE sheet_id = $1 AND entity_id = $2',
    [sheetId, fieldId],
  )
  return Number((r.rows[0] as { n: number }).n)
}
async function recordRevisionCount(recordId: string): Promise<number> {
  const r = await q('SELECT COUNT(*)::int AS n FROM meta_record_revisions WHERE record_id = $1', [recordId])
  return Number((r.rows[0] as { n: number }).n)
}
async function recordVersion(recordId: string): Promise<number> {
  const r = await q('SELECT version FROM meta_records WHERE id = $1', [recordId])
  return Number((r.rows[0] as { version: number }).version)
}

const relCountExpr = (linkFieldId: string) => `RELCOUNTIF("${linkFieldId}","${FLD_SHARED_STATUS}","is","paid")`

describeIfDatabase('W1-1 LOCK-B golden matrix — expression-change bulk recompute (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'W1-1 Bulk Base'])
    for (const sheetId of [SHEET_GF5, SHEET_GF6, SHEET_GF7, SHEET_GF8, SHEET_GF12, SHEET_FOREIGN]) {
      await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [sheetId, BASE_ID, sheetId])
    }
    for (const id of [WRITER, MASKED]) {
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1,$2,$1,'x','member',$3::jsonb, TRUE, FALSE) ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
        [id, `${id}@t.local`, JSON.stringify(['multitable:read', 'multitable:write'])],
      )
    }

    // Shared foreign sheet (relation-agg target for GF7/GF8) — one status field, masked for MASKED.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SHARED_STATUS, SHEET_FOREIGN, 'Status', 'string', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_FOREIGN, SHEET_FOREIGN, JSON.stringify({ [FLD_SHARED_STATUS]: 'paid' })])
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_FOREIGN, FLD_SHARED_STATUS, 'user', MASKED, false, false])

    // ---- GF5 sheet: 3 records, pure formula (=NAME), PATCH to a different pure expression ----
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_GF5_NAME, SHEET_GF5, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_GF5_OTHER, SHEET_GF5, 'Other', 'string', '{}', 2])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_GF5_FORMULA, SHEET_GF5, 'Formula', 'formula', JSON.stringify({ expression: `={${FLD_GF5_NAME}}` }), 3],
    )
    for (const [i, rid] of REC_GF5.entries()) {
      await q(
        'INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
        [rid, SHEET_GF5, JSON.stringify({ [FLD_GF5_NAME]: `name${i}`, [FLD_GF5_OTHER]: `other${i}`, [FLD_GF5_FORMULA]: `name${i}` })],
      )
    }

    // ---- GF6 sheet: 3 records, cap will be set to 2 for the test ----
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_GF6_NAME, SHEET_GF6, 'Name', 'string', '{}', 1])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_GF6_FORMULA, SHEET_GF6, 'Formula', 'formula', JSON.stringify({ expression: `={${FLD_GF6_NAME}}` }), 2],
    )
    for (const [i, rid] of REC_GF6.entries()) {
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [rid, SHEET_GF6, JSON.stringify({ [FLD_GF6_NAME]: `name${i}` })])
    }

    // ---- GF7 sheet: relation-agg formula reaching SHEET_FOREIGN's masked status field ----
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_GF7_LINK, SHEET_GF7, 'Link', 'link', JSON.stringify({ foreignSheetId: SHEET_FOREIGN }), 1])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_GF7_FORMULA, SHEET_GF7, 'Formula', 'formula', JSON.stringify({ expression: relCountExpr(FLD_GF7_LINK) }), 2],
    )
    for (const rid of REC_GF7) {
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [rid, SHEET_GF7, JSON.stringify({ [FLD_GF7_LINK]: [REC_FOREIGN], [FLD_GF7_FORMULA]: 1 })])
      await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_${rid}`, FLD_GF7_LINK, rid, REC_FOREIGN])
    }

    // ---- GF8 sheet: relation-agg formula (per-record UPDATE unwrapped -> a per-record query
    // failure propagates), 3 records rec_a/rec_b/rec_c (alphabetical -> deterministic iteration
    // order per the route's `ORDER BY id ASC`).
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_GF8_LINK, SHEET_GF8, 'Link', 'link', JSON.stringify({ foreignSheetId: SHEET_FOREIGN }), 1])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_GF8_FORMULA, SHEET_GF8, 'Formula', 'formula', JSON.stringify({ expression: relCountExpr(FLD_GF8_LINK) }), 2],
    )
    for (const rid of [REC_GF8_A, REC_GF8_B, REC_GF8_C]) {
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [rid, SHEET_GF8, JSON.stringify({ [FLD_GF8_LINK]: [REC_FOREIGN], [FLD_GF8_FORMULA]: 0 })])
      await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_${rid}`, FLD_GF8_LINK, rid, REC_FOREIGN])
    }

    // ---- GF12 sheet: pure formula, 2 records, re-save decoupling ----
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_GF12_NAME, SHEET_GF12, 'Name', 'string', '{}', 1])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_GF12_FORMULA, SHEET_GF12, 'Formula', 'formula', JSON.stringify({ expression: `={${FLD_GF12_NAME}}` }), 2],
    )
    for (const [i, rid] of REC_GF12.entries()) {
      // seed the formula field STALE (as if the expression changed earlier and this record never
      // got a subsequent write) so the re-save's recompute has something visible to refresh.
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [rid, SHEET_GF12, JSON.stringify({ [FLD_GF12_NAME]: `n${i}`, [FLD_GF12_FORMULA]: 'stale' })])
    }
  })

  afterEach(() => {
    delete process.env.MULTITABLE_FORMULA_BULK_RECOMPUTE_MAX_ROWS
  })

  afterAll(async () => {
    const allSheets = [SHEET_GF5, SHEET_GF6, SHEET_GF7, SHEET_GF8, SHEET_GF12, SHEET_FOREIGN]
    await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[FLD_GF7_LINK, FLD_GF8_LINK]]).catch(() => {})
    await q('DELETE FROM formula_dependencies WHERE sheet_id = ANY($1::text[])', [allSheets]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_FOREIGN]).catch(() => {})
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = ANY($1::text[])', [allSheets]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = ANY($1::text[])', [allSheets]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [allSheets]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [allSheets]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [allSheets]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[WRITER, MASKED]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set (real DB run, not skipped)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('GF5 (<= cap): ALL live records reflect the new expression; response counts match; zero meta_record_revisions/version-bump (GF11 bulk part)', async () => {
    const versionsBefore = await Promise.all(REC_GF5.map(recordVersion))
    const res = await patchField(WRITER, FLD_GF5_FORMULA, { property: { expression: `={${FLD_GF5_OTHER}}` } })
    expect(res.status).toBe(200)
    expect(res.body?.data?.bulkRecompute).toMatchObject({ attempted: 3, recomputed: 3, taintSkipped: 0, failed: false })

    for (const [i, rid] of REC_GF5.entries()) {
      expect(await readFormulaField(rid, FLD_GF5_FORMULA)).toBe(`other${i}`)
      expect(await recordRevisionCount(rid)).toBe(0)
    }
    const versionsAfter = await Promise.all(REC_GF5.map(recordVersion))
    expect(versionsAfter).toEqual(versionsBefore) // B5: derived materialization, no version bump
  })

  test('GF6 (> cap): 422 FORMULA_EXPRESSION_BULK_OVER_CAP; config UNCHANGED; zero rows touched', async () => {
    process.env.MULTITABLE_FORMULA_BULK_RECOMPUTE_MAX_ROWS = '2' // sheet has 3 live records
    const before = await fieldExpression(FLD_GF6_FORMULA)
    const res = await patchField(WRITER, FLD_GF6_FORMULA, { property: { expression: `=999` } })
    expect(res.status).toBe(422)
    expect(res.body?.error?.code).toBe('FORMULA_EXPRESSION_BULK_OVER_CAP')
    expect(res.body?.error?.total).toBe(3)
    expect(res.body?.error?.max).toBe(2)
    // Config NOT saved — re-read proves the OLD expression, not the rejected one.
    expect(await fieldExpression(FLD_GF6_FORMULA)).toBe(before)
    expect(before).not.toBe('999')
    // Zero rows touched.
    for (const rid of REC_GF6) {
      expect(await recordRevisionCount(rid)).toBe(0)
    }
  })

  test('GF7: masked editor -> recompute SKIPPED (taintSkipped == attempted, recomputed == 0), old values preserved; unmasked editor -> recomputes fully', async () => {
    // MASKED cannot read SHEET_FOREIGN's status field (the RELCOUNTIF criteria) -> the bulk
    // recompute must taint-skip the WHOLE field for every record, leaving the seeded value (1)
    // untouched.
    const resMasked = await patchField(MASKED, FLD_GF7_FORMULA, { property: { expression: relCountExpr(FLD_GF7_LINK) } })
    expect(resMasked.status).toBe(200)
    expect(resMasked.body?.data?.bulkRecompute).toMatchObject({ attempted: 2, recomputed: 0, taintSkipped: 2, failed: false })
    for (const rid of REC_GF7) {
      expect(await readFormulaField(rid, FLD_GF7_FORMULA)).toBe(1) // unchanged (seeded value)
    }

    // WRITER can read everything -> the SAME expression (re-save) now fully recomputes.
    const resWriter = await patchField(WRITER, FLD_GF7_FORMULA, { property: { expression: relCountExpr(FLD_GF7_LINK) } })
    expect(resWriter.status).toBe(200)
    expect(resWriter.body?.data?.bulkRecompute).toMatchObject({ attempted: 2, recomputed: 2, taintSkipped: 0, failed: false })
    for (const rid of REC_GF7) {
      expect(await readFormulaField(rid, FLD_GF7_FORMULA)).toBe(1) // RELCOUNTIF(link, status='paid') -> 1 match
    }
  })

  test('GF8: injected mid-chunk failure aborts remaining work (config stands, failed:true) — a same-expression re-save converges to full freshness', async () => {
    const pool = poolManager.get()
    const originalQuery = pool.query.bind(pool)
    // Per-record relation-agg read (`loadRecordDataById`) is UNWRAPPED inside
    // recalculateFormulaFields (unlike the pure-formula engine path, which swallows per-record
    // errors internally) — throwing here for ONE specific record simulates a genuine "unexpected
    // mid-chunk" infrastructure error.
    ;(pool as unknown as { query: typeof originalQuery }).query = ((sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT data FROM meta_records WHERE id = $1 AND sheet_id = $2') && Array.isArray(params) && params[0] === REC_GF8_B) {
        return Promise.reject(new Error('injected mid-chunk failure'))
      }
      return originalQuery(sql, params)
    }) as typeof originalQuery

    let res: request.Response
    try {
      res = await patchField(WRITER, FLD_GF8_FORMULA, { property: { expression: relCountExpr(FLD_GF8_LINK) } })
    } finally {
      ;(pool as unknown as { query: typeof originalQuery }).query = originalQuery
    }
    expect(res!.status).toBe(200) // the CONFIG patch itself succeeds — recompute failure never rolls it back
    expect(await fieldExpression(FLD_GF8_FORMULA)).toBe(relCountExpr(FLD_GF8_LINK))
    expect(res!.body?.data?.bulkRecompute?.failed).toBe(true)
    expect(typeof res!.body?.data?.bulkRecompute?.error).toBe('string')

    // rec_a (before the poison in ORDER BY id ASC) DID get recomputed and persisted; rec_b/rec_c
    // (poisoned / after) remain stale — "strictly no worse than today", not silently corrupted.
    expect(await readFormulaField(REC_GF8_A, FLD_GF8_FORMULA)).toBe(1)
    expect(await readFormulaField(REC_GF8_B, FLD_GF8_FORMULA)).toBe(0)
    expect(await readFormulaField(REC_GF8_C, FLD_GF8_FORMULA)).toBe(0)

    // Recovery: a same-expression re-save (B1 fires on expression-present, not expression-changed)
    // re-runs the recompute (no poison this time) and converges ALL records to full freshness.
    const revBefore = await configRevisionCount(SHEET_GF8, FLD_GF8_FORMULA)
    const resave = await patchField(WRITER, FLD_GF8_FORMULA, { property: { expression: relCountExpr(FLD_GF8_LINK) } })
    expect(resave.status).toBe(200)
    expect(resave.body?.data?.bulkRecompute).toMatchObject({ attempted: 3, recomputed: 3, taintSkipped: 0, failed: false })
    for (const rid of [REC_GF8_A, REC_GF8_B, REC_GF8_C]) {
      expect(await readFormulaField(rid, FLD_GF8_FORMULA)).toBe(1)
    }
    // The re-save is a config no-op (identical expression) -> no NEW meta_config_revisions row.
    expect(await configRevisionCount(SHEET_GF8, FLD_GF8_FORMULA)).toBe(revBefore)
  })

  test('GF12: a same-expression re-save fires the bulk recompute but records ZERO new meta_config_revisions rows (recompute-trigger and config-audit-trigger are decoupled)', async () => {
    const before = await Promise.all(REC_GF12.map((rid) => readFormulaField(rid, FLD_GF12_FORMULA)))
    expect(before).toEqual(['stale', 'stale'])
    const revBefore = await configRevisionCount(SHEET_GF12, FLD_GF12_FORMULA)

    // Re-save the SAME expression already stored (`={${FLD_GF12_NAME}}`).
    const res = await patchField(WRITER, FLD_GF12_FORMULA, { property: { expression: `={${FLD_GF12_NAME}}` } })
    expect(res.status).toBe(200)
    expect(res.body?.data?.bulkRecompute).toMatchObject({ attempted: 2, recomputed: 2, taintSkipped: 0, failed: false })

    // Recompute DID fire — the stale seeded values are now fresh.
    expect(await readFormulaField(REC_GF12[0], FLD_GF12_FORMULA)).toBe('n0')
    expect(await readFormulaField(REC_GF12[1], FLD_GF12_FORMULA)).toBe('n1')

    // But the config-audit trail is untouched — a no-op re-save records no new revision row.
    expect(await configRevisionCount(SHEET_GF12, FLD_GF12_FORMULA)).toBe(revBefore)
  })
})
