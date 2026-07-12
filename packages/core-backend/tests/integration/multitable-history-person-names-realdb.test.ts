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
 *   G4 LOCK-3 (layer-2): a person inside a property-HIDDEN person field appears NOWHERE. Authored as a
 *      tripwire when layer-2 hiding was a platform no-op on person fields; FLIPPED to this deny assertion
 *      once #4165 fixed it. Layer-2 is now a SECOND independent exclusion, alongside G3's layer-3.
 *
 * MUTATION MATRIX (12 combinations, measured — independently re-run by the #4161 adversarial review).
 * The leak is guarded three times: (i) the `changed_field_ids` filter (`allowed.has`) → a denied person field
 * never becomes a person-field candidate; (ii) the name loop's `allowed.has` re-check; (iii) the id harvest
 * reads the POST-MASK `changes`, never a raw snapshot.
 *   NOTE (review NIT-2): (i) and (ii) are the SAME predicate applied twice — defense-in-depth, not two
 *   independent properties. The genuinely independent guard is (iii).
 *
 * Two flavors of breaking (iii) matter, and they say OPPOSITE things about G3:
 *   - (iii-a) harvest this batch's RAW rows → also loses the hydrated before-image
 *   - (iii-b) harvest raw snapshots AND the raw, UNMASKED hydrated prev-snapshot → before-image still works
 *             (this is the MORE REALISTIC refactor: "just read the snapshots directly")
 *
 *   | breaks            | G1    | G2    | G3    | leak? |
 *   |-------------------|-------|-------|-------|-------|
 *   | none (as-is)      | GREEN | GREEN | GREEN |  –    |
 *   | any ONE           | see below, but NEVER a leak                   |
 *   | any TWO           | never a leak                                  |
 *   | i + ii + iii-a    | RED   | RED   | RED   | LEAK  |
 *   | i + ii + iii-b    | GREEN | GREEN | **RED** | LEAK |
 *
 * So, precisely:
 *   - The leak needs ALL THREE broken — no single or double break reds G3 (upheld).
 *   - G1/G2 are load-bearing for CORRECTNESS (they red under iii-a).
 *   - **G3 is NOT merely a redundant last line.** Under (iii-b) — the refactor someone would actually write —
 *     **G1 and G2 stay GREEN and G3 is the SOLE detector of the leak.** An earlier version of this header
 *     called G3 "triply-redundant"; that undersold it and is corrected here.
 *   (Mutation-red proves a guard is load-bearing for its layer; it is not by itself a reachability claim.)
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
const PERSON_HIDDEN = `fld_pn_hid_${TS}` // layer-2 property.hidden person field (a NO-OP on person — see G4)
const REC = `rec_pn_${TS}`
const BATCH_PRIOR = `batch_pn_prior_${TS}`
const BATCH = `batch_pn_${TS}`

const VIEWER = `user_pn_viewer_${TS}` // the actor
const P_KEPT = `user_pn_kept_${TS}` // still in the cell after the change
const P_REMOVED = `user_pn_removed_${TS}` // REMOVED by this change — the whole point
const P_INACTIVE = `user_pn_inactive_${TS}` // deactivated (is_active = false)
const P_SECRET = `user_pn_secret_${TS}` // ONLY in the DENIED field — must never surface
const P_HIDDEN = `user_pn_hidden_${TS}` // ONLY in the layer-2 property-hidden field (G4 tripwire)

const KEPT_NAME = 'Kept Person'
const REMOVED_NAME = 'Removed Person'
const INACTIVE_NAME = 'Inactive Person'
const SECRET_NAME = 'SecretPersonMustNeverAppear'
const HIDDEN_NAME = 'Layer2HiddenPerson'

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
    await addUser(P_HIDDEN, HIDDEN_NAME)

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'PersonNames Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'PN Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [PERSON_OK, SHEET_ID, 'Assignees', 'person', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [PERSON_DENIED, SHEET_ID, 'SecretAssignees', 'person', '{}', 2])
    // layer-2 property-hidden person field — which the platform does NOT actually hide (G4 tripwire).
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [PERSON_HIDDEN, SHEET_ID, 'HiddenAssignees', 'person', '{"hidden":true}', 3])
    // layer-3: VIEWER cannot read PERSON_DENIED ⇒ its VALUES (and thus its userIds) are dropped post-mask.
    await q(
      `INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,'user',$3,false,false)`,
      [SHEET_ID, PERSON_DENIED, VIEWER],
    )

    // v1 (prior batch): the person cell holds THREE people; the denied field holds the secret person.
    await insertRevision(1, BATCH_PRIOR, { [PERSON_OK]: [P_KEPT, P_REMOVED, P_INACTIVE], [PERSON_DENIED]: [P_SECRET], [PERSON_HIDDEN]: [P_HIDDEN] }, [PERSON_OK, PERSON_DENIED, PERSON_HIDDEN])
    // v2 (BATCH under test): P_REMOVED and P_INACTIVE are removed — only P_KEPT survives in the current cell.
    // The denied field is listed as changed too, so its ids are in the RAW snapshot the projection reads.
    await insertRevision(2, BATCH, { [PERSON_OK]: [P_KEPT], [PERSON_DENIED]: [P_SECRET], [PERSON_HIDDEN]: [P_HIDDEN] }, [PERSON_OK, PERSON_DENIED, PERSON_HIDDEN])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    for (const u of [VIEWER, P_KEPT, P_REMOVED, P_INACTIVE, P_SECRET, P_HIDDEN]) await q('DELETE FROM users WHERE id = $1', [u]).catch(() => {})
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

  /**
   * G4 — DENY ASSERTION (flipped 2026-07-12, once the platform fix landed).
   *
   * This test was authored as a CURRENT-REALITY TRIPWIRE: layer-2 `property.hidden` used to be a NO-OP on
   * native person fields (the `person` branch of `sanitizeFieldPropertyByType` was a closed allowlist that
   * silently dropped `hidden`/`visible`), so a "hidden" person field was readable at every surface. The
   * tripwire pinned that reality and said, in as many words, "flip this when the platform bug is fixed".
   *
   * It is fixed (#4165 `30d2acb17`): `withLayer2VisibilityKeys` now carries the layer-2 keys across EVERY
   * type's sanitizer, in BOTH sanitizers. The tripwire duly went red — `expected undefined to be
   * 'Layer2HiddenPerson'` — which is the tripwire working, not a regression. It is now flipped to the
   * assertion it always wanted to be:
   *
   *   a layer-2 property-hidden PERSON field is masked, so its member NEVER reaches the directory resolver
   *   and their display NAME can never surface.
   *
   * This makes layer-2 a SECOND independent exclusion for `personNames`, alongside the layer-3
   * field_permissions exclusion G3 pins. Both layers now hold.
   */
  test('G4 LOCK-3 (layer-2): a person inside a property-HIDDEN person field appears NOWHERE', async () => {
    const res = await detail(BATCH)
    expect(res.status).toBe(200)
    const personNames = res.body?.data?.personNames

    // the hidden field's member is NOT resolved — not even to a raw id
    expect(personNames[P_HIDDEN]).toBeUndefined()

    // precondition (proves the layer-2 mask is actually on, so this is not vacuous):
    // the hidden field's VALUES are dropped upstream, exactly like the layer-3 denied field in G3
    const change = (res.body?.data?.changes ?? []).find((c: any) => c.recordId === REC)
    expect(change?.before?.[PERSON_HIDDEN]).toBeUndefined()
    expect(change?.after?.[PERSON_HIDDEN]).toBeUndefined()
    expect(change?.changedFieldIds).not.toContain(PERSON_HIDDEN)

    // WHOLE-BODY: neither the hidden member's id nor their display name may appear anywhere.
    const body = JSON.stringify(res.body)
    expect(body).not.toContain(HIDDEN_NAME)
    expect(body).not.toContain(P_HIDDEN)
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
