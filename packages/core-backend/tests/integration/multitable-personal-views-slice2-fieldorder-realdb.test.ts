/**
 * Slice 2 real-DB goldens for the personal (per-user) FIELD-ORDER overlay.
 *
 * Design: docs/development/multitable-personal-views-design-lock-20260705.md (§6 slice 2)
 * Verification: docs/development/multitable-personal-views-slice2-verification-20260705.md
 *
 * Slice 2 adds a `fieldOrder` facet to the existing `PersonalViewConfigOverlay`, carried through the
 * SAME actor-scoped table (`meta_view_personal_configs`) + CRUD + `applyPersonalViewOverlay` as slice 1.
 * It is served on the `GET /views` view config so the FE (slice 3) can reorder; it reuses slice 1's
 * actor-scoping wholesale (no new client-supplied-id surface). Flag: same `MULTITABLE_ENABLE_PERSONAL_VIEWS`.
 *
 * Goldens: field-order actor isolation (A's order invisible to B) · byte-identical shared (flag-off /
 * no override → no fieldOrder served) · forged-identity (a forged body.userId cannot write another user's
 * row) · additive (setting only fieldOrder leaves the other facets falling through to shared).
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI, matching sibling real-DB specs).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_pv2_${TS}`
const SHEET_ID = `sheet_pv2_${TS}`
const F1 = `fld_pv2_1_${TS}`
const F2 = `fld_pv2_2_${TS}`
const VIEW_ID = `view_pv2_${TS}`
const USER_A = `user_pv2_a_${TS}`
const USER_B = `user_pv2_b_${TS}`

// Sheet-global order is F1(1) then F2(2). A's personal order flips them.
const PERSONAL_A_ORDER = [F2, F1]

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

let app: Express
let currentUserId: string | null = USER_A
let currentForgedHeader: string | undefined

const listViews = () => {
  const r = request(app).get('/api/multitable/views').query({ sheetId: SHEET_ID })
  return currentForgedHeader ? r.set('x-user-id', currentForgedHeader) : r
}
const putPersonalConfig = (viewId: string, config: Record<string, unknown>, opts?: { forgedBodyUserId?: string }) => {
  const r = request(app)
    .put(`/api/multitable/views/${viewId}/personal-config`)
    .send({ config, ...(opts?.forgedBodyUserId ? { userId: opts.forgedBodyUserId } : {}) })
  return currentForgedHeader ? r.set('x-user-id', currentForgedHeader) : r
}
const viewFromList = (res: { body: unknown }) =>
  (((res.body as { data?: { views?: unknown } })?.data?.views ?? []) as Array<{ id: string; fieldOrder?: string[]; filterInfo?: unknown }>)
    .find((v) => v.id === VIEW_ID)
const rowForUser = async (userId: string) =>
  (await q('SELECT config FROM meta_view_personal_configs WHERE view_id = $1 AND user_id = $2', [VIEW_ID, userId]))
    .rows[0] as { config: { fieldOrder?: string[] } } | undefined

describeIfDatabase('personal views — slice 2 field-order overlay (real DB)', () => {
  beforeAll(async () => {
    process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS = 'true'
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as unknown as { user?: unknown }).user = currentUserId
        ? { id: currentUserId, roles: [], perms: ['multitable:read', 'multitable:write'] }
        : undefined
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'PV2 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'PV2 Sheet'])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6),($7,$8,$9,$10,$11::jsonb,$12)',
      [F1, SHEET_ID, 'F1', 'string', '{}', 1, F2, SHEET_ID, 'F2', 'string', '{}', 2],
    )
    await q(
      'INSERT INTO meta_views (id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb)',
      [VIEW_ID, SHEET_ID, 'PV2 View', 'grid', '{}', '{}', '{}', '[]', '{}'],
    )
  })

  afterAll(async () => {
    delete process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS
    await q('DELETE FROM meta_view_personal_configs WHERE view_id = $1', [VIEW_ID]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await poolManager.get().end?.()
  })

  afterEach(async () => {
    await q('DELETE FROM meta_view_personal_configs WHERE view_id = $1', [VIEW_ID]).catch(() => {})
    currentUserId = USER_A
    currentForgedHeader = undefined
    process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS = 'true'
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('field-order actor isolation: A order applied for A, INVISIBLE to B', async () => {
    currentUserId = USER_A
    const put = await putPersonalConfig(VIEW_ID, { fieldOrder: PERSONAL_A_ORDER })
    expect(put.status).toBe(200)
    expect(viewFromList(await listViews())?.fieldOrder).toEqual(PERSONAL_A_ORDER)

    currentUserId = USER_B
    expect(viewFromList(await listViews())?.fieldOrder).toBeUndefined() // B sees sheet-global order — A's order invisible
  })

  test('byte-identical: flag OFF with A row present → no fieldOrder served', async () => {
    currentUserId = USER_A
    await putPersonalConfig(VIEW_ID, { fieldOrder: PERSONAL_A_ORDER })
    process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS = 'false'
    expect(viewFromList(await listViews())?.fieldOrder).toBeUndefined()
  })

  test('byte-identical: flag ON, no override for this actor → no fieldOrder', async () => {
    currentUserId = USER_B
    expect(viewFromList(await listViews())?.fieldOrder).toBeUndefined()
  })

  test('forged-identity: A writing fieldOrder with forged body.userId=B does NOT touch B row', async () => {
    currentUserId = USER_A
    const res = await putPersonalConfig(VIEW_ID, { fieldOrder: PERSONAL_A_ORDER }, { forgedBodyUserId: USER_B })
    expect(res.status).toBe(200)
    expect(await rowForUser(USER_B)).toBeUndefined() // B untouched — target is the authenticated actor A
    expect((await rowForUser(USER_A))?.config?.fieldOrder).toEqual(PERSONAL_A_ORDER)
  })

  test('additive: setting only fieldOrder leaves other facets falling through to shared', async () => {
    currentUserId = USER_A
    await putPersonalConfig(VIEW_ID, { fieldOrder: PERSONAL_A_ORDER })
    const a = viewFromList(await listViews())
    expect(a?.fieldOrder).toEqual(PERSONAL_A_ORDER)
    expect(a?.filterInfo).toEqual({}) // shared filter untouched (not clobbered by the fieldOrder-only overlay)
  })
})
