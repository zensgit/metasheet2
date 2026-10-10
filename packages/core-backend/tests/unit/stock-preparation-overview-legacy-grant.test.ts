/**
 * 一个项目一张备料表 — S3 fix round 1 (R1): the LEGACY grant door (`POST /api/spreadsheets/:id/permissions/
 * grant`, routes/spreadsheet-permissions.ts) on the stock-preparation project overview. A principal who may
 * manage access on the overview (access management is KEPT by the clamp) may write the READ code there and
 * nothing else: `spreadsheet:write` / `spreadsheet:admin` / any other code is refused 409
 * STOCK_PREP_OVERVIEW_READ_ONLY with no transaction and no INSERT. An ordinary sheet takes a write code as
 * before (control); a revoke (narrowing) on the overview is not refused. Fake pool, no DB.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'

const sqlLog: Array<{ sql: string; params: unknown[] }> = []
const collapse = (sql: string) => sql.replace(/\s+/g, ' ').trim()

const OVERVIEW = 'sheet_0123456789abcdef01234567'
const PLAIN = 'sheet_plain_legacy_r1'
const CALLER = 'u_legacy_r1'

function answerFor(sql: string, params: unknown[]): { rows: unknown[]; rowCount: number } {
  const text = collapse(sql)
  if (/^SELECT deleted_at FROM meta_sheets WHERE id = \$1(?: FOR UPDATE)?$/i.test(text)) {
    return [OVERVIEW, PLAIN].includes(params[0] as string) ? { rows: [{ deleted_at: null }], rowCount: 1 } : { rows: [], rowCount: 0 }
  }
  if (text === "SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) AND (to_jsonb(meta_sheets) ->> 'system_kind') = $2") {
    const ids = (params[0] as string[]) ?? []
    return { rows: ids.filter((id) => id === OVERVIEW).map((id) => ({ id })), rowCount: 0 }
  }
  if (/^SELECT perm_code FROM spreadsheet_permissions/i.test(text)) return { rows: [{ perm_code: 'spreadsheet:read' }], rowCount: 1 }
  return { rows: [], rowCount: 0 }
}

const record = async (sql: string, params: unknown[] = []) => {
  sqlLog.push({ sql: collapse(sql), params })
  return answerFor(sql, params)
}

const pgMocks = vi.hoisted(() => ({ transaction: vi.fn() }))

vi.mock('../../src/db/pg', () => ({
  pool: { query: (sql: string, params?: unknown[]) => record(sql, params ?? []) },
  query: (sql: string, params?: unknown[]) => record(sql, params ?? []),
  transaction: pgMocks.transaction,
}))
const rbac = vi.hoisted(() => ({ isAdmin: false }))
vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn(async () => rbac.isAdmin),
  listUserPermissions: vi.fn().mockResolvedValue([]),
  userHasPermission: vi.fn().mockResolvedValue(false),
  invalidateUserPerms: vi.fn(),
}))
vi.mock('../../src/rbac/namespace-admission', () => ({
  isPermissionAllowedByNamespaceAdmission: vi.fn().mockResolvedValue(true),
}))
vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn().mockResolvedValue(undefined) }))

import { spreadsheetPermissionsRouter } from '../../src/routes/spreadsheet-permissions'

const SHEET_MANAGER = ['spreadsheet-permissions:read', 'spreadsheet-permissions:write', 'multitable:read', 'multitable:share']

function buildApp(permissions: string[]): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as express.Request & { user?: unknown }).user = { id: CALLER, permissions }
    next()
  })
  app.use(spreadsheetPermissionsRouter())
  return app
}

const pinned = usePinnedServer()
const writes = () => sqlLog.filter(({ sql }) => /^(INSERT INTO|DELETE FROM) spreadsheet_permissions/i.test(sql))

describe('S3 fix round 1 — the legacy grant door writes the READ code only on the overview (R1)', () => {
  beforeEach(() => {
    sqlLog.length = 0
    rbac.isAdmin = false
    pgMocks.transaction.mockReset()
    pgMocks.transaction.mockImplementation(async (handler: (c: { query: typeof record }) => Promise<unknown>) => handler({ query: record }))
  })

  for (const asAdmin of [false, true]) {
    const who = asAdmin ? 'platform admin' : 'multitable:share holder'
    it(`${who}: spreadsheet:write / admin / an arbitrary code on the overview → 409 STOCK_PREP_OVERVIEW_READ_ONLY, no transaction, no INSERT`, async () => {
      for (const permission of ['spreadsheet:write', 'spreadsheet:admin', 'spreadsheet:write-own', 'multitable:write']) {
        sqlLog.length = 0
        rbac.isAdmin = asAdmin
        pinned.setApp(buildApp(SHEET_MANAGER))
        const res = await request(pinned.url()).post(`/api/spreadsheets/${OVERVIEW}/permissions/grant`).send({ userId: 'u_target', permission })
        expect(res.status, permission).toBe(409)
        expect(res.body.error).toMatchObject({ code: 'STOCK_PREP_OVERVIEW_READ_ONLY', details: { reason: 'grant_level' } })
        expect(JSON.stringify(res.body)).not.toContain('u_target')
        expect(pgMocks.transaction, permission).not.toHaveBeenCalled()
        expect(writes(), permission).toEqual([])
      }
    })
  }

  it('spreadsheet:read on the overview is written (G2 by a sheet manager)', async () => {
    pinned.setApp(buildApp(SHEET_MANAGER))
    const res = await request(pinned.url()).post(`/api/spreadsheets/${OVERVIEW}/permissions/grant`).send({ userId: 'u_target', permission: 'spreadsheet:read' })
    expect(res.status).toBe(200)
    expect(writes().map((w) => w.params)).toEqual([[OVERVIEW, 'u_target', 'spreadsheet:read']])
  })

  it('control: an ordinary sheet still takes spreadsheet:write; a revoke on the overview is not refused (it can only narrow)', async () => {
    pinned.setApp(buildApp(SHEET_MANAGER))
    const plain = await request(pinned.url()).post(`/api/spreadsheets/${PLAIN}/permissions/grant`).send({ userId: 'u_target', permission: 'spreadsheet:write' })
    expect(plain.status).toBe(200)
    expect(writes().map((w) => w.params)).toEqual([[PLAIN, 'u_target', 'spreadsheet:write']])
    sqlLog.length = 0
    const revoke = await request(pinned.url()).post(`/api/spreadsheets/${OVERVIEW}/permissions/revoke`).send({ userId: 'u_target', permission: 'spreadsheet:write' })
    expect(revoke.status).toBe(200)
    expect(writes()).toHaveLength(1)
  })
})
