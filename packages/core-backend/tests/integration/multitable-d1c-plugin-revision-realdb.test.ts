/**
 * Global History — D-1c, W0 slice ② (RATIFIED design-lock, see
 * `docs/development/multitable-global-history-d1c-form-submit-edit-uncaptured-revision-design-lock-20260712.md`,
 * §0.5 OD-1..OD-3, §0/§7a sites A2 + A5):
 *
 *   A2  plugin-SDK `patchRecord`  (`packages/core-backend/src/multitable/records.ts:507`)
 *   A5  plugin-SDK `createRecord` (`packages/core-backend/src/multitable/records.ts:546`)
 *
 * Both sites raw-mutated `meta_records` with NO `meta_record_revisions` row, so `reconstructRecordsAtT`
 * (the primitive under the PIT view / revert / reset) derived existence+data PURELY from revisions and
 * could never see these writes — the "A2 PIT lie" the design-lock's §3 reproduced end-to-end on this
 * exact site, and (for A5) a Reset-to-T at any T after an uncaptured plugin CREATE could not distinguish
 * "created after T" from "created before T but never captured" and would destroy a record legitimately
 * present at T.
 *
 * Fix = emit `recordRecordRevision(...)` inside the SAME transaction as each mutation. `index.ts` wraps
 * every plugin-SDK `createRecord`/`patchRecord` call in `poolManager.get().transaction(...)` — the SOLE
 * production wiring. `source='plugin'` (OD-2 — names the write entry point). `actorId=null` (OD-3 — the
 * plugin lane threads no per-record actor identity through this SDK boundary at all; "no actor is
 * available", never a fabricated system actor).
 *
 * This is a RECYCLE of Draft #4216 (`claude/r13-lane-b-plugin-revision-20260713`, left untouched — a
 * parallel session's Draft, per the owner's "不合、不 rebase" instruction) with the owner's REQUIRED P1
 * fix applied: `patchRecord`'s original `?? existing.version + 1` fallback masked a zero-row
 * `UPDATE ... RETURNING` (the record concurrently deleted between the earlier plain-SELECT reads and
 * this UPDATE — a REAL race here, unlike the form-submit EDIT branch slice ① fixed, which already holds
 * a `SELECT ... FOR UPDATE` before its own UPDATE). Left unguarded, that zero-row UPDATE would still
 * reach `recordRecordRevision(...)` and write a spurious `update` revision for a record that no longer
 * exists — and because `meta_record_revisions.record_id` carries no FK (migration
 * zzzz20260430172000), that revision would persist forever and could RESURRECT the deleted record via
 * `reconstructRecordsAtT`. Fix: fail closed — a zero-row RETURNING throws `MultitableRecordNotFoundError`
 * BEFORE any revision is written. Proven below under GENUINE two-connection Postgres lock contention
 * (never a sleep heuristic — per this line's TOCTOU doctrine: sequential reasoning about a race proves
 * nothing, only a constructed race does).
 *
 * OUT OF SCOPE for this slice (do not read anything below as covering these):
 *   - A3/A4 automation update/create (`automation-executor.ts`) — slice ③, a SEPARATE PR.
 *   - A7 approval `resultWriteback` — slice ④, a SEPARATE PR, `source='approval'`.
 *   - A8 attachment-delete — slice ⑤, a SEPARATE PR, `source='attachment'`.
 *   - The OD-6 revision-disposition guard (#4227) — a separate rung, landing LAST.
 *   - §0.6 `HISTORY_INCOMPLETE` (already landed, #4234) — NOT exercised here at all: PIT-correctness is
 *     proven via a DIRECT `reconstructRecordsAtT` call, never through the revert/reset preview routes
 *     that invoke the §0.6 precheck, so this file adds no fixture obligation against it.
 *   - Edge-level `meta_links` history (OD-4) — a link field's ids ARE captured here as ordinary `data`
 *     (in scope, tested below), but `meta_links` itself getting its own revision/tombstone history is a
 *     SEPARATE, still-unsolved design-lock. Nothing here claims edge-level completeness.
 *
 * Every mutation under test is driven through the REAL production plugin-SDK entry point —
 * `MetaSheetServer`'s (private) `createCoreAPI()` factory, the exact object `index.ts` binds into the
 * plugin IoC container — never a hand-rolled `query` calling `records.ts` functions directly. This is
 * what makes the atomicity + transaction-boundary proofs real: if a future refactor ever unwrapped
 * `poolManager.get().transaction(...)` at the `index.ts` call sites, the atomicity goldens below would
 * go red (the injected revision-INSERT failure would no longer roll back the record mutation), which a
 * hand-rolled `query: txQuery` calling `patchRecord`/`createRecord` directly could never detect (it would
 * silently supply its own transaction and stay green regardless of production wiring).
 *
 * Runs only with DATABASE_URL (plugin-tests.yml multitable real-DB job).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { MetaSheetServer } from '../../src/index'
import { reconstructRecordsAtT } from '../../src/multitable/record-reconstructor'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const OWNER = `u_d1c2_owner_${TS}`
const BASE = `base_d1c2_${TS}`
const SHEET_MAIN = `sheet_d1c2_main_${TS}`
const SHEET_LINK = `sheet_d1c2_link_${TS}`
const SHEET_LINK_TARGET = `sheet_d1c2_linktgt_${TS}`
const SHEET_FAIL_CREATE = `sheet_d1c2_failcreate_${TS}`
const SHEET_FAIL_PATCH = `sheet_d1c2_failpatch_${TS}`
const SHEET_RACE = `sheet_d1c2_race_${TS}`

const FLD_TITLE = `fld_d1c2_title_${TS}`
const FLD_NOTES = `fld_d1c2_notes_${TS}`
const FLD_FAIL_CREATE_TITLE = `fld_d1c2_ftitle_${TS}`
const FLD_FAIL_PATCH_TITLE = `fld_d1c2_ptitle_${TS}`
const FLD_RACE_TITLE = `fld_d1c2_rtitle_${TS}`
const FLD_LINK_TITLE = `fld_d1c2_ltitle_${TS}`
const FLD_LINK = `fld_d1c2_link_${TS}`
const FLD_LINK_TARGET_NAME = `fld_d1c2_tgtname_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

/** The slice of the real core API this golden drives (index.ts builds it; we do not re-declare it). */
type CoreApiShape = {
  multitable: {
    records: {
      createRecord: (input: {
        sheetId: string
        data: Record<string, unknown>
      }) => Promise<{ id: string; sheetId: string; version: number; data: Record<string, unknown> }>
      patchRecord: (input: {
        sheetId: string
        recordId: string
        changes: Record<string, unknown>
      }) => Promise<{ id: string; sheetId: string; version: number; data: Record<string, unknown> }>
    }
  }
}

/** The REAL production plugin-SDK surface — same technique as the D-2 suite's G18/G15 goldens. */
function realSdk(): CoreApiShape['multitable']['records'] {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  const coreApi = (server as unknown as { createCoreAPI: () => CoreApiShape }).createCoreAPI()
  return coreApi.multitable.records
}

async function makeSheet(id: string, name: string): Promise<void> {
  await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [id, BASE, name])
}
async function makeField(
  id: string,
  sheetId: string,
  name: string,
  type: string,
  property: Record<string, unknown> = {},
  order = 0,
): Promise<void> {
  await q(
    `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
    [id, sheetId, name, type, JSON.stringify(property), order],
  )
}

const revisionsOf = async (
  recordId: string,
): Promise<
  Array<{
    action: string
    source: string
    actor_id: string | null
    version: number
    snapshot: Record<string, unknown> | null
    changed_field_ids: string[]
  }>
> =>
  (
    await q(
      `SELECT action, source, actor_id, version, snapshot, changed_field_ids
         FROM meta_record_revisions WHERE record_id = $1 ORDER BY created_at ASC, version ASC`,
      [recordId],
    )
  ).rows as never[]

const recordRow = async (
  recordId: string,
): Promise<{ id: string; data: Record<string, unknown>; version: number } | undefined> =>
  (await q('SELECT id, data, version FROM meta_records WHERE id = $1', [recordId])).rows[0] as
    | { id: string; data: Record<string, unknown>; version: number }
    | undefined

async function cutoffAfter(recordId: string, version: number): Promise<string> {
  const res = await q(
    `SELECT (created_at + interval '1 microsecond')::text AS as_of
       FROM meta_record_revisions WHERE record_id = $1 AND version = $2
       ORDER BY created_at DESC LIMIT 1`,
    [recordId, version],
  )
  expect(res.rows).toHaveLength(1)
  return String((res.rows[0] as { as_of: string }).as_of)
}

/** Genuine Postgres-level failure injection (never a JS-level mock/stub). */
async function injectTrigger(
  name: string,
  spec: { table: string; timing: string; when: string; errcode: string; message: string },
): Promise<void> {
  await q(`CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $fn$
           BEGIN
             RAISE EXCEPTION '${spec.message}' USING ERRCODE = '${spec.errcode}';
           END $fn$ LANGUAGE plpgsql`)
  await q(`CREATE TRIGGER ${name}_trg BEFORE ${spec.timing} ON ${spec.table}
           FOR EACH ROW WHEN (${spec.when}) EXECUTE FUNCTION ${name}()`)
}
async function dropTrigger(name: string, table: string): Promise<void> {
  await q(`DROP TRIGGER IF EXISTS ${name}_trg ON ${table}`).catch(() => {})
  await q(`DROP FUNCTION IF EXISTS ${name}()`).catch(() => {})
}

/**
 * Block until a backend is GENUINELY waiting on the `meta_records` row lock held by THIS test's holder
 * connection — the deterministic proof (never a sleep heuristic) that `patchRecord`'s UPDATE is truly
 * parked behind the holder's uncommitted DELETE, not merely "probably done by now". Correlated to the
 * holder's OWN backend pid via `pg_blocking_pids(pid)` — the same technique as
 * `multitable-d2-sidedoor-delete-recoverability-realdb.test.ts`'s `waitUntilBlockedOnRecordLock` and
 * `approval-card-delivery-wrapper.db.test.ts`'s `waitUntilBlockedOnInstanceLock` — so an unrelated
 * lock-waiter elsewhere in this shared integration database (many `describeIfDatabase` files share ONE
 * Postgres) can never satisfy the probe. Throws (never silently returns) if it never blocks, so this
 * golden can never degrade into the sequential case (a vacuous green).
 */
async function waitUntilBlockedOnRecordLock(
  blockerPid: number,
  queryLike: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await q(
      `SELECT COUNT(*)::int AS c FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND $1 = ANY(pg_blocking_pids(pid))
          AND query ILIKE $2`,
      [blockerPid, queryLike],
    )
    if ((r.rows[0] as { c: number }).c >= 1) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(
    `patchRecord's UPDATE never blocked on the meta_records row lock HELD BY THIS TEST (pid ${blockerPid}) — interleaving did not occur`,
  )
}

describeIfDatabase('D-1c slice ② — plugin-SDK createRecord/patchRecord write plugin revisions (real DB)', () => {
  let sdk: CoreApiShape['multitable']['records']
  let linkTarget: string

  beforeAll(async () => {
    sdk = realSdk()
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE, 'D1C2 Base', OWNER])
    await makeSheet(SHEET_MAIN, 'D1C2 Main')
    await makeSheet(SHEET_LINK, 'D1C2 Link')
    await makeSheet(SHEET_LINK_TARGET, 'D1C2 Link Target')
    await makeSheet(SHEET_FAIL_CREATE, 'D1C2 Fail Create')
    await makeSheet(SHEET_FAIL_PATCH, 'D1C2 Fail Patch')
    await makeSheet(SHEET_RACE, 'D1C2 Race')

    await makeField(FLD_TITLE, SHEET_MAIN, 'Title', 'string', {}, 1)
    await makeField(FLD_NOTES, SHEET_MAIN, 'Notes', 'string', {}, 2) // 2nd field on SHEET_MAIN — G4 merge-trap golden
    await makeField(FLD_FAIL_CREATE_TITLE, SHEET_FAIL_CREATE, 'Title', 'string')
    await makeField(FLD_FAIL_PATCH_TITLE, SHEET_FAIL_PATCH, 'Title', 'string')
    await makeField(FLD_RACE_TITLE, SHEET_RACE, 'Title', 'string')
    await makeField(FLD_LINK_TARGET_NAME, SHEET_LINK_TARGET, 'Name', 'string')
    await makeField(FLD_LINK_TITLE, SHEET_LINK, 'Title', 'string')
    await makeField(FLD_LINK, SHEET_LINK, 'Linked', 'link', { foreignSheetId: SHEET_LINK_TARGET })

    // Seed one target record for the link-edge golden (not itself under test — plain SQL insert is fine,
    // this sheet is never scanned by any §0.6/revert/reset precheck in this file).
    linkTarget = `rec_d1c2_tgt_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
      linkTarget,
      SHEET_LINK_TARGET,
      JSON.stringify({ [FLD_LINK_TARGET_NAME]: 'target' }),
    ])
  })

  afterAll(async () => {
    for (const sheet of [SHEET_MAIN, SHEET_LINK, SHEET_LINK_TARGET, SHEET_FAIL_CREATE, SHEET_FAIL_PATCH, SHEET_RACE]) {
      await q(
        'DELETE FROM meta_record_revisions WHERE record_id IN (SELECT id FROM meta_records WHERE sheet_id = $1)',
        [sheet],
      ).catch(() => {})
      await q('DELETE FROM meta_links WHERE record_id IN (SELECT id FROM meta_records WHERE sheet_id = $1)', [
        sheet,
      ]).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [sheet]).catch(() => {})
    }
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  test('sentinel: DATABASE_URL is set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── Site A5 — plugin-SDK createRecord ──────────────────────────────────────────────────────────────
  describe('Site A5 — plugin-SDK createRecord', () => {
    test('createRecord writes a revision: action=create source=plugin actorId=null, full snapshot', async () => {
      const created = await sdk.createRecord({
        sheetId: SHEET_MAIN,
        data: { [FLD_TITLE]: 'plugin-created v1' },
      })
      expect(created.version).toBe(1)

      const revs = await revisionsOf(created.id)
      expect(revs).toHaveLength(1)
      expect(revs[0]!.action).toBe('create')
      expect(revs[0]!.source).toBe('plugin')
      expect(revs[0]!.actor_id).toBeNull()
      expect(revs[0]!.version).toBe(1)
      expect(revs[0]!.snapshot).toMatchObject({ [FLD_TITLE]: 'plugin-created v1' })
    })

    test('reconstructRecordsAtT sees the record exist immediately after create (was ABSENT before the fix)', async () => {
      const created = await sdk.createRecord({
        sheetId: SHEET_MAIN,
        data: { [FLD_TITLE]: 'plugin-created for-pit' },
      })
      const asOf = await cutoffAfter(created.id, 1)
      const state = await reconstructRecordsAtT(q, SHEET_MAIN, asOf, [created.id])
      const entry = state.get(created.id)
      expect(entry?.exists).toBe(true)
      expect(entry?.version).toBe(1)
      expect(entry?.data).toMatchObject({ [FLD_TITLE]: 'plugin-created for-pit' })
    })

    test('ATOMICITY: a failing revision INSERT rolls back the record INSERT too — no half-write', async () => {
      const trg = `d1c2_fail_create_trg_${TS}`
      await injectTrigger(trg, {
        table: 'meta_record_revisions',
        timing: 'INSERT',
        when: `NEW.sheet_id = '${SHEET_FAIL_CREATE}'`,
        errcode: 'P0001',
        message: 'D1C2 injected create-revision failure',
      })
      try {
        await expect(
          sdk.createRecord({ sheetId: SHEET_FAIL_CREATE, data: { [FLD_FAIL_CREATE_TITLE]: 'never-persisted' } }),
        ).rejects.toThrow(/injected create-revision failure/)
      } finally {
        await dropTrigger(trg, 'meta_record_revisions')
      }

      // The whole unit rolled back: no record was created on this dedicated sheet at all (only one
      // create attempt against it exists in this test).
      const rows = await q('SELECT id FROM meta_records WHERE sheet_id = $1', [SHEET_FAIL_CREATE])
      expect(rows.rows).toHaveLength(0)
      const revRows = await q(
        `SELECT r.id FROM meta_record_revisions r JOIN meta_records m ON m.id = r.record_id WHERE m.sheet_id = $1`,
        [SHEET_FAIL_CREATE],
      )
      expect(revRows.rows).toHaveLength(0)
    })
  })

  // ── Site A2 — plugin-SDK patchRecord ───────────────────────────────────────────────────────────────
  describe('Site A2 — plugin-SDK patchRecord', () => {
    test('patchRecord writes a revision: action=update source=plugin actorId=null, single-field record', async () => {
      const created = await sdk.createRecord({ sheetId: SHEET_MAIN, data: { [FLD_TITLE]: 'v1-original' } })

      const patched = await sdk.patchRecord({
        sheetId: SHEET_MAIN,
        recordId: created.id,
        changes: { [FLD_TITLE]: 'v2-edited-via-plugin' },
      })
      expect(patched.version).toBe(2)

      const revs = await revisionsOf(created.id)
      expect(revs).toHaveLength(2) // create (v1) + update (v2)
      const updateRev = revs.find((r) => r.action === 'update')!
      expect(updateRev.source).toBe('plugin')
      expect(updateRev.actor_id).toBeNull()
      expect(updateRev.version).toBe(2)
      expect(updateRev.changed_field_ids).toEqual([FLD_TITLE])
      // NOTE: this is a SINGLE-field record, so patch ≡ nextData and `snapshot: patch` would pass here
      // too. The merge trap is pinned by the TWO-field golden below, not by this test.
      expect(updateRev.snapshot).toMatchObject({ [FLD_TITLE]: 'v2-edited-via-plugin' })
      expect(Object.keys(updateRev.snapshot ?? {})).toEqual([FLD_TITLE])
    })

    // G4 THE MERGE TRAP: patch ONE field of a TWO-field record; the untouched field MUST survive in the
    // snapshot. On a single-field record patch ≡ nextData, so `snapshot: patch` would pass vacuously.
    // Only a ≥2-field record distinguishes `snapshot: nextData` (full merged row, correct) from
    // `snapshot: patch` (drops the untouched field).
    test('G4 full-merge snapshot: patching ONE field of a TWO-field record keeps the untouched field', async () => {
      const created = await sdk.createRecord({
        sheetId: SHEET_MAIN,
        data: { [FLD_TITLE]: 'g4-title-v1', [FLD_NOTES]: 'g4-notes-untouched' },
      })
      await sdk.patchRecord({
        sheetId: SHEET_MAIN,
        recordId: created.id,
        changes: { [FLD_TITLE]: 'g4-title-v2' }, // patch ONLY title — notes must survive via the data merge
      })
      const updateRev = (await revisionsOf(created.id)).find((r) => r.action === 'update')!
      expect(updateRev.snapshot?.[FLD_TITLE]).toBe('g4-title-v2')
      // the untouched field — `snapshot: patch` (bare single-field patch) would DROP this:
      expect(updateRev.snapshot?.[FLD_NOTES]).toBe('g4-notes-untouched')
      expect(updateRev.changed_field_ids).toEqual([FLD_TITLE])
    })

    test('reconstructRecordsAtT(after edit) returns the NEW value+version (was the PIT LIE before the fix); asOf BEFORE the edit still returns the pre-edit value', async () => {
      const created = await sdk.createRecord({ sheetId: SHEET_MAIN, data: { [FLD_TITLE]: 'pit-v1-original' } })
      const beforeEdit = await cutoffAfter(created.id, 1)

      await sdk.patchRecord({
        sheetId: SHEET_MAIN,
        recordId: created.id,
        changes: { [FLD_TITLE]: 'pit-v2-edited' },
      })
      const afterEdit = await cutoffAfter(created.id, 2)

      // asOf STRICTLY BEFORE the edit must still report the pre-edit value — the new revision must not
      // corrupt earlier T.
      const beforeState = await reconstructRecordsAtT(q, SHEET_MAIN, beforeEdit, [created.id])
      expect(beforeState.get(created.id)).toMatchObject({
        exists: true,
        version: 1,
        data: { [FLD_TITLE]: 'pit-v1-original' },
      })

      // The headline golden: asOf AFTER the edit must report the NEW value+version. Before the fix this
      // returned {version:1, data:'pit-v1-original'} FOREVER (the A2 PIT lie) because no v2 revision
      // existed for reconstructRecordsAtT to see.
      const afterState = await reconstructRecordsAtT(q, SHEET_MAIN, afterEdit, [created.id])
      expect(afterState.get(created.id)).toMatchObject({
        exists: true,
        version: 2,
        data: { [FLD_TITLE]: 'pit-v2-edited' },
      })
    })

    test('OD-4: a link-field edit lands in the revision snapshot as ordinary `data`, consistent with meta_links. Edge-level `meta_links` history is a SEPARATE, still-unsolved lock — NOT claimed or tested here.', async () => {
      const created = await sdk.createRecord({ sheetId: SHEET_LINK, data: { [FLD_LINK_TITLE]: 'link-host' } })

      const patched = await sdk.patchRecord({
        sheetId: SHEET_LINK,
        recordId: created.id,
        changes: { [FLD_LINK]: [linkTarget] },
      })
      expect(patched.version).toBe(2)

      const revs = await revisionsOf(created.id)
      const updateRev = revs.find((r) => r.action === 'update')!
      expect(updateRev.source).toBe('plugin')
      expect(updateRev.actor_id).toBeNull()
      expect(updateRev.snapshot).toMatchObject({ [FLD_LINK]: [linkTarget] })

      // Restoration-consistency: the `meta_links` edge the plugin SDK actually wrote matches the ids the
      // revision snapshot claims.
      const edge = await q('SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2', [
        FLD_LINK,
        created.id,
      ])
      expect((edge.rows as Array<{ foreign_record_id: string }>).map((r) => r.foreign_record_id)).toEqual([
        linkTarget,
      ])
    })

    test('ATOMICITY: a failing revision INSERT rolls back the UPDATE too — record stays at its ORIGINAL pre-patch value', async () => {
      const created = await sdk.createRecord({
        sheetId: SHEET_FAIL_PATCH,
        data: { [FLD_FAIL_PATCH_TITLE]: 'pre-patch-original' },
      })
      expect(created.version).toBe(1)

      const trg = `d1c2_fail_patch_trg_${TS}`
      await injectTrigger(trg, {
        table: 'meta_record_revisions',
        timing: 'INSERT',
        when: `NEW.record_id = '${created.id}' AND NEW.action = 'update'`,
        errcode: 'P0001',
        message: 'D1C2 injected patch-revision failure',
      })
      try {
        await expect(
          sdk.patchRecord({
            sheetId: SHEET_FAIL_PATCH,
            recordId: created.id,
            changes: { [FLD_FAIL_PATCH_TITLE]: 'should-never-stick' },
          }),
        ).rejects.toThrow(/injected patch-revision failure/)
      } finally {
        await dropTrigger(trg, 'meta_record_revisions')
      }

      // Discriminating assertion: not "a row exists" (a swallowed error would also leave one) but that
      // the row is back at its EXACT original pre-patch data AND version — the UPDATE was undone.
      const row = await recordRow(created.id)
      expect(row).toMatchObject({ version: 1, data: { [FLD_FAIL_PATCH_TITLE]: 'pre-patch-original' } })

      // Only the original create revision exists — no update revision was left behind.
      const revs = await revisionsOf(created.id)
      expect(revs).toHaveLength(1)
      expect(revs[0]).toMatchObject({ action: 'create', version: 1 })
    })

    test('BEHAVIOR PRESERVED: patchRecord on a record absent from the start still throws NotFound and writes no revision', async () => {
      const ghost = `rec_d1c2_ghost_${TS}`
      await expect(
        sdk.patchRecord({ sheetId: SHEET_MAIN, recordId: ghost, changes: { [FLD_TITLE]: 'x' } }),
      ).rejects.toThrow(/not found/i)
      expect(await revisionsOf(ghost)).toHaveLength(0)
    })

    // ── THE P1 FIX GOLDEN ────────────────────────────────────────────────────────────────────────────
    // GENUINE two-connection lock race (never a sleep heuristic): Connection A (this test's "holder")
    // opens its own dedicated raw client, BEGINs, and DELETEs the record — an uncommitted, row-locking
    // delete. Connection B is the REAL `sdk.patchRecord(...)` call: its plain `getRecord`/
    // `guardRecordNotLockedForPlugin` reads succeed immediately (readers never block on an uncommitted
    // writer under MVCC), but its `UPDATE` — the FIRST point in `patchRecord` that actually needs the row
    // lock — blocks behind the holder's uncommitted DELETE. Only once `waitUntilBlockedOnRecordLock`
    // deterministically confirms B is genuinely parked behind A's lock does A COMMIT. B's UPDATE then
    // resumes under READ COMMITTED semantics, discovers the row was concurrently deleted, and affects
    // ZERO rows — exactly the condition the P1 fix guards. Before the fix, the masked
    // `?? existing.version + 1` fallback would have silently synthesized a version and gone on to write a
    // spurious `update` revision for a now-nonexistent record.
    test('CONCURRENT-DELETE golden (P1 fix): a DELETE that commits WHILE patchRecord is blocked on the row lock produces a zero-row UPDATE — the fix throws NotFound and writes NO spurious revision', async () => {
      const created = await sdk.createRecord({ sheetId: SHEET_RACE, data: { [FLD_RACE_TITLE]: 'race-v1' } })
      expect(created.version).toBe(1)

      const rawPool = poolManager.get().getInternalPool()
      const holder = await rawPool.connect()
      let patchRejection: Error | undefined
      try {
        await holder.query('BEGIN')
        await holder.query('DELETE FROM meta_records WHERE id = $1', [created.id])
        const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)

        const patchPromise = sdk
          .patchRecord({
            sheetId: SHEET_RACE,
            recordId: created.id,
            changes: { [FLD_RACE_TITLE]: 'race-v2-SHOULD-NOT-LAND' },
          })
          .then(
            () => undefined,
            (err: unknown) => {
              patchRejection = err as Error
              return undefined
            },
          )

        // Barrier: block until B is deterministically confirmed parked behind A's lock on THIS record.
        await waitUntilBlockedOnRecordLock(holderPid, '%UPDATE meta_records%')

        // A commits ⇒ the row is truly gone ⇒ B's UPDATE unblocks and sees ZERO matching rows.
        await holder.query('COMMIT')
        await patchPromise
      } finally {
        holder.release()
      }

      expect(patchRejection).toBeInstanceOf(Error)
      expect(patchRejection?.message).toMatch(/not found/i)

      // THE discriminating assertion: exactly the original create revision — no spurious `update` row.
      const revs = await revisionsOf(created.id)
      expect(revs).toHaveLength(1)
      expect(revs[0]!.action).toBe('create')

      // And the record itself really is gone — this is a genuine concurrent DELETE (not a suppression
      // proxy), so there is no live row left to compare a "did it change" assertion against.
      expect(await recordRow(created.id)).toBeUndefined()
    }, 15000)
  })
})
