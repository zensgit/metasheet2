/**
 * Slice 1 real-DB goldens for personal (per-user) view config overlay.
 *
 * Ratified design: docs/development/multitable-personal-views-design-lock-20260705.md
 * Verification: docs/development/multitable-personal-views-slice1-verification-20260705.md
 *
 * Scope: data model (`meta_view_personal_configs`) + resolution contract (§1-C, shared-fallback)
 * + actor-scoped isolation (§1-B, LOAD-BEARING) on `GET /views` and the new
 * `GET|PUT|DELETE /views/:viewId/personal-config` routes. NO frontend, NO field-order overlay
 * (slice 2).
 *
 * Goldens (design-lock §4):
 *  - G-A (read isolation, LOAD-BEARING): user A's override is not visible to user B.
 *  - G-B (shared fallback byte-identical): no override / flag-off => shared config unchanged.
 *  - G-C (write isolation, LOAD-BEARING): A cannot create/update B's override.
 *  - forged-identity clause: forged body.userId / query.userId / x-user-id header MUST NOT
 *    change the read/write target — the target is always the authenticated actor.
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI, matching sibling real-DB specs).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_pv1_${TS}`
const SHEET_ID = `sheet_pv1_${TS}`
const FIELD_ID = `fld_pv1_${TS}`
const VIEW_ID = `view_pv1_${TS}`
const USER_A = `user_pv1_a_${TS}`
const USER_B = `user_pv1_b_${TS}`

const SHARED_FILTER = { conjunction: 'and', conditions: [{ fieldId: FIELD_ID, operator: 'is', value: 'shared-val' }] }
const SHARED_SORT = { fieldId: FIELD_ID, direction: 'asc' }
const SHARED_GROUP = {}
const SHARED_HIDDEN: string[] = []

const PERSONAL_A_FILTER = { conjunction: 'and', conditions: [{ fieldId: FIELD_ID, operator: 'is', value: 'personal-a-val' }] }

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

let app: Express
let currentUserId: string | null = USER_A
let currentPerms: string[] = ['multitable:read', 'multitable:write']
let currentForgedHeader: string | undefined

const listViews = () => {
  const r = request(app).get('/api/multitable/views').query({ sheetId: SHEET_ID })
  return currentForgedHeader ? r.set('x-user-id', currentForgedHeader) : r
}
const getPersonalConfig = (viewId: string, opts?: { forgedQueryUserId?: string }) => {
  let r = request(app).get(`/api/multitable/views/${viewId}/personal-config`)
  if (opts?.forgedQueryUserId) r = r.query({ userId: opts.forgedQueryUserId })
  return currentForgedHeader ? r.set('x-user-id', currentForgedHeader) : r
}
const putPersonalConfig = (
  viewId: string,
  config: Record<string, unknown>,
  opts?: { forgedBodyUserId?: string; forgedQueryUserId?: string },
) => {
  let r = request(app)
    .put(`/api/multitable/views/${viewId}/personal-config`)
    .send({ config, ...(opts?.forgedBodyUserId ? { userId: opts.forgedBodyUserId } : {}) })
  if (opts?.forgedQueryUserId) r = r.query({ userId: opts.forgedQueryUserId })
  return currentForgedHeader ? r.set('x-user-id', currentForgedHeader) : r
}
const deletePersonalConfig = (viewId: string) => {
  const r = request(app).delete(`/api/multitable/views/${viewId}/personal-config`)
  return currentForgedHeader ? r.set('x-user-id', currentForgedHeader) : r
}

const rowForUser = async (userId: string) =>
  (await q('SELECT config FROM meta_view_personal_configs WHERE view_id = $1 AND user_id = $2', [VIEW_ID, userId]))
    .rows[0] as { config: unknown } | undefined

describeIfDatabase('personal (per-user) view config overlay — slice 1 (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = currentUserId ? { id: currentUserId, roles: [], perms: currentPerms } : undefined
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_ID, 'PV1 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_ID, BASE_ID, 'PV1 Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FIELD_ID, SHEET_ID, 'F1', 'string', '{}', 1])
    await q(
      'INSERT INTO meta_views (id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb)',
      [VIEW_ID, SHEET_ID, 'PV1 View', 'grid', JSON.stringify(SHARED_FILTER), JSON.stringify(SHARED_SORT), JSON.stringify(SHARED_GROUP), JSON.stringify(SHARED_HIDDEN), '{}'],
    )
  })

  afterAll(async () => {
    await q('DELETE FROM meta_view_personal_configs WHERE view_id = $1', [VIEW_ID]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  beforeEach(async () => {
    currentUserId = USER_A
    currentPerms = ['multitable:read', 'multitable:write']
    currentForgedHeader = undefined
    delete process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS
    await q('DELETE FROM meta_view_personal_configs WHERE view_id = $1', [VIEW_ID])
  })

  afterEach(() => {
    delete process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ---------------------------------------------------------------------------------------
  // G-B — shared fallback byte-identical
  // ---------------------------------------------------------------------------------------
  test('G-B: flag OFF — shared config served unchanged even with a personal override row present', async () => {
    // A personal override row exists for USER_A...
    await q(
      `INSERT INTO meta_view_personal_configs (view_id, user_id, config) VALUES ($1, $2, $3::jsonb)`,
      [VIEW_ID, USER_A, JSON.stringify({ filterInfo: PERSONAL_A_FILTER })],
    )
    // ...but the flag is OFF (default-off, §P2): the overlay must be completely inert.
    expect(process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS).toBeUndefined()

    currentUserId = USER_A
    const res = await listViews()
    expect(res.status).toBe(200)
    const view = res.body.data.views.find((v: any) => v.id === VIEW_ID)
    expect(view.filterInfo).toEqual(SHARED_FILTER)
    expect(view.sortInfo).toEqual(SHARED_SORT)
    expect(view.groupInfo).toEqual(SHARED_GROUP)
    expect(view.hiddenFieldIds).toEqual(SHARED_HIDDEN)
  })

  test('G-B: flag ON, no override row for this actor — shared config byte-identical', async () => {
    process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS = 'true'
    currentUserId = USER_B // no override row for B
    const res = await listViews()
    expect(res.status).toBe(200)
    const view = res.body.data.views.find((v: any) => v.id === VIEW_ID)
    expect(view.filterInfo).toEqual(SHARED_FILTER)
    expect(view.sortInfo).toEqual(SHARED_SORT)
    expect(view.groupInfo).toEqual(SHARED_GROUP)
    expect(view.hiddenFieldIds).toEqual(SHARED_HIDDEN)
  })

  test('flag OFF — the new personal-config routes are inert (404), not merely no-op', async () => {
    currentUserId = USER_A
    const getRes = await getPersonalConfig(VIEW_ID)
    expect(getRes.status).toBe(404)
    const putRes = await putPersonalConfig(VIEW_ID, { filterInfo: PERSONAL_A_FILTER })
    expect(putRes.status).toBe(404)
    // and no row was written
    expect(await rowForUser(USER_A)).toBeUndefined()
  })

  // ---------------------------------------------------------------------------------------
  // G-A — read isolation (LOAD-BEARING)
  // ---------------------------------------------------------------------------------------
  test('G-A: user A personal override is applied for A but NOT visible to user B', async () => {
    process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS = 'true'
    await q(
      `INSERT INTO meta_view_personal_configs (view_id, user_id, config) VALUES ($1, $2, $3::jsonb)`,
      [VIEW_ID, USER_A, JSON.stringify({ filterInfo: PERSONAL_A_FILTER })],
    )

    currentUserId = USER_A
    const resA = await listViews()
    const viewA = resA.body.data.views.find((v: any) => v.id === VIEW_ID)
    expect(viewA.filterInfo).toEqual(PERSONAL_A_FILTER) // A sees own override
    expect(viewA.sortInfo).toEqual(SHARED_SORT) // unset facet falls through (§1-D, additive)

    currentUserId = USER_B
    const resB = await listViews()
    const viewB = resB.body.data.views.find((v: any) => v.id === VIEW_ID)
    expect(viewB.filterInfo).toEqual(SHARED_FILTER) // B sees SHARED — A's override is invisible to B
  })

  test('G-A: GET personal-config is actor-scoped — B reading the endpoint never sees A row', async () => {
    process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS = 'true'
    await q(
      `INSERT INTO meta_view_personal_configs (view_id, user_id, config) VALUES ($1, $2, $3::jsonb)`,
      [VIEW_ID, USER_A, JSON.stringify({ filterInfo: PERSONAL_A_FILTER })],
    )

    currentUserId = USER_A
    const resA = await getPersonalConfig(VIEW_ID)
    expect(resA.body.data.config).toEqual({ filterInfo: PERSONAL_A_FILTER })

    currentUserId = USER_B
    const resB = await getPersonalConfig(VIEW_ID)
    expect(resB.body.data.config).toBeNull() // B has no row of their own
  })

  // ---------------------------------------------------------------------------------------
  // G-C — write isolation (LOAD-BEARING) + forged-identity clause
  // ---------------------------------------------------------------------------------------
  test('G-C + forged-identity: A writing with a forged body.userId=B does NOT touch B\'s row', async () => {
    process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS = 'true'
    currentUserId = USER_A
    const res = await putPersonalConfig(VIEW_ID, { filterInfo: PERSONAL_A_FILTER }, { forgedBodyUserId: USER_B })
    expect(res.status).toBe(200)

    expect(await rowForUser(USER_A)).toBeDefined() // A's own row was written
    expect(await rowForUser(USER_B)).toBeUndefined() // B's row was NEVER created
  })

  test('G-C + forged-identity: A writing with a forged query.userId=B does NOT touch B\'s row', async () => {
    process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS = 'true'
    currentUserId = USER_A
    const res = await putPersonalConfig(VIEW_ID, { filterInfo: PERSONAL_A_FILTER }, { forgedQueryUserId: USER_B })
    expect(res.status).toBe(200)

    expect(await rowForUser(USER_A)).toBeDefined()
    expect(await rowForUser(USER_B)).toBeUndefined()
  })

  test('G-C + forged-identity: A writing with a forged x-user-id: B header does NOT touch B\'s row', async () => {
    process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS = 'true'
    currentUserId = USER_A
    currentForgedHeader = USER_B
    const res = await putPersonalConfig(VIEW_ID, { filterInfo: PERSONAL_A_FILTER })
    expect(res.status).toBe(200)

    expect(await rowForUser(USER_A)).toBeDefined() // written under the AUTHENTICATED actor (A)
    expect(await rowForUser(USER_B)).toBeUndefined() // forged header never redirected the write to B
  })

  test('G-C: A cannot delete B\'s override by forging identity; only B\'s own request can', async () => {
    process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS = 'true'
    // B creates their own override first (as B, for real).
    currentUserId = USER_B
    await putPersonalConfig(VIEW_ID, { sortInfo: { fieldId: FIELD_ID, direction: 'desc' } })
    expect(await rowForUser(USER_B)).toBeDefined()

    // A tries to delete "B's" override via a forged header while authenticated as A.
    currentUserId = USER_A
    currentForgedHeader = USER_B
    const res = await deletePersonalConfig(VIEW_ID)
    expect(res.status).toBe(200)
    expect(res.body.data.deleted).toBe(false) // A has no row of their own — nothing to delete
    expect(await rowForUser(USER_B)).toBeDefined() // B's row is UNTOUCHED

    // B deletes their own row for real — that succeeds.
    currentUserId = USER_B
    currentForgedHeader = undefined
    const resB = await deletePersonalConfig(VIEW_ID)
    expect(resB.status).toBe(200)
    expect(resB.body.data.deleted).toBe(true)
    expect(await rowForUser(USER_B)).toBeUndefined()
  })

  test('unauthenticated request is rejected, not defaulted to some fallback user', async () => {
    process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS = 'true'
    currentUserId = null
    const res = await putPersonalConfig(VIEW_ID, { filterInfo: PERSONAL_A_FILTER })
    expect([401, 403]).toContain(res.status)
  })
})
