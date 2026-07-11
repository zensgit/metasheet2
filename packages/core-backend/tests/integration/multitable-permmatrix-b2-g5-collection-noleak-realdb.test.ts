/**
 * W1-2 permission matrix — B2 / G-5: row-level read-deny (M2) "zero presence" on the COLLECTION
 * surfaces the existing goldens don't yet cover (real DB).
 * Spec: docs/development/multitable-w1-2-permission-matrix-spec-20260705.md §3 G-5.
 *
 * G-5 in one line: a record the actor is row-level read-DENIED (per-sheet opt-in flag
 * `row_level_read_permissions_enabled` + a `record_permissions` 'none' scope — M2, `permission-service.ts`
 * `loadRowLevelReadDenyEnabled`/`loadDeniedRecordIds`) must leave ZERO existence footprint on every
 * collection/aggregate surface: absent from lists, not counted in aggregates/summaries, absent from
 * export, absent from history. This is a DIFFERENT contract from the single-record GET, which is
 * explicitly NOT touched here (see below).
 *
 * ── NOT re-tested here (already locked — see spec §1 + this investigation) ─────────────────────────
 *  - Single-record GET keeps its LOCKED contract: 403 + NO `data` key (univer-meta.ts `GET
 *    /records/:recordId`, `requireRecordReadable` → `sendForbidden`). Pinned by
 *    `multitable-rowlevel-readdeny-enforce.test.ts` ("flag ON: the none-scoped record is DENIED (403)").
 *    This file does NOT change or re-assert that contract, and does NOT introduce a 404/denied≡missing
 *    shape for it — that would be a read-path contract change, explicitly out of scope (spec §3 G-5).
 *  - GET /records (cursor list): flag ON already excludes the none-scoped record — pinned by
 *    `multitable-rowlevel-readdeny-enforce.test.ts` ("GET /records flag ON: the none-scoped record is
 *    EXCLUDED, the non-scoped one remains").
 *  - GET /records-summary (link-picker candidates): flag ON already excludes it — pinned by the same
 *    file ("/records-summary flag ON: the none-scoped record is EXCLUDED from the picker").
 *  - GET /sheets/:sheetId/view-aggregate: flag ON already excludes it from the total — pinned by the
 *    same file ("view-aggregate flag ON: the none-scoped record is EXCLUDED from the total").
 *  All three above are driven DIRECTLY off the M2 mechanism (record_permissions='none') this file also
 *  uses — genuinely redundant to re-assert, so this file does NOT duplicate them.
 *
 * ── NEW coverage in this file (the actual G-5 gap) ──────────────────────────────────────────────────
 *  1. EXPORT (GET /sheets/:sheetId/export-xlsx): the route DOES implement the M2 exclusion
 *     (`exportDeniedIds` via `loadRowLevelReadDenyEnabled` + `loadDeniedRecordIds`, univer-meta.ts
 *     ~12148-12420) in BOTH its code branches — the no-filter/no-sort cursor-pagination stream AND the
 *     view-filter/sort load-all path — but NO existing golden exercises the M2 flag against export
 *     (multitable-export-allrows-maskroute-realdb.test.ts covers field_permissions + view filter/sort
 *     only; multitable-export-permission-canary.test.ts's own header explicitly says record-scope was
 *     "NOT covered" at the time it was authored, pre-dating the #18 M2 feature). This is the primary new
 *     ground this file covers.
 *  2. HISTORY (GET /bases/:baseId/history/events[/:batchId]): `history-projection.ts` shares the SAME
 *     `loadDeniedRecordIds` consumer contract (LOCK-3), and `multitable-history-events-realdb.test.ts`
 *     already thoroughly locks that CONSUMER contract (batch invisible / total excludes it / detail
 *     404-parity / admin bypass / flag-off inert) — but drives it via the M4 conditional-rule-deny path
 *     (`conditional_read_rules`), never via a pure M2 `record_permissions`='none' grant-deny row. Since
 *     `loadDeniedRecordIds` computes grant-deny (M2) and rule-deny (M4) via two INDEPENDENT SQL branches
 *     unioned into one Set (permission-service.ts `loadDeniedRecordIds` (a) vs (b)), the M4-driven test
 *     does not exercise the M2 branch's SQL. This file adds a SMALL, non-duplicating M2-direct
 *     confirmatory pair (not the full LOCK-3 matrix — cursor/search/tie-break stay in the existing file)
 *     to close that specific loop.
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

const xlsx = (await import('xlsx')) as unknown as {
  read: (data: unknown, opts: { type: string }) => { SheetNames: string[]; Sheets: Record<string, unknown> }
  utils: { sheet_to_json: (ws: unknown, opts: { header: 1; raw: false; defval: string }) => string[][] }
}

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// PART A — EXPORT (GET /sheets/:sheetId/export-xlsx)
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describeIfDatabase('W1-2 B2 G-5 — export "zero presence" for a row-level read-denied record (real DB)', () => {
  const TS = Date.now()
  const BASE_ID = `base_b2exp_${TS}`
  const SHEET_ID = `sheet_b2exp_${TS}`
  const F_NAME = `fld_b2exp_name_${TS}`
  const F_AMOUNT = `fld_b2exp_amount_${TS}`
  const REC_DENIED = `rec_b2exp_denied_${TS}` // record_permissions 'none' scope for USER (M2)
  const REC_OK_A = `rec_b2exp_ok_a_${TS}`
  const REC_OK_B = `rec_b2exp_ok_b_${TS}`
  const USER_ID = `user_b2exp_${TS}`
  const VIEW_SORTED = `view_b2exp_sorted_${TS}` // exercises the OTHER runtime branch (view load-all path)

  let app: Express
  const setFlag = (on: boolean) => q('UPDATE meta_sheets SET row_level_read_permissions_enabled = $2 WHERE id = $1', [SHEET_ID, on])

  async function exportXlsxRows(query: Record<string, string> = {}): Promise<string[][]> {
    const res = await request(app)
      .get(`/api/multitable/sheets/${SHEET_ID}/export-xlsx`)
      .query(query)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = []
        r.on('data', (c) => chunks.push(Buffer.from(c)))
        r.on('end', () => cb(null, Buffer.concat(chunks)))
      })
    expect(res.status).toBe(200)
    const parsed = xlsx.read(res.body, { type: 'buffer' })
    return xlsx.utils.sheet_to_json(parsed.Sheets[parsed.SheetNames[0]], { header: 1, raw: false, defval: '' })
  }

  async function exportCsvRows(query: Record<string, string> = {}): Promise<string[][]> {
    const res = await request(app)
      .get(`/api/multitable/sheets/${SHEET_ID}/export-xlsx`)
      .query({ format: 'csv', ...query })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = []
        r.on('data', (c) => chunks.push(Buffer.from(c)))
        r.on('end', () => cb(null, Buffer.concat(chunks)))
      })
    expect(res.status).toBe(200)
    const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8').replace(/^﻿/, '') : ''
    return text.length === 0 ? [] : text.split('\r\n').map((line) => line.split(','))
  }

  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = { id: USER_ID, roles: [], perms: ['multitable:read'], permissions: ['multitable:read'] }
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [USER_ID])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'B2 Export Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'B2 Export Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_NAME, SHEET_ID, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_AMOUNT, SHEET_ID, 'Amount', 'number', '{}', 2])

    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_DENIED, SHEET_ID, JSON.stringify({ [F_NAME]: 'denied_secret_row', [F_AMOUNT]: 999 })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_OK_A, SHEET_ID, JSON.stringify({ [F_NAME]: 'row_a', [F_AMOUNT]: 1 })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_OK_B, SHEET_ID, JSON.stringify({ [F_NAME]: 'row_b', [F_AMOUNT]: 2 })])

    // Pure M2: a 'none' record_permissions scope for USER on REC_DENIED. No conditional_read_rules (M4)
    // involved anywhere in this describe block — this is the grant-deny branch specifically.
    await q('INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,$3,$4,$5)', [SHEET_ID, REC_DENIED, 'user', USER_ID, 'none'])

    // A saved view with a sort, to route export through the OTHER runtime branch (view load-all path,
    // where denied records are dropped via `all = all.filter(...)` BEFORE filter/sort/cap — not just the
    // no-view cursor-stream branch's per-page `continue`).
    await q(
      'INSERT INTO meta_views (id, sheet_id, name, type, filter_info, sort_info, hidden_field_ids) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)',
      [VIEW_SORTED, SHEET_ID, 'B2 Sorted', 'grid', 'null', JSON.stringify({ rules: [{ fieldId: F_AMOUNT, desc: true }] }), '[]'],
    )
  })

  afterAll(async () => {
    await q('DELETE FROM record_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [USER_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('control (non-vacuous baseline): flag OFF exports the denied row too (grant-additive default)', async () => {
    await setFlag(false)
    const rows = await exportXlsxRows()
    const names = new Set(rows.slice(1).map((r) => r[0]))
    expect(names.has('denied_secret_row')).toBe(true) // proves the row is genuinely exportable absent the flag
    expect(names.size).toBe(3)
  })

  test('no-view branch: flag ON excludes the M2-denied record — zero presence (no id, no leaked value, exact count)', async () => {
    await setFlag(true)
    const rows = await exportXlsxRows()
    const body = rows.slice(1)
    expect(body.length).toBe(2) // exactly the 2 non-denied rows — not 3
    const names = new Set(body.map((r) => r[0]))
    expect(names.has('row_a')).toBe(true)
    expect(names.has('row_b')).toBe(true)
    expect(names.has('denied_secret_row')).toBe(false) // absent, not just masked
    expect(rows.flat().some((c) => c.includes('999'))).toBe(false) // no leaked Amount value either
  })

  test('no-view branch (CSV format): the SAME M2 exclusion holds for the CSV re-serialization', async () => {
    await setFlag(true)
    const rows = await exportCsvRows()
    const body = rows.slice(1)
    expect(body.length).toBe(2)
    expect(body.some((r) => r[0] === 'denied_secret_row')).toBe(false)
  })

  test('view load-all branch (filter/sort present): flag ON STILL excludes the denied record, sort stays correct', async () => {
    await setFlag(true)
    const rows = await exportXlsxRows({ viewId: VIEW_SORTED })
    const body = rows.slice(1)
    expect(body.length).toBe(2) // denied row dropped BEFORE sort/cap in the load-all branch too
    const names = body.map((r) => r[0])
    expect(names).not.toContain('denied_secret_row')
    // Amount desc among the surviving rows: row_b(2) then row_a(1) — proves a real sort over the
    // ALREADY-filtered set, not an accidental pass.
    expect(names).toEqual(['row_b', 'row_a'])
  })

  test('admin bypass: flag ON, an admin actor still sees the denied record in export (M2 is non-admin only)', async () => {
    await setFlag(true)
    const adminApp = express()
    adminApp.use(express.json())
    adminApp.use((req, _res, next) => {
      ;(req as any).user = { id: USER_ID, roles: ['admin'], perms: ['multitable:read'], permissions: ['multitable:read'] }
      next()
    })
    adminApp.use('/api/multitable', univerMetaRouter())
    const res = await request(adminApp)
      .get(`/api/multitable/sheets/${SHEET_ID}/export-xlsx`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = []
        r.on('data', (c) => chunks.push(Buffer.from(c)))
        r.on('end', () => cb(null, Buffer.concat(chunks)))
      })
    expect(res.status).toBe(200)
    const parsed = xlsx.read(res.body, { type: 'buffer' })
    const rows = xlsx.utils.sheet_to_json(parsed.Sheets[parsed.SheetNames[0]], { header: 1, raw: false, defval: '' }) as string[][]
    const names = new Set(rows.slice(1).map((r) => r[0]))
    expect(names.has('denied_secret_row')).toBe(true) // admin bypasses the M2 deny
    expect(names.size).toBe(3)
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// PART B — HISTORY (GET /bases/:baseId/history/events[/:batchId]) — M2-direct supplementary check
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describeIfDatabase('W1-2 B2 G-5 — history "zero presence" for a row-level read-denied record, M2-direct (real DB)', () => {
  const TS = Date.now()
  const BASE_ID = `base_b2hist_${TS}`
  const SHEET_ID = `sheet_b2hist_${TS}`
  const STATUS = `fld_b2hist_status_${TS}`
  const REC_SECRET = `rec_b2hist_secret_${TS}` // record_permissions 'none' for USER (M2, not a conditional rule)
  const REC_PUBLIC = `rec_b2hist_public_${TS}`
  const BULK_BATCH = `batch_b2hist_bulk_${TS}` // one bulk action touching BOTH records (shared batch id)
  const SECRET_BATCH = `batch_b2hist_secret_${TS}` // a single-record action on the secret record only
  const USER_ID = `user_b2hist_${TS}`

  let app: Express
  let testRoles: string[] = []
  const setFlag = (on: boolean) => q('UPDATE meta_sheets SET row_level_read_permissions_enabled = $2 WHERE id = $1', [SHEET_ID, on])
  const events = (query: Record<string, unknown> = {}) =>
    request(app).get(`/api/multitable/bases/${BASE_ID}/history/events`).query({ limit: 100, ...query })
  const detail = (batchId: string) => request(app).get(`/api/multitable/bases/${BASE_ID}/history/events/${batchId}`)
  const batchIds = (res: { body?: { data?: { batches?: Array<{ batchId: string }> } } }) =>
    (res.body?.data?.batches ?? []).map((b) => b.batchId)
  const batchOf = (res: { body?: { data?: { batches?: Array<{ batchId: string }> } } }, id: string) =>
    (res.body?.data?.batches ?? []).find((b) => b.batchId === id) as { batchId: string; visibleAffectedRecordCount: number } | undefined

  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = { id: USER_ID, roles: testRoles, perms: ['multitable:read', 'multitable:write'] }
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'B2 History Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'B2 History Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [STATUS, SHEET_ID, 'Status', 'select', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_SECRET, SHEET_ID, JSON.stringify({ [STATUS]: 'secret' })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_PUBLIC, SHEET_ID, JSON.stringify({ [STATUS]: 'public' })])

    const rev = (rid: string, batchId: string, status: string) =>
      q(
        `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, patch, snapshot, batch_id)
         VALUES (gen_random_uuid(), $1, $2, 1, 'update', 'rest', $3, ARRAY[$4]::text[], '{}'::jsonb, $5::jsonb, $6)`,
        [SHEET_ID, rid, USER_ID, STATUS, JSON.stringify({ [STATUS]: status }), batchId],
      )
    await rev(REC_SECRET, BULK_BATCH, 'secret')
    await rev(REC_PUBLIC, BULK_BATCH, 'public')
    await rev(REC_SECRET, SECRET_BATCH, 'secret')

    // Pure M2: a 'none' record_permissions scope for USER on REC_SECRET. NO conditional_read_rules
    // anywhere in this describe block — the existing history LOCK-3 goldens
    // (multitable-history-events-realdb.test.ts) already drive the identical consumer contract via M4
    // (conditional_read_rules); this block closes the loop for the OTHER `loadDeniedRecordIds` branch.
    await q('INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,$3,$4,$5)', [SHEET_ID, REC_SECRET, 'user', USER_ID, 'none'])
  })

  afterAll(async () => {
    await q('DELETE FROM record_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [USER_ID]).catch(() => {})
  })

  beforeEach(async () => {
    testRoles = []
    await setFlag(false)
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('control (non-vacuous baseline): flag OFF, the M2-scoped batch is visible and counted', async () => {
    const res = await events()
    expect(res.status).toBe(200)
    expect(batchIds(res)).toContain(SECRET_BATCH)
    expect(res.body?.data?.total).toBe(2)
    expect(batchOf(res, BULK_BATCH)?.visibleAffectedRecordCount).toBe(2)
  })

  test('flag ON (M2-direct): the all-denied batch is invisible + uncounted; the mixed batch drops the denied record', async () => {
    await setFlag(true)
    const res = await events()
    expect(res.status).toBe(200)
    const ids = batchIds(res)
    expect(ids).not.toContain(SECRET_BATCH) // every record in this batch is M2-denied → batch invisible
    expect(ids).toContain(BULK_BATCH)
    expect(res.body?.data?.total).toBe(1) // post-filter total — the denied batch is NOT counted
    expect(batchOf(res, BULK_BATCH)?.visibleAffectedRecordCount).toBe(1) // secret record dropped from the mixed batch
  })

  test('flag ON (M2-direct): batch detail for the denied batch shares the SAME 404 shape as a missing batch', async () => {
    await setFlag(true)
    const denied = await detail(SECRET_BATCH)
    const missing = await detail(`batch_b2hist_missing_${TS}`)
    expect(denied.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(denied.body?.error?.code).toBe(missing.body?.error?.code) // no existence oracle
  })

  test('admin bypass: flag ON (M2-direct), an admin sees the denied batch and the full count', async () => {
    await setFlag(true)
    testRoles = ['admin']
    const res = await events()
    expect(res.status).toBe(200)
    expect(batchIds(res)).toContain(SECRET_BATCH)
    expect(batchOf(res, BULK_BATCH)?.visibleAffectedRecordCount).toBe(2)
    expect((await detail(SECRET_BATCH)).status).toBe(200)
  })
})
