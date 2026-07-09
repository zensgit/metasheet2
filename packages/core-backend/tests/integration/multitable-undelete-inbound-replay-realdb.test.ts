/**
 * 4c-3 record-undelete inbound-edge replay — RB1–RB11 golden matrix (real DB). Design-lock
 * `docs/development/multitable-global-history-4c3-record-undelete-2b-inbound-edge-replay-design-lock-20260708.md`
 * (owner-ratified 2026-07-09, semantics = Option A neighbour-consent).
 *
 * Cross-sheet by construction (RB2 requirement): R lives on SHEET_A, its neighbours N on SHEET_B,
 * where the link field F is declared. The tombstone's `sheet_id` stores R's sheet while
 * `field_id`/`record_id` belong to N's — the replay must never filter on it (§2 trap).
 *
 * RB12 (mutations) is executed OUTSIDE this file: each precondition in
 * `inbound-link-replay.ts` / the retention floor is neutered in src → exactly the matching golden
 * here goes red → precise revert. Recorded in the PR body.
 *
 * RB13/RB14 (R8 absorption-audit hardening, P3-3/NIT-3 — post-hoc, no product behaviour changed):
 * both preconditions were ALREADY correctly implemented (precondition 2's `JOIN meta_records n` and
 * the `recoverable: replay.total > 0` computation in record-service.ts) but had no dedicated golden.
 * See `/tmp/pr3975-4c3-absorption-audit-claude-20260709.md`.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import {
  sweepLinkTombstoneRetention,
  type MetaRevisionRetentionConfig,
} from '../../src/multitable/meta-revision-retention'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_rb_${TS}`
const SHEET_A = `sheet_rb_a_${TS}` // R's sheet (deleted/restored records)
const SHEET_B = `sheet_rb_b_${TS}` // neighbours' sheet (owns the link field F)
const WRITER = `u_rb_w_${TS}`
const CAPTURE_FLAG = 'MULTITABLE_TOMBSTONE_CAPTURE_ENABLED'
const INBOUND_FLAG = 'MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND'

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let seq = 0
const mkFieldId = (tag: string) => `fld_rb_${tag}_${TS}_${seq++}`
const mkRecordId = (tag: string) => `rec_rb_${tag}_${TS}_${seq++}`

async function insertField(sheetId: string, fieldId: string, type = 'link', property = '{}'): Promise<void> {
  await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
    fieldId, sheetId, fieldId, type, property, seq,
  ])
}
async function insertRecord(sheetId: string, recordId: string, data: Record<string, unknown>): Promise<void> {
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [recordId, sheetId, JSON.stringify(data)])
}
async function insertLink(fieldId: string, recordId: string, foreignRecordId: string): Promise<void> {
  await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [fieldId, recordId, foreignRecordId])
}
const httpDelete = (recordId: string) => request(app).delete(`/api/multitable/records/${recordId}`)
const httpRestore = (recordId: string) => request(app).post(`/api/multitable/records/${recordId}/restore`)
const edgeCount = async (fieldId: string, recordId: string, foreignId: string): Promise<number> =>
  (await q('SELECT 1 FROM meta_links WHERE field_id=$1 AND record_id=$2 AND foreign_record_id=$3', [fieldId, recordId, foreignId])).rows.length

/** Standard fixture: N (on B) points at R (on A) through link field F (on B). */
async function fixture(tag: string): Promise<{ F: string; R: string; N: string }> {
  const F = mkFieldId(tag)
  await insertField(SHEET_B, F)
  const R = mkRecordId(`${tag}r`)
  await insertRecord(SHEET_A, R, {})
  const N = mkRecordId(`${tag}n`)
  await insertRecord(SHEET_B, N, { [F]: [R] })
  await insertLink(F, N, R)
  return { F, R, N }
}

const RETENTION: MetaRevisionRetentionConfig = {
  enabled: true,
  policy: 'keep-days',
  keepN: 5,
  retentionDays: 30,
  batchSize: 100,
}

describeIfDatabase('4c-3 — record-undelete inbound-edge replay (real DB, RB matrix)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: WRITER, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'RB Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_A, BASE, 'RB A'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_B, BASE, 'RB B'])
    // Every test in this suite runs with capture ON (tombstones must exist to replay); the inbound
    // flag is per-test (RB1 proves OFF is inert).
    process.env[CAPTURE_FLAG] = 'true'
  })

  afterAll(async () => {
    delete process.env[CAPTURE_FLAG]
    delete process.env[INBOUND_FLAG]
    for (const sheet of [SHEET_A, SHEET_B]) {
      await q('DELETE FROM meta_link_tombstones WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_links WHERE field_id IN (SELECT id FROM meta_fields WHERE sheet_id = $1)', [sheet]).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [sheet]).catch(() => {})
    }
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  afterEach(() => {
    delete process.env[INBOUND_FLAG]
    process.env[CAPTURE_FLAG] = 'true'
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('RB1 flag-off: restore replays NO inbound edge and the response carries no inbound field (byte-identical)', async () => {
    const { F, R, N } = await fixture('rb1')
    expect((await httpDelete(R)).status).toBe(200)
    const res = await httpRestore(R)
    expect(res.status).toBe(200)
    expect(res.body?.data?.inbound).toBeUndefined()
    expect(await edgeCount(F, N, R)).toBe(0) // today's behavior: inbound edge stays lost
  })

  test('RB2 happy path (CROSS-SHEET): inbound edge comes back; neighbour cell re-renders R; trash list signalled recoverable', async () => {
    process.env[INBOUND_FLAG] = 'true'
    const { F, R, N } = await fixture('rb2')
    expect((await httpDelete(R)).status).toBe(200)
    expect(await edgeCount(F, N, R)).toBe(0)

    // §6 signal on the trash list BEFORE restoring.
    const trash = await request(app).get(`/api/multitable/sheets/${SHEET_A}/trash`)
    expect(trash.status).toBe(200)
    const row = (trash.body?.data?.records ?? trash.body?.records ?? []).find(
      (r: { recordId: string }) => r.recordId === R,
    )
    expect(row?.inboundEdgesRecoverable).toBe(true)

    const res = await httpRestore(R)
    expect(res.status).toBe(200)
    expect(res.body?.data?.inbound).toMatchObject({ replayed: 1, recoverable: true })
    expect(await edgeCount(F, N, R)).toBe(1)
  })

  test('RB3 legacy trash row (NULL anchor): outbound-only restore, recoverable=false, nothing fabricated', async () => {
    process.env[INBOUND_FLAG] = 'true'
    const { F, R, N } = await fixture('rb3')
    expect((await httpDelete(R)).status).toBe(200)
    await q('UPDATE meta_records_trash SET delete_revision_id = NULL WHERE record_id = $1', [R])
    const res = await httpRestore(R)
    expect(res.status).toBe(200)
    expect(res.body?.data?.inbound).toMatchObject({ replayed: 0, recoverable: false })
    expect(await edgeCount(F, N, R)).toBe(0)
  })

  test('RB4 link field DELETED inside the window: no 23503, restore succeeds, edge skipped as fieldGone', async () => {
    process.env[INBOUND_FLAG] = 'true'
    const { F, R, N } = await fixture('rb4')
    expect((await httpDelete(R)).status).toBe(200)
    await q('DELETE FROM meta_links WHERE field_id = $1', [F]) // FK rows first (no cascade needed here but explicit)
    await q('DELETE FROM meta_fields WHERE id = $1', [F])
    const res = await httpRestore(R)
    expect(res.status).toBe(200)
    expect(res.body?.data?.inbound?.replayed).toBe(0)
    expect(res.body?.data?.inbound?.skipped?.fieldGone).toBe(1)
    expect(await edgeCount(F, N, R)).toBe(0)
  })

  test('RB5 link field RETYPED inside the window: skipped as fieldNotLink', async () => {
    process.env[INBOUND_FLAG] = 'true'
    const { F, R, N } = await fixture('rb5')
    expect((await httpDelete(R)).status).toBe(200)
    await q("UPDATE meta_fields SET type = 'text' WHERE id = $1", [F])
    const res = await httpRestore(R)
    expect(res.status).toBe(200)
    expect(res.body?.data?.inbound?.skipped?.fieldNotLink).toBe(1)
    expect(await edgeCount(F, N, R)).toBe(0)
  })

  test('RB6 link field became a MIRROR inside the window: skipped as fieldMirror (spine invariant)', async () => {
    process.env[INBOUND_FLAG] = 'true'
    const { F, R, N } = await fixture('rb6')
    expect((await httpDelete(R)).status).toBe(200)
    await q(`UPDATE meta_fields SET property = '{"mirrorOf":"whatever"}'::jsonb WHERE id = $1`, [F])
    const res = await httpRestore(R)
    expect(res.status).toBe(200)
    expect(res.body?.data?.inbound?.skipped?.fieldMirror).toBe(1)
    expect(await edgeCount(F, N, R)).toBe(0)
  })

  test('RB7 Option A: neighbour REMOVED the link inside the window — never replayed, no data/meta_links fork', async () => {
    process.env[INBOUND_FLAG] = 'true'
    const { F, R, N } = await fixture('rb7')
    expect((await httpDelete(R)).status).toBe(200)
    await q(`UPDATE meta_records SET data = jsonb_set(data, $2, '[]'::jsonb) WHERE id = $1`, [N, `{${F}}`])
    const res = await httpRestore(R)
    expect(res.status).toBe(200)
    expect(res.body?.data?.inbound?.skipped?.neighborDeclined).toBe(1)
    expect(await edgeCount(F, N, R)).toBe(0) // the user's removal wins — index stays consistent with N.data
  })

  test('RB8 self-link: outbound replay + inbound capture yield exactly ONE edge', async () => {
    process.env[INBOUND_FLAG] = 'true'
    const F = mkFieldId('rb8')
    await insertField(SHEET_A, F) // self-link: field on R's own sheet
    const R = mkRecordId('rb8r')
    await insertRecord(SHEET_A, R, { [F]: [R] })
    await insertLink(F, R, R)
    expect((await httpDelete(R)).status).toBe(200)
    const res = await httpRestore(R)
    expect(res.status).toBe(200)
    expect(await edgeCount(F, R, R)).toBe(1)
    expect(res.body?.data?.inbound?.skipped?.alreadyPresent).toBe(1) // the inbound copy deferred to outbound's row
  })

  test('RB9 delete→restore→delete→restore: each restore anchors to ITS OWN vintage, never doubles', async () => {
    process.env[INBOUND_FLAG] = 'true'
    const { F, R, N } = await fixture('rb9')
    expect((await httpDelete(R)).status).toBe(200)
    const r1 = await httpRestore(R)
    expect(r1.body?.data?.inbound?.replayed).toBe(1)
    expect(await edgeCount(F, N, R)).toBe(1)
    expect((await httpDelete(R)).status).toBe(200)
    const r2 = await httpRestore(R)
    expect(r2.body?.data?.inbound?.replayed).toBe(1) // vintage 2's single tombstone — not 1+2 across vintages
    expect(await edgeCount(F, N, R)).toBe(1)
  })

  test('RB10 retention: floor protects live-trash-referenced groups; whole-group pruning never tears a set', async () => {
    process.env[INBOUND_FLAG] = 'true'
    // Group 1: R1 deleted, trash row STAYS (floor must protect its tombstones even when aged).
    const fx1 = await fixture('rb10a')
    const N2 = mkRecordId('rb10a2')
    await insertRecord(SHEET_B, N2, { [fx1.F]: [fx1.R] })
    await insertLink(fx1.F, N2, fx1.R) // second inbound edge → group of 2 rows (torn-set material)
    expect((await httpDelete(fx1.R)).status).toBe(200)
    const anchor1 = (await q('SELECT delete_revision_id FROM meta_records_trash WHERE record_id = $1', [fx1.R])).rows[0] as { delete_revision_id: string }
    expect(anchor1.delete_revision_id).toBeTruthy()

    // Group 2: R2 deleted then RESTORED (trash row gone → group prunable once aged).
    const fx2 = await fixture('rb10b')
    expect((await httpDelete(fx2.R)).status).toBe(200)
    const anchor2 = (await q('SELECT delete_revision_id FROM meta_records_trash WHERE record_id = $1', [fx2.R])).rows[0] as { delete_revision_id: string }
    expect((await httpRestore(fx2.R)).status).toBe(200)

    // Age EVERYTHING far past keep-days.
    await q(`UPDATE meta_link_tombstones SET created_at = now() - interval '400 days' WHERE source_revision_id IN ($1::uuid, $2::uuid)`, [anchor1.delete_revision_id, anchor2.delete_revision_id])

    const swept = await sweepLinkTombstoneRetention(q as never, RETENTION)
    expect(swept).toBeGreaterThanOrEqual(1)
    // Floor: group 1 (live trash reference) survives INTACT — both rows.
    const g1 = await q('SELECT 1 FROM meta_link_tombstones WHERE source_revision_id = $1::uuid', [anchor1.delete_revision_id])
    expect(g1.rows).toHaveLength(2)
    // Group 2 (restored → no trash row) is gone WHOLE — zero rows, not a torn remainder.
    const g2 = await q('SELECT 1 FROM meta_link_tombstones WHERE source_revision_id = $1::uuid', [anchor2.delete_revision_id])
    expect(g2.rows).toHaveLength(0)
    // And the protected record is STILL fully restorable with its inbound edges.
    const res = await httpRestore(fx1.R)
    expect(res.status).toBe(200)
    expect(res.body?.data?.inbound?.replayed).toBe(2)
    expect(await edgeCount(fx1.F, fx1.N, fx1.R)).toBe(1)
    expect(await edgeCount(fx1.F, N2, fx1.R)).toBe(1)
  })

  test('RB11 concurrency (C4): the loser blocks on the trash row FOR UPDATE and gets a clean 409 — no dup edges, no half state', async () => {
    process.env[INBOUND_FLAG] = 'true'
    const { F, R, N } = await fixture('rb11')
    expect((await httpDelete(R)).status).toBe(200)
    const trashPk = String(
      ((await q('SELECT id FROM meta_records_trash WHERE record_id = $1', [R])).rows[0] as { id: unknown }).id,
    )

    // Deterministic interleaving (a raw Promise.all race can also legally yield 404 when the loser's
    // pre-read lands after the winner's commit — that path is fine but proves nothing about C4).
    // Here the "winner" is a manual txn that (1) grabs the trash row FOR UPDATE, (2) waits until the
    // HTTP restore is provably blocked on that same FOR UPDATE, (3) performs the winning restore's
    // essential writes and commits. The blocked loser then resumes, finds the trash row gone, and
    // must 409 — the exact C4 contract.
    const pool = poolManager.get()
    let loserPromise: Promise<{ status: number }> | undefined
    await pool.transaction(async ({ query }) => {
      await query('SELECT * FROM meta_records_trash WHERE id = $1 FOR UPDATE', [trashPk])
      // supertest Tests are LAZY thenables — the HTTP request is not dispatched until .then() is
      // attached. Promise.resolve() attaches it now, so the loser really is in flight (and blocked
      // on our FOR UPDATE) while this txn still holds the lock.
      loserPromise = Promise.resolve(httpRestore(R)) as unknown as Promise<{ status: number }>
      // Give the loser time to pass its pre-read and block on our row lock.
      await new Promise((r) => setTimeout(r, 400))
      await query(
        'INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
        [R, SHEET_A, JSON.stringify({})],
      )
      await query('DELETE FROM meta_records_trash WHERE id = $1', [trashPk])
    })
    const loser = await loserPromise!
    expect(loser.status).toBe(409)
    // No duplicate restore artifacts: exactly one record row, trash empty, at most the winner's edges.
    expect((await q('SELECT 1 FROM meta_records WHERE id = $1', [R])).rows).toHaveLength(1)
    expect((await q('SELECT 1 FROM meta_records_trash WHERE record_id = $1', [R])).rows).toHaveLength(0)
    expect(await edgeCount(F, N, R)).toBeLessThanOrEqual(1)
  })

  test('RB13 neighborGone: N hard-deleted inside the window — that edge is skipped (not a 23503/FK surprise), R restore still succeeds', async () => {
    process.env[INBOUND_FLAG] = 'true'
    const { F, R, N } = await fixture('rb13')
    expect((await httpDelete(R)).status).toBe(200)
    // Hard-delete the neighbour itself (no cascade concern: its inbound-owning meta_links row was
    // already destroyed by R's delete above — this only removes N's own meta_records row).
    await q('DELETE FROM meta_records WHERE id = $1', [N])
    const res = await httpRestore(R)
    expect(res.status).toBe(200)
    expect(res.body?.data?.inbound?.replayed).toBe(0)
    expect(res.body?.data?.inbound?.skipped?.neighborGone).toBe(1)
    expect(await edgeCount(F, N, R)).toBe(0) // N no longer exists — nothing to point at it
  })

  test('RB14 anchor present but ZERO tombstones (capture was OFF for this one delete): recoverable=false, zero replay, no error', async () => {
    process.env[INBOUND_FLAG] = 'true'
    process.env[CAPTURE_FLAG] = 'false' // capture off for THIS delete only — anchor still gets written (record-service always pre-generates it)
    const { F, R, N } = await fixture('rb14')
    expect((await httpDelete(R)).status).toBe(200)
    process.env[CAPTURE_FLAG] = 'true' // restore the suite default before the restore call below
    const trashRow = (await q('SELECT delete_revision_id FROM meta_records_trash WHERE record_id = $1', [R])).rows[0] as { delete_revision_id: string | null }
    expect(trashRow.delete_revision_id).toBeTruthy() // anchor is unconditional — NOT gated by the capture flag
    const tombstones = await q('SELECT 1 FROM meta_link_tombstones WHERE source_revision_id = $1::uuid', [trashRow.delete_revision_id])
    expect(tombstones.rows).toHaveLength(0) // nothing was captured — capture was off at delete time
    const res = await httpRestore(R)
    expect(res.status).toBe(200)
    expect(res.body?.data?.inbound).toMatchObject({ replayed: 0, recoverable: false }) // honest, not fabricated
    expect(await edgeCount(F, N, R)).toBe(0)
  })
})
