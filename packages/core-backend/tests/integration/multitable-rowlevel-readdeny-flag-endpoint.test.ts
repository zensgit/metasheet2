/**
 * #18 row-level-read-deny flag endpoints — real-DB regression. Pins GET/PUT
 * /sheets/:sheetId/row-level-read-deny: PUT is canManageSheetAccess-gated (multitable:share),
 * GET is canRead-gated, body is z.boolean()-validated (400), missing sheet → 404. The PUT toggles
 * meta_sheets.row_level_read_permissions_enabled — the per-sheet opt-in for the #18 read-deny.
 * (The flag's ENFORCEMENT across read surfaces is covered by multitable-rowlevel-readdeny-enforce/xrec;
 * this pins the authoring endpoints' gating, which had none.)
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE = `base_rld_${TS}`
const SHEET = `sheet_rld_${TS}`
const MANAGER = `u_rld_mgr_${TS}`
const READER = `u_rld_ro_${TS}`

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
// manager: multitable:share → canManageSheetAccess; reader: read-only (canRead, NOT manage)
const managerApp = () => buildApp(MANAGER, ['multitable:read', 'multitable:share'])
const readerApp = () => buildApp(READER, ['multitable:read'])
const FLAG = `/api/multitable/sheets/${SHEET}/row-level-read-deny`

async function dbFlag(): Promise<boolean | null> {
  const r = await q('SELECT row_level_read_permissions_enabled AS e FROM meta_sheets WHERE id = $1', [SHEET])
  return (r.rows[0] as { e?: boolean } | undefined)?.e ?? null
}

describeIfDatabase('#18 row-level-read-deny flag endpoints (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'RLD Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'RLD Sheet'])
  })
  beforeEach(async () => {
    await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = false WHERE id = $1', [SHEET])
  })
  afterAll(async () => {
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('manager PUT enable → 200 + DB updated + GET reflects enabled=true', async () => {
    const put = await request(managerApp()).put(FLAG).send({ enabled: true })
    expect(put.status).toBe(200)
    expect(put.body.data.enabled).toBe(true)
    expect(await dbFlag()).toBe(true)
    const get = await request(managerApp()).get(FLAG)
    expect(get.status).toBe(200)
    expect(get.body.data.enabled).toBe(true)
  })

  test('manager PUT disable → 200 + GET reflects enabled=false', async () => {
    await request(managerApp()).put(FLAG).send({ enabled: true })
    const put = await request(managerApp()).put(FLAG).send({ enabled: false })
    expect(put.status).toBe(200)
    expect(put.body.data.enabled).toBe(false)
    expect(await dbFlag()).toBe(false)
  })

  test('non-manager (read-only) PUT → 403, flag UNCHANGED', async () => {
    const put = await request(readerApp()).put(FLAG).send({ enabled: true })
    expect(put.status).toBe(403)
    expect(await dbFlag()).toBe(false)
  })

  test('reader GET → 200 (canRead-gated), reads the current flag', async () => {
    const get = await request(readerApp()).get(FLAG)
    expect(get.status).toBe(200)
    expect(get.body.data.enabled).toBe(false)
  })

  test('PUT with a non-boolean / missing enabled → 400 (validation), flag unchanged', async () => {
    expect((await request(managerApp()).put(FLAG).send({ enabled: 'yes' })).status).toBe(400)
    expect((await request(managerApp()).put(FLAG).send({})).status).toBe(400)
    expect(await dbFlag()).toBe(false)
  })

  test('PUT on a missing sheet → 404', async () => {
    const put = await request(managerApp())
      .put(`/api/multitable/sheets/sheet_rld_missing_${TS}/row-level-read-deny`)
      .send({ enabled: true })
    expect(put.status).toBe(404)
  })
})
