/**
 * Global History — D-1c, W0 slice ① (RATIFIED design-lock, see
 * `docs/development/multitable-global-history-d1c-form-submit-edit-uncaptured-revision-design-lock-20260712.md`,
 * §0.5 OD-1..OD-3, §0/§7a sites A1 + A6):
 *
 *   A1  form-submit EDIT   (`univer-meta.ts` — `POST /views/:viewId/submit`, `recordId` present)
 *   A6  form-submit CREATE (same handler, no `recordId`)
 *
 * Both sites raw-mutated `meta_records` with NO `meta_record_revisions` row, so `reconstructRecordsAtT`
 * (the primitive under the PIT view / revert / reset) derived existence+data PURELY from revisions and
 * could never see these writes — a sheet revert/reset to a T after a form edit would silently overwrite
 * the member's edit with the stale pre-edit value (irrecoverably), and a Reset-to-T at any T after an
 * uncaptured CREATE could not distinguish "created after T" from "created before T but never captured"
 * and would destroy a record legitimately present at T.
 *
 * Fix = emit `recordRecordRevision(...)` inside the SAME transaction as each mutation (the route already
 * runs inside `pool.transaction`), full post-mutation snapshot, `source='public-form'` per OD-2 (names
 * the FORM SURFACE, not the actor's auth level — CREATE is genuinely anonymous-reachable, EDIT happens to
 * be authenticated-only), `actorId` carried verbatim — `null` on the true-anonymous CREATE path, never
 * fabricated (OD-3).
 *
 * OUT OF SCOPE for this slice (do not read anything below as covering these):
 *   - A8 attachment-delete (`univer-meta.ts:15693`) — that is slice ⑤, a SEPARATE PR, `source='attachment'`.
 *   - Edge-level `meta_links` history (OD-4) — a link field's ids ARE captured here as ordinary `data`
 *     (in scope, tested below), but `meta_links` itself getting its own revision/tombstone history is a
 *     SEPARATE, still-unsolved design-lock. Nothing here claims edge-level completeness.
 *   - The §0.6 `HISTORY_INCOMPLETE` precheck (already landed, #4234) — exercised only incidentally here
 *     (revert-preview / reset-preview call it), never modified.
 *
 * Every mutation under test is driven through the REAL Express route (`univerMetaRouter()` on a real app,
 * real `poolManager` pool) — no hand-rolled SQL for the path under test. `asOf` cutoffs are derived from
 * each revision's OWN `created_at` (+ a margin) rather than process wall-clock time, to avoid clock skew
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
const BASE = `base_d1c1_${TS}`
const SHEET = `sheet_d1c1_${TS}`
const VIEW_ID = `view_d1c1_${TS}`
const FLD_NAME = `fld_d1c1_name_${TS}`
const FLD_DESC = `fld_d1c1_desc_${TS}`
const FLD_LINK = `fld_d1c1_link_${TS}`
const PUB_TOKEN = `pub_d1c1_${TS}`
const MEMBER = `u_d1c1_member_${TS}`
const ADMIN = `u_d1c1_admin_${TS}`
const LINK_TARGET_1 = `rec_d1c1_lt1_${TS}`

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
// The revert/reset ROUTES parse `asOf` via `new Date(parsed.data.asOf).toISOString()` — that TRUNCATES to
// millisecond precision. `created_at` in Postgres carries full microsecond precision, so a naive
// "+1 microsecond" buffer (correct for a DIRECT reconstructRecordsAtT call) gets erased by the route's own
// truncation and can land the parsed `asOf` BEFORE `created_at` (whenever created_at's own sub-millisecond
// fraction is non-zero) — a false "not <= asOf" exclusion. Read the revision's timestamp as an epoch-ms
// number and add a 5ms margin, comfortably clearing any sub-millisecond fraction while staying far short
// of the next revision (a separate HTTP round-trip away).
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

async function createMemberRecord(name: string, extra: Record<string, unknown> = {}): Promise<{ id: string; version: number }> {
  asUser(MEMBER, ['multitable:read', 'multitable:write'])
  const res = await request(app)
    .post(`/api/multitable/views/${VIEW_ID}/submit`)
    .send({ data: { [FLD_NAME]: name, ...extra } })
  expect(res.status).toBe(200)
  const record = (res.body as { data?: { record?: { id?: string; version?: number } } }).data?.record
  return { id: String(record?.id), version: Number(record?.version) }
}

describeIfDatabase('D-1c slice ① — form-submit CREATE/EDIT write public-form revisions (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      if (currentUser) (req as unknown as { user?: unknown }).user = currentUser
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'D1C1 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'D1C1 Sheet'])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_NAME, SHEET, 'Name', 'string', '{}', 1],
    )
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_DESC, SHEET, 'Description', 'string', '{}', 2],
    )
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LINK, SHEET, 'Link', 'link', JSON.stringify({ foreignSheetId: SHEET }), 3],
    )
    await q(
      'INSERT INTO meta_views (id, sheet_id, name, type, config) VALUES ($1,$2,$3,$4,$5::jsonb)',
      [VIEW_ID, SHEET, 'Form', 'form', JSON.stringify({ publicForm: { enabled: true, publicToken: PUB_TOKEN, accessMode: 'public' } })],
    )
    // One plain link-target record (not part of the flows under test) to link against. D-1c §0.6
    // (already landed, #4234) fail-closed-refuses revert/reset-preview whenever ANY live record on the
    // scanned sheet has no revision or content-mismatched history — so this fixture MUST carry a matching
    // revision, or every revert-preview/reset-preview call below (which scan the WHOLE sheet) would 409
    // HISTORY_INCOMPLETE on account of this seed row alone, not the behavior under test.
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [LINK_TARGET_1, SHEET, JSON.stringify({ [FLD_NAME]: 'link-target-1' })])
    await recordRecordRevision(q, {
      sheetId: SHEET,
      recordId: LINK_TARGET_1,
      version: 1,
      action: 'create',
      source: 'rest',
      actorId: null,
      changedFieldIds: [],
      patch: {},
      snapshot: { [FLD_NAME]: 'link-target-1' },
    })
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [MEMBER])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ADMIN])
  })

  afterAll(async () => {
    delete process.env.MULTITABLE_ENABLE_PIT_RESET
    await q('DELETE FROM meta_links WHERE field_id = $1', [FLD_LINK]).catch(() => {})
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

  test('G0 POSITIVE CONTROL: an already-compliant normal-path PATCH (NOT one of the 2 slice-① sites) proves the harness + reconstructor are trustworthy', async () => {
    const recId = `rec_d1c1_g0_${TS}`
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

  describe('Site A6 — form-submit CREATE (public-form, TRUE anonymous)', () => {
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

    test('Reset-to-T (esp. CREATE): a record created BEFORE reset-T is NOT pushed into the delete-set (Reset would otherwise destroy it — §0.5 corrected CREATE risk)', async () => {
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
      await q(`CREATE OR REPLACE FUNCTION _d1c1_fail_create() RETURNS trigger AS $f$
        BEGIN IF NEW.action = 'create' AND NEW.source = 'public-form' THEN RAISE EXCEPTION 'd1c1 injected create-revision failure'; END IF; RETURN NEW; END;
      $f$ LANGUAGE plpgsql`, [])
      await q('CREATE TRIGGER _d1c1_fail_create_trg BEFORE INSERT ON meta_record_revisions FOR EACH ROW EXECUTE FUNCTION _d1c1_fail_create()', [])
      try {
        asAnonymous()
        const res = await request(app)
          .post(`/api/multitable/views/${VIEW_ID}/submit`)
          .send({ publicToken: PUB_TOKEN, data: { [FLD_NAME]: 'd1c1-atomic-create-marker' } })
        expect(res.status).toBe(500)
      } finally {
        await q('DROP TRIGGER IF EXISTS _d1c1_fail_create_trg ON meta_record_revisions', [])
        await q('DROP FUNCTION IF EXISTS _d1c1_fail_create()', [])
      }
      const leftover = await q(`SELECT count(*)::int AS c FROM meta_records WHERE sheet_id = $1 AND data->>$2 = $3`, [SHEET, FLD_NAME, 'd1c1-atomic-create-marker'])
      expect((leftover.rows[0] as { c: number }).c).toBe(0)
    })
  })

  describe('Site A1 — form-submit EDIT (authenticated member)', () => {
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
      // patch === nextData, so `snapshot: patch` would pass vacuously (mutation-proven separately). A
      // record with a NAME and a DESCRIPTION field, edited on only the name, distinguishes
      // `snapshot: data` (correct) from `snapshot: patch` (drops the description).
      const created = await createMemberRecord('mt-name-v1', { [FLD_DESC]: 'untouched-description' })
      asUser(MEMBER, ['multitable:read', 'multitable:write'])
      const res = await request(app)
        .post(`/api/multitable/views/${VIEW_ID}/submit`)
        .send({ recordId: created.id, expectedVersion: created.version, data: { [FLD_NAME]: 'mt-name-v2' } })
      expect(res.status).toBe(200)
      const revs = await revisionsOf(created.id)
      const last = revs[revs.length - 1]!
      expect(last.action).toBe('update')
      expect((last.snapshot as Record<string, unknown>)?.[FLD_NAME]).toBe('mt-name-v2')
      // the untouched description field — `snapshot: patch` would DROP this:
      expect((last.snapshot as Record<string, unknown>)?.[FLD_DESC]).toBe('untouched-description')
    })

    test('OD-4: a link-field edit lands in the revision snapshot as ordinary `data` (ids captured — in scope). Edge-level `meta_links` history is a SEPARATE, still-unsolved lock — NOT claimed or tested here.', async () => {
      const created = await createMemberRecord('link-v1')
      asUser(MEMBER, ['multitable:read', 'multitable:write'])
      const res = await request(app)
        .post(`/api/multitable/views/${VIEW_ID}/submit`)
        .send({ recordId: created.id, expectedVersion: created.version, data: { [FLD_NAME]: 'link-v1', [FLD_LINK]: [LINK_TARGET_1] } })
      expect(res.status).toBe(200)

      const revs = await revisionsOf(created.id)
      const last = revs[revs.length - 1]!
      expect(last.action).toBe('update')
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

    test('atomicity (EDIT): if the revision INSERT throws, the UPDATE rolls back — record unchanged, no half-write', async () => {
      const created = await createMemberRecord('atomic-edit-v1')
      await q(`CREATE OR REPLACE FUNCTION _d1c1_fail_edit() RETURNS trigger AS $f$
        BEGIN IF NEW.record_id = '${created.id}' THEN RAISE EXCEPTION 'd1c1 injected edit-revision failure'; END IF; RETURN NEW; END;
      $f$ LANGUAGE plpgsql`, [])
      await q('CREATE TRIGGER _d1c1_fail_edit_trg BEFORE INSERT ON meta_record_revisions FOR EACH ROW EXECUTE FUNCTION _d1c1_fail_edit()', [])
      try {
        asUser(MEMBER, ['multitable:read', 'multitable:write'])
        const res = await request(app)
          .post(`/api/multitable/views/${VIEW_ID}/submit`)
          .send({ recordId: created.id, expectedVersion: created.version, data: { [FLD_NAME]: 'atomic-edit-v2-SHOULD-NOT-LAND' } })
        expect(res.status).toBe(500)
      } finally {
        await q('DROP TRIGGER IF EXISTS _d1c1_fail_edit_trg ON meta_record_revisions', [])
        await q('DROP FUNCTION IF EXISTS _d1c1_fail_edit()', [])
      }
      const row = await liveRecord(created.id)
      expect(row?.data?.[FLD_NAME]).toBe('atomic-edit-v1')
      expect(row?.version).toBe(1)
      expect(await revisionsOf(created.id)).toHaveLength(1) // only the create revision — no half-written update
    })

    test('CONCURRENT-DELETE golden (required fix #3, the zero-row RETURNING fail-closed): if the UPDATE affects ZERO rows, NO spurious update revision is written', async () => {
      // A genuine two-connection race cannot be constructed here: the EDIT branch already does
      // `SELECT ... FOR UPDATE` on this exact row inside THIS transaction before reaching the UPDATE, so
      // any real concurrent DELETE/UPDATE from another transaction blocks until this one commits or rolls
      // back — Postgres row locking makes the naive "two clients race" version of this test impossible to
      // build, not merely hard. Simulate the OBSERVABLE consequence directly and deterministically instead:
      // a BEFORE UPDATE trigger that returns NULL for this one row causes Postgres to skip updating it
      // silently (no exception) — from the app code's point of view this is indistinguishable from "the row
      // vanished between the FOR-UPDATE read and this UPDATE" (e.g. a future refactor that drops the lock,
      // or any other same-txn path that removes the row first). This is exactly the zero-row RETURNING
      // condition the fail-closed guard exists to catch.
      const created = await createMemberRecord('concurrent-delete-v1')
      await q(`CREATE OR REPLACE FUNCTION _d1c1_suppress_update() RETURNS trigger AS $f$
        BEGIN RETURN NULL; END;
      $f$ LANGUAGE plpgsql`, [])
      await q(`CREATE TRIGGER _d1c1_suppress_update_trg BEFORE UPDATE ON meta_records
        FOR EACH ROW WHEN (OLD.id = '${created.id}') EXECUTE FUNCTION _d1c1_suppress_update()`, [])
      try {
        asUser(MEMBER, ['multitable:read', 'multitable:write'])
        const res = await request(app)
          .post(`/api/multitable/views/${VIEW_ID}/submit`)
          .send({ recordId: created.id, expectedVersion: created.version, data: { [FLD_NAME]: 'concurrent-delete-v2-SHOULD-NOT-LAND' } })
        // the guard throws NotFoundError -> the route's own catch maps it to 404, not a raw 500
        expect(res.status).toBe(404)
      } finally {
        await q('DROP TRIGGER IF EXISTS _d1c1_suppress_update_trg ON meta_records', [])
        await q('DROP FUNCTION IF EXISTS _d1c1_suppress_update()', [])
      }
      // THE discriminating assertion: exactly the original create revision — no spurious `update` row.
      const revs = await revisionsOf(created.id)
      expect(revs).toHaveLength(1)
      expect(revs[0]!.action).toBe('create')
      // and the live row itself is byte-identical to before the suppressed edit (the trigger never
      // actually touched it, but confirm the route didn't fall through to some other write path either).
      const row = await liveRecord(created.id)
      expect(row?.data?.[FLD_NAME]).toBe('concurrent-delete-v1')
      expect(row?.version).toBe(1)
    })
  })
})
