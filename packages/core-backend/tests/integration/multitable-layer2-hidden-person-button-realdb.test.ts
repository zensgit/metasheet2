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

  test('CONTROL: a hidden STRING field was always masked — proves the harness detects masking at all', async () => {
    const res = await detail(BATCH)
    const change = (res.body?.data?.changes ?? []).find((c: any) => c.recordId === REC)
    expect(change.after?.[STRING_HIDDEN]).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain(STRING_CANARY)
  })
})
