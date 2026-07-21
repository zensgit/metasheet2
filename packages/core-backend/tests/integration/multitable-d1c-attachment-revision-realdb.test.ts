/**
 * Global History — D-1c, W0 slice ⑤ (FINAL) (RATIFIED design-lock, see
 * `docs/development/multitable-global-history-d1c-form-submit-edit-uncaptured-revision-design-lock-20260712.md`,
 * §0.5 OD-1..OD-3, §0/§7a site A8):
 *
 *   A8  attachment-delete cell-strip (`univer-meta.ts` — `DELETE /attachments/:attachmentId`, the
 *       branch that strips the deleted attachment id out of the record's attachment-field cell)
 *
 * The strip raw-mutated `meta_records` with NO `meta_record_revisions` row, so `reconstructRecordsAtT`
 * (the primitive under the PIT view / revert / reset) derived existence+data PURELY from revisions and
 * could never see this write — a sheet revert/reset to a T after an attachment delete would silently
 * RE-ADD the deleted attachment id back into the cell (irrecoverably — resurrecting a reference to
 * now-purged binary/metadata).
 *
 * Fix = emit `recordRecordRevision(...)` inside the SAME transaction as the strip (the route already
 * runs both the record-edit UPDATE and the attachment soft-delete inside `pool.transaction`), full
 * post-strip snapshot, `source='attachment'` per OD-2 (owner ruled: attachment gets its OWN source,
 * distinct from 'rest'/'public-form'/'plugin'/'automation'/'approval' — the write entry point is the
 * attachment-delete endpoint itself), `actorId=getRequestActorId(req)` carried verbatim — already
 * `string | null`, never fabricated (OD-3).
 *
 * ZERO-ROW DETERMINATION (see the fix's inline comment at the call site): this route shares the SAME
 * family as slice ①'s form-submit EDIT branch — it ALSO holds a `SELECT ... FOR UPDATE` lock on the
 * exact row, in the SAME transaction, immediately before its own `UPDATE`, AND its pre-existing code
 * carried the identical `?? <fallback>` version-synthesis mask that slices ①/② both had to close. So
 * this slice applies the SAME contract as ①/②: a zero-row `UPDATE ... RETURNING` throws `NotFoundError`
 * (fail-closed), mapped to a 404 by a new `if (err instanceof NotFoundError)` branch added to this
 * route's catch (mirroring the `/views/:viewId/submit` route's identical handling) — NOT the
 * automation/approval lane's pre-existing "silent success" contract (③/④), because THIS route never had
 * that contract to preserve; its pre-existing code was the masking-fallback bug, not a documented
 * leniency.
 *
 * OUT OF SCOPE for this slice (do not read anything below as covering these):
 *   - form-submit CREATE/EDIT (A1/A6, slice ①), plugin-SDK (A2/A5, slice ②), automation (A3/A4, slice
 *     ③), approval resultWriteback (A7, slice ④) — all landed, all UNTOUCHED by this PR.
 *   - The OD-6 revision-disposition guard (#4227) — a separate rung, not part of any of the five slices.
 *   - Edge-level `meta_links` history (OD-4) — not implicated here (attachment fields are not link
 *     fields); nothing here claims edge-level completeness.
 *   - The §0.6 `HISTORY_INCOMPLETE` precheck (already landed, #4234) — exercised only incidentally here
 *     (the revert-preview golden calls it), never modified.
 *
 * Every mutation under test is driven through the REAL Express route (`univerMetaRouter()` on a real
 * app, real `poolManager` pool) — no hand-rolled SQL for the path under test. `asOf` cutoffs are derived
 * from each revision's OWN `created_at` (+ a margin) rather than process wall-clock time (D-1 convention).
 *
 * §0.6 fixture note: every record this file seeds is inserted via a raw SQL INSERT paired IMMEDIATELY
 * with a matching `recordRecordRevision(..., action:'create', ...)` call — a legitimate "capture-complete"
 * fixture (same technique as slice ①'s `LINK_TARGET_1` seed and its own `G0` control) — so no live row on
 * this file's sheet is ever missing a revision or content-mismatched, and the sheet-wide
 * `revert-preview` golden below does not spuriously 409 `HISTORY_INCOMPLETE` on account of an unrelated
 * seed row.
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
import { activateCheckpoint, type QueryFn } from '../../src/multitable/history-trust-checkpoint'
import { pruneSealedHistoryOperations } from '../utils/exact-anchor-history-fixture'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE = `base_d1c5_${TS}`
const SHEET = `sheet_d1c5_${TS}`
const FLD_NAME = `fld_d1c5_name_${TS}`
const FLD_FILES = `fld_d1c5_files_${TS}`
const MEMBER = `u_d1c5_member_${TS}`
const ADMIN = `u_d1c5_admin_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

let app: Express
let currentUser: { id: string; roles: string[]; perms: string[] } | undefined
const asAnonymous = (): void => { currentUser = undefined }
const asUser = (id: string, perms: string[], roles: string[] = ['member']): void => {
  currentUser = { id, roles, perms }
}

let seedCounter = 0
function nextId(prefix: string): string {
  seedCounter += 1
  return `${prefix}_d1c5_${TS}_${seedCounter}`
}

async function revisionsOf(recordId: string): Promise<Array<Record<string, unknown>>> {
  const r = await q(
    `SELECT id, action, source, actor_id, version, changed_field_ids, patch, snapshot, created_at
       FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2 ORDER BY created_at ASC, version ASC`,
    [SHEET, recordId],
  )
  return r.rows as Array<Record<string, unknown>>
}

// D-1 convention: derive `asOf` from the revision's OWN created_at (never process wall-clock). See the
// identical helper + rationale in multitable-d1c-form-submit-revision-realdb.test.ts.
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

/** Real sealed operation id for a fenced writer revision — exact-anchor authority for recovery previews. */
async function sealedOperationId(recordId: string, version: number): Promise<string> {
  const r = await q(
    `SELECT operation_id::text AS op FROM meta_record_revisions
      WHERE sheet_id = $1 AND record_id = $2 AND version = $3 AND operation_id IS NOT NULL
      ORDER BY seq DESC LIMIT 1`,
    [SHEET, recordId, version],
  )
  const op = (r.rows[0] as { op: string } | undefined)?.op
  expect(op).toBeTruthy()
  return op!
}

async function liveRecord(recordId: string): Promise<{ data: Record<string, unknown>; version: number } | undefined> {
  const r = await q('SELECT data, version FROM meta_records WHERE id = $1', [recordId])
  return r.rows[0] as { data: Record<string, unknown>; version: number } | undefined
}

async function attachmentDeletedAt(attachmentId: string): Promise<string | null> {
  const r = await q('SELECT deleted_at FROM multitable_attachments WHERE id = $1', [attachmentId])
  return (r.rows[0] as { deleted_at: string | null } | undefined)?.deleted_at ?? null
}

// Seeds a record via raw INSERT + a matching `create` revision (§0.6 fixture note above) — legitimate:
// A6 (form-submit CREATE) is OUT of scope for this slice, so seeding this way (not through a route) does
// not smuggle A6 coverage into this file.
async function seedRecord(data: Record<string, unknown>, actorId: string | null = MEMBER): Promise<string> {
  const recId = nextId('rec')
  await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [recId, SHEET, JSON.stringify(data), actorId])
  await recordRecordRevision(q, {
    sheetId: SHEET,
    recordId: recId,
    version: 1,
    action: 'create',
    source: 'rest',
    actorId,
    changedFieldIds: [],
    patch: {},
    snapshot: data,
  })
  return recId
}

async function seedAttachment(recordId: string, fieldId: string, filename: string): Promise<string> {
  const attId = nextId('att')
  await q(
    `INSERT INTO multitable_attachments
       (id, sheet_id, record_id, field_id, storage_file_id, filename, original_name, mime_type, size, storage_path)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [attId, SHEET, recordId, fieldId, `storage_${attId}`, filename, filename, 'text/plain', 11, `${attId}/path`],
  )
  return attId
}

const deleteAttachment = (attachmentId: string) => request(app).delete(`/api/multitable/attachments/${attachmentId}`)

describeIfDatabase('D-1c slice ⑤ (FINAL) — attachment-delete cell-strip writes attachment revisions (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      if (currentUser) (req as unknown as { user?: unknown }).user = currentUser
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'D1C5 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'D1C5 Sheet'])
    // Covering checkpoint while empty so later fenced strip writes can serve as exact recovery anchors.
    await poolManager.get().transaction(async ({ query }) => {
      await activateCheckpoint(query as unknown as QueryFn, { sheetId: SHEET })
    })
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_NAME, SHEET, 'Name', 'string', '{}', 1],
    )
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_FILES, SHEET, 'Files', 'attachment', '{}', 2],
    )
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [MEMBER])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ADMIN])
    // Fence on for the whole suite so strip writers mint sealed operation endpoints usable as anchors.
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT = 'true'
  })

  afterAll(async () => {
    delete process.env.MULTITABLE_ENABLE_PIT_RESET
    delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
    delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
    await pruneSealedHistoryOperations(SHEET).catch(() => {})
    await q('DELETE FROM multitable_attachments WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_history_baselines WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_history_trust_checkpoints WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_recovery_token_burns WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[MEMBER, ADMIN]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL is set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('G0 POSITIVE CONTROL: an already-compliant normal-path PATCH (NOT the site under test) proves the harness + reconstructor are trustworthy', async () => {
    const recId = await seedRecord({ [FLD_NAME]: 'g0-v1' })
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

  test('real entry-point golden: DELETE /attachments/:id writes an update revision with source=attachment, the strip actor, and the FULL post-strip snapshot (merge trap)', async () => {
    const recId = await seedRecord({ [FLD_NAME]: 'keep-me-main' })
    // two attachments on the SAME field — proves only the deleted id is removed, the sibling id survives.
    const attA = await seedAttachment(recId, FLD_FILES, 'a.txt')
    const attB = await seedAttachment(recId, FLD_FILES, 'b.txt')
    await q('UPDATE meta_records SET data = data || $1::jsonb WHERE id = $2', [JSON.stringify({ [FLD_FILES]: [attA, attB] }), recId])
    // keep the seed revision's snapshot honest with the live row it now matches (§0.6 content projection).
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2', [SHEET, recId])
    await recordRecordRevision(q, { sheetId: SHEET, recordId: recId, version: 1, action: 'create', source: 'rest', actorId: MEMBER, changedFieldIds: [], patch: {}, snapshot: { [FLD_NAME]: 'keep-me-main', [FLD_FILES]: [attA, attB] } })

    asUser(MEMBER, ['multitable:read', 'multitable:write'])
    const res = await deleteAttachment(attA)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, data: { deleted: attA } })

    const row = await liveRecord(recId)
    expect(row?.version).toBe(2)
    expect(row?.data).toEqual({ [FLD_NAME]: 'keep-me-main', [FLD_FILES]: [attB] })

    const revs = await revisionsOf(recId)
    expect(revs).toHaveLength(2) // create + this strip-update
    const last = revs[revs.length - 1]!
    expect(last.action).toBe('update')
    expect(last.source).toBe('attachment')
    expect(last.actor_id).toBe(MEMBER)
    expect(last.version).toBe(2)
    expect(last.changed_field_ids).toEqual([FLD_FILES])
    expect(last.patch).toEqual({ [FLD_FILES]: [attB] })
    // THE merge-trap assertion: the snapshot carries FLD_NAME too, though it was never touched by this
    // strip — a naive `snapshot: patch` would drop it (identical class to every other slice's G4).
    expect(last.snapshot).toEqual({ [FLD_NAME]: 'keep-me-main', [FLD_FILES]: [attB] })

    expect(await attachmentDeletedAt(attA)).not.toBeNull()
    expect(await attachmentDeletedAt(attB)).toBeNull()
  })

  test('PIT-correct after fix: reconstructRecordsAtT returns the post-strip cell value at T >= strip', async () => {
    // Note: this deliberately does NOT also assert a "T < strip returns the pre-strip value" leg — the
    // seed's create revision and the strip's update revision can land within the same few milliseconds
    // on a local/CI Postgres, and computing a "before" cutoff ahead of time races the D-1 asOf-margin
    // convention (a margin generous enough to clear the route's millisecond truncation can overtake the
    // NEXT revision when writes are this close together). The slice's proof obligation is T >= strip;
    // sibling slice ① (same route family) does not carry a "before" leg either.
    const recId = await seedRecord({ [FLD_FILES]: [] })
    const att = await seedAttachment(recId, FLD_FILES, 'pit.txt')
    await q('UPDATE meta_records SET data = data || $1::jsonb WHERE id = $2', [JSON.stringify({ [FLD_FILES]: [att] }), recId])
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2', [SHEET, recId])
    await recordRecordRevision(q, { sheetId: SHEET, recordId: recId, version: 1, action: 'create', source: 'rest', actorId: MEMBER, changedFieldIds: [], patch: {}, snapshot: { [FLD_FILES]: [att] } })

    asUser(MEMBER, ['multitable:read', 'multitable:write'])
    const res = await deleteAttachment(att)
    expect(res.status).toBe(200)

    const asOfAfter = await cutoffAfterVersion(recId, 2)

    const stateAfter = await reconstructRecordsAtT(q, SHEET, asOfAfter, [recId])
    expect((stateAfter.get(recId)?.data as Record<string, unknown> | null)?.[FLD_FILES]).toEqual([])
    expect(stateAfter.get(recId)?.version).toBe(2)
  })

  test('the destructive leg: revert-preview at the sealed strip operation proposes ZERO reverts for this record (PIT/revert no longer lies)', async () => {
    const recId = await seedRecord({ [FLD_FILES]: [] })
    const att = await seedAttachment(recId, FLD_FILES, 'revert.txt')
    await q('UPDATE meta_records SET data = data || $1::jsonb WHERE id = $2', [JSON.stringify({ [FLD_FILES]: [att] }), recId])
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2', [SHEET, recId])
    await recordRecordRevision(q, { sheetId: SHEET, recordId: recId, version: 1, action: 'create', source: 'rest', actorId: MEMBER, changedFieldIds: [], patch: {}, snapshot: { [FLD_FILES]: [att] } })

    asUser(MEMBER, ['multitable:read', 'multitable:write'])
    const stripRes = await deleteAttachment(att)
    expect(stripRes.status).toBe(200)

    const anchorOperationId = await sealedOperationId(recId, 2)
    asUser(ADMIN, ['multitable:read', 'multitable:write', 'multitable:share'])
    const pv = await request(app).post(`/api/multitable/sheets/${SHEET}/revert-preview`).send({ anchorOperationId })
    expect(pv.status).toBe(200)
    const proposedIds = ((pv.body as { data?: { records?: Array<{ recordId: string }> } }).data?.records ?? []).map((r) => r.recordId)
    expect(proposedIds).not.toContain(recId)
    expect(pv.body?.data?.summary?.visibleRevertCount ?? 0).toBe(0)
  })

  test('atomicity: if the revision INSERT throws, the WHOLE transaction rolls back — the record edit AND the attachment soft-delete both undo, no half-write', async () => {
    const recId = await seedRecord({ [FLD_NAME]: 'atomic-v1' })
    const att = await seedAttachment(recId, FLD_FILES, 'atomic.txt')
    await q('UPDATE meta_records SET data = data || $1::jsonb WHERE id = $2', [JSON.stringify({ [FLD_FILES]: [att] }), recId])
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2', [SHEET, recId])
    await recordRecordRevision(q, { sheetId: SHEET, recordId: recId, version: 1, action: 'create', source: 'rest', actorId: MEMBER, changedFieldIds: [], patch: {}, snapshot: { [FLD_NAME]: 'atomic-v1', [FLD_FILES]: [att] } })

    await q(`CREATE OR REPLACE FUNCTION _d1c5_fail_revision() RETURNS trigger AS $f$
      BEGIN IF NEW.record_id = '${recId}' THEN RAISE EXCEPTION 'd1c5 injected revision failure'; END IF; RETURN NEW; END;
    $f$ LANGUAGE plpgsql`, [])
    await q('CREATE TRIGGER _d1c5_fail_revision_trg BEFORE INSERT ON meta_record_revisions FOR EACH ROW EXECUTE FUNCTION _d1c5_fail_revision()', [])
    try {
      asUser(MEMBER, ['multitable:read', 'multitable:write'])
      const res = await deleteAttachment(att)
      expect(res.status).toBe(500)
    } finally {
      await q('DROP TRIGGER IF EXISTS _d1c5_fail_revision_trg ON meta_record_revisions', [])
      await q('DROP FUNCTION IF EXISTS _d1c5_fail_revision()', [])
    }

    const row = await liveRecord(recId)
    expect(row?.data).toEqual({ [FLD_NAME]: 'atomic-v1', [FLD_FILES]: [att] })
    expect(row?.version).toBe(1)
    expect(await revisionsOf(recId)).toHaveLength(1) // only the seed create — no half-written update
    // THE extra proof unique to this route (two mutations in one txn): the attachment soft-delete
    // rolled back too, not just the record edit.
    expect(await attachmentDeletedAt(att)).toBeNull()
  })

  test('CONCURRENT-DELETE golden (zero-row RETURNING fail-closed, THROW contract — same family as slice ①): a suppressed UPDATE writes NO spurious revision and NO attachment tombstone', async () => {
    // A genuine two-connection race cannot be constructed here: this branch already does
    // `SELECT ... FOR UPDATE` on this exact row inside THIS transaction before reaching the UPDATE, so
    // any real concurrent DELETE/UPDATE from another transaction blocks until this one commits or rolls
    // back (identical reasoning to slice ①'s form-submit EDIT branch). Simulate the OBSERVABLE
    // consequence directly and deterministically: a BEFORE UPDATE trigger that returns NULL for this one
    // row causes Postgres to skip updating it silently — indistinguishable, from the app code's point of
    // view, from "the row vanished between the FOR-UPDATE read and this UPDATE."
    const recId = await seedRecord({ [FLD_FILES]: [] })
    const att = await seedAttachment(recId, FLD_FILES, 'race.txt')
    await q('UPDATE meta_records SET data = data || $1::jsonb WHERE id = $2', [JSON.stringify({ [FLD_FILES]: [att] }), recId])
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2', [SHEET, recId])
    await recordRecordRevision(q, { sheetId: SHEET, recordId: recId, version: 1, action: 'create', source: 'rest', actorId: MEMBER, changedFieldIds: [], patch: {}, snapshot: { [FLD_FILES]: [att] } })

    await q(`CREATE OR REPLACE FUNCTION _d1c5_suppress_update() RETURNS trigger AS $f$
      BEGIN RETURN NULL; END;
    $f$ LANGUAGE plpgsql`, [])
    await q(`CREATE TRIGGER _d1c5_suppress_update_trg BEFORE UPDATE ON meta_records
      FOR EACH ROW WHEN (OLD.id = '${recId}') EXECUTE FUNCTION _d1c5_suppress_update()`, [])
    try {
      asUser(MEMBER, ['multitable:read', 'multitable:write'])
      const res = await deleteAttachment(att)
      // the guard throws NotFoundError -> the route's own catch now maps it to 404, not a raw 500
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recId}` } })
    } finally {
      await q('DROP TRIGGER IF EXISTS _d1c5_suppress_update_trg ON meta_records', [])
      await q('DROP FUNCTION IF EXISTS _d1c5_suppress_update()', [])
    }

    // THE discriminating assertion: exactly the seed create revision — no spurious `update` row.
    const revs = await revisionsOf(recId)
    expect(revs).toHaveLength(1)
    expect(revs[0]!.action).toBe('create')
    const row = await liveRecord(recId)
    expect(row?.data).toEqual({ [FLD_FILES]: [att] })
    expect(row?.version).toBe(1)
    // the attachment tombstone rolled back too — the throw fires BEFORE softDeleteAttachmentRowShared
    // in the same transaction.
    expect(await attachmentDeletedAt(att)).toBeNull()
  })
})
