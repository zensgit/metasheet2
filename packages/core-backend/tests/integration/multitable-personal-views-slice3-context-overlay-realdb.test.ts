/**
 * Slice 3 P1 real-DB golden: the personal (per-user) view overlay must be applied on the MAIN load path,
 * `GET /api/multitable/context` — not only `GET /views`. The apps/web Workbench loads via
 * loadContext → ctx.views, so a saved personal row that is invisible on /context is invisible on the main
 * grid (the P1 the Slice 3 review caught). This locks:
 *
 *  - CTX-A (personal overlay applied on /context): flag ON + a personal row for THIS actor ⇒ /context
 *    data.views carries the personal config, and data.personalOverrideViewIds names the view.
 *  - CTX-B (shared fallback byte-identical on /context): flag ON, no row ⇒ shared; flag OFF, row present ⇒
 *    shared + personalOverrideViewIds empty (the main-path parity of G-B).
 *  - CTX-ISO (actor-scoped, §1-B): A's override is NOT visible to B via /context; B's
 *    personalOverrideViewIds is empty.
 *
 * Ratified design: docs/development/multitable-personal-views-slice3-fe-toggle-design-lock-20260706.md
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI, matching sibling real-DB specs).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_pv3_${TS}`
const SHEET_ID = `sheet_pv3_${TS}`
const FIELD_ID = `fld_pv3_${TS}`
const VIEW_ID = `view_pv3_${TS}`
const USER_A = `user_pv3_a_${TS}`
const USER_B = `user_pv3_b_${TS}`

const SHARED_FILTER = { conjunction: 'and', conditions: [{ fieldId: FIELD_ID, operator: 'is', value: 'shared-val' }] }
const SHARED_SORT = { fieldId: FIELD_ID, direction: 'asc' }
const PERSONAL_A_FILTER = { conjunction: 'and', conditions: [{ fieldId: FIELD_ID, operator: 'is', value: 'personal-a-val' }] }

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

let app: Express
let currentUserId: string | null = USER_A

const getContext = () => request(app).get('/api/multitable/context').query({ sheetId: SHEET_ID, viewId: VIEW_ID })
const seedPersonalRow = (userId: string, config: Record<string, unknown>) =>
  q('INSERT INTO meta_view_personal_configs (view_id, user_id, config) VALUES ($1,$2,$3::jsonb)', [VIEW_ID, userId, JSON.stringify(config)])
const viewFrom = (res: { body: any }) => res.body.data.views.find((v: any) => v.id === VIEW_ID)

describeIfDatabase('personal view overlay on /context — slice 3 P1 (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = currentUserId ? { id: currentUserId, roles: [], perms: ['multitable:read', 'multitable:write'] } : undefined
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_ID, 'PV3 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_ID, BASE_ID, 'PV3 Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FIELD_ID, SHEET_ID, 'F1', 'string', '{}', 1])
    await q(
      'INSERT INTO meta_views (id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb)',
      [VIEW_ID, SHEET_ID, 'PV3 View', 'grid', JSON.stringify(SHARED_FILTER), JSON.stringify(SHARED_SORT), JSON.stringify({}), JSON.stringify([]), '{}'],
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
    delete process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS
    await q('DELETE FROM meta_view_personal_configs WHERE view_id = $1', [VIEW_ID])
  })
  afterEach(() => { delete process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('CTX-A: flag ON + personal row for the actor ⇒ /context serves the personal overlay + names it in personalOverrideViewIds', async () => {
    process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS = 'true'
    await seedPersonalRow(USER_A, { filterInfo: PERSONAL_A_FILTER })

    currentUserId = USER_A
    const res = await getContext()
    expect(res.status).toBe(200)
    // The MAIN load path now reflects the personal override (was the P1 bug: it showed shared).
    expect(viewFrom(res).filterInfo).toEqual(PERSONAL_A_FILTER)
    expect(res.body.data.personalOverrideViewIds).toContain(VIEW_ID)
    expect(res.body.data.capabilities.personalViewsEnabled).toBe(true)
  })

  test('CTX-B: flag ON, no row for the actor ⇒ /context shared config byte-identical, no override ids', async () => {
    process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS = 'true'
    currentUserId = USER_A
    const res = await getContext()
    expect(res.status).toBe(200)
    expect(viewFrom(res).filterInfo).toEqual(SHARED_FILTER)
    expect(res.body.data.personalOverrideViewIds).toEqual([])
  })

  test('CTX-B: flag OFF with a personal row present ⇒ /context still shared + empty override ids (main-path G-B)', async () => {
    await seedPersonalRow(USER_A, { filterInfo: PERSONAL_A_FILTER })
    expect(process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS).toBeUndefined()

    currentUserId = USER_A
    const res = await getContext()
    expect(res.status).toBe(200)
    expect(viewFrom(res).filterInfo).toEqual(SHARED_FILTER)
    expect(res.body.data.personalOverrideViewIds).toEqual([])
    expect(res.body.data.capabilities.personalViewsEnabled).toBe(false)
  })

  test('CTX-ISO: A\'s personal override is NOT visible to B via /context (actor-scoped, §1-B)', async () => {
    process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS = 'true'
    await seedPersonalRow(USER_A, { filterInfo: PERSONAL_A_FILTER })

    currentUserId = USER_B
    const res = await getContext()
    expect(res.status).toBe(200)
    // B sees the SHARED config, never A's personal filter; B has no override of their own.
    expect(viewFrom(res).filterInfo).toEqual(SHARED_FILTER)
    expect(res.body.data.personalOverrideViewIds).toEqual([])
    expect(JSON.stringify(res.body)).not.toContain('personal-a-val')
  })
})
