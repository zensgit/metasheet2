/**
 * R13 Lane A (D-1c, ratified 2026-07-13 — see docs branch `docs/multitable-d1c-form-submit-edit-revision-lock`,
 * §0.5 rulings OD-1..OD-6; audit `/tmp/r13-revision-disposition-audit-20260713.md`) — three `meta_records`
 * write sites in `routes/univer-meta.ts` mutated a record with NO `meta_record_revisions` row, so
 * `reconstructRecordsAtT` (the primitive under the PIT view / revert / reset) derived existence+data PURELY
 * from revisions and could never see these writes:
 *
 *   A1  form-submit CREATE  (`univer-meta.ts` — `POST /views/:viewId/submit`, no `recordId`)
 *   A2  form-submit EDIT    (same handler, `recordId` present — link-field edits fold into this UPDATE too,
 *                            OD-4: `patch[fieldId] = ids` is a real `data` mutation, IN SCOPE)
 *   A3  attachment-delete   (`DELETE /attachments/:attachmentId`)
 *
 * Fix = emit `recordRecordRevision(...)` inside the SAME transaction as each mutation, full post-mutation
 * snapshot, `source` BY SURFACE (OD-2: 'public-form' for A1/A2, 'rest' for A3), `actorId` carried verbatim —
 * null on the true-anonymous A1 path, never fabricated (OD-3).
 *
 * Every mutation under test is driven through the REAL Express route (`univerMetaRouter()` on a real app,
 * real `poolManager` pool) — no hand-rolled SQL for the path under test (mirrors `multitable-form-submit-
 * trigger.test.ts` / `multitable-record-lock-bypass.test.ts`). `asOf` cutoffs are derived from each
 * revision's OWN `created_at` (+ a microsecond) rather than process wall-clock time, to avoid clock skew
 * between the test host and the DB server (D-1 convention).
 *
 * Runs only with DATABASE_URL (plugin-tests.yml multitable real-DB job).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { reconstructRecordsAtT } from '../../src/multitable/record-reconstructor'
import { recordRecordRevision } from '../../src/multitable/record-history-service'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE = `base_r13a_${TS}`
const SHEET = `sheet_r13a_${TS}`
const VIEW_ID = `view_r13a_${TS}`
const FLD_NAME = `fld_r13a_name_${TS}`
const FLD_LINK = `fld_r13a_link_${TS}`
const FLD_ATT = `fld_r13a_att_${TS}`
const PUB_TOKEN = `pub_r13a_${TS}`
const MEMBER = `u_r13a_member_${TS}`
const ADMIN = `u_r13a_admin_${TS}`
const LINK_TARGET_1 = `rec_r13a_lt1_${TS}`
const LINK_TARGET_2 = `rec_r13a_lt2_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

let app: Express
let currentUser: { id: string; roles: string[]; perms: string[] } | undefined
const asAnonymous = (): void => { currentUser = undefined }
const asUser = (id: string, perms: string[], roles: string[] = ['member']): void => {
  currentUser = { id, roles, perms }
}

async function revisionsOf(recordId: string): Promise<Array<Record<string, unknown>>> {
  const r = await q(
    `SELECT id, action, source, actor_id, version, changed_field_ids, patch, snapshot, created_at
       FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2 ORDER BY created_at ASC, version ASC`,
    [SHEET, recordId],
  )
  return r.rows as Array<Record<string, unknown>>
}

// D-1 convention: derive `asOf` from the revision's OWN created_at (never process wall-clock), so a slow
// test host can never introduce clock-skew false negatives/positives into a PIT boundary check.
//
// The revert/reset ROUTES parse `asOf` via `new Date(parsed.data.asOf).toISOString()` (`univer-meta.ts`
// ~:10077/:10291) — that TRUNCATES to millisecond precision. `created_at` in Postgres carries full
// microsecond precision, so a naive "+1 microsecond" buffer (correct for a DIRECT reconstructRecordsAtT
// call) gets erased by the route's own truncation and can land the parsed `asOf` BEFORE `created_at`
// (whenever created_at's own sub-millisecond fraction is non-zero) — a false "not <= asOf" exclusion.
// Read the revision's timestamp as an epoch-ms number and add a 5ms margin, comfortably clearing any
// sub-millisecond fraction while staying far short of the next revision (a separate HTTP round-trip away).
async function epochMs(recordId: string, version: number): Promise<number> {
  const r = await q(
    `SELECT EXTRACT(EPOCH FROM created_at) * 1000 AS ms
       FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2 AND version = $3`,
    [SHEET, recordId, version],
  )
  expect(r.rows).toHaveLength(1)
  return Number((r.rows[0] as { ms: string | number }).ms)
}

async function cutoffAfterVersion(recordId: string, version: number): Promise<string> {
  const ms = await epochMs(recordId, version)
  return new Date(ms + 5).toISOString()
}

// For a boundary that must fall strictly BETWEEN two known revisions (not just "shortly after" one),
// use the true midpoint rather than a fixed buffer — robust regardless of how close together the two
// writes happened to land in wall-clock time.
async function cutoffBetweenVersions(recordId: string, beforeVersion: number, afterVersion: number): Promise<string> {
  const before = await epochMs(recordId, beforeVersion)
  const after = await epochMs(recordId, afterVersion)
  expect(after).toBeGreaterThan(before)
  return new Date(Math.round((before + after) / 2)).toISOString()
}

async function linksOf(fieldId: string, recordId: string): Promise<string[]> {
  const r = await q(
    'SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2 ORDER BY foreign_record_id',
    [fieldId, recordId],
  )
  return (r.rows as Array<{ foreign_record_id: string }>).map((row) => String(row.foreign_record_id))
}

async function liveRecord(recordId: string): Promise<{ data: Record<string, unknown>; version: number } | undefined> {
  const r = await q('SELECT data, version FROM meta_records WHERE id = $1', [recordId])
  return r.rows[0] as { data: Record<string, unknown>; version: number } | undefined
}

async function createAnonRecord(name: string): Promise<string> {
  asAnonymous()
  const res = await request(app)
    .post(`/api/multitable/views/${VIEW_ID}/submit`)
    .send({ publicToken: PUB_TOKEN, data: { [FLD_NAME]: name } })
  expect(res.status).toBe(200)
  return String((res.body as { data?: { record?: { id?: string } } }).data?.record?.id)
}

async function createMemberRecord(name: string, linkIds: string[] = []): Promise<{ id: string; version: number }> {
  asUser(MEMBER, ['multitable:read', 'multitable:write'])
  const res = await request(app)
    .post(`/api/multitable/views/${VIEW_ID}/submit`)
    .send({ data: { [FLD_NAME]: name, ...(linkIds.length > 0 ? { [FLD_LINK]: linkIds } : {}) } })
  expect(res.status).toBe(200)
  const record = (res.body as { data?: { record?: { id?: string; version?: number } } }).data?.record
  return { id: String(record?.id), version: Number(record?.version) }
}

async function seedAttachmentRecord(attIds: string[]): Promise<{ id: string; version: number }> {
  const recId = `rec_r13a_att_${TS}_${Math.random().toString(36).slice(2, 8)}`
  await q(
    'INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)',
    [recId, SHEET, JSON.stringify({ [FLD_NAME]: 'att-holder', [FLD_ATT]: attIds }), MEMBER],
  )
  await recordRecordRevision(q, {
    sheetId: SHEET,
    recordId: recId,
    version: 1,
    action: 'create',
    source: 'rest',
    actorId: MEMBER,
    changedFieldIds: [],
    patch: {},
    snapshot: { [FLD_NAME]: 'att-holder', [FLD_ATT]: attIds },
  })
  for (const attId of attIds) {
    await q(
      `INSERT INTO multitable_attachments
         (id, sheet_id, record_id, field_id, storage_file_id, filename, original_name, mime_type, size, storage_path, storage_provider, metadata, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
      [attId, SHEET, recId, FLD_ATT, `sf_${attId}`, 'f.txt', 'f.txt', 'text/plain', 3, `/tmp/${attId}`, 'local', '{}', MEMBER],
    )
  }
  return { id: recId, version: 1 }
}

describeIfDatabase('R13 Lane A — form-submit CREATE/EDIT + attachment-delete now write revisions (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      if (currentUser) (req as unknown as { user?: unknown }).user = currentUser
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'R13A Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'R13A Sheet'])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_NAME, SHEET, 'Name', 'string', '{}', 1],
    )
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LINK, SHEET, 'Link', 'link', JSON.stringify({ foreignSheetId: SHEET }), 2],
    )
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_ATT, SHEET, 'Files', 'attachment', '{}', 3],
    )
    await q(
      'INSERT INTO meta_views (id, sheet_id, name, type, config) VALUES ($1,$2,$3,$4,$5::jsonb)',
      [VIEW_ID, SHEET, 'Form', 'form', JSON.stringify({ publicForm: { enabled: true, publicToken: PUB_TOKEN, accessMode: 'public' } })],
    )
    // Two plain link-target records (not part of the flows under test) to link against.
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [LINK_TARGET_1, SHEET, JSON.stringify({ [FLD_NAME]: 'target-1' })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [LINK_TARGET_2, SHEET, JSON.stringify({ [FLD_NAME]: 'target-2' })])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [MEMBER])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ADMIN])
  })

  afterAll(async () => {
    delete process.env.MULTITABLE_ENABLE_PIT_RESET
    await q('DELETE FROM multitable_attachments WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[MEMBER, ADMIN]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL is set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('G0 POSITIVE CONTROL: an already-compliant normal-path PATCH (NOT one of the 3 lane-A sites) proves the harness + reconstructor are trustworthy', async () => {
    const recId = `rec_r13a_g0_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [recId, SHEET, JSON.stringify({ [FLD_NAME]: 'g0-v1' }), MEMBER])
    await recordRecordRevision(q, { sheetId: SHEET, recordId: recId, version: 1, action: 'create', source: 'rest', actorId: MEMBER, changedFieldIds: [], patch: {}, snapshot: { [FLD_NAME]: 'g0-v1' } })

    asUser(MEMBER, ['multitable:read', 'multitable:write'])
    const res = await request(app).patch(`/api/multitable/records/${recId}`).send({ sheetId: SHEET, data: { [FLD_NAME]: 'g0-v2' } })
    expect(res.status).toBe(200)

    const revs = await revisionsOf(recId)
    expect(revs.some((r) => r.action === 'update' && r.source === 'rest')).toBe(true)
    const asOf = await cutoffAfterVersion(recId, 2)
    const state = await reconstructRecordsAtT(q, SHEET, asOf, [recId])
    expect(state.get(recId)?.exists).toBe(true)
    expect((state.get(recId)?.data as Record<string, unknown> | null)?.[FLD_NAME]).toBe('g0-v2')
    expect(state.get(recId)?.version).toBe(2)
  })

  describe('Site A1 — form-submit CREATE (public-form, TRUE anonymous)', () => {
    test('real POST /views/:viewId/submit (anonymous, no recordId) writes a create revision: source=public-form, actorId=null', async () => {
      const recId = await createAnonRecord('anon-created-v1')

      const revs = await revisionsOf(recId)
      expect(revs).toHaveLength(1)
      expect(revs[0]!.action).toBe('create')
      expect(revs[0]!.source).toBe('public-form')
      expect(revs[0]!.actor_id).toBeNull()
      expect(revs[0]!.version).toBe(1)
      expect(revs[0]!.snapshot).toMatchObject({ [FLD_NAME]: 'anon-created-v1' })
    })

    test('reconstructRecordsAtT after the create returns the record ALIVE with the right data+version (PIT no longer blind to CREATE)', async () => {
      const recId = await createAnonRecord('anon-created-v2')
      const asOf = await cutoffAfterVersion(recId, 1)
      const state = await reconstructRecordsAtT(q, SHEET, asOf, [recId])
      expect(state.get(recId)?.exists).toBe(true)
      expect((state.get(recId)?.data as Record<string, unknown> | null)?.[FLD_NAME]).toBe('anon-created-v2')
      expect(state.get(recId)?.version).toBe(1)
    })

    test('Reset-to-T (esp. CREATE): a record created BEFORE reset-T is NOT pushed into the delete-set (Reset would otherwise destroy it)', async () => {
      const recId = await createAnonRecord('anon-created-v3')
      const asOf = await cutoffAfterVersion(recId, 1)
      process.env.MULTITABLE_ENABLE_PIT_RESET = 'true'
      try {
        asUser(ADMIN, ['multitable:read', 'multitable:write', 'multitable:share'])
        const pv = await request(app).post(`/api/multitable/sheets/${SHEET}/reset-preview`).send({ asOf })
        expect(pv.status).toBe(200)
        const deleteIds = (pv.body as { data?: { deleteRecordIds?: string[] } }).data?.deleteRecordIds ?? []
        expect(deleteIds).not.toContain(recId)
      } finally {
        delete process.env.MULTITABLE_ENABLE_PIT_RESET
      }
    })

    test('atomicity (CREATE): if the revision INSERT throws, the whole create ROLLS BACK — no half-written record', async () => {
      await q(`CREATE OR REPLACE FUNCTION _r13a_fail_create() RETURNS trigger AS $f$
        BEGIN IF NEW.action = 'create' AND NEW.source = 'public-form' THEN RAISE EXCEPTION 'r13a injected create-revision failure'; END IF; RETURN NEW; END;
      $f$ LANGUAGE plpgsql`, [])
      await q('CREATE TRIGGER _r13a_fail_create_trg BEFORE INSERT ON meta_record_revisions FOR EACH ROW EXECUTE FUNCTION _r13a_fail_create()', [])
      try {
        asAnonymous()
        const res = await request(app)
          .post(`/api/multitable/views/${VIEW_ID}/submit`)
          .send({ publicToken: PUB_TOKEN, data: { [FLD_NAME]: 'r13a-atomic-create-marker' } })
        expect(res.status).toBe(500)
      } finally {
        await q('DROP TRIGGER IF EXISTS _r13a_fail_create_trg ON meta_record_revisions', [])
        await q('DROP FUNCTION IF EXISTS _r13a_fail_create()', [])
      }
      const leftover = await q(`SELECT count(*)::int AS c FROM meta_records WHERE sheet_id = $1 AND data->>$2 = $3`, [SHEET, FLD_NAME, 'r13a-atomic-create-marker'])
      expect((leftover.rows[0] as { c: number }).c).toBe(0)
    })
  })

  describe('Site A2 — form-submit EDIT (authenticated member) + OD-4 link consistency', () => {
    test('real POST /views/:viewId/submit EDIT (recordId+expectedVersion) writes an update revision with the FULL post-merge snapshot', async () => {
      const created = await createMemberRecord('edit-v1')
      asUser(MEMBER, ['multitable:read', 'multitable:write'])
      const res = await request(app)
        .post(`/api/multitable/views/${VIEW_ID}/submit`)
        .send({ recordId: created.id, expectedVersion: created.version, data: { [FLD_NAME]: 'edit-v2' } })
      expect(res.status).toBe(200)
      expect((res.body as { data?: { mode?: string } }).data?.mode).toBe('update')

      const revs = await revisionsOf(created.id)
      expect(revs).toHaveLength(2) // create + this update
      const last = revs[revs.length - 1]!
      expect(last.action).toBe('update')
      expect(last.source).toBe('public-form')
      expect(last.actor_id).toBe(MEMBER)
      expect(last.version).toBe(2)
      expect(last.snapshot).toMatchObject({ [FLD_NAME]: 'edit-v2' })

      const asOf = await cutoffAfterVersion(created.id, 2)
      const state = await reconstructRecordsAtT(q, SHEET, asOf, [created.id])
      expect((state.get(created.id)?.data as Record<string, unknown> | null)?.[FLD_NAME]).toBe('edit-v2')
      expect(state.get(created.id)?.version).toBe(2)
    })

    test('EDIT full-merge snapshot (G4 merge trap): editing ONE field of a two-field record keeps the untouched field', async () => {
      // The snapshot MUST be the full post-merge row, not the bare patch. On a single-field record
      // patch ≡ nextData, so `snapshot: patch` passes vacuously (mutation-proven). A record with a NAME
      // AND a LINK field, edited on only the name, distinguishes `snapshot: data` (correct) from
      // `snapshot: patch` (drops the link field). Mutating univer-meta.ts:14454 to the bare patch reds THIS.
      const created = await createMemberRecord('mt-name-v1', [LINK_TARGET_1])
      asUser(MEMBER, ['multitable:read', 'multitable:write'])
      const res = await request(app)
        .post(`/api/multitable/views/${VIEW_ID}/submit`)
        .send({ recordId: created.id, expectedVersion: created.version, data: { [FLD_NAME]: 'mt-name-v2' } })
      expect(res.status).toBe(200)
      const revs = await revisionsOf(created.id)
      const last = revs[revs.length - 1]!
      expect(last.action).toBe('update')
      expect((last.snapshot as Record<string, unknown>)?.[FLD_NAME]).toBe('mt-name-v2')
      // the untouched link field — `snapshot: patch` would DROP this, reddening the test:
      expect((last.snapshot as Record<string, unknown>)?.[FLD_LINK]).toEqual([LINK_TARGET_1])
    })

    test('the destructive leg: revert-preview at asOf AFTER the edit proposes ZERO reverts for this record (PIT/revert no longer lies)', async () => {
      const created = await createMemberRecord('destr-v1')
      asUser(MEMBER, ['multitable:read', 'multitable:write'])
      const editRes = await request(app)
        .post(`/api/multitable/views/${VIEW_ID}/submit`)
        .send({ recordId: created.id, expectedVersion: created.version, data: { [FLD_NAME]: 'destr-v2' } })
      expect(editRes.status).toBe(200)

      const asOf = await cutoffAfterVersion(created.id, 2)
      asUser(ADMIN, ['multitable:read', 'multitable:write', 'multitable:share'])
      const pv = await request(app).post(`/api/multitable/sheets/${SHEET}/revert-preview`).send({ asOf })
      expect(pv.status).toBe(200)
      const proposedIds = ((pv.body as { data?: { records?: Array<{ recordId: string }> } }).data?.records ?? []).map((r) => r.recordId)
      expect(proposedIds).not.toContain(created.id)
    })

    test('OD-4: a link-field edit is captured in the revision snapshot AND meta_links — a REAL revert reproduces BOTH consistently', async () => {
      const created = await createMemberRecord('link-v1', [LINK_TARGET_1])
      expect(await linksOf(FLD_LINK, created.id)).toEqual([LINK_TARGET_1])

      asUser(MEMBER, ['multitable:read', 'multitable:write'])
      const editRes = await request(app)
        .post(`/api/multitable/views/${VIEW_ID}/submit`)
        .send({ recordId: created.id, expectedVersion: created.version, data: { [FLD_NAME]: 'link-v2', [FLD_LINK]: [LINK_TARGET_2] } })
      expect(editRes.status).toBe(200)

      // 1. The revision snapshot captured the NEW link ids (not just the scalar field) — patch[fieldId]=ids
      //    folds into the same UPDATE, and the fix's snapshot is the full post-merge row.
      const revs = await revisionsOf(created.id)
      const editRev = revs[revs.length - 1]!
      expect(editRev.snapshot).toMatchObject({ [FLD_LINK]: [LINK_TARGET_2] })
      // 2. The live meta_links edges agree with the snapshot right now.
      expect(await linksOf(FLD_LINK, created.id)).toEqual([LINK_TARGET_2])

      // 3. THE ROUNDTRIP (the part a snapshot-only check can't prove): revert this record back to its
      //    PRE-edit (v1) state via the REAL revert-execute flow — an independent computation path from
      //    the original edit. If the fix is real, both representations land back in agreement.
      const asOfBeforeEdit = await cutoffBetweenVersions(created.id, 1, 2)
      asUser(ADMIN, ['multitable:read', 'multitable:write', 'multitable:share'])
      const pv = await request(app).post(`/api/multitable/sheets/${SHEET}/revert-preview`).send({ asOf: asOfBeforeEdit })
      expect(pv.status).toBe(200)
      const proposed = (pv.body as { data?: { records?: Array<{ recordId: string }> } }).data?.records ?? []
      expect(proposed.some((r) => r.recordId === created.id)).toBe(true)
      const ex = await request(app)
        .post(`/api/multitable/sheets/${SHEET}/revert-execute`)
        .send({ asOf: asOfBeforeEdit, previewIdentity: (pv.body as { data?: { previewIdentity?: string } }).data?.previewIdentity })
      expect(ex.status).toBe(200)

      const row = await liveRecord(created.id)
      expect(row?.data?.[FLD_LINK]).toEqual([LINK_TARGET_1]) // cell ids reverted...
      expect(await linksOf(FLD_LINK, created.id)).toEqual([LINK_TARGET_1]) // ...and meta_links edges WITH them
    })

    test('atomicity (EDIT): if the revision INSERT throws, the UPDATE rolls back — record unchanged, no half-write', async () => {
      const created = await createMemberRecord('atomic-edit-v1')
      await q(`CREATE OR REPLACE FUNCTION _r13a_fail_edit() RETURNS trigger AS $f$
        BEGIN IF NEW.record_id = '${created.id}' THEN RAISE EXCEPTION 'r13a injected edit-revision failure'; END IF; RETURN NEW; END;
      $f$ LANGUAGE plpgsql`, [])
      await q('CREATE TRIGGER _r13a_fail_edit_trg BEFORE INSERT ON meta_record_revisions FOR EACH ROW EXECUTE FUNCTION _r13a_fail_edit()', [])
      try {
        asUser(MEMBER, ['multitable:read', 'multitable:write'])
        const res = await request(app)
          .post(`/api/multitable/views/${VIEW_ID}/submit`)
          .send({ recordId: created.id, expectedVersion: created.version, data: { [FLD_NAME]: 'atomic-edit-v2-SHOULD-NOT-LAND' } })
        expect(res.status).toBe(500)
      } finally {
        await q('DROP TRIGGER IF EXISTS _r13a_fail_edit_trg ON meta_record_revisions', [])
        await q('DROP FUNCTION IF EXISTS _r13a_fail_edit()', [])
      }
      const row = await liveRecord(created.id)
      expect(row?.data?.[FLD_NAME]).toBe('atomic-edit-v1')
      expect(row?.version).toBe(1)
      expect(await revisionsOf(created.id)).toHaveLength(1) // only the create revision — no half-written update
    })
  })

  describe('Site A3 — attachment-delete (authenticated member)', () => {
    test('real DELETE /attachments/:id writes an update revision: source=rest, actor known, snapshot = full post-merge row', async () => {
      const att1 = `att_r13a_1_${TS}`
      const att2 = `att_r13a_2_${TS}`
      const rec = await seedAttachmentRecord([att1, att2])
      asUser(MEMBER, ['multitable:read', 'multitable:write'])
      const res = await request(app).delete(`/api/multitable/attachments/${att1}`)
      expect(res.status).toBe(200)

      const revs = await revisionsOf(rec.id)
      expect(revs).toHaveLength(2)
      const last = revs[revs.length - 1]!
      expect(last.action).toBe('update')
      expect(last.source).toBe('rest')
      expect(last.actor_id).toBe(MEMBER)
      expect(last.version).toBe(2)
      expect(last.snapshot).toMatchObject({ [FLD_NAME]: 'att-holder', [FLD_ATT]: [att2] })

      const asOf = await cutoffAfterVersion(rec.id, 2)
      const state = await reconstructRecordsAtT(q, SHEET, asOf, [rec.id])
      expect((state.get(rec.id)?.data as Record<string, unknown> | null)?.[FLD_ATT]).toEqual([att2])
    })

    test('the destructive leg: revert-preview after the attachment-delete proposes ZERO reverts for this record', async () => {
      const att1 = `att_r13a_3_${TS}`
      const att2 = `att_r13a_4_${TS}`
      const rec = await seedAttachmentRecord([att1, att2])
      asUser(MEMBER, ['multitable:read', 'multitable:write'])
      const del = await request(app).delete(`/api/multitable/attachments/${att1}`)
      expect(del.status).toBe(200)

      const asOf = await cutoffAfterVersion(rec.id, 2)
      asUser(ADMIN, ['multitable:read', 'multitable:write', 'multitable:share'])
      const pv = await request(app).post(`/api/multitable/sheets/${SHEET}/revert-preview`).send({ asOf })
      expect(pv.status).toBe(200)
      const proposedIds = ((pv.body as { data?: { records?: Array<{ recordId: string }> } }).data?.records ?? []).map((r) => r.recordId)
      expect(proposedIds).not.toContain(rec.id)
    })

    test('atomicity (attachment-delete): if the revision INSERT throws, the record edit AND the soft-delete both roll back', async () => {
      const att1 = `att_r13a_5_${TS}`
      const att2 = `att_r13a_6_${TS}`
      const rec = await seedAttachmentRecord([att1, att2])
      await q(`CREATE OR REPLACE FUNCTION _r13a_fail_att() RETURNS trigger AS $f$
        BEGIN IF NEW.record_id = '${rec.id}' AND NEW.version = 2 THEN RAISE EXCEPTION 'r13a injected attachment-revision failure'; END IF; RETURN NEW; END;
      $f$ LANGUAGE plpgsql`, [])
      await q('CREATE TRIGGER _r13a_fail_att_trg BEFORE INSERT ON meta_record_revisions FOR EACH ROW EXECUTE FUNCTION _r13a_fail_att()', [])
      try {
        asUser(MEMBER, ['multitable:read', 'multitable:write'])
        const res = await request(app).delete(`/api/multitable/attachments/${att1}`)
        expect(res.status).toBe(500)
      } finally {
        await q('DROP TRIGGER IF EXISTS _r13a_fail_att_trg ON meta_record_revisions', [])
        await q('DROP FUNCTION IF EXISTS _r13a_fail_att()', [])
      }
      const row = await liveRecord(rec.id)
      expect(row?.data?.[FLD_ATT]).toEqual([att1, att2]) // unchanged — attachment id NOT stripped
      expect(row?.version).toBe(1)
      const attRow = await q('SELECT deleted_at FROM multitable_attachments WHERE id = $1', [att1])
      expect((attRow.rows[0] as { deleted_at: unknown } | undefined)?.deleted_at).toBeNull() // soft-delete rolled back too (same txn)
    })
  })
})
