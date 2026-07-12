/**
 * Layer-2 field hiding must actually MASK the value — end-to-end — for `person` and `button`.
 *
 * The unit test (tests/unit/field-property-layer2-visibility.test.ts) proves the sanitizer now preserves
 * `hidden`/`visible` for these two types. This proves the consequence that actually matters: with the key
 * preserved, `isFieldPermissionHidden` sees it, the field leaves the two-layer allow-set, and the read
 * surface stops emitting the value.
 *
 * Read surface used: the History batch-detail projection, because it applies the canonical two-layer mask
 * (layer-2 property-hidden ∩ layer-3 field_permissions) via `allowedFieldsBySheet` — the same chain the
 * record read paths use. A field outside that set has its VALUES dropped by `filterDataByAllowedFields`
 * AND its id dropped from `changedFieldIds`.
 *
 * Structure (differential — the controls are what make it non-vacuous):
 *   - PERSON_HIDDEN  (person, property.hidden=true)   → value MUST be masked      ← was leaking
 *   - BUTTON_HIDDEN  (button, property.hidden=true)   → value MUST be masked      ← was leaking
 *   - PERSON_VISIBLE (person, no hidden)              → value MUST still be returned (non-vacuous control:
 *                                                       proves we did not just mask everything)
 *   - STRING_HIDDEN  (string, property.hidden=true)   → value MUST be masked (control: always worked, so a
 *                                                       green here proves the harness detects masking)
 *
 * MUTATION MATRIX (measured — and the reason the ROUTE goldens exist rather than inference):
 * the two record routes go through DIFFERENT sanitizers, which is only visible by mutating each half:
 *   - `GET /records` (list)        → univer-meta's `loadSheetFields` → **univer-meta's** sanitizer
 *   - `GET /records/:id` (single)  → `loaders.ts`                    → **field-codecs'** sanitizer
 *
 *   | mutation                      | list | single |
 *   |-------------------------------|------|--------|
 *   | remove univer-meta half only  | RED  | green  |
 *   | remove field-codecs half only | green| RED    |
 *   | remove BOTH                   | RED  | RED    |
 *
 * So each route golden pins a DIFFERENT half of the fix, and a single-module mutation would have missed
 * one. This is exactly why a permission-layer fix cannot be argued "platform-wide" from the fact that the
 * surfaces share a sanitizer — they don't all share the SAME one.
 *
 * KNOWN, ACCEPTED CONSEQUENCE (owner-decided, not changed here): making person/button genuinely hideable
 * also makes them able to trigger the pre-existing Yjs gate — `canReadEveryYjsFieldForUser` refuses the
 * whole Y.Doc if ANY field on the sheet is unreadable, so the client falls back to REST. That fail-closed is
 * the correct security boundary (a record-level Y.Doc cannot be field-masked); this change only widens the
 * set of field types that can trip it. A field-scoped Yjs design is a separate piece of work.
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
const BASE_ID = `base_l2_${TS}`
const SHEET_ID = `sheet_l2_${TS}`
const PERSON_HIDDEN = `fld_l2_ph_${TS}`
const BUTTON_HIDDEN = `fld_l2_bh_${TS}`
const PERSON_VISIBLE = `fld_l2_pv_${TS}`
const STRING_HIDDEN = `fld_l2_sh_${TS}`
const REC = `rec_l2_${TS}`
const BATCH = `batch_l2_${TS}`
const VIEWER = `user_l2_viewer_${TS}`
const P_SECRET = `user_l2_secret_${TS}` // only inside the HIDDEN person field
const P_OPEN = `user_l2_open_${TS}` // inside the VISIBLE person field
const BUTTON_CANARY = 'button-hidden-canary'
const STRING_CANARY = 'string-hidden-canary'

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
const detail = (batchId: string) => request(app).get(`/api/multitable/bases/${BASE_ID}/history/events/${batchId}`)
// The RECORD read routes — the surface on which the leak was originally confirmed. A permission fix must be
// pinned HERE, not inferred from a shared sanitizer across modules.
const recordsList = () => request(app).get('/api/multitable/records').query({ sheetId: SHEET_ID })
const singleRecord = () => request(app).get(`/api/multitable/records/${REC}`).query({ sheetId: SHEET_ID })

describeIfDatabase('layer-2 property.hidden masks person + button values (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: VIEWER, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }; next() })
    app.use('/api/multitable', univerMetaRouter())

    for (const u of [VIEWER, P_SECRET, P_OPEN]) {
      await q("INSERT INTO users (id, password_hash, name) VALUES ($1,'x',$2) ON CONFLICT (id) DO NOTHING", [u, `N_${u}`])
    }
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'L2 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'L2 Sheet'])
    const addField = (id: string, name: string, type: string, property: string, order: number) =>
      q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [id, SHEET_ID, name, type, property, order])
    await addField(PERSON_HIDDEN, 'HiddenPeople', 'person', '{"hidden":true}', 1)
    await addField(BUTTON_HIDDEN, 'HiddenButton', 'button', '{"hidden":true}', 2)
    await addField(PERSON_VISIBLE, 'OpenPeople', 'person', '{}', 3)
    await addField(STRING_HIDDEN, 'HiddenString', 'string', '{"hidden":true}', 4)

    // a LIVE record row — GET /records and GET /records/:id read meta_records (the revisions below drive the
    // History surface). Same four fields, so one fixture proves both surfaces.
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
      REC, SHEET_ID,
      JSON.stringify({
        [PERSON_HIDDEN]: [P_SECRET],
        [BUTTON_HIDDEN]: BUTTON_CANARY,
        [PERSON_VISIBLE]: [P_OPEN],
        [STRING_HIDDEN]: STRING_CANARY,
      }),
    ])

    await q(
      `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, patch, snapshot, batch_id)
       VALUES (gen_random_uuid(), $1, $2, 1, 'update', 'rest', $3, $4::text[], '{}'::jsonb, $5::jsonb, $6)`,
      [
        SHEET_ID, REC, VIEWER,
        [PERSON_HIDDEN, BUTTON_HIDDEN, PERSON_VISIBLE, STRING_HIDDEN],
        JSON.stringify({
          [PERSON_HIDDEN]: [P_SECRET],
          [BUTTON_HIDDEN]: BUTTON_CANARY,
          [PERSON_VISIBLE]: [P_OPEN],
          [STRING_HIDDEN]: STRING_CANARY,
        }),
        BATCH,
      ],
    )
  })

  afterAll(async () => {
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    for (const u of [VIEWER, P_SECRET, P_OPEN]) await q('DELETE FROM users WHERE id = $1', [u]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('a layer-2 hidden PERSON field is masked — its value, its member, and its field id all absent', async () => {
    const res = await detail(BATCH)
    expect(res.status).toBe(200)
    const change = (res.body?.data?.changes ?? []).find((c: any) => c.recordId === REC)
    expect(change).toBeTruthy()

    expect(change.after?.[PERSON_HIDDEN]).toBeUndefined() // value dropped
    expect(change.changedFieldIds).not.toContain(PERSON_HIDDEN) // field id dropped (no "it changed" oracle)
    // whole-body: the hidden member's id must not surface anywhere (incl. via personNames-style maps)
    expect(JSON.stringify(res.body)).not.toContain(P_SECRET)
  })

  test('a layer-2 hidden BUTTON field is masked (same rule, second affected type)', async () => {
    const res = await detail(BATCH)
    const change = (res.body?.data?.changes ?? []).find((c: any) => c.recordId === REC)
    expect(change.after?.[BUTTON_HIDDEN]).toBeUndefined()
    expect(change.changedFieldIds).not.toContain(BUTTON_HIDDEN)
    expect(JSON.stringify(res.body)).not.toContain(BUTTON_CANARY)
  })

  test('NON-VACUOUS: a VISIBLE person field is still returned (we did not simply mask everything)', async () => {
    const res = await detail(BATCH)
    const change = (res.body?.data?.changes ?? []).find((c: any) => c.recordId === REC)
    expect(change.after?.[PERSON_VISIBLE]).toEqual([P_OPEN])
    expect(change.changedFieldIds).toContain(PERSON_VISIBLE)
  })

  /**
   * THE ROUTES THE LEAK WAS ORIGINALLY CONFIRMED ON.
   *
   * The History batch-detail tests above prove the two-layer mask chain. They are NOT a substitute for these:
   * the originally-observed fact was that **`GET /records` returned the hidden person field's userId**. A
   * permission-layer fix must be pinned on the actual read routes, not inferred "platform-wide" from the fact
   * that both surfaces happen to share a sanitizer. Cross-module deduction is an argument, not a test.
   *
   * Asserted on BOTH the list and the single-record route: the hidden person's and hidden button's FIELD ID,
   * VALUE, and (for person) MEMBER ID are all absent; the visible person is still returned.
   */
  test('GET /records (list): a hidden person/button field is absent — field id, value, and member id', async () => {
    const res = await recordsList()
    expect(res.status).toBe(200)
    const rows = (res.body?.data?.records ?? res.body?.data ?? res.body?.records ?? []) as Array<Record<string, any>>
    const rec = rows.find((r) => r.id === REC)
    expect(rec).toBeTruthy()
    const data = (rec!.data ?? rec!.fields ?? rec) as Record<string, unknown>

    expect(data[PERSON_HIDDEN]).toBeUndefined()          // hidden PERSON: value gone
    expect(Object.keys(data)).not.toContain(PERSON_HIDDEN) // …and its field id gone
    expect(data[BUTTON_HIDDEN]).toBeUndefined()          // hidden BUTTON: same
    expect(data[PERSON_VISIBLE]).toEqual([P_OPEN])       // NON-VACUOUS: visible person still returned

    const body = JSON.stringify(res.body)
    expect(body).not.toContain(P_SECRET)      // the hidden member's user id, nowhere in the body
    expect(body).not.toContain(BUTTON_CANARY)
    expect(body).not.toContain(STRING_CANARY)
    expect(body).toContain(P_OPEN)            // control: the VISIBLE member does appear
  })

  test('GET /records/:recordId (single): same — hidden person/button absent, visible person returned', async () => {
    const res = await singleRecord()
    expect(res.status).toBe(200)
    const rec = (res.body?.data?.record ?? res.body?.data ?? res.body?.record ?? {}) as Record<string, any>
    const data = (rec.data ?? rec.fields ?? rec) as Record<string, unknown>

    expect(data[PERSON_HIDDEN]).toBeUndefined()
    expect(data[BUTTON_HIDDEN]).toBeUndefined()
    expect(data[PERSON_VISIBLE]).toEqual([P_OPEN])

    const body = JSON.stringify(res.body)
    expect(body).not.toContain(P_SECRET)
    expect(body).not.toContain(BUTTON_CANARY)
    expect(body).toContain(P_OPEN)
  })

  /**
   * The OTHER sanitizer. The tests above seed `property` via raw SQL, so they exercise only the READ-path
   * codec (field-codecs.ts). The HTTP field-WRITE path has its own sanitizer (`univer-meta.ts`'s
   * `sanitizeFieldProperty`, reached via `normalizeFieldWriteInput` from `PATCH /fields/:fieldId`), and it
   * had the SAME closed-allowlist person branch. Neutering ONLY that call site left every other test in this
   * PR green — an untested guard (review P2-2). This drives the real route so the write half is covered.
   */
  test('WRITE PATH (the univer-meta sanitizer): PATCH /fields persists property.hidden on a person field', async () => {
    const fid = `fld_l2_wp_${TS}`
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [fid, SHEET_ID, 'WritePathPerson', 'person', '{}', 5])

    const res = await request(app).patch(`/api/multitable/fields/${fid}`).send({ property: { hidden: true, limitSingleRecord: false } })
    expect(res.status).toBe(200)

    // It PERSISTED — this is exactly what the univer-meta half of the fix is responsible for. Without it,
    // the closed-allowlist person branch rebuilds `property` and the hide is dropped on the way in.
    const row = (await q('SELECT property FROM meta_fields WHERE id = $1', [fid])).rows[0] as { property: Record<string, unknown> }
    expect(row.property.hidden).toBe(true)
    // …and the type-specific sanitization still ran (the cross-cutting rule did not replace it)
    expect(row.property.limitSingleRecord).toBe(false)

    await q('DELETE FROM meta_fields WHERE id = $1', [fid]).catch(() => {})
  })

  test('CONTROL: a hidden STRING field was always masked — proves the harness detects masking at all', async () => {
    const res = await detail(BATCH)
    const change = (res.body?.data?.changes ?? []).find((c: any) => c.recordId === REC)
    expect(change.after?.[STRING_HIDDEN]).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain(STRING_CANARY)
  })
})
