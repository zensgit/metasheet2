/**
 * Real-DB integration test for the formula dry-run endpoint (#5a, design #1860):
 * POST /api/multitable/sheets/:sheetId/formula/dry-run.
 * Confirms the canManageFields gate, structural caps, and the happy path. Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_dry_${TS}`
const SHEET_ID = `sheet_dry_${TS}`
const FLD_A = `fld_a_${TS}`
const FLD_B = `fld_b_${TS}`

let app: Express
let testPerms: string[] = ['multitable:write'] // canManageFields requires multitable:write
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const post = (body: unknown) => request(app).post(`/api/multitable/sheets/${SHEET_ID}/formula/dry-run`).send(body as object)

describeIfDatabase('multitable formula dry-run (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: `u_dry_${TS}`, roles: [], perms: testPerms }; next() })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_ID, 'Dry Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_ID, BASE_ID, 'Dry Sheet'])
    for (const [fid, name, order] of [[FLD_A, 'A', 1], [FLD_B, 'B', 2]] as const) {
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [fid, SHEET_ID, name, 'number', '{}', order])
    }
  })

  afterAll(async () => {
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('happy path: evaluates a {fld}-only expression against sample values', async () => {
    testPerms = ['multitable:write']
    const res = await post({ expression: `={${FLD_A}}+{${FLD_B}}`, sampleValues: { [FLD_A]: 2, [FLD_B]: 3 } })
    expect(res.status).toBe(200)
    expect(res.body.data.success).toBe(true)
    expect(res.body.data.result).toBe(5)
    expect(res.body.data.resultType).toBe('number')
  })

  test('unknown field reference → 200 success:false (NOT evaluated), no false-green', async () => {
    testPerms = ['multitable:write']
    const res = await post({ expression: `={fld_missing_${TS}}+1`, sampleValues: {} })
    expect(res.status).toBe(200)
    expect(res.body.data.success).toBe(false)
    expect(res.body.data.result).toBeUndefined()
    expect(res.body.data.diagnostics.some((d: { kind: string }) => d.kind === 'unknown_field')).toBe(true)
  })

  test('capability gate: read-only user (no multitable:write) → 403', async () => {
    testPerms = ['multitable:read']
    const res = await post({ expression: `={${FLD_A}}+1`, sampleValues: { [FLD_A]: 1 } })
    expect(res.status).toBe(403)
    testPerms = ['multitable:write']
  })

  test('missing expression → 400', async () => {
    const res = await post({ sampleValues: {} })
    expect(res.status).toBe(400)
  })

  test('structural cap: over-long expression → 413', async () => {
    const res = await post({ expression: '=' + '1+'.repeat(3000) + '1', sampleValues: {} })
    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe('DRYRUN_EXPRESSION_TOO_LONG')
  })

  test('structural cap: nesting deeper than 32 → 422 DRYRUN_TOO_DEEP', async () => {
    const res = await post({ expression: '=' + '('.repeat(33) + '1' + ')'.repeat(33), sampleValues: {} })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('DRYRUN_TOO_DEEP')
  })

  test('structural cap: more than 64 referenced fields → 422 DRYRUN_TOO_MANY_REFS', async () => {
    testPerms = ['multitable:write'] // ref-count check runs after the canManageFields gate
    const expr = '=' + Array.from({ length: 65 }, (_, i) => `{fld_x${i}}`).join('+')
    const res = await post({ expression: expr, sampleValues: {} })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('DRYRUN_TOO_MANY_REFS')
  })
})
