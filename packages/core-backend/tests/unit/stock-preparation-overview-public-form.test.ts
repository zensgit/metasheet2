/**
 * 一个项目一张备料表 — S3 fix round 2 (F7b; register R-37): a PUBLIC FORM never admits anyone to the read-only
 * stock-preparation project overview. `isPublicFormAccessAllowed` turns an anonymous token holder into a
 * principal with PUBLIC_FORM_CAPABILITIES (record create), bypassing the person-capability clamp. No form can be
 * shared on the overview today (view management is clamped), so the refusal is the second barrier, next to the
 * e-learning projection refusal in the same function.
 *
 * Mock pool, no DB, the REAL univer-meta router behind one pinned listener (`request(app)` is banned in
 * tests/unit, #4154). The caller is ANONYMOUS and presents the view's correct, unexpired public token:
 *   P-01 submit to a public-form view whose sheet is the overview → 401 (public access refused), no INSERT;
 *   P-02 form-context of the same view → 401, nothing of the sheet read;
 *   P-03 control: the SAME view on an ordinary sheet of the same derived-id shape is admitted (the request
 *        gets past the public-access decision: the overview lookup ran and the sheet row / fields are read).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'

const OVERVIEW = 'sheet_0123456789abcdef01234567'
const ORDINARY = 'sheet_fedcba9876543210fedcba98'
const VIEW_ID = 'view_f7b_form'
const TOKEN = 'tok_f7b_public'
const OVERVIEW_SQL = "SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) AND (to_jsonb(meta_sheets) ->> 'system_kind') = $2"
const collapse = (sql: string) => sql.replace(/\s+/g, ' ').trim()

type Log = Array<{ sql: string; params: unknown[] }>

function createMockPool(log: Log, sheetId: string) {
  const answer = async (sql: string, params: unknown[] = []) => {
    const q = collapse(sql)
    log.push({ sql: q, params })
    if (q === OVERVIEW_SQL) {
      const ids = (params[0] as string[]) ?? []
      const rows = ids.filter((id) => id === OVERVIEW).map((id) => ({ id }))
      return { rows, rowCount: rows.length }
    }
    if (/FROM meta_views WHERE id = \$1/.test(q)) {
      return {
        rows: [{
          id: VIEW_ID,
          sheet_id: sheetId,
          name: 'Public form',
          type: 'form',
          filter_info: null,
          sort_info: null,
          group_info: null,
          hidden_field_ids: [],
          config: { publicForm: { enabled: true, publicToken: TOKEN, accessMode: 'public' } },
        }],
        rowCount: 1,
      }
    }
    if (q === 'SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL') {
      return { rows: [{ id: params[0], base_id: 'base_f7b', name: 'Sheet', description: null }], rowCount: 1 }
    }
    if (q.startsWith('SELECT deleted_at FROM meta_sheets WHERE id = $1')) {
      return { rows: [{ deleted_at: null }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }
  return {
    query: vi.fn(answer),
    transaction: vi.fn(async () => { throw Object.assign(new Error('synthetic transaction refusal'), { code: 'SYNTHETIC' }) }),
  }
}

async function buildAnonymousApp(log: Log, sheetId: string): Promise<Express> {
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  vi.spyOn(poolManager, 'get').mockReturnValue(createMockPool(log, sheetId) as never)
  const app = express()
  app.use(express.json())
  app.use('/api/multitable', univerMetaRouter())
  return app
}

const pinned = usePinnedServer()

describe('S3 fix round 2 F7b — a public form never admits anyone to the overview', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => {
    vi.doUnmock('../../src/rbac/service')
    vi.restoreAllMocks()
  })

  it('P-01 anonymous submit with the correct token to a public-form view ON the overview → 401, no INSERT', async () => {
    const log: Log = []
    pinned.setApp(await buildAnonymousApp(log, OVERVIEW))
    const res = await request(pinned.url()).post(`/api/multitable/views/${VIEW_ID}/submit`).send({ publicToken: TOKEN, data: { fld_any: 'x' } })
    expect(res.status).toBe(401)
    expect(JSON.stringify(res.body)).not.toContain(OVERVIEW)
    expect(log.some((entry) => entry.sql === OVERVIEW_SQL)).toBe(true)
    expect(log.some((entry) => /^(INSERT|UPDATE)\b/i.test(entry.sql))).toBe(false)
    expect(log.some((entry) => /FROM meta_fields/i.test(entry.sql))).toBe(false)
  })

  it('P-02 anonymous form-context with the correct token on the overview → 401, no sheet row or field read', async () => {
    const log: Log = []
    pinned.setApp(await buildAnonymousApp(log, OVERVIEW))
    const res = await request(pinned.url()).get('/api/multitable/form-context').query({ viewId: VIEW_ID, publicToken: TOKEN })
    expect(res.status).toBe(401)
    expect(log.some((entry) => entry.sql === OVERVIEW_SQL)).toBe(true)
    expect(log.some((entry) => /FROM meta_fields/i.test(entry.sql))).toBe(false)
  })

  it('P-03 control: the same public-form view on an ordinary sheet (same id shape) is admitted past the public-access decision', async () => {
    const log: Log = []
    pinned.setApp(await buildAnonymousApp(log, ORDINARY))
    const res = await request(pinned.url()).post(`/api/multitable/views/${VIEW_ID}/submit`).send({ publicToken: TOKEN, data: {} })
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)
    // The capability resolver's clamp lookup and the public-form check both ask about the ORDINARY id; neither refuses.
    const lookups = log.filter((entry) => entry.sql === OVERVIEW_SQL).map((entry) => entry.params[0])
    expect(lookups.length).toBeGreaterThanOrEqual(1)
    for (const ids of lookups) expect(ids).toEqual([ORDINARY])
    // Past the decision: the route went on to the sheet row and its fields.
    expect(log.some((entry) => /FROM meta_fields/i.test(entry.sql))).toBe(true)
  })
})
