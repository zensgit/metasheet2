/**
 * W0 tail — field-undelete rehydration now emits revisions (real DB). OD-6 owner ruling (design-lock §0.5,
 * 2026-07-13): `recreateFieldFromConfig`'s tombstone-value rehydration UPDATE (univer-meta.ts) rewrites real
 * captured user cell values back into `meta_records.data` — MUST-WRITE, not silently exempt, the exact
 * fingerprint of the bug class the D-1c five slices (#4245-#4249) closed. It was the SOLE entry in
 * `KNOWN_REVISION_GAPS` (`multitable-revision-disposition-guard.guard.test.ts`); this is the site's own
 * rung: the UPDATE now bumps `version` and RETURNs the post-write row so a `recordRecordRevision` is
 * emitted AT THE NEW version, same transaction, for every rehydrated record. Zero rows affected (record
 * hard-deleted concurrently, between tombstone capture and undelete) emits nothing — no FK-less ghost.
 *
 * Interplay with W0-1 (#4269, `3356a7ed6`, LANDED before this branch was cut) — `history-integrity-
 * precheck.ts`'s own docstring DEFERRED list named this exact site as a still-open "content-integrity gap,
 * own rung" (see its §1.3 SECOND LAYER: live user-field content must equal the LATEST captured revision's
 * snapshot). Before this fix: the rehydration wrote real data with no revision at all, so the "latest"
 * snapshot for a rehydrated record stayed stale (missing the field) while live data carried it — a false
 * HISTORY_INCOMPLETE (`content_mismatch`) waiting to fire on the very next revert/reset-preview. The
 * PRIMARY layer (contiguity) has an independent failure mode: bumping `version` with NO emitted revision
 * leaves a hole (`chain_hole`); emitting a revision at the OLD, pre-bump version instead of the new one
 * creates a duplicate occupant (`duplicate_version_event`). The POSITIVE CONTROL below exercises the real
 * `revert-preview` route (the precheck's own production entry point, both layers) after a rehydration and
 * asserts 200 — proving the landed shape (bump-then-emit-at-new-version, full snapshot) is correct on BOTH
 * layers at once, not just individually reasoned about.
 *
 * Mutation matrix (manually run against this file, not automated — see the PR body for the transcript):
 *   • delete the `recordRecordRevision(...)` call (keep the version bump)  → CONTIGUITY golden reds
 *     (chain_hole: liveVersion=2, no chain event at v2).
 *   • delete `version = m.version + 1` from the UPDATE (keep the emit, at the now-unbumped `RETURNING`
 *     version, i.e. still 1) → CONTIGUITY golden reds (duplicate_version_event: two events at v1).
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { reconstructRecordsAtT } from '../../src/multitable/record-reconstructor'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_tfrr_${TS}`
const UNDELETE_FLAG = 'MULTITABLE_ENABLE_CONFIG_UNDELETE'
const CAPTURE_FLAG = 'MULTITABLE_TOMBSTONE_CAPTURE_ENABLED'
const REVERT_FLAG = 'MULTITABLE_ENABLE_SHEET_REVERT'

type Actor = { id: string; roles: string[]; perms: string[] }
// 'multitable:share' is what `canManageSheetAccess` actually keys on (sheet-capabilities.ts) — needed for
// the revert-preview positive control (D2: a sheet-wide revert needs a sheet-admin cap, above plain write).
const MANAGER: Actor = { id: `u_tfrr_mgr_${TS}`, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:share'] }

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let actor: Actor = MANAGER
let seq = 0
const CREATED_SHEETS: string[] = []

async function freshSheet(tag: string): Promise<string> {
  const id = `sheet_tfrr_${tag}_${TS}`
  await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [id, BASE, id])
  CREATED_SHEETS.push(id)
  return id
}
const mkFieldId = (tag: string) => `fld_tfrr_${tag}_${TS}_${seq++}`
const mkRecordId = (tag: string) => `rec_tfrr_${tag}_${TS}_${seq++}`

async function insertField(sheetId: string, fieldId: string, name: string, type: string, order: number): Promise<void> {
  await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [fieldId, sheetId, name, type, '{}', order])
}
async function insertRecord(sheetId: string, recordId: string, data: Record<string, unknown>): Promise<void> {
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [recordId, sheetId, JSON.stringify(data)])
}
/** A record-revision at an explicit `created_at` — the deterministic BEFORE baseline `reconstructRecordsAtT`
 * reads (it derives purely from `meta_record_revisions`, never from live `meta_records`). Deliberately
 * independent of the live row's initial `data` (see the happy-path test): the "before" fixture records the
 * record's OWN pre-rehydration revision-timeline state (field absent), same as a real record whose only
 * captured history predates the field ever being (re)created on it. */
async function seedCreateRevision(sheetId: string, recordId: string, data: Record<string, unknown>, createdAtIso: string): Promise<void> {
  await q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, patch, snapshot, created_at)
     VALUES (gen_random_uuid(), $1, $2, 1, 'create', 'rest', $3, ARRAY[]::text[], '{}'::jsonb, $4::jsonb, $5)`,
    [sheetId, recordId, MANAGER.id, JSON.stringify(data), createdAtIso],
  )
}

const deleteField = (fieldId: string) => request(app).delete(`/api/multitable/fields/${fieldId}`)
const preview = (sheetId: string, revisionId: string, as: Actor = MANAGER) => { actor = as; return request(app).post(`/api/multitable/sheets/${sheetId}/config-restore-preview`).send({ revisionId }) }
const execute = (sheetId: string, body: Record<string, unknown>, as: Actor = MANAGER) => { actor = as; return request(app).post(`/api/multitable/sheets/${sheetId}/config-restore-execute`).send(body) }
const revertPreview = (sheetId: string, asOf: string, as: Actor = MANAGER) => { actor = as; return request(app).post(`/api/multitable/sheets/${sheetId}/revert-preview`).send({ asOf }) }

async function lastFieldDeleteRevisionId(sheetId: string, fieldId: string): Promise<string> {
  const r = await q(
    `SELECT id FROM meta_config_revisions WHERE sheet_id = $1 AND entity_type = 'field' AND entity_id = $2 AND action = 'delete'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [sheetId, fieldId],
  )
  return (r.rows[0] as { id: string }).id
}
async function recordRow(recordId: string): Promise<{ version: number; data: Record<string, unknown> } | undefined> {
  const r = await q('SELECT version, data FROM meta_records WHERE id = $1', [recordId])
  return r.rows[0] as { version: number; data: Record<string, unknown> } | undefined
}
type RevisionRow = { version: number; action: string; source: string; actor_id: string | null; changed_field_ids: string[]; patch: Record<string, unknown>; snapshot: Record<string, unknown> | null; batch_id: string | null }
async function revisionsFor(recordId: string): Promise<RevisionRow[]> {
  const r = await q('SELECT version, action, source, actor_id, changed_field_ids, patch, snapshot, batch_id FROM meta_record_revisions WHERE record_id = $1 ORDER BY version', [recordId])
  return r.rows as RevisionRow[]
}
/** meta_fields uses HARD delete (no `deleted_at` column) — "still deleted" for a field means "still absent". */
async function fieldExists(fieldId: string): Promise<boolean> {
  const r = await q('SELECT 1 FROM meta_fields WHERE id = $1', [fieldId])
  return r.rows.length > 0
}
async function fieldOrder(fieldId: string): Promise<number | undefined> {
  const r = await q('SELECT "order" FROM meta_fields WHERE id = $1', [fieldId])
  const row = r.rows[0] as { order: number } | undefined
  return row ? Number(row.order) : undefined
}
async function fieldCreateRevisionCount(sheetId: string, fieldId: string): Promise<number> {
  const r = await q(`SELECT COUNT(*)::int AS n FROM meta_config_revisions WHERE sheet_id = $1 AND entity_type = 'field' AND entity_id = $2 AND action = 'create'`, [sheetId, fieldId])
  return Number((r.rows[0] as { n: number }).n)
}

describeIfDatabase('W0 tail — field-undelete rehydration emits revisions (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as { user?: Actor }).user = actor; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'TFRR Base'])
  })

  afterAll(async () => {
    for (const s of CREATED_SHEETS) {
      await q('DELETE FROM meta_field_value_tombstones WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_link_tombstones WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_record_version_markers WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [s]).catch(() => {})
    }
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  beforeEach(() => {
    process.env[CAPTURE_FLAG] = 'true'
    process.env[UNDELETE_FLAG] = 'true'
    process.env[REVERT_FLAG] = 'true' // revert-preview itself is ungated, but set for parity/§ interplay clarity
  })
  afterEach(() => {
    delete process.env[UNDELETE_FLAG]
    delete process.env[CAPTURE_FLAG]
    delete process.env[REVERT_FLAG]
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('happy path: two rehydrated records each get version+1 and a revision AT THE NEW version (full snapshot, shared batch), reconstructRecordsAtT sees the before/after boundary, and revert-preview (W0-1 contiguity + content-projection) 200s — the positive control', async () => {
    const s = await freshSheet('happy')
    const F = mkFieldId('happy')
    await insertField(s, F, 'HappyVal', 'string', 1)

    const R1 = mkRecordId('happy1')
    const R2 = mkRecordId('happy2')
    const T0 = new Date(Date.now() - 60_000).toISOString()
    // Live rows start WITH F (so field-delete's capture actually tombstones a value for each).
    await insertRecord(s, R1, { [F]: 'original-1', other: 'x1' })
    await insertRecord(s, R2, { [F]: 'original-2', other: 'x2' })
    // Each record's OWN pre-rehydration revision-timeline baseline is WITHOUT F (see helper docstring).
    await seedCreateRevision(s, R1, { other: 'x1' }, T0)
    await seedCreateRevision(s, R2, { other: 'x2' }, T0)
    const tBeforeRehydrate = new Date(Date.parse(T0) + 30_000).toISOString() // 30s after T0, well before "now"

    expect((await deleteField(F)).status).toBe(200)
    const revF = await lastFieldDeleteRevisionId(s, F)

    const p = await preview(s, revF)
    expect(p.status).toBe(200)
    expect(p.body?.data?.undelete?.tombstoneAvailable).toBe(true)
    const ok = await execute(s, { revisionId: revF, previewToken: p.body.data.previewToken, confirm: 'undelete' })
    expect(ok.status).toBe(200)
    const tAfterRehydrate = new Date().toISOString()

    // ---- version bump + live data ----
    const row1 = await recordRow(R1)
    expect(row1?.version).toBe(2)
    expect(row1?.data).toEqual({ [F]: 'original-1', other: 'x1' })
    const row2 = await recordRow(R2)
    expect(row2?.version).toBe(2)
    expect(row2?.data).toEqual({ [F]: 'original-2', other: 'x2' })

    // ---- revision AT THE NEW version, full snapshot, correct disposition (OD-2/OD-3) ----
    const revs1 = await revisionsFor(R1)
    expect(revs1).toHaveLength(2) // seeded create@1 + the emitted rehydration@2
    const rehydrateRev1 = revs1.find((r) => r.version === 2)
    expect(rehydrateRev1).toMatchObject({
      action: 'update',
      source: 'restore',
      actor_id: MANAGER.id,
      changed_field_ids: [F],
      patch: { [F]: 'original-1' },
      snapshot: { [F]: 'original-1', other: 'x1' }, // FULL post-write row, not patch-only
    })
    const revs2 = await revisionsFor(R2)
    const rehydrateRev2 = revs2.find((r) => r.version === 2)
    expect(rehydrateRev2).toMatchObject({ action: 'update', source: 'restore', patch: { [F]: 'original-2' }, snapshot: { [F]: 'original-2', other: 'x2' } })

    // One shared batchId across every record THIS field-undelete rehydrated (LOCK-12), distinct records same batch.
    expect(rehydrateRev1?.batch_id).toBeTruthy()
    expect(rehydrateRev1?.batch_id).toBe(rehydrateRev2?.batch_id)

    // ---- reconstructRecordsAtT: before the rehydration (field absent) vs after (rehydrated value) ----
    const beforeState = (await reconstructRecordsAtT(q, s, tBeforeRehydrate, [R1])).get(R1)
    expect(beforeState).toMatchObject({ exists: true, version: 1, data: { other: 'x1' } })
    expect(beforeState?.data?.[F]).toBeUndefined()
    const afterState = (await reconstructRecordsAtT(q, s, tAfterRehydrate, [R1])).get(R1)
    expect(afterState).toMatchObject({ exists: true, version: 2, data: { [F]: 'original-1', other: 'x1' } })

    // ---- POSITIVE CONTROL: W0-1 generation-aware contiguity + retained content-projection both pass. Before
    // this fix, `history-integrity-precheck.ts`'s own docstring named this exact site as a DEFERRED content-
    // integrity gap — the rehydrated live data had no matching revision, so the content-projection layer would
    // have refused (content_mismatch) the very next revert/reset-preview on this sheet.
    const pv = await revertPreview(s, tAfterRehydrate)
    expect(pv.status).toBe(200)
  })

  test('zero-row / concurrent-delete leg: a record hard-deleted between field-delete and field-undelete gets NO ghost revision; its live sibling still rehydrates correctly', async () => {
    const s = await freshSheet('zero')
    const F = mkFieldId('zero')
    await insertField(s, F, 'ZeroVal', 'string', 1)

    const R_KEEP = mkRecordId('zerokeep')
    const R_DIES = mkRecordId('zerodies')
    const T0 = new Date(Date.now() - 60_000).toISOString()
    await insertRecord(s, R_KEEP, { [F]: 'keep-val' })
    await insertRecord(s, R_DIES, { [F]: 'dies-val' })
    await seedCreateRevision(s, R_KEEP, {}, T0)
    await seedCreateRevision(s, R_DIES, {}, T0)

    expect((await deleteField(F)).status).toBe(200) // captures tombstones for BOTH records
    const revF = await lastFieldDeleteRevisionId(s, F)

    // Concurrent hard-delete of R_DIES between the field-delete and the field-undelete (simulates a race —
    // no delete revision is written either, mirroring a genuinely uncaptured concurrent removal).
    await q('DELETE FROM meta_records WHERE id = $1', [R_DIES])

    const p = await preview(s, revF)
    expect(p.status).toBe(200)
    const ok = await execute(s, { revisionId: revF, previewToken: p.body.data.previewToken, confirm: 'undelete' })
    expect(ok.status).toBe(200)

    // R_KEEP rehydrated normally: version+1, one new revision.
    const keepRow = await recordRow(R_KEEP)
    expect(keepRow?.version).toBe(2)
    expect(keepRow?.data?.[F]).toBe('keep-val')
    expect(await revisionsFor(R_KEEP)).toHaveLength(2) // seeded create@1 + rehydration@2

    // R_DIES: no live row (still gone), and — the fail-closed leg this test pins — NO ghost revision was
    // written for it. Only its pre-existing seeded create@1 remains; a revision without a matching data
    // write is an FK-less ghost (the D-1c slice ②/③ attack this codebase already hardened against).
    expect(await recordRow(R_DIES)).toBeUndefined()
    const diesRevs = await revisionsFor(R_DIES)
    expect(diesRevs).toHaveLength(1)
    expect(diesRevs[0]?.action).toBe('create')
  })

  // Owner post-merge review of #4279 (Medium finding #2): the two tests above prove the success path and
  // the zero-row leg, but neither forces a `meta_record_revisions` INSERT failure AFTER the row data/version
  // updates — so neither actually pins that the WHOLE field-undelete (field re-creation + its order-shift +
  // its create-revision + the per-record rehydration UPDATE + the per-record revision emit) is ONE atomic
  // transaction. This golden does, following the same scoped-trigger shape as the D-1c slice ⑤ atomicity
  // golden (`multitable-d1c-attachment-revision-realdb.test.ts`).
  test('atomicity golden: if the meta_record_revisions INSERT throws mid-rehydration, the WHOLE field-undelete transaction rolls back — field re-creation, its order-shift, AND the record data/version all undo, no half-write', async () => {
    const s = await freshSheet('atomic')
    const F = mkFieldId('atomic')
    const TRAIL = mkFieldId('atomicTrail') // a trailing field — proves the recreate's own order-shift undoes too
    await insertField(s, F, 'AtomicVal', 'string', 1)
    await insertField(s, TRAIL, 'Trailing', 'string', 2)

    const R = mkRecordId('atomic')
    const T0 = new Date(Date.now() - 60_000).toISOString()
    await insertRecord(s, R, { [F]: 'atomic-orig', other: 'x1' })
    await seedCreateRevision(s, R, { other: 'x1' }, T0)

    expect((await deleteField(F)).status).toBe(200)
    // The forward delete already shifted TRAIL's order 2 -> 1 (the -1 shift dropFieldCascade applies).
    expect(await fieldOrder(TRAIL)).toBe(1)
    const revF = await lastFieldDeleteRevisionId(s, F)

    const p = await preview(s, revF)
    expect(p.status).toBe(200)
    expect(p.body?.data?.undelete?.tombstoneAvailable).toBe(true)
    const previewToken = p.body.data.previewToken

    // Scoped, self-cleaning failure injection: fires ONLY for R's own rehydration-revision INSERT — the
    // AND clause (record_id match AND source='restore') is the exact discriminator recreateFieldFromConfig
    // uses for this write (see univer-meta.ts ~6569), so this cannot fire for any other concurrently-seeded
    // record or test file sharing this database. Dropped in `finally`, always, win or lose.
    await q(`CREATE OR REPLACE FUNCTION _tfrr_atomic_fail_revision() RETURNS trigger AS $f$
      BEGIN IF NEW.record_id = '${R}' AND NEW.source = 'restore' THEN RAISE EXCEPTION 'tfrr atomic injected revision failure'; END IF; RETURN NEW; END;
    $f$ LANGUAGE plpgsql`, [])
    await q('CREATE TRIGGER _tfrr_atomic_fail_revision_trg BEFORE INSERT ON meta_record_revisions FOR EACH ROW EXECUTE FUNCTION _tfrr_atomic_fail_revision()', [])
    try {
      const failed = await execute(s, { revisionId: revF, previewToken, confirm: 'undelete' })
      expect(failed.status).toBe(500) // not a RecordServiceRestoreConflictError -> falls through to the outer catch's generic 500
    } finally {
      await q('DROP TRIGGER IF EXISTS _tfrr_atomic_fail_revision_trg ON meta_record_revisions', [])
      await q('DROP FUNCTION IF EXISTS _tfrr_atomic_fail_revision()', [])
    }

    // ---- everything in the SAME transaction rolled back: field re-creation, its order-shift, config
    // revision, record data + version, and the (never-committed) revision emit itself. ----
    expect(await fieldExists(F)).toBe(false) // field: still absent (hard-delete; "still deleted" == still no row)
    expect(await fieldOrder(TRAIL)).toBe(1) // the recreate's own +1 shift did NOT stick (would be 2 if it had)
    expect(await fieldCreateRevisionCount(s, F)).toBe(0) // the field-create config revision never committed

    const row = await recordRow(R)
    expect(row?.data).toEqual({ other: 'x1' }) // rehydrated value NOT present
    expect(row?.version).toBe(1) // unchanged — the version bump did not survive the rollback
    expect(await revisionsFor(R)).toHaveLength(1) // only the seeded create@1 — no ghost rehydration revision

    // ---- positive control: identical fixture, trigger gone -> the SAME undelete now succeeds fully. Proves
    // the failure above was caused BY the trigger (not a broken previewToken / stale-revision fixture) — the
    // revision id and preview flow are still valid; the DB state is byte-for-byte back where the delete left it. ----
    const p2 = await preview(s, revF)
    expect(p2.status).toBe(200)
    const ok = await execute(s, { revisionId: revF, previewToken: p2.body.data.previewToken, confirm: 'undelete' })
    expect(ok.status).toBe(200)

    expect(await fieldExists(F)).toBe(true)
    expect(await fieldOrder(TRAIL)).toBe(2) // this time the shift DOES stick
    const row2 = await recordRow(R)
    expect(row2?.data).toEqual({ [F]: 'atomic-orig', other: 'x1' })
    expect(row2?.version).toBe(2)
    expect(await revisionsFor(R)).toHaveLength(2)
  })
})
