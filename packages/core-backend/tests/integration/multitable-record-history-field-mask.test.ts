/**
 * Real-DB integration test for F1 — record history response field mask.
 * Design-lock: docs/development/multitable-record-history-field-mask-design-20260530.md (#2144).
 *
 * Record history already has sheet + record read gates, but pre-F1 it returned revision `patch`,
 * `snapshot`, and `changedFieldIds` verbatim. This suite proves the response is now filtered by
 * the same layer-2 and layer-3 allowed-field set used by the interactive read paths.
 *
 * Seed non-negotiable: FLD_SECRET.property = {} so the deny is solely layer-3
 * (field_permissions.visible=false). FLD_STATIC_HIDDEN has property.hidden=true and no
 * field-permission row, proving layer-2 also applies.
 */
import { randomUUID } from 'crypto'
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_f1hist_${TS}`
const SHEET_ID = `sheet_f1hist_${TS}`
const RECORD_ID = `rec_f1hist_${TS}`
const MISSING_RECORD_ID = `rec_f1hist_missing_${TS}`
const FLD_VISIBLE = `fld_f1hist_visible_${TS}`
const FLD_SECRET = `fld_f1hist_secret_${TS}`
const FLD_STATIC_HIDDEN = `fld_f1hist_static_hidden_${TS}`
const USER_DENIED = `u_f1hist_denied_${TS}`
const USER_ALLOWED = `u_f1hist_allowed_${TS}`
const VISIBLE_CANARY = 'visible-history-canary'
const SECRET_CANARY = 'do-not-leak-history-secret'
const STATIC_HIDDEN_CANARY = 'do-not-leak-history-static-hidden'

type RevisionBody = {
  version: number
  changedFieldIds: string[]
  patch: Record<string, unknown>
  snapshot: Record<string, unknown> | null
}

let app: Express
let testUserId = USER_DENIED
let testPerms: string[] = ['multitable:read']

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const historyReq = (recordId = RECORD_ID) =>
  request(app).get(`/api/multitable/sheets/${SHEET_ID}/records/${recordId}/history`)

function itemsOf(res: { body: { data?: { items?: RevisionBody[] } } }): RevisionBody[] {
  return res.body.data?.items ?? []
}

function versionOf(res: { body: { data?: { items?: RevisionBody[] } } }, version: number): RevisionBody {
  const item = itemsOf(res).find((entry) => entry.version === version)
  expect(item).toBeDefined()
  return item as RevisionBody
}

describeIfDatabase('F1 record history field mask (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = testUserId ? { id: testUserId, roles: [], perms: testPerms } : undefined
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'F1 History Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'F1 History Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_VISIBLE, SHEET_ID, 'Visible', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SECRET, SHEET_ID, 'Secret', 'string', '{}', 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_STATIC_HIDDEN, SHEET_ID, 'Static Hidden', 'string', '{"hidden":true}', 3])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [
      RECORD_ID,
      SHEET_ID,
      JSON.stringify({
        [FLD_VISIBLE]: VISIBLE_CANARY,
        [FLD_SECRET]: SECRET_CANARY,
        [FLD_STATIC_HIDDEN]: STATIC_HIDDEN_CANARY,
      }),
    ])
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_SECRET, 'user', USER_DENIED, false, false])

    await q(
      `INSERT INTO meta_record_revisions (
         id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, patch, snapshot
       )
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::text[],$9::jsonb,$10::jsonb)`,
      [
        randomUUID(),
        SHEET_ID,
        RECORD_ID,
        2,
        'update',
        'rest',
        USER_ALLOWED,
        [FLD_VISIBLE, FLD_SECRET, FLD_STATIC_HIDDEN],
        JSON.stringify({
          [FLD_VISIBLE]: VISIBLE_CANARY,
          [FLD_SECRET]: SECRET_CANARY,
          [FLD_STATIC_HIDDEN]: STATIC_HIDDEN_CANARY,
        }),
        JSON.stringify({
          [FLD_VISIBLE]: VISIBLE_CANARY,
          [FLD_SECRET]: SECRET_CANARY,
          [FLD_STATIC_HIDDEN]: STATIC_HIDDEN_CANARY,
        }),
      ],
    )
    await q(
      `INSERT INTO meta_record_revisions (
         id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, patch, snapshot
       )
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::text[],$9::jsonb,$10::jsonb)`,
      [
        randomUUID(),
        SHEET_ID,
        RECORD_ID,
        1,
        'create',
        'rest',
        USER_ALLOWED,
        [FLD_VISIBLE],
        JSON.stringify({ [FLD_VISIBLE]: VISIBLE_CANARY }),
        null,
      ],
    )
  })

  beforeEach(() => {
    testUserId = USER_DENIED
    testPerms = ['multitable:read']
  })

  afterAll(async () => {
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('R1: denied layer-3 field values are absent from patch and snapshot while visible values remain', async () => {
    const res = await historyReq()
    expect(res.status).toBe(200)
    const item = versionOf(res, 2)

    expect(item.patch[FLD_VISIBLE]).toBe(VISIBLE_CANARY)
    expect(item.snapshot?.[FLD_VISIBLE]).toBe(VISIBLE_CANARY)
    expect(item.patch[FLD_SECRET]).toBeUndefined()
    expect(item.snapshot?.[FLD_SECRET]).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain(SECRET_CANARY)
  })

  test('R2: changedFieldIds drops denied fields and stays aligned with the visible patch keys', async () => {
    const res = await historyReq()
    expect(res.status).toBe(200)
    const item = versionOf(res, 2)

    expect(item.changedFieldIds).toContain(FLD_VISIBLE)
    expect(item.changedFieldIds).not.toContain(FLD_SECRET)
    expect(item.changedFieldIds).not.toContain(FLD_STATIC_HIDDEN)
  })

  test('R3: static-hidden field values are absent without relying on a field_permissions row', async () => {
    const res = await historyReq()
    expect(res.status).toBe(200)
    const item = versionOf(res, 2)

    expect(item.patch[FLD_STATIC_HIDDEN]).toBeUndefined()
    expect(item.snapshot?.[FLD_STATIC_HIDDEN]).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain(STATIC_HIDDEN_CANARY)
  })

  test('R4: a readable subject with no layer-3 deny still sees the non-static secret value', async () => {
    testUserId = USER_ALLOWED
    testPerms = ['multitable:read']

    const res = await historyReq()
    expect(res.status).toBe(200)
    const item = versionOf(res, 2)
    expect(item.patch[FLD_SECRET]).toBe(SECRET_CANARY)
    expect(item.snapshot?.[FLD_SECRET]).toBe(SECRET_CANARY)
    expect(JSON.stringify(res.body)).toContain(SECRET_CANARY)
  })

  test('R5: existing authz guard remains intact for non-readers', async () => {
    testPerms = []
    const res = await historyReq()
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).not.toContain(SECRET_CANARY)
  })

  test('R6: existing record gate remains intact for missing records', async () => {
    const res = await historyReq(MISSING_RECORD_ID)
    expect(res.status).toBe(404)
  })

  test('R7: null snapshots stay null', async () => {
    const res = await historyReq()
    expect(res.status).toBe(200)
    expect(versionOf(res, 1).snapshot).toBeNull()
  })
})
