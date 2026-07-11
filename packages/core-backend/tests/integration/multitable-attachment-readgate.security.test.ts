/**
 * F2 security regression guard (#3973) — real-DB, self-contained.
 *
 * Proves `GET /api/multitable/attachments/:attachmentId` enforces the SAME read gates as every
 * other multitable read surface, via `ensureAttachmentDownloadReadable` in
 * `src/routes/univer-meta.ts`:
 *   - row-deny: an attachment owned by a `record_permissions` 'none'-scoped record is NOT_FOUND
 *     (404) — no existence signal leaks to a row-denied actor (same contract as every other
 *     row-deny surface: a denied record looks absent, not merely forbidden).
 *   - field-mask: an attachment on a `field_permissions.visible=false` field is FIELD_FORBIDDEN
 *     (403), even though the owning record itself is fully readable.
 *
 * Extracted into its own file rather than un-excluding the parent
 * `tests/integration/multitable-attachments.api.test.ts` — that file also carries 8 pre-existing
 * SQL-string-matching mock tests for an unrelated area with their own known drift, tracked
 * separately. This file has no SQL mocks (real Postgres via `poolManager`, same pattern as
 * `multitable-rowlevel-readdeny-enforce.test.ts` / `multitable-records-read-field-mask.test.ts`),
 * so it cannot drift the way string-matched mocks do, and is wired directly into the
 * `Run multitable real-DB integration` step in `plugin-tests.yml` so a regression re-opening F2
 * turns CI red instead of silently living in an excluded file.
 *
 * Runs only with DATABASE_URL (describeIfDatabase + a sentinel test so it fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

// IDs are namespaced (`*_argate_*_${TS}`) so they can never collide with a sibling integration
// test's fixtures in the shared real-DB run (meta_fields.id / meta_records.id are global PKs).
const TS = Date.now()
const BASE_ID = `base_argate_${TS}`
const SHEET_ID = `sheet_argate_${TS}`
const FLD_FILES = `fld_argate_files_${TS}` // plain attachment field — never field-masked
const FLD_SECRET_FILES = `fld_argate_secret_${TS}` // field-masked (field_permissions.visible=false) for USER_ID
const REC_ROW_DENIED = `rec_argate_denied_${TS}` // record_permissions 'none' for USER_ID
const REC_VISIBLE = `rec_argate_visible_${TS}` // fully readable record; holds the field-masked attachment
const ATT_ROW_DENIED = `att_argate_row_denied_${TS}`
const ATT_FIELD_MASKED = `att_argate_field_masked_${TS}`
const USER_ID = `user_argate_${TS}`
// Distinctive filenames used as leak canaries — must never appear in a denied response body.
const ROW_DENIED_CANARY = `row-denied-secret-${TS}.txt`
const FIELD_MASKED_CANARY = `field-masked-secret-${TS}.txt`

let app: Express
let testUserId: string = USER_ID
let testPerms: string[] = ['multitable:read']
let testRoles: string[] = []

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const setRowLevelFlag = (on: boolean) =>
  q('UPDATE meta_sheets SET row_level_read_permissions_enabled = $2 WHERE id = $1', [SHEET_ID, on])
const downloadAttachment = (attachmentId: string) => request(app).get(`/api/multitable/attachments/${attachmentId}`)

describeIfDatabase('F2 attachment download read-gate (#3973 security regression, real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = testUserId ? { id: testUserId, roles: testRoles, perms: testPerms } : undefined
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'F2 Attachment Readgate Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'F2 Attachment Readgate Sheet'])
    // Both fields' property is `{}` (property.hidden UNSET) — the field-mask deny must come
    // solely from layer-3 (field_permissions), matching the #2015 seed discipline.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_FILES, SHEET_ID, 'Files', 'attachment', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SECRET_FILES, SHEET_ID, 'Secret files', 'attachment', '{}', 2])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_ROW_DENIED, SHEET_ID, JSON.stringify({ [FLD_FILES]: [ATT_ROW_DENIED] })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_VISIBLE, SHEET_ID, JSON.stringify({ [FLD_SECRET_FILES]: [ATT_FIELD_MASKED] })])

    // Row-deny fixture: a 'none' record_permission scoped to USER_ID on REC_ROW_DENIED (same shape
    // as multitable-rowlevel-readdeny-enforce.test.ts's #18 core-enforcement fixture).
    await q('INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,$3,$4,$5)', [SHEET_ID, REC_ROW_DENIED, 'user', USER_ID, 'none'])
    // Field-mask fixture: FLD_SECRET_FILES denied to USER_ID via layer-3 field_permissions (same
    // shape as multitable-records-read-field-mask.test.ts's #2015 fixture).
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_SECRET_FILES, 'user', USER_ID, false, false])

    await q(
      `INSERT INTO multitable_attachments
         (id, sheet_id, record_id, field_id, storage_file_id, filename, original_name, mime_type, size, storage_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [ATT_ROW_DENIED, SHEET_ID, REC_ROW_DENIED, FLD_FILES, `storage_${ATT_ROW_DENIED}`, ROW_DENIED_CANARY, ROW_DENIED_CANARY, 'text/plain', 27, `${ATT_ROW_DENIED}/path`],
    )
    await q(
      `INSERT INTO multitable_attachments
         (id, sheet_id, record_id, field_id, storage_file_id, filename, original_name, mime_type, size, storage_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [ATT_FIELD_MASKED, SHEET_ID, REC_VISIBLE, FLD_SECRET_FILES, `storage_${ATT_FIELD_MASKED}`, FIELD_MASKED_CANARY, FIELD_MASKED_CANARY, 'text/plain', 23, `${ATT_FIELD_MASKED}/path`],
    )
  })

  afterAll(async () => {
    await q('DELETE FROM multitable_attachments WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM record_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('F2: rejects attachment download when the owning record is row-denied (404, no existence leak)', async () => {
    await setRowLevelFlag(true)
    testUserId = USER_ID
    testPerms = ['multitable:read']
    testRoles = []

    const response = await downloadAttachment(ATT_ROW_DENIED)

    expect(response.status).toBe(404)
    expect(response.body).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: `Attachment not found: ${ATT_ROW_DENIED}` },
    })
    expect(JSON.stringify(response.body)).not.toContain(ROW_DENIED_CANARY)
  })

  test('F2: rejects attachment download when the attachment field is field-masked (403 FIELD_FORBIDDEN)', async () => {
    await setRowLevelFlag(false)
    testUserId = USER_ID
    testPerms = ['multitable:read']
    testRoles = []

    const response = await downloadAttachment(ATT_FIELD_MASKED)

    expect(response.status).toBe(403)
    expect(response.body).toEqual({
      ok: false,
      error: { code: 'FIELD_FORBIDDEN', message: 'Attachment field is not readable' },
    })
    expect(JSON.stringify(response.body)).not.toContain(FIELD_MASKED_CANARY)
  })
})
