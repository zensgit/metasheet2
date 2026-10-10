/**
 * 一个项目一张备料表 — S3 fix round 1, the ROUTE half of the overview's read-only guarantee (ADR
 * adr-stock-prep-project-sheets-20261008 §5 「只读（Q5）」; register R-37). Mock pool, no DB, real
 * univer-meta router behind one pinned listener (`request(app)` is banned in tests/unit, #4154).
 *
 *   R1  PUT /sheets/:sheetId/permissions/:subjectType/:subjectId on the overview: a principal who may
 *       manage access (admin, multitable:share) may share it for READING — `read` reaches the subject
 *       lookup — but `write` / `write-own` / `admin` are refused 409 STOCK_PREP_OVERVIEW_READ_ONLY before
 *       any subject lookup or write; an ordinary sheet takes `write` as before (control).
 *   R8a POST /sheets refuses a client-chosen id of the host-derived shape (`sheet_` + 24 hex) with 403
 *       SHEET_ID_RESERVED and ZERO statements; a client uuid id is not refused (control). GET /view?seed=true
 *       refuses to MATERIALIZE an absent id of that shape the same way; a live one still reads.
 */
import { createHash } from 'node:crypto'

import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getObjectSheetId } from '../../src/multitable/provisioning'
import { STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID } from '../../src/multitable/stock-preparation-overview-contract'
import { usePinnedServer } from '../utils/pinned-server'

const OVERVIEW = getObjectSheetId('tenant_r:integration-core', STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID)
const PLAIN = 'sheet_plain_r1'
const ROLE = 'stock-prep_frontline'

const collapse = (sql: string) => sql.replace(/\s+/g, ' ').trim()

type Log = Array<{ sql: string; params: unknown[] }>

function createMockPool(log: Log, opts: { liveSheets: string[]; overviews: string[] }) {
  const answer = async (sql: string, params: unknown[] = []) => {
    const q = collapse(sql)
    log.push({ sql: q, params })
    if (q === 'SELECT deleted_at FROM meta_sheets WHERE id = $1' || q === 'SELECT deleted_at FROM meta_sheets WHERE id = $1 FOR UPDATE') {
      return { rows: opts.liveSheets.includes(params[0] as string) ? [{ deleted_at: null }] : [], rowCount: 0 }
    }
    if (q === "SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) AND (to_jsonb(meta_sheets) ->> 'system_kind') = $2") {
      const ids = (params[0] as string[]) ?? []
      return { rows: ids.filter((id) => opts.overviews.includes(id)).map((id) => ({ id })), rowCount: 0 }
    }
    // Every subject lookup misses: a 404 NOT_FOUND then PROVES the request got past the overview rule.
    if (q === 'SELECT id FROM roles WHERE id = $1' || q === 'SELECT id FROM users WHERE id = $1') return { rows: [], rowCount: 0 }
    return { rows: [], rowCount: 0 }
  }
  return {
    query: vi.fn(answer),
    transaction: vi.fn(async () => { throw Object.assign(new Error('synthetic transaction refusal'), { code: 'SYNTHETIC' }) }),
  }
}

async function buildApp(log: Log, opts: { liveSheets: string[]; overviews: string[] }, user: { isAdmin: boolean; perms: string[] }): Promise<Express> {
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(user.isAdmin),
    userHasPermission: vi.fn().mockResolvedValue(user.isAdmin),
    listUserPermissions: vi.fn().mockResolvedValue(user.perms),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  vi.spyOn(poolManager, 'get').mockReturnValue(createMockPool(log, opts) as never)
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as express.Request & { user?: unknown }).user = { id: 'u_r1', roles: user.isAdmin ? ['admin'] : [], perms: user.perms }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return app
}

const pinned = usePinnedServer()
const ADMIN = { isAdmin: true, perms: [] as string[] }
const SHARER = { isAdmin: false, perms: ['multitable:read', 'multitable:share'] }

describe('S3 fix round 1 — the sheet-permission PUT on the overview is read-only (R1)', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => {
    vi.doUnmock('../../src/rbac/service')
    vi.restoreAllMocks()
  })

  for (const [label, user] of [['platform admin', ADMIN], ['multitable:share holder', SHARER]] as const) {
    it(`${label}: write / write-own / admin on the overview → 409 STOCK_PREP_OVERVIEW_READ_ONLY before any subject lookup or write`, async () => {
      for (const accessLevel of ['write', 'admin', 'write-own']) {
        const log: Log = []
        pinned.setApp(await buildApp(log, { liveSheets: [OVERVIEW, PLAIN], overviews: [OVERVIEW] }, user))
        const res = await request(pinned.url()).put(`/api/multitable/sheets/${OVERVIEW}/permissions/role/${ROLE}`).send({ accessLevel })
        expect(res.status, accessLevel).toBe(409)
        expect(res.body.error).toMatchObject({ code: 'STOCK_PREP_OVERVIEW_READ_ONLY', details: { reason: 'grant_level' } })
        expect(JSON.stringify(res.body)).not.toContain(ROLE)
        expect(log.some((entry) => entry.sql === 'SELECT id FROM roles WHERE id = $1' || /^(INSERT|DELETE)\b/i.test(entry.sql)), accessLevel).toBe(false)
        vi.resetModules()
      }
    })

    it(`${label}: read (and none) on the overview pass the rule and reach the subject lookup`, async () => {
      for (const accessLevel of ['read', 'none']) {
        const log: Log = []
        pinned.setApp(await buildApp(log, { liveSheets: [OVERVIEW, PLAIN], overviews: [OVERVIEW] }, user))
        const res = await request(pinned.url()).put(`/api/multitable/sheets/${OVERVIEW}/permissions/role/${ROLE}`).send({ accessLevel })
        expect(res.status, accessLevel).toBe(404)
        expect(res.body.error.code).toBe('NOT_FOUND')
        expect(log.some((entry) => entry.sql === 'SELECT id FROM roles WHERE id = $1'), accessLevel).toBe(true)
        vi.resetModules()
      }
    })
  }

  it('control: an ordinary sheet takes a write grant past the same point (no overview lookup is even issued for its id)', async () => {
    const log: Log = []
    pinned.setApp(await buildApp(log, { liveSheets: [OVERVIEW, PLAIN], overviews: [OVERVIEW] }, ADMIN))
    const res = await request(pinned.url()).put(`/api/multitable/sheets/${PLAIN}/permissions/role/${ROLE}`).send({ accessLevel: 'write' })
    expect(res.status).toBe(404)
    expect(log.some((entry) => entry.sql === 'SELECT id FROM roles WHERE id = $1')).toBe(true)
    expect(log.some((entry) => entry.sql.includes("'system_kind'"))).toBe(false)
  })

  it('a person who cannot manage access is still refused 403 first (the rule never widens the gate)', async () => {
    const log: Log = []
    pinned.setApp(await buildApp(log, { liveSheets: [OVERVIEW], overviews: [OVERVIEW] }, { isAdmin: false, perms: ['multitable:read', 'multitable:write'] }))
    const res = await request(pinned.url()).put(`/api/multitable/sheets/${OVERVIEW}/permissions/role/${ROLE}`).send({ accessLevel: 'read' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })
})

describe('S3 fix round 1 — the host-derived sheet-id namespace is reserved for provisioning (R8a)', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => {
    vi.doUnmock('../../src/rbac/service')
    vi.restoreAllMocks()
  })

  const derivedIds = () => [
    OVERVIEW,
    getObjectSheetId('tenant_other:integration-core', STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID),
    `sheet_${createHash('sha1').update('anything').digest('hex').slice(0, 24)}`,
  ]

  it('POST /sheets with a derived-shape id → 403 SHEET_ID_RESERVED, values-free, with ZERO statements', async () => {
    for (const id of derivedIds()) {
      const log: Log = []
      pinned.setApp(await buildApp(log, { liveSheets: [], overviews: [] }, ADMIN))
      const res = await request(pinned.url()).post('/api/multitable/sheets').send({ id, name: 'squatter' })
      expect(res.status, id).toBe(403)
      expect(res.body.error.code).toBe('SHEET_ID_RESERVED')
      expect(JSON.stringify(res.body)).not.toContain(id)
      expect(log, id).toEqual([])
      vi.resetModules()
    }
  })

  it('control: a client uuid id (and no id at all) is NOT refused by the reservation', async () => {
    for (const body of [{ id: 'sheet_1b4e28ba-2fa1-11d2-883f-0016d3cca427', name: 'mine' }, { name: 'generated' }]) {
      const log: Log = []
      pinned.setApp(await buildApp(log, { liveSheets: [], overviews: [] }, ADMIN))
      const res = await request(pinned.url()).post('/api/multitable/sheets').send(body)
      expect(res.body?.error?.code).not.toBe('SHEET_ID_RESERVED')
      vi.resetModules()
    }
  })

  it('GET /view?seed=true refuses to MATERIALIZE an absent derived-shape id (403 SHEET_ID_RESERVED); a live one still reads past it', async () => {
    const log: Log = []
    pinned.setApp(await buildApp(log, { liveSheets: [], overviews: [] }, ADMIN))
    const res = await request(pinned.url()).get('/api/multitable/view').query({ sheetId: OVERVIEW, seed: 'true' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('SHEET_ID_RESERVED')
    expect(log.some((entry) => /INSERT/i.test(entry.sql))).toBe(false)

    vi.resetModules()
    const liveLog: Log = []
    pinned.setApp(await buildApp(liveLog, { liveSheets: [OVERVIEW], overviews: [] }, ADMIN))
    const live = await request(pinned.url()).get('/api/multitable/view').query({ sheetId: OVERVIEW, seed: 'true' })
    expect(live.body?.error?.code).not.toBe('SHEET_ID_RESERVED')
  })
})
