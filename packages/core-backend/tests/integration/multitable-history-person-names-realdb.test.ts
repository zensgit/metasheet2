/**
 * Person before-side name resolution — batch-detail `personNames` directory map (real DB).
 *
 * THE PROBLEM: the grid's `personSummaries` cache only knows a record's CURRENT cell. A person REMOVED by
 * the very change you are looking at is, by definition, no longer in the current cell — so the History diff
 * rendered them as a raw `userId`. "Who was removed" was unreadable. `loadHistoryBatchDetail` now emits
 * `personNames: { [userId]: { display, inactive? } }` covering every userId in the batch's (post-mask)
 * person values, BOTH sides, resolved from the SAME directory as `actorName`.
 *
 * THE LOCK-3 PROPERTY: a person inside a field_permissions-DENIED person field must never surface — and
 * leaking their display NAME would be strictly worse than leaking the raw id. G3 pins that with a
 * whole-body assertion.
 *
 * Goldens:
 *   G1 the REMOVED person (present in `before`, gone from `after`) resolves to a display name — the point.
 *   G2 a deactivated user carries `inactive: true` (OD-P2; same `users.is_active === false` rule as the grid).
 *   G3 LOCK-3: a person in a field_permissions-DENIED person field appears NOWHERE — not in personNames,
 *      not anywhere in the response body (whole-body assertion).
 *
 * MUTATION MATRIX (measured, not asserted — stating exactly what each golden is load-bearing FOR):
 *   The leak is guarded THREE independent times: (i) `involvedFieldsBySheet` accumulates from the POST-MASK
 *   `fields`, so a denied person field never even becomes a person-field candidate; (ii) the name loop
 *   re-checks `allowed.has`; (iii) the id harvest reads the POST-MASK `changes`, never a raw snapshot.
 *     - break (ii) alone              → 4/4 still GREEN (no leak — (i)+(iii) hold)
 *     - break (iii) alone             → G1+G2 RED (the removed/inactive people live only on the HYDRATED
 *                                       `before` side, absent from this batch's raw rows), but NO leak
 *     - break (ii)+(iii)              → G1+G2 RED, still NO leak (guard (i) alone suffices)
 *     - break ALL THREE               → G3 RED: the denied person's display NAME surfaces in the body
 *   So: **G1/G2 are load-bearing for correctness** (they red on a real refactor). **G3 is non-vacuous but
 *   triply-redundant** — it is the last line, not the only line. Do not read a green G3 as "the mask works";
 *   read it as "all three guards would have to fail together." (Mutation-red proves load-bearing for a layer;
 *   it does not by itself prove a reachable vulnerability.)
 *
 * Runs only with DATABASE_URL. (plugin-tests.yml whitelist — two-point wiring.)
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE_ID = `base_pn_${TS}`
const SHEET_ID = `sheet_pn_${TS}`
const PERSON_OK = `fld_pn_ok_${TS}` // readable person field
const PERSON_DENIED = `fld_pn_den_${TS}` // layer-3 field_permissions-denied person field
const REC = `rec_pn_${TS}`
const BATCH_PRIOR = `batch_pn_prior_${TS}`
const BATCH = `batch_pn_${TS}`

const VIEWER = `user_pn_viewer_${TS}` // the actor
const P_KEPT = `user_pn_kept_${TS}` // still in the cell after the change
const P_REMOVED = `user_pn_removed_${TS}` // REMOVED by this change — the whole point
const P_INACTIVE = `user_pn_inactive_${TS}` // deactivated (is_active = false)
const P_SECRET = `user_pn_secret_${TS}` // ONLY in the DENIED field — must never surface

const KEPT_NAME = 'Kept Person'
const REMOVED_NAME = 'Removed Person'
const INACTIVE_NAME = 'Inactive Person'
const SECRET_NAME = 'SecretPersonMustNeverAppear'

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express

const detail = (batchId: string) => request(app).get(`/api/multitable/bases/${BASE_ID}/history/events/${batchId}`)

const addUser = (id: string, name: string, isActive = true) =>
  q(
    "INSERT INTO users (id, password_hash, name, is_active) VALUES ($1,'x',$2,$3) ON CONFLICT (id) DO NOTHING",
    [id, name, isActive],
  )

const insertRevision = (version: number, batchId: string, snapshot: Record<string, unknown>, changed: string[]) =>
  q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, patch, snapshot, batch_id)
     VALUES (gen_random_uuid(), $1, $2, $3, 'update', 'rest', $4, $5::text[], '{}'::jsonb, $6::jsonb, $7)`,
    [SHEET_ID, REC, version, VIEWER, changed, JSON.stringify(snapshot), batchId],
  )

describeIfDatabase('person before-side name resolution — batch-detail personNames (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: VIEWER, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }; next() })
    app.use('/api/multitable', univerMetaRouter())

    await addUser(VIEWER, 'Viewer')
    await addUser(P_KEPT, KEPT_NAME)
    await addUser(P_REMOVED, REMOVED_NAME)
    await addUser(P_INACTIVE, INACTIVE_NAME, false) // 2c-S4: is_active = false ⇒ inactive
    await addUser(P_SECRET, SECRET_NAME)

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'PersonNames Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'PN Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [PERSON_OK, SHEET_ID, 'Assignees', 'person', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [PERSON_DENIED, SHEET_ID, 'SecretAssignees', 'person', '{}', 2])
    // layer-3: VIEWER cannot read PERSON_DENIED ⇒ its VALUES (and thus its userIds) are dropped post-mask.
    await q(
      `INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,'user',$3,false,false)`,
      [SHEET_ID, PERSON_DENIED, VIEWER],
    )

    // v1 (prior batch): the person cell holds THREE people; the denied field holds the secret person.
    await insertRevision(1, BATCH_PRIOR, { [PERSON_OK]: [P_KEPT, P_REMOVED, P_INACTIVE], [PERSON_DENIED]: [P_SECRET] }, [PERSON_OK, PERSON_DENIED])
    // v2 (BATCH under test): P_REMOVED and P_INACTIVE are removed — only P_KEPT survives in the current cell.
    // The denied field is listed as changed too, so its ids are in the RAW snapshot the projection reads.
    await insertRevision(2, BATCH, { [PERSON_OK]: [P_KEPT], [PERSON_DENIED]: [P_SECRET] }, [PERSON_OK, PERSON_DENIED])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    for (const u of [VIEWER, P_KEPT, P_REMOVED, P_INACTIVE, P_SECRET]) await q('DELETE FROM users WHERE id = $1', [u]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('G1 the REMOVED person (in before, gone from after) resolves to a display name — the whole point', async () => {
    const res = await detail(BATCH)
    expect(res.status).toBe(200)
    const personNames = res.body?.data?.personNames
    expect(personNames && typeof personNames === 'object').toBe(true)

    // The removed person is NOT in the record's current cell, so the grid cache could never supply this.
    expect(personNames[P_REMOVED]).toBeTruthy()
    expect(personNames[P_REMOVED].display).toBe(REMOVED_NAME)
    // the surviving person resolves too (both sides are covered)
    expect(personNames[P_KEPT]?.display).toBe(KEPT_NAME)

    // and the before side genuinely still carries the removed id (i.e. this isn't vacuous)
    const change = (res.body?.data?.changes ?? []).find((c: any) => c.recordId === REC)
    expect(change?.before?.[PERSON_OK]).toEqual([P_KEPT, P_REMOVED, P_INACTIVE])
    expect(change?.after?.[PERSON_OK]).toEqual([P_KEPT])
  })

  test('G2 a deactivated user carries inactive:true (OD-P2, same users.is_active rule as the grid)', async () => {
    const res = await detail(BATCH)
    const personNames = res.body?.data?.personNames
    expect(personNames[P_INACTIVE]?.display).toBe(INACTIVE_NAME)
    expect(personNames[P_INACTIVE]?.inactive).toBe(true)
    // an ACTIVE user must NOT be marked (otherwise the marker is meaningless)
    expect(personNames[P_KEPT]?.inactive).toBeUndefined()
  })

  test('G3 LOCK-3: a person inside a field_permissions-DENIED person field appears NOWHERE', async () => {
    const res = await detail(BATCH)
    expect(res.status).toBe(200)
    const personNames = res.body?.data?.personNames

    // not in the directory map — neither the id nor the name
    expect(personNames[P_SECRET]).toBeUndefined()

    // the denied field's VALUES are dropped upstream (precondition — proves the mask is actually on)
    const change = (res.body?.data?.changes ?? []).find((c: any) => c.recordId === REC)
    expect(change?.before?.[PERSON_DENIED]).toBeUndefined()
    expect(change?.after?.[PERSON_DENIED]).toBeUndefined()

    // WHOLE-BODY: neither the secret user's id nor their display name may appear anywhere in the response.
    // (Harvesting ids from the RAW snapshot instead of post-mask `changes` would leak the NAME here.)
    const body = JSON.stringify(res.body)
    expect(body).not.toContain(SECRET_NAME)
    expect(body).not.toContain(P_SECRET)
  })
})
