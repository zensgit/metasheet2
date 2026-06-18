/**
 * #18 phase-2 (2b-S3) conditional-rules authoring API — real-DB. Pins GET/PUT
 * /sheets/:sheetId/conditional-rules: PUT is canManageSheetAccess-gated (multitable:share) and validates
 * every rule through parseConditionalRules (a structurally-invalid rule rejects the whole PUT, 400, no
 * write); GET is canRead-gated. Rules persist in meta_sheets.conditional_read_rules.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE = `base_cr_${TS}`
const SHEET = `sheet_cr_${TS}`
const MANAGER = `u_cr_mgr_${TS}`
const READER = `u_cr_ro_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function buildApp(userId: string, perms: string[]): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as any).user = { id: userId, roles: ['member'], perms, permissions: perms }
    next()
  })
  a.use('/api/multitable', univerMetaRouter())
  return a
}
// manager: multitable:share → canManageSheetAccess; reader: read-only; no-read: no multitable perms.
const managerApp = () => buildApp(MANAGER, ['multitable:read', 'multitable:share'])
const readerApp = () => buildApp(READER, ['multitable:read'])
const noReadApp = () => buildApp(`u_cr_nr_${TS}`, [])
const URL = `/api/multitable/sheets/${SHEET}/conditional-rules`

const VALID = [{ id: 'r1', fieldId: 'fld_status', operator: 'eq', value: 'secret', effect: 'deny_read' }]
const dbRules = async (): Promise<unknown> => {
  const r = await q('SELECT conditional_read_rules AS rules FROM meta_sheets WHERE id = $1', [SHEET])
  return (r.rows[0] as { rules?: unknown } | undefined)?.rules
}

describeIfDatabase('#18 phase-2 conditional-rules API (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'CR Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'CR Sheet'])
  })
  beforeEach(async () => {
    await q(`UPDATE meta_sheets SET conditional_read_rules = '[]'::jsonb WHERE id = $1`, [SHEET])
  })
  afterAll(async () => {
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('manager PUT valid rules → 200 + GET returns them + DB persists', async () => {
    const put = await request(managerApp()).put(URL).send({ rules: VALID })
    expect(put.status).toBe(200)
    expect(put.body.data.rules).toHaveLength(1)
    const get = await request(managerApp()).get(URL)
    expect(get.status).toBe(200)
    expect(get.body.data.rules[0]).toMatchObject({ id: 'r1', fieldId: 'fld_status', operator: 'eq', effect: 'deny_read' })
    expect(Array.isArray(await dbRules())).toBe(true)
  })

  test('PUT invalid rule (bad operator) → 400, nothing written', async () => {
    const bad = [{ id: 'r1', fieldId: 'fld_status', operator: 'bogus', effect: 'deny_read' }]
    const put = await request(managerApp()).put(URL).send({ rules: bad })
    expect(put.status).toBe(400)
    expect(await dbRules()).toEqual([])
  })

  test('PUT invalid rule (unknown effect) → 400, nothing written', async () => {
    const bad = [{ id: 'r1', fieldId: 'fld_status', operator: 'eq', effect: 'deny_write' }]
    expect((await request(managerApp()).put(URL).send({ rules: bad })).status).toBe(400)
    expect(await dbRules()).toEqual([])
  })

  test('PUT non-array body → 400', async () => {
    expect((await request(managerApp()).put(URL).send({ rules: 'nope' })).status).toBe(400)
    expect((await request(managerApp()).put(URL).send({})).status).toBe(400)
  })

  test('non-manager (read-only) PUT → 403, rules unchanged', async () => {
    const put = await request(readerApp()).put(URL).send({ rules: VALID })
    expect(put.status).toBe(403)
    expect(await dbRules()).toEqual([])
  })

  test('reader GET → 200 (canRead-gated)', async () => {
    const get = await request(readerApp()).get(URL)
    expect(get.status).toBe(200)
    expect(get.body.data.rules).toEqual([])
  })

  test('no-read user GET → 403', async () => {
    expect((await request(noReadApp()).get(URL)).status).toBe(403)
  })

  test('PUT on a missing sheet → 404', async () => {
    const put = await request(managerApp())
      .put(`/api/multitable/sheets/sheet_cr_missing_${TS}/conditional-rules`)
      .send({ rules: VALID })
    expect(put.status).toBe(404)
  })
})
