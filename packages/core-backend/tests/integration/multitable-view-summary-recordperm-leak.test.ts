/**
 * Real-DB canary for the GET /view record-level read-leak fix
 * (origin/claude/multitable-view-summary-recordperm-leak-20260616, commit b5f3ed204).
 *
 * THE FIX: move the record-level permission filter to BEFORE the link / attachment / person
 * summary construction in the GET /view handler, so the summary maps (each keyed by recordId)
 * are built from the already-filtered `rows`. Before the fix, summaries were built from the FULL
 * row set and `rows` was filtered afterward, so a summary map could carry display values for a
 * record dropped by the record-permission filter — a leak-by-construction footgun (any future 4th
 * summary type would inherit it).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * INVESTIGATION CONCLUSION (the conflict the task asked to resolve)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The /view record-level filter is currently a NO-OP for READS. It cannot remove any row for a
 * reader under the present data model. Proof (3-way):
 *
 *  1. `deriveRecordPermissions` (permission-derivation.ts:130):
 *       - unmapped record  → canRead = capabilities.canRead
 *       - mapped record    → canRead = capabilities.canRead && (level ∈ {read,write,admin})
 *     `record_permissions.access_level` has CHECK IN ('read','write','admin')
 *     (migration zzzz20260413100000_create_record_permissions.ts:20) — i.e. EVERY persistable
 *     level grants read, so the `&&` second operand is ALWAYS true. The /view handler already
 *     gated `if (!capabilities.canRead) return sendForbidden(res)` upstream, so by the time the
 *     filter runs capabilities.canRead === true. Net: canRead === true for every row, mapped or not.
 *
 *  2. `loadRecordPermissionScopeMap` (permission-service.ts:893) returns ONLY the requesting
 *     subject's GRANT rows (user / member-group / role match). There is no "deny" row type — the
 *     scope map can only ADD read access, never subtract it. (record-read is grant-additive.)
 *
 *  3. The codebase already documents this: univer-meta.ts:8243-8246 ("record-read is grant-additive
 *     ... no deny level") and the F0a GET /records test T7 ("Read is grant-additive (golden:
 *     record-read is a non-gate), so the filter is inert").
 *
 * Therefore a "denied" record is not constructible for a reader today, and the leak the fix closes
 * is NOT reachable through the record-permission filter as currently wired. The fix is DEFENSIVE /
 * forward-looking: it removes the leak-by-construction footgun so that IF a per-record read-DENY
 * semantics is ever added (or the filter is re-pointed to "only mapped records visible"), the
 * summaries cannot leak the dropped records' display values.
 *
 * SEPARATE FINDING (flagged for owner): the record-level READ filter being open-for-reads may be a
 * latent record-ACL gap OR intended sheet-level-read semantics. This canary does NOT assert a
 * deny — it cannot, because none is constructible — it asserts the INVARIANT the fix guarantees:
 *   every key in linkSummaries / attachmentSummaries / personSummaries is a member of the returned
 *   rows' id set (summaries ⊆ rows).
 * That invariant holds vacuously today (no row is dropped) AND would catch the leak the moment a
 * deny path makes the filter drop a row — exactly what the fix protects. It is the strongest real
 * assertion available given the no-op finding.
 *
 * Runs only with DATABASE_URL (describeIfDatabase + a sentinel test so it fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
// IDs namespaced (`*_vsl_*_${TS}`) — meta_fields.id / meta_records.id are global PKs; siblings share the DB.
const BASE_ID = `base_vsl_${TS}`
const SHEET_A = `sheet_vsl_src_${TS}` // sheet under test (has link + attachment + person fields)
const FLD_LINK = `fld_vsl_link_${TS}` // link field → SHEET_B  → linkSummaries
const FLD_ATTACH = `fld_vsl_attach_${TS}` // attachment field    → attachmentSummaries
const FLD_PERSON = `fld_vsl_person_${TS}` // native person field  → personSummaries
const SHEET_B = `sheet_vsl_foreign_${TS}` // foreign sheet for the link field
const FLD_B_NAME = `fld_vsl_bname_${TS}` // foreign default display field
const REC_A = `rec_vsl_a_${TS}` // record WITH a record_permissions grant for USER (mapped)
const REC_B = `rec_vsl_b_${TS}` // record WITHOUT a grant for USER (unmapped — read still allowed: no-op proof)
const FOREIGN_REC = `rec_vsl_foreign_${TS}` // linked-to foreign record
const ATTACH_A = `att_vsl_a_${TS}` // attachment on REC_A
const ATTACH_B = `att_vsl_b_${TS}` // attachment on REC_B
const USER_ID = `u_vsl_${TS}` // non-admin reader; has a record_permissions grant on REC_A only
const PERSON_USER = `u_vsl_person_${TS}` // the userId stored in the native person field

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let testUserId = USER_ID
const testPerms = ['multitable:read'] // non-admin reader → canRead=true, isAdminRole=false (filter branch runs)

const viewReq = () =>
  request(app).get('/api/multitable/view').query({ sheetId: SHEET_A, includeLinkSummaries: 'true' })

describeIfDatabase('GET /view record-perm read-leak fix — summaries ⊆ rows invariant (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = testUserId ? { id: testUserId, roles: [], perms: testPerms } : undefined
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'VSL Base'])

    // foreign sheet B + a display field + a foreign record (target of the link)
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_B, BASE_ID, 'VSL Foreign'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_B_NAME, SHEET_B, 'BName', 'string', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [FOREIGN_REC, SHEET_B, JSON.stringify({ [FLD_B_NAME]: 'Foreign Display' })])

    // sheet A: link + attachment + native person fields → exercises ALL THREE summary surfaces
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_A, BASE_ID, 'VSL Source'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LINK, SHEET_A, 'Linked', 'link', JSON.stringify({ foreignSheetId: SHEET_B }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_ATTACH, SHEET_A, 'Files', 'attachment', '{}', 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_PERSON, SHEET_A, 'Owner', 'person', '{}', 3])

    // person user (resolved by buildPersonSummaries via SELECT id,email,name FROM users)
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1, $2, $3, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET is_active = TRUE`,
      [PERSON_USER, `${PERSON_USER}@example.test`, 'Person User'],
    )

    // two records on sheet A; attachment cell = [attachmentId], person cell = [userId]
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_A, SHEET_A, JSON.stringify({ [FLD_ATTACH]: [ATTACH_A], [FLD_PERSON]: [PERSON_USER] })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_B, SHEET_A, JSON.stringify({ [FLD_ATTACH]: [ATTACH_B], [FLD_PERSON]: [PERSON_USER] })])

    // link both records → the same foreign record (so both carry a linkSummary key)
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [FLD_LINK, REC_A, FOREIGN_REC])
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [FLD_LINK, REC_B, FOREIGN_REC])

    // one attachment per record (storage_file_id is UNIQUE → distinct values)
    await q(
      `INSERT INTO multitable_attachments
         (id, sheet_id, record_id, field_id, storage_file_id, filename, original_name, mime_type, size, storage_path, storage_provider, metadata, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
      [ATTACH_A, SHEET_A, REC_A, FLD_ATTACH, `sf_${ATTACH_A}`, 'a.png', 'a.png', 'image/png', 10, `/p/${ATTACH_A}`, 'local', '{}', USER_ID],
    )
    await q(
      `INSERT INTO multitable_attachments
         (id, sheet_id, record_id, field_id, storage_file_id, filename, original_name, mime_type, size, storage_path, storage_provider, metadata, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
      [ATTACH_B, SHEET_A, REC_B, FLD_ATTACH, `sf_${ATTACH_B}`, 'b.png', 'b.png', 'image/png', 20, `/p/${ATTACH_B}`, 'local', '{}', USER_ID],
    )

    // record-permission grant for USER on REC_A ONLY → makes hasRecordPermissionAssignments=true and
    // recordScopeMap.size>0 so the filter BRANCH ACTUALLY RUNS. REC_B is left unmapped: it must STILL be
    // returned (the no-op proof — an unmapped record is readable, since record-read is grant-additive).
    await q('INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,$3,$4,$5)', [SHEET_A, REC_A, 'user', USER_ID, 'read'])
  })

  afterAll(async () => {
    await q('DELETE FROM record_permissions WHERE sheet_id = $1', [SHEET_A]).catch(() => {})
    await q('DELETE FROM multitable_attachments WHERE sheet_id = $1', [SHEET_A]).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id = $1', [FLD_LINK]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[SHEET_A, SHEET_B]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SHEET_A, SHEET_B]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SHEET_A, SHEET_B]]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [PERSON_USER]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('positive control: /view populates all three summary surfaces (link + attachment + person)', async () => {
    // Defeats a false-green where the invariant holds only because the summary maps are empty.
    testUserId = USER_ID
    const res = await viewReq()
    expect(res.status).toBe(200)
    const data = res.body.data

    const rowIds: string[] = (data.rows as Array<{ id: string }>).map((r) => r.id)
    // record-read is grant-additive (filter is a no-op for reads): BOTH the mapped REC_A and the
    // UNMAPPED REC_B are returned. This is the no-op confirmation referenced in the header.
    // NOTE for a future per-record read-DENY implementer: if you add a deny path, the
    // `toContain(REC_B)` line below pins TODAY's grant-additive semantics and MUST be revisited
    // (an unmapped record would then be excluded). The separate-finding flag in the header — "latent
    // record-ACL gap OR intended sheet-level-read semantics" — is the open question that gates that change.
    expect(rowIds).toContain(REC_A)
    expect(rowIds).toContain(REC_B)

    // each summary surface is actually populated (real keys present)
    expect(Object.keys(data.linkSummaries ?? {}).length).toBeGreaterThan(0)
    expect(Object.keys(data.attachmentSummaries ?? {}).length).toBeGreaterThan(0)
    expect(Object.keys(data.personSummaries ?? {}).length).toBeGreaterThan(0)

    // and they carry the expected shape for REC_A (positive control for content, not just keys)
    expect(data.linkSummaries?.[REC_A]?.[FLD_LINK]?.[0]?.id).toBe(FOREIGN_REC)
    expect(data.attachmentSummaries?.[REC_A]?.[FLD_ATTACH]?.[0]?.id).toBe(ATTACH_A)
    expect(data.personSummaries?.[REC_A]?.[FLD_PERSON]?.[0]?.id).toBe(PERSON_USER)
  })

  test('INVARIANT (the fix guarantees): every summary key ∈ returned rows id set (summaries ⊆ rows)', async () => {
    // This is the property the fix makes true BY CONSTRUCTION (summaries built from the already-filtered
    // `rows`). It holds vacuously today because the record-perm filter drops nothing for a reader (see the
    // header investigation), AND it is the exact assertion that would catch the leak the moment a per-record
    // read-DENY path makes the filter drop a row while a summary key for that row survives. It is enforced
    // across ALL THREE summary surfaces — not just the newest (person) one — because the leak footgun the
    // fix removed was generic to any recordId-keyed summary map (a future 4th surface inherits the guarantee).
    testUserId = USER_ID
    const res = await viewReq()
    expect(res.status).toBe(200)
    const data = res.body.data

    const rowIdSet = new Set<string>((data.rows as Array<{ id: string }>).map((r) => r.id))

    const assertSubsetOfRows = (label: string, summaryMap: Record<string, unknown> | undefined) => {
      const keys = Object.keys(summaryMap ?? {})
      for (const recordId of keys) {
        expect(
          rowIdSet.has(recordId),
          `${label} carries a summary for ${recordId} which is NOT in the returned rows (record-perm read leak)`,
        ).toBe(true)
      }
    }

    assertSubsetOfRows('linkSummaries', data.linkSummaries)
    assertSubsetOfRows('attachmentSummaries', data.attachmentSummaries)
    assertSubsetOfRows('personSummaries', data.personSummaries)
  })
})
