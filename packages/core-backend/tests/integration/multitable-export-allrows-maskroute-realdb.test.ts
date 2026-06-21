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
  })

  afterAll(async () => {
    for (const t of ['field_permissions', 'meta_records', 'meta_fields']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
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
})
