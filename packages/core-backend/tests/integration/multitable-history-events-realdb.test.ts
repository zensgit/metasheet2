/**
 * Global History & Point-in-Time Restore — T1b/T4 LOCK-3 security goldens (real DB).
 *
 * The base-level history center (GET /bases/:baseId/history/events[/:batchId]) is a project-on-read
 * projection over meta_record_revisions. These goldens pin the load-bearing LOCK-3 contract:
 *   - a row-level rule-denied record never leaks through the batch list, the total, or the visible
 *     affected counts (a batch whose every record is denied is invisible AND uncounted; a mixed batch
 *     reports only the visible record/field counts);
 *   - a field_permissions-denied FIELD on a row-readable record never leaks its id (changedFieldIds),
 *     value (detail.after), or count (visibleAffectedFieldCount) — masked surgically, the visible field
 *     of the same change still passes (the LOCK-3 field layer, parity with the per-record history route);
 *   - batch detail for a denied batch shares the SAME 404 shape as a missing batch (no existence oracle);
 *   - admin bypasses (row layer); flag-off is byte-inert;
 *   - a bulk action (shared batch_id) is ONE batch (the T1 acceptance), end-to-end through the projection.
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { loadHistoryBatchSummaries } from '../../src/multitable/history-projection'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE_ID = `base_gh_${TS}`
const SHEET_ID = `sheet_gh_${TS}`
const STATUS = `fld_gh_status_${TS}`
const SALARY = `fld_gh_salary_${TS}` // a second field, field_permission-deniable (LOCK-3 field layer)
const REC_SECRET = `rec_gh_secret_${TS}`
const REC_PUBLIC = `rec_gh_public_${TS}`
const BULK_BATCH = `batch_gh_bulk_${TS}` // one bulk action touching BOTH records (shared id)
const SECRET_BATCH = `batch_gh_secret_${TS}` // a single-record action on the secret record only
const FIELD_BATCH = `batch_gh_field_${TS}` // a single-record action on REC_PUBLIC touching STATUS + SALARY
const TIE_A = `batch_gh_tie_a_${TS}` // two batches sharing ONE created_at (cursor tie-break test)
const TIE_B = `batch_gh_tie_b_${TS}`
const USER_ID = `user_gh_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let testUserId = USER_ID
let testPerms: string[] = ['multitable:read', 'multitable:write']
let testRoles: string[] = ['member']

const setFlag = (on: boolean) => q('UPDATE meta_sheets SET row_level_read_permissions_enabled = $2 WHERE id = $1', [SHEET_ID, on])
const setRules = (rules: unknown[]) => q('UPDATE meta_sheets SET conditional_read_rules = $2::jsonb WHERE id = $1', [SHEET_ID, JSON.stringify(rules)])
const denySecretRule = [{ id: 'r1', fieldId: STATUS, operator: 'eq', value: 'secret', effect: 'deny_read' }]

const events = (query: Record<string, unknown> = {}) =>
  request(app).get(`/api/multitable/bases/${BASE_ID}/history/events`).query({ limit: 100, ...query })
const detail = (batchId: string) => request(app).get(`/api/multitable/bases/${BASE_ID}/history/events/${batchId}`)
const batchIds = (res: { body?: { data?: { batches?: Array<{ batchId: string }> } } }) =>
  (res.body?.data?.batches ?? []).map((b) => b.batchId)
const batchOf = (res: { body?: { data?: { batches?: Array<{ batchId: string }> } } }, id: string) =>
  (res.body?.data?.batches ?? []).find((b) => b.batchId === id) as
    | { batchId: string; visibleAffectedRecordCount: number; visibleAffectedFieldCount: number }
    | undefined

type ChangeShape = { recordId: string; changedFieldIds: string[]; after: Record<string, unknown> | null }
const changeOf = (res: { body?: { data?: { changes?: ChangeShape[] } } }, recordId: string) =>
  (res.body?.data?.changes ?? []).find((c) => c.recordId === recordId)

// A single-record action on the VISIBLE record touching BOTH fields (STATUS + SALARY). Added INSIDE the
// field-layer tests (after the beforeEach seed) so the existing total===2 assertions are not perturbed.
const mixedFieldRev = () =>
  q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, patch, snapshot, batch_id)
     VALUES (gen_random_uuid(), $1, $2, 2, 'update', 'rest', $3, ARRAY[$4,$5]::text[], '{}'::jsonb, $6::jsonb, $7)`,
    [SHEET_ID, REC_PUBLIC, USER_ID, STATUS, SALARY, JSON.stringify({ [STATUS]: 'public', [SALARY]: 99999 }), FIELD_BATCH],
  )
// A single-record visible-record revision (REC_PUBLIC) at an EXPLICIT created_at + batch_id (cursor tests).
const revAt = (batchId: string, createdAt: string) =>
  q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, patch, snapshot, batch_id, created_at)
     VALUES (gen_random_uuid(), $1, $2, 1, 'update', 'rest', $3, ARRAY[$4]::text[], '{}'::jsonb, $5::jsonb, $6, $7)`,
    [SHEET_ID, REC_PUBLIC, USER_ID, STATUS, JSON.stringify({ [STATUS]: 'public' }), batchId, createdAt],
  )
// Page through (limit=1) collecting batchIds; asserts `total` is constant across pages. Returns {seen, total}.
const pageAll = async (extra: Record<string, unknown> = {}): Promise<{ seen: string[]; total: number }> => {
  const seen: string[] = []
  let cursor: string | undefined
  let total = -1
  for (let i = 0; i < 50; i++) {
    const res = await events({ ...extra, limit: 1, ...(cursor ? { cursor } : {}) })
    expect(res.status).toBe(200)
    if (total === -1) total = res.body?.data?.total
    else expect(res.body?.data?.total).toBe(total) // total is constant across pages
    seen.push(...batchIds(res))
    cursor = res.body?.data?.nextCursor ?? undefined
    if (!cursor) break
  }
  return { seen, total }
}
// field_permissions row hiding a field from the test user (subject_type='user'); afterEach clears it.
const denyFieldForUser = (fieldId: string) =>
  q(
    `INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only)
     VALUES ($1,$2,'user',$3,false,false)`,
    [SHEET_ID, fieldId, USER_ID],
  )

const seed = async () => {
  await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID])
  await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID])
  for (const [rid, status] of [[REC_SECRET, 'secret'], [REC_PUBLIC, 'public']] as const) {
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
      rid, SHEET_ID, JSON.stringify({ [STATUS]: status }),
    ])
  }
  const rev = (rid: string, batchId: string, status: string) =>
    q(
      `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, patch, snapshot, batch_id)
       VALUES (gen_random_uuid(), $1, $2, 1, 'update', 'rest', $3, ARRAY[$4]::text[], '{}'::jsonb, $5::jsonb, $6)`,
      [SHEET_ID, rid, USER_ID, STATUS, JSON.stringify({ [STATUS]: status }), batchId],
    )
  await rev(REC_SECRET, BULK_BATCH, 'secret')
  await rev(REC_PUBLIC, BULK_BATCH, 'public')
  await rev(REC_SECRET, SECRET_BATCH, 'secret')
}

describeIfDatabase('global-history events — LOCK-3 security goldens (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = testUserId ? { id: testUserId, roles: testRoles, perms: testPerms } : undefined
      next()
    })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'GH Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'GH Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [STATUS, SHEET_ID, 'Status', 'select', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [SALARY, SHEET_ID, 'Salary', 'number', '{}', 2])
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  // The field layer toggles a field_permissions row; clear it after every test so the row-layer goldens
  // (which assume no field denial) stay isolated regardless of order.
  afterEach(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
  })

  beforeEach(async () => {
    testUserId = USER_ID
    testPerms = ['multitable:read', 'multitable:write']
    testRoles = ['member']
    await setFlag(false)
    await setRules([])
    await seed()
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('bulk action = ONE batch (T1 acceptance): flag OFF, BULK batch reports 2 visible records', async () => {
    const res = await events()
    expect(res.status).toBe(200)
    const ids = batchIds(res)
    expect(ids).toContain(BULK_BATCH)
    expect(ids).toContain(SECRET_BATCH)
    expect(res.body?.data?.total).toBe(2)
    expect(batchOf(res, BULK_BATCH)?.visibleAffectedRecordCount).toBe(2) // two records, ONE batch
  })

  test('LOCK-3 list+count: flag ON + deny rule hides the all-denied batch and drops the denied record from a mixed batch', async () => {
    await setFlag(true)
    await setRules(denySecretRule)
    const res = await events()
    expect(res.status).toBe(200)
    const ids = batchIds(res)
    expect(ids).not.toContain(SECRET_BATCH) // every record denied → batch invisible
    expect(ids).toContain(BULK_BATCH)
    expect(res.body?.data?.total).toBe(1) // post-permission-filter total — denied batch not counted
    // mixed batch: secret record dropped, only the public record + its field remain visible
    expect(batchOf(res, BULK_BATCH)?.visibleAffectedRecordCount).toBe(1)
  })

  test('LOCK-3 detail: a rule-denied batch and a nonexistent batch return the SAME 404 shape (no existence oracle)', async () => {
    await setFlag(true)
    await setRules(denySecretRule)
    const denied = await detail(SECRET_BATCH)
    const missing = await detail(`batch_gh_does_not_exist_${TS}`)
    expect(denied.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(denied.body?.error?.code).toBe(missing.body?.error?.code)
    // the visible mixed batch still opens, showing only the non-denied record
    const ok = await detail(BULK_BATCH)
    expect(ok.status).toBe(200)
    expect(ok.body?.data?.visibleAffectedRecordCount).toBe(1)
    expect((ok.body?.data?.changes ?? []).every((c: { recordId: string }) => c.recordId !== REC_SECRET)).toBe(true)
  })

  test('admin bypass: flag ON + deny rule, an admin sees the denied batch and the full count', async () => {
    await setFlag(true)
    await setRules(denySecretRule)
    testRoles = ['admin']
    const res = await events()
    expect(res.status).toBe(200)
    expect(batchIds(res)).toContain(SECRET_BATCH)
    expect(batchOf(res, BULK_BATCH)?.visibleAffectedRecordCount).toBe(2) // no records hidden from admin
    expect((await detail(SECRET_BATCH)).status).toBe(200)
  })

  test('flag OFF is inert: even with a deny rule authored, all batches and counts are visible', async () => {
    await setRules(denySecretRule)
    await setFlag(false)
    const res = await events()
    expect(batchIds(res)).toContain(SECRET_BATCH)
    expect(res.body?.data?.total).toBe(2)
    expect(batchOf(res, BULK_BATCH)?.visibleAffectedRecordCount).toBe(2)
  })

  // LOCK-3 FIELD layer. These two tests differ ONLY by the field_permissions denial row, on the SAME actor.
  // Test A is the false-green guard: it proves SALARY genuinely changed and is visible without a denial, so
  // Test B's absence assertions cannot pass vacuously.
  test('field layer (no denial = control): a mixed-field change reports BOTH fields and the value', async () => {
    await mixedFieldRev()
    const res = await events()
    expect(res.status).toBe(200)
    expect(batchOf(res, FIELD_BATCH)?.visibleAffectedFieldCount).toBe(2) // STATUS + SALARY both visible
    const d = await detail(FIELD_BATCH)
    expect(d.status).toBe(200)
    const change = changeOf(d, REC_PUBLIC)
    expect(change?.changedFieldIds).toContain(SALARY) // field genuinely changed (guards against a vacuous pass)
    expect(change?.after?.[SALARY]).toBe(99999) // value present when the field is allowed
    expect(d.body?.data?.visibleAffectedFieldCount).toBe(2)
  })

  test('field layer (denial): a field_permissions-denied field is absent from changedFieldIds, after, and the field count', async () => {
    await mixedFieldRev()
    await denyFieldForUser(SALARY)
    const res = await events()
    expect(res.status).toBe(200)
    expect(batchOf(res, FIELD_BATCH)?.visibleAffectedFieldCount).toBe(1) // only STATUS counted — SALARY masked
    const d = await detail(FIELD_BATCH)
    expect(d.status).toBe(200)
    const change = changeOf(d, REC_PUBLIC)
    expect(change?.changedFieldIds).toEqual([STATUS]) // hidden field id absent
    expect(change?.after?.[SALARY]).toBeUndefined() // hidden value absent from the snapshot
    expect(change?.after?.[STATUS]).toBe('public') // visible field of the SAME change still passes (surgical)
    expect(d.body?.data?.visibleAffectedFieldCount).toBe(1) // detail count masked too
  })

  // ----- T2b field filter (post-mask, leak-free) -----

  test('T2b field filter: ?fieldId returns batches that touched a READABLE field', async () => {
    await mixedFieldRev()
    expect(batchIds(await events({ fieldId: STATUS }))).toContain(FIELD_BATCH)
    expect(batchIds(await events({ fieldId: SALARY }))).toContain(FIELD_BATCH) // SALARY readable here → matches
  })

  test('T2b field filter is LEAK-FREE: filtering by a field_permissions-denied field returns NO batch (post-mask)', async () => {
    await mixedFieldRev()
    await denyFieldForUser(SALARY)
    // The denied field is never in the batch's VISIBLE field set, so filtering by it yields nothing — the
    // actor cannot probe "which batches touched the hidden field". A readable field still filters normally.
    expect(batchIds(await events({ fieldId: SALARY }))).not.toContain(FIELD_BATCH)
    expect(batchIds(await events({ fieldId: STATUS }))).toContain(FIELD_BATCH)
  })

  // ----- T2b search (post-mask snapshot match, leak-free) -----

  test('T2b search positive control: a VISIBLE field value IS searchable (non-vacuous)', async () => {
    await mixedFieldRev() // FIELD_BATCH snapshot = { STATUS: 'public', SALARY: 99999 }
    expect(batchIds(await events({ q: '99999' }))).toContain(FIELD_BATCH) // SALARY value (visible) searchable
    expect(batchIds(await events({ q: 'public' }))).toContain(FIELD_BATCH) // STATUS value searchable
  })

  test('T2b search is LEAK-FREE (field-mask): a field_permissions-denied value is NOT searchable (post-mask)', async () => {
    await mixedFieldRev()
    await denyFieldForUser(SALARY)
    // 99999 lives ONLY in the now-denied SALARY → searching it must return no batch (can't probe hidden values).
    expect(batchIds(await events({ q: '99999' }))).not.toContain(FIELD_BATCH)
    // non-vacuous: the still-visible STATUS value is still searchable.
    expect(batchIds(await events({ q: 'public' }))).toContain(FIELD_BATCH)
  })

  test('T2b search is LEAK-FREE (row-deny): a row-denied record value is NOT searchable', async () => {
    await setRules(denySecretRule)
    await setFlag(true) // deny status='secret' records (REC_SECRET)
    // 'secret' lives only in the row-denied REC_SECRET → searching it returns nothing.
    expect(batchIds(await events({ q: 'secret' }))).toHaveLength(0)
    // non-vacuous: 'public' (REC_PUBLIC, visible) still matches the bulk batch.
    expect(batchIds(await events({ q: 'public' }))).toContain(BULK_BATCH)
  })

  test('T2b search: total is POST-search (a non-matching batch is not counted)', async () => {
    await mixedFieldRev()
    const res = await events({ q: '99999' }) // only FIELD_BATCH carries 99999
    expect(batchIds(res)).toEqual([FIELD_BATCH])
    expect(res.body?.data?.total).toBe(1) // post-search total
  })

  // ----- T2b cursor pagination (stable key-cursor over the post-filter set) -----

  test('T2b cursor: paging with limit=1 returns every batch EXACTLY once (no skip / no duplicate)', async () => {
    await mixedFieldRev() // 3 batches: BULK, SECRET, FIELD
    const { seen, total } = await pageAll()
    expect(total).toBe(3)
    expect(seen.length).toBe(3)
    expect(new Set(seen).size).toBe(3) // no duplicates
    expect(new Set(seen)).toEqual(new Set([BULK_BATCH, SECRET_BATCH, FIELD_BATCH])) // no skips
  })

  test('T2b cursor: two batches sharing ONE created_at straddling a page boundary — still exactly once', async () => {
    const sameTime = new Date(TS - 60000).toISOString()
    await revAt(TIE_A, sameTime)
    await revAt(TIE_B, sameTime) // identical created_at, different batchId → the tie the cursor must break
    const { seen } = await pageAll()
    expect(seen.filter((id) => id === TIE_A).length).toBe(1) // the tie-break golden: no skip/duplicate
    expect(seen.filter((id) => id === TIE_B).length).toBe(1)
  })

  test('T2b cursor: total stays POST-filter while paging (a row-denied batch is neither paged nor counted)', async () => {
    await setRules(denySecretRule)
    await setFlag(true) // SECRET_BATCH fully denied → invisible
    const { seen, total } = await pageAll()
    expect(seen).not.toContain(SECRET_BATCH) // a cursor from a visible page can never reach the denied batch
    expect(total).toBe(seen.length) // total == the matches the actor can see
  })

  test('T2b cursor: a malformed cursor is treated as the first page (defined behavior, no crash)', async () => {
    const res = await events({ cursor: 'not-a-valid-cursor!!!' })
    expect(res.status).toBe(200)
    expect(batchIds(res).length).toBeGreaterThan(0) // first page, not a 500
  })

  // ----- T2b search truncation is SURFACED (not silent) -----

  test('T2b search truncation: the API surfaces searchTruncated=false for a normal (non-truncated) search', async () => {
    await mixedFieldRev()
    const res = await events({ q: 'public' })
    expect(res.status).toBe(200)
    expect(res.body?.data?.searchTruncated).toBe(false) // the flag is present, and false when within the cap
  })

  test('T2b search truncation: searchTruncated=true when the candidate cap is hit (and false with a generous cap)', async () => {
    await mixedFieldRev() // ≥2 candidate revisions exist on the sheet
    const params = { sheetIds: [SHEET_ID], allowedFieldsBySheet: new Map([[SHEET_ID, new Set([STATUS, SALARY])]]), search: '99999' }
    const access = { userId: USER_ID, isAdminRole: false }
    const capped = await loadHistoryBatchSummaries(q, { ...params, searchRowCap: 1 }, access)
    expect(capped.searchTruncated).toBe(true) // cap=1 with ≥2 candidate rows → bounded, surfaced
    const full = await loadHistoryBatchSummaries(q, { ...params, searchRowCap: 10000 }, access)
    expect(full.searchTruncated).toBe(false) // generous cap → complete
  })

  test('T2b search cap is finite-guarded: a NaN / non-integer searchRowCap never produces invalid SQL', async () => {
    await mixedFieldRev()
    const params = { sheetIds: [SHEET_ID], allowedFieldsBySheet: new Map([[SHEET_ID, new Set([STATUS, SALARY])]]), search: '99999' }
    const access = { userId: USER_ID, isAdminRole: false }
    // NaN → falls back to the default cap (no `LIMIT NaN` — the await would reject on invalid SQL); not truncated.
    const nanCap = await loadHistoryBatchSummaries(q, { ...params, searchRowCap: NaN }, access)
    expect(nanCap.searchTruncated).toBe(false)
    // null → the DEFAULT cap, NOT 1 (Number(null)===0 would clamp to LIMIT 1 → spuriously "truncated").
    const nullCap = await loadHistoryBatchSummaries(q, { ...params, searchRowCap: null as unknown as number }, access)
    expect(nullCap.searchTruncated).toBe(false)
    // A fractional cap is floored to a valid integer LIMIT (no `LIMIT 1.9`); floor(1.9)=1 with ≥2 rows → truncated.
    const fracCap = await loadHistoryBatchSummaries(q, { ...params, searchRowCap: 1.9 }, access)
    expect(fracCap.searchTruncated).toBe(true)
  })
})
