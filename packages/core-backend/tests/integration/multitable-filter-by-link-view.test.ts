/**
 * 2a filter-by-link (first cut) — real-DB /view wire + permission goldens.
 *
 * Proves a `link`-field filter condition compares against the linked records' PERMISSION-FILTERED display
 * strings through the real GET /view handler (wire-vs-fixture-drift guard), and that the design-lock's
 * permission invariants hold end-to-end (multitable-2a-filter-by-link-lookup-designlock §2 / D1·D2·D5·D6):
 *
 *   D1/D6 value ops: `is` = membership over visible displays (exact, not substring); `contains` = substring.
 *   D2 denied-link: a link to a foreign record the actor can't read is EXCLUDED from the comparison set —
 *     `is "Secret"` / `contains "secret"` match NOTHING for the denied actor (no match, no display leak),
 *     while an admin (and the same actor with the foreign flag OFF) DO match → proves the deny is the cause.
 *   D5 presence ops: `isEmpty`/`isNotEmpty` test RAW link presence (meta_links), permission-INVARIANT —
 *     a row whose links are ALL hidden is NOT empty (it has links); identical result for restricted vs admin.
 *   Composition: a link leaf works inside a nested OR/AND group.
 *
 * Link ids live in meta_links (NOT record.data), so this also locks that the filter sources presence +
 * display from the relational load. Runs only with DATABASE_URL via the plugin-tests.yml step.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const USER = `u_fbl_${TS}`
const BASE_ID = `base_fbl_${TS}`
const FS = `sheet_fbl_for_${TS}` // foreign sheet (linked)
const MS = `sheet_fbl_main_${TS}` // main sheet (filtered)

const FLD_FNAME = `fld_fbl_fname_${TS}` // foreign display field (string → buildLinkSummaries auto-picks it)
const FLD_LINK = `fld_fbl_link_${TS}`
const FLD_GROUP = `fld_fbl_group_${TS}` // groupable column on MS (dashboard group-by axis)

const FR_ACME = `rec_fbl_acme_${TS}` // Name: Acme   (visible)
const FR_GLOBEX = `rec_fbl_globex_${TS}` // Name: Globex (visible)
const FR_SECRET = `rec_fbl_secret_${TS}` // Name: Secret (row-denied to USER on FS)

const M_A = `rec_fbl_m_a_${TS}` // links [Acme]
const M_AG = `rec_fbl_m_ag_${TS}` // links [Acme, Globex]
const M_S = `rec_fbl_m_s_${TS}` // links [Secret]        → all-hidden for USER
const M_AS = `rec_fbl_m_as_${TS}` // links [Acme, Secret] → mixed
const M_NONE = `rec_fbl_m_none_${TS}` // links []

// views (one per filter under test)
const V_IS_ACME = `v_fbl_is_acme_${TS}`
const V_IS_GLOB = `v_fbl_is_glob_${TS}` // `is "Glob"` (partial) — exact membership ⇒ no match
const V_CONTAINS_GLOB = `v_fbl_contains_glob_${TS}`
const V_IS_SECRET = `v_fbl_is_secret_${TS}`
const V_CONTAINS_SECRET = `v_fbl_contains_secret_${TS}`
const V_ISEMPTY = `v_fbl_isempty_${TS}`
const V_ISNOTEMPTY = `v_fbl_isnotempty_${TS}`
const V_NESTED = `v_fbl_nested_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
let testRoles: string[] = ['member']
function buildApp(): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as any).user = { id: USER, roles: testRoles, perms: ['multitable:read', 'multitable:base:read'], permissions: ['multitable:read', 'multitable:base:read'] }
    next()
  })
  a.use('/api/multitable', univerMetaRouter())
  return a
}
const setForeignFlag = (on: boolean) =>
  q('UPDATE meta_sheets SET row_level_read_permissions_enabled = $2 WHERE id = $1', [FS, on])
async function viewRowIds(viewId: string): Promise<string[]> {
  const res = await request(buildApp()).get(`/api/multitable/view?sheetId=${MS}&viewId=${viewId}&limit=50&offset=0`)
  expect(res.status).toBe(200)
  return (res.body.data.rows as Array<{ id: string }>).map((r) => r.id).sort()
}
const sortIds = (...ids: string[]) => ids.slice().sort()
const grid = (conditions: unknown[], conjunction: 'and' | 'or' = 'and') => JSON.stringify({ conjunction, conditions })
async function seedView(id: string, filterInfo: string): Promise<void> {
  await q(
    'INSERT INTO meta_views (id, sheet_id, name, type, hidden_field_ids, filter_info, sort_info, config) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)',
    [id, MS, id, 'grid', '[]', filterInfo, JSON.stringify({ rules: [] }), JSON.stringify({})],
  )
}
async function dashboardTotal(viewId: string): Promise<number> {
  const res = await request(buildApp()).post('/api/multitable/dashboard/query').send({
    sheetId: MS, viewId, widgets: [{ title: 'g', chartType: 'bar', groupByFieldId: FLD_GROUP, metric: 'count' }],
  })
  expect(res.status).toBe(200)
  return (res.body?.data?.widgets?.[0]?.totalRecords as number) ?? -1
}
async function aggregateStatus(viewId: string): Promise<number> {
  return (await request(buildApp()).get(`/api/multitable/sheets/${MS}/view-aggregate?viewId=${viewId}`)).status
}

describeIfDatabase('multitable filter-by-link over real /view (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'FBL Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [FS, BASE_ID, 'FBL Foreign'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [MS, BASE_ID, 'FBL Main'])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_FNAME, FS, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [FR_ACME, FS, JSON.stringify({ [FLD_FNAME]: 'Acme' })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [FR_GLOBEX, FS, JSON.stringify({ [FLD_FNAME]: 'Globex' })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [FR_SECRET, FS, JSON.stringify({ [FLD_FNAME]: 'Secret' })])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LINK, MS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_GROUP, MS, 'Group', 'string', '{}', 2])
    // main records — record.data[FLD_LINK] is intentionally NOT the source of truth (the read path
    // discards it); links live in meta_links below. We store an empty array to prove the filter never
    // reads record.data for link presence/display. FLD_GROUP is a plain group-by axis for the dashboard.
    const mainGroup: Record<string, string> = { [M_A]: 'g1', [M_AG]: 'g1', [M_S]: 'g2', [M_AS]: 'g1', [M_NONE]: 'g2' }
    for (const id of [M_A, M_AG, M_S, M_AS, M_NONE]) {
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [id, MS, JSON.stringify({ [FLD_LINK]: [], [FLD_GROUP]: mainGroup[id] })])
    }
    const links: Array<[string, string]> = [
      [M_A, FR_ACME],
      [M_AG, FR_ACME], [M_AG, FR_GLOBEX],
      [M_S, FR_SECRET],
      [M_AS, FR_ACME], [M_AS, FR_SECRET],
    ]
    let i = 0
    for (const [rec, fr] of links) {
      await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_fbl_${i++}_${TS}`, FLD_LINK, rec, fr])
    }

    // FR_SECRET is row-denied ('none') to USER on the FOREIGN sheet; flag turned ON in beforeAll.
    await q('INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,$3,$4,$5)', [FS, FR_SECRET, 'user', USER, 'none'])
    await setForeignFlag(true)

    await seedView(V_IS_ACME, grid([{ fieldId: FLD_LINK, operator: 'is', value: 'Acme' }]))
    await seedView(V_IS_GLOB, grid([{ fieldId: FLD_LINK, operator: 'is', value: 'Glob' }]))
    await seedView(V_CONTAINS_GLOB, grid([{ fieldId: FLD_LINK, operator: 'contains', value: 'glob' }]))
    await seedView(V_IS_SECRET, grid([{ fieldId: FLD_LINK, operator: 'is', value: 'Secret' }]))
    await seedView(V_CONTAINS_SECRET, grid([{ fieldId: FLD_LINK, operator: 'contains', value: 'secret' }]))
    await seedView(V_ISEMPTY, grid([{ fieldId: FLD_LINK, operator: 'isEmpty' }]))
    await seedView(V_ISNOTEMPTY, grid([{ fieldId: FLD_LINK, operator: 'isNotEmpty' }]))
    // nested: (link is "Acme" OR link contains "glob") wrapped in the root AND group
    await seedView(V_NESTED, grid([{ conjunction: 'or', conditions: [
      { fieldId: FLD_LINK, operator: 'is', value: 'Acme' },
      { fieldId: FLD_LINK, operator: 'contains', value: 'glob' },
    ] }]))
  })

  afterAll(async () => {
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [MS]).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id = $1', [FLD_LINK]).catch(() => {})
    await q('DELETE FROM record_permissions WHERE sheet_id = $1', [FS]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('D1/D6 — `is` is membership over visible displays (exact), `contains` is substring', async () => {
    testRoles = ['member']; await setForeignFlag(true)
    expect(await viewRowIds(V_IS_ACME)).toEqual(sortIds(M_A, M_AG, M_AS)) // any visible display === "Acme"
    expect(await viewRowIds(V_IS_GLOB)).toEqual([]) // "Glob" ≠ "Globex" exactly → no match (is is not substring)
    expect(await viewRowIds(V_CONTAINS_GLOB)).toEqual(sortIds(M_AG)) // "Globex" contains "glob"
  })

  test('D2 — a denied linked record is EXCLUDED from the comparison set (no match, no display leak)', async () => {
    testRoles = ['member']; await setForeignFlag(true)
    expect(await viewRowIds(V_IS_SECRET)).toEqual([]) // "Secret" is hidden → never matched
    expect(await viewRowIds(V_CONTAINS_SECRET)).toEqual([]) // hidden display not in the comparison set
  })

  test('D2 — admin bypass + flag-OFF canary prove the deny (not a blanket hide) is what excludes Secret', async () => {
    // admin sees Secret → the rows DO exist and the filter logic matches them
    testRoles = ['admin']; await setForeignFlag(true)
    expect(await viewRowIds(V_IS_SECRET)).toEqual(sortIds(M_S, M_AS))
    // same actor, foreign flag OFF → no deny → Secret visible → matches (proves exclusion was the deny)
    testRoles = ['member']; await setForeignFlag(false)
    expect(await viewRowIds(V_IS_SECRET)).toEqual(sortIds(M_S, M_AS))
    await setForeignFlag(true)
  })

  test('D5 — isEmpty/isNotEmpty are raw-presence + permission-INVARIANT (all-hidden row is NOT empty)', async () => {
    testRoles = ['member']; await setForeignFlag(true)
    // M_S links only the hidden Secret, but it HAS a raw link → not empty for the restricted user.
    expect(await viewRowIds(V_ISEMPTY)).toEqual(sortIds(M_NONE))
    expect(await viewRowIds(V_ISNOTEMPTY)).toEqual(sortIds(M_A, M_AG, M_S, M_AS))
    // admin gets the identical presence result → permission-invariant (the D5 leak avoided).
    testRoles = ['admin']
    expect(await viewRowIds(V_ISEMPTY)).toEqual(sortIds(M_NONE))
    expect(await viewRowIds(V_ISNOTEMPTY)).toEqual(sortIds(M_A, M_AG, M_S, M_AS))
    testRoles = ['member']
  })

  test('composition — a link leaf works inside a nested OR group', async () => {
    testRoles = ['member']; await setForeignFlag(true)
    // (is "Acme" OR contains "glob") → Acme rows ∪ Globex rows
    expect(await viewRowIds(V_NESTED)).toEqual(sortIds(M_A, M_AG, M_AS))
  })

  test('dashboard /dashboard/query applies the same link filter + permission discipline', async () => {
    testRoles = ['member']; await setForeignFlag(true)
    expect(await dashboardTotal(V_IS_ACME)).toBe(3) // M_A, M_AG, M_AS
    expect(await dashboardTotal(V_IS_SECRET)).toBe(0) // hidden Secret excluded from the comparison set
  })

  test('view-aggregate HARD-FAILS (422) on a link filter — preserves the /view parity invariant', async () => {
    // /view supports link filters; view-aggregate can't evaluate them on its path, so it 422s rather than
    // silently disagree (link-aggregate is a deferred follow-up, same stance as computed-field filters).
    testRoles = ['member']; await setForeignFlag(true)
    expect(await aggregateStatus(V_IS_ACME)).toBe(422)
  })
})
