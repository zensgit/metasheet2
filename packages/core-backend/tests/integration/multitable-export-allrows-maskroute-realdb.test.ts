/**
 * Export "all rows" via the mask-preserving backend route — full-sheet completeness + mask (real DB).
 *
 * The verified bug: the multitable export picker serialized the CLIENT-LOADED grid page (page size 50),
 * so "all rows" exported at most 50 rows. The fix rewires "all rows" to the backend route
 * (univer-meta.ts GET /sheets/:sheetId/export-xlsx), which cursor-paginates the WHOLE sheet and applies
 * the SAME field_permissions + view-hidden + §2a.3 formula-taint masking AFTER the `fieldIds` selection.
 *
 * THE keystone here (vs the existing mock-pool canary multitable-export-permission-canary.test.ts): a
 * REAL DB seeded with > the FE page size (120 rows) — asserting ALL of them are exported proves the route
 * returns the full sheet, not a 50-row page. Plus, against real seeded `field_permissions`: a denied
 * column is excluded even when its id is passed in `fieldIds` (the mask is the enforcement boundary;
 * selection can only narrow), a permitted subset narrows correctly, and the SAME masking holds for the
 * new `format=csv` path (the format branch re-serializes the already-masked rows; it adds no data access).
 *
 * Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const xlsx = await import('xlsx') as unknown as {
  read: (data: unknown, opts: { type: string }) => { SheetNames: string[]; Sheets: Record<string, unknown> }
  utils: { sheet_to_json: (ws: unknown, opts: { header: 1; raw: false; defval: string }) => string[][] }
}

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_exp_${TS}`
const SHEET = `sheet_exp_${TS}`
const F_NAME = `fld_exp_name_${TS}`
const F_AMOUNT = `fld_exp_amount_${TS}`
const F_SECRET = `fld_exp_secret_${TS}` // field_permissions-denied to VIEWER
const VIEWER = `user_exp_viewer_${TS}`
// > the FE DEFAULT_PAGE_SIZE (50). 120 also exceeds it by >2 pages, so a page-bound export would be obvious.
const SEED_ROWS = 120
// Views exercising the row filter + sort (the parity fix this file extends). Distinct ids per view so the
// loaders' module-level view cache never returns a stale config (we never mutate a view after creating it).
const VIEW_FILTER = `view_exp_filter_${TS}` // Amount >= 30 → rows 30..119 (90 rows: > the 50-page AND < the 120-sheet)
const VIEW_FILTER_THRESHOLD = 30
const VIEW_NO_FILTER = `view_exp_nofilter_${TS}` // empty filter/sort → must export the FULL sheet
const VIEW_SORT_DESC = `view_exp_sortdesc_${TS}` // sort Amount desc → rows must come back 119..0
const VIEW_FILTER_DENIED = `view_exp_filterdenied_${TS}` // filter on the DENIED Secret field → silently dropped
// Hide the filtered column (the canonical saved-filter idiom): hide Amount, still filter Amount >= 30.
// The filter MUST still apply (read-permitted field, just not emitted) → 90 rows, Amount column absent.
const VIEW_FILTER_HIDDEN = `view_exp_filterhidden_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express

// Parse a binary xlsx export response into a header+cells matrix.
async function exportXlsxRows(query: Record<string, string> = {}): Promise<string[][]> {
  const res = await request(app)
    .get(`/api/multitable/sheets/${SHEET}/export-xlsx`)
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

// Parse a CSV export response into a header+cells matrix (BOM-stripped, CRLF-split, RFC-4180 unquoting).
async function exportCsvRows(query: Record<string, string> = {}): Promise<{ status: number; rows: string[][]; contentType: string }> {
  const res = await request(app)
    .get(`/api/multitable/sheets/${SHEET}/export-xlsx`)
    .query({ format: 'csv', ...query })
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = []
      r.on('data', (c) => chunks.push(Buffer.from(c)))
      r.on('end', () => cb(null, Buffer.concat(chunks)))
    })
  const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8').replace(/^﻿/, '') : ''
  const rows = text.length === 0 ? [] : text.split('\r\n').map(parseCsvLine)
  return { status: res.status, rows, contentType: String(res.header['content-type'] ?? '') }
}

// Minimal RFC-4180 single-line parser (no embedded newlines in this test's data) → string cells.
function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else { inQuotes = false }
      } else { cur += ch }
    } else if (ch === '"') { inQuotes = true }
    else if (ch === ',') { out.push(cur); cur = '' }
    else { cur += ch }
  }
  out.push(cur)
  return out
}

describeIfDatabase('multitable export "all rows" via mask route (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: VIEWER, roles: ['member'], perms: ['multitable:read'] }; next() })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'Export Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'Export Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_NAME, SHEET, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_AMOUNT, SHEET, 'Amount', 'number', '{}', 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_SECRET, SHEET, 'Secret', 'string', '{}', 3])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [VIEWER])

    // Seed SEED_ROWS records. Name is the row's zero-padded index so we can assert the full set is present.
    for (let i = 0; i < SEED_ROWS; i++) {
      const name = `row_${String(i).padStart(4, '0')}`
      await q(
        'INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
        [`rec_exp_${TS}_${i}`, SHEET, JSON.stringify({ [F_NAME]: name, [F_AMOUNT]: i, [F_SECRET]: `secret_${i}` })],
      )
    }
    // field_permissions: deny F_SECRET to VIEWER (subject-scoped read mask).
    await q(
      `INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,'user',$3,false,false)`,
      [SHEET, F_SECRET, VIEWER],
    )

    // Views for the row-filter + sort parity cases. filter_info / sort_info carry the same shapes GET /view
    // reads (parseMetaFilterInfo / parseMetaSortRules), so the export reuses the IDENTICAL evaluation.
    const view = (id: string, filterInfo: unknown, sortInfo: unknown, hiddenFieldIds: string[] = []) =>
      q('INSERT INTO meta_views (id, sheet_id, name, type, filter_info, sort_info, hidden_field_ids) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)',
        [id, SHEET, id, 'grid', JSON.stringify(filterInfo), JSON.stringify(sortInfo), JSON.stringify(hiddenFieldIds)])
    const FILTER_AMOUNT = { conjunction: 'and', conditions: [{ fieldId: F_AMOUNT, operator: 'greaterequal', value: VIEW_FILTER_THRESHOLD }] }
    await view(VIEW_FILTER, FILTER_AMOUNT, null)
    await view(VIEW_NO_FILTER, null, null)
    await view(VIEW_SORT_DESC, null, { rules: [{ fieldId: F_AMOUNT, desc: true }] })
    // Filter on the DENIED Secret field — must be pruned (silently dropped, no oracle), so the export
    // returns the FULL sheet (the denied condition behaves exactly like a non-existent field).
    await view(VIEW_FILTER_DENIED, { conjunction: 'and', conditions: [{ fieldId: F_SECRET, operator: 'is', value: 'secret_5' }] }, null)
    // Hide the filtered column: Amount is view-hidden BUT still the filter target. A read-permitted field
    // stays filterable even when hidden from output (parity with GET /view) → filter applies, Amount absent.
    await view(VIEW_FILTER_HIDDEN, FILTER_AMOUNT, null, [F_AMOUNT])
  })

  afterAll(async () => {
    for (const t of ['field_permissions', 'meta_views', 'meta_records', 'meta_fields']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [VIEWER]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('(a) "all rows" exports the FULL sheet (every seeded row, > the 50-row client page)', async () => {
    const rows = await exportXlsxRows()
    const header = rows[0] ?? []
    const body = rows.slice(1)
    // Name + Amount only (Secret denied) — header proves the mask, body proves completeness.
    expect(header).toEqual(['Name', 'Amount'])
    expect(body.length).toBe(SEED_ROWS) // THE regression: not capped at the FE page size (50)
    expect(body.length).toBeGreaterThan(50)
    // Every distinct seeded Name is present exactly once (no page truncation, no dupes).
    const names = new Set(body.map((r) => r[0]))
    expect(names.size).toBe(SEED_ROWS)
    expect(names.has('row_0000')).toBe(true)
    expect(names.has(`row_${String(SEED_ROWS - 1).padStart(4, '0')}`)).toBe(true)
  })

  test('(b) a field_permissions-denied column is EXCLUDED even when its id is passed in fieldIds (mask holds)', async () => {
    // Request the denied column explicitly alongside a permitted one — selection must not widen past the mask.
    const rows = await exportXlsxRows({ fieldIds: `${F_NAME},${F_SECRET}` })
    const header = rows[0] ?? []
    const flat = rows.flat()
    expect(header).toEqual(['Name']) // Secret dropped by the mask despite being requested
    expect(flat).not.toContain('Secret')
    expect(flat.some((c) => c.startsWith('secret_'))).toBe(false) // no denied value leaked in any cell
    expect(rows.slice(1).length).toBe(SEED_ROWS) // still the full sheet
  })

  test('(c) selecting a subset of ALLOWED columns narrows correctly (and stays full-sheet)', async () => {
    const rows = await exportXlsxRows({ fieldIds: F_AMOUNT })
    const header = rows[0] ?? []
    expect(header).toEqual(['Amount']) // narrowed to the one requested permitted column
    expect(rows.slice(1).length).toBe(SEED_ROWS)
  })

  test('(d-1) CSV "all rows" exports the FULL sheet with the SAME field mask', async () => {
    const { status, rows, contentType } = await exportCsvRows()
    expect(status).toBe(200)
    expect(contentType).toContain('text/csv')
    const header = rows[0] ?? []
    const body = rows.slice(1)
    expect(header).toEqual(['Name', 'Amount']) // Secret masked in CSV too
    expect(body.length).toBe(SEED_ROWS)
    expect(body.length).toBeGreaterThan(50)
    const names = new Set(body.map((r) => r[0]))
    expect(names.size).toBe(SEED_ROWS)
  })

  test('(d-2) CSV SECURITY: a denied column requested via fieldIds is excluded (mask holds for CSV)', async () => {
    const { status, rows } = await exportCsvRows({ fieldIds: `${F_NAME},${F_SECRET}` })
    expect(status).toBe(200)
    const header = rows[0] ?? []
    const flat = rows.flat()
    expect(header).toEqual(['Name'])
    expect(flat.some((c) => c.startsWith('secret_'))).toBe(false)
  })

  test('(e) all-foreign fieldIds → 400 (no empty/200 file) for both formats', async () => {
    const xlsxRes = await request(app).get(`/api/multitable/sheets/${SHEET}/export-xlsx`).query({ fieldIds: 'nope1,nope2' })
    expect(xlsxRes.status).toBe(400)
    expect(xlsxRes.body?.error?.code).toBe('VALIDATION_ERROR')
    const csvRes = await request(app).get(`/api/multitable/sheets/${SHEET}/export-xlsx`).query({ format: 'csv', fieldIds: 'nope1,nope2' })
    expect(csvRes.status).toBe(400)
    expect(csvRes.body?.error?.code).toBe('VALIDATION_ERROR')
  })

  test('(f) an unsupported format value is a 400 (no silent fallback to xlsx)', async () => {
    const res = await request(app).get(`/api/multitable/sheets/${SHEET}/export-xlsx`).query({ format: 'pdf' })
    expect(res.status).toBe(400)
    expect(res.body?.error?.code).toBe('VALIDATION_ERROR')
  })

  // ── View row-filter + sort parity (the held-PR #3003 semantic this change resolves) ───────────────────
  // The export of a FILTERED view must return ALL rows OF THE FILTER (the full filtered set) — not the
  // 50-row client page, and not the unfiltered sheet. Amount >= 30 selects rows 30..119 = 90 rows, which is
  // BOTH > the FE page size (so it can't be a page) AND < the full sheet (so it can't be unfiltered).
  const EXPECTED_FILTERED = SEED_ROWS - VIEW_FILTER_THRESHOLD // 90

  test('(g) a FILTERED view exports exactly the filtered subset — all of it, not 50, not the whole sheet (xlsx)', async () => {
    const rows = await exportXlsxRows({ viewId: VIEW_FILTER })
    const header = rows[0] ?? []
    const body = rows.slice(1)
    expect(header).toEqual(['Name', 'Amount']) // mask still holds (Secret denied)
    expect(body.length).toBe(EXPECTED_FILTERED) // EXACTLY the filtered set
    expect(body.length).toBeGreaterThan(50) // not a page
    expect(body.length).toBeLessThan(SEED_ROWS) // not the unfiltered sheet
    // The exported Names are EXACTLY rows 30..119 — the right subset, not just the right count.
    const names = new Set(body.map((r) => r[0]))
    expect(names.size).toBe(EXPECTED_FILTERED)
    expect(names.has(`row_${String(VIEW_FILTER_THRESHOLD).padStart(4, '0')}`)).toBe(true) // row_0030 included (boundary, >= )
    expect(names.has('row_0029')).toBe(false) // row_0029 excluded (just below threshold)
    expect(names.has(`row_${String(SEED_ROWS - 1).padStart(4, '0')}`)).toBe(true) // row_0119 included
    // No Amount below the threshold leaked through.
    const minAmount = Math.min(...body.map((r) => Number(r[1])))
    expect(minAmount).toBe(VIEW_FILTER_THRESHOLD)
  })

  test('(g-csv) the SAME filtered subset for CSV (filter + mask both hold)', async () => {
    const { status, rows } = await exportCsvRows({ viewId: VIEW_FILTER })
    expect(status).toBe(200)
    const header = rows[0] ?? []
    const body = rows.slice(1)
    expect(header).toEqual(['Name', 'Amount'])
    expect(body.length).toBe(EXPECTED_FILTERED)
    expect(body.length).toBeGreaterThan(50)
    expect(Math.min(...body.map((r) => Number(r[1])))).toBe(VIEW_FILTER_THRESHOLD)
    expect(rows.flat().some((c) => c.startsWith('secret_'))).toBe(false) // denied value never leaks
  })

  test('(g-mask) the field+taint mask still holds on a filtered view even when the denied id is requested (xlsx+csv)', async () => {
    // Request the denied Secret column AND filter the view: selection can only narrow, filter narrows rows.
    const x = await exportXlsxRows({ viewId: VIEW_FILTER, fieldIds: `${F_NAME},${F_SECRET}` })
    expect(x[0]).toEqual(['Name']) // Secret dropped by the mask despite being requested
    expect(x.slice(1).length).toBe(EXPECTED_FILTERED) // filter still applied
    expect(x.flat().some((c) => c.startsWith('secret_'))).toBe(false)
    const c = await exportCsvRows({ viewId: VIEW_FILTER, fieldIds: `${F_NAME},${F_SECRET}` })
    expect(c.status).toBe(200)
    expect(c.rows[0]).toEqual(['Name'])
    expect(c.rows.slice(1).length).toBe(EXPECTED_FILTERED)
    expect(c.rows.flat().some((cell) => cell.startsWith('secret_'))).toBe(false)
  })

  test('(h) a no-filter view exports the FULL sheet (parity with the no-view all-rows path)', async () => {
    const rows = await exportXlsxRows({ viewId: VIEW_NO_FILTER })
    const body = rows.slice(1)
    expect(rows[0]).toEqual(['Name', 'Amount'])
    expect(body.length).toBe(SEED_ROWS) // the WHOLE sheet, not a page
    expect(new Set(body.map((r) => r[0])).size).toBe(SEED_ROWS)
  })

  test('(i) the view SORT is applied (Amount desc → 119..0, full sheet, masked)', async () => {
    const rows = await exportXlsxRows({ viewId: VIEW_SORT_DESC })
    const body = rows.slice(1)
    expect(rows[0]).toEqual(['Name', 'Amount'])
    expect(body.length).toBe(SEED_ROWS) // sort-only view still exports the full sheet
    const amounts = body.map((r) => Number(r[1]))
    expect(amounts[0]).toBe(SEED_ROWS - 1) // first row = highest Amount (119)
    expect(amounts[amounts.length - 1]).toBe(0) // last row = lowest Amount (0)
    // Strictly descending end-to-end (proves a real global sort, not a per-page one).
    const isDescending = amounts.every((v, idx) => idx === 0 || amounts[idx - 1] >= v)
    expect(isDescending).toBe(true)
  })

  test('(j) SECURITY: a filter on a DENIED field is silently dropped (no oracle) → exports the full sheet, no leak', async () => {
    // The view filters Secret == 'secret_5'. Secret is field_permissions-denied to VIEWER, so the condition
    // is pruned exactly like a non-existent field — NOT applied. Result: the full sheet (filter inert), and
    // crucially no denied value reaches any cell (header masked, no secret_* anywhere).
    const rows = await exportXlsxRows({ viewId: VIEW_FILTER_DENIED })
    expect(rows[0]).toEqual(['Name', 'Amount']) // Secret column masked
    expect(rows.slice(1).length).toBe(SEED_ROWS) // denied filter dropped → full sheet (not narrowed to 1 row)
    expect(rows.flat().some((c) => c.startsWith('secret_'))).toBe(false) // no denied value leaked via the filter
  })

  test('(k) the filtered column may be VIEW-HIDDEN and still filter (hide Amount, filter Amount>=30 → 90 rows, no Amount column)', async () => {
    // The canonical saved-filter idiom: hide the column you filter on. A read-permitted but view-hidden
    // field must still narrow the rows (parity with GET /view) — the column is just absent from output.
    // This is the case the OTHER seeded views (hidden_field_ids: []) structurally cannot reach.
    const rows = await exportXlsxRows({ viewId: VIEW_FILTER_HIDDEN })
    const header = rows[0] ?? []
    const body = rows.slice(1)
    expect(header).toEqual(['Name']) // Amount hidden from OUTPUT (view-hidden) — but still filtered ON
    expect(header).not.toContain('Amount')
    expect(body.length).toBe(EXPECTED_FILTERED) // filter STILL applied despite the column being hidden (not 120)
    expect(body.length).toBeGreaterThan(50)
    expect(body.length).toBeLessThan(SEED_ROWS)
    // The surviving rows are exactly 30..119 (proves it filtered on Amount, not something else).
    const names = new Set(body.map((r) => r[0]))
    expect(names.has(`row_${String(VIEW_FILTER_THRESHOLD).padStart(4, '0')}`)).toBe(true)
    expect(names.has('row_0029')).toBe(false)
    expect(names.has(`row_${String(SEED_ROWS - 1).padStart(4, '0')}`)).toBe(true)
  })
})
