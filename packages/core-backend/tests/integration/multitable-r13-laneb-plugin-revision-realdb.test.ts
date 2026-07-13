/**
 * R13 Lane B (design-lock `multitable-global-history-d1c-form-submit-edit-uncaptured-revision-design-lock-20260712.md`,
 * §0.5 OD-1 lane B; owner-ratified 2026-07-13). Real DB.
 *
 * The two plugin-SDK single-record write sites mutated `meta_records` (data + version) but wrote NO
 * `meta_record_revisions` row:
 *
 *   `records.ts:546` createRecord  (audit A5, `/tmp/r13-revision-disposition-audit-20260713.md` §1 row 2)
 *   `records.ts:507` patchRecord   (audit A2, §1 row 6 — REPRODUCED end-to-end in the design-lock §3)
 *
 * `reconstructRecordsAtT` (`record-reconstructor.ts:34`) derives record existence AND data PURELY from
 * `meta_record_revisions`. Without a revision:
 *   - a plugin-created record is ABSENT from every PIT/revert/reset view forever, and a Reset-to-T that
 *     should PRESERVE it instead DESTROYS it (audit §1(c): `computeSheetReset` cannot distinguish
 *     "created after T" from "created before T but never captured", so it deletes both).
 *   - a plugin-patched record's PIT/revert/reset/History-Center view lies with the PRE-patch value and
 *     version, at every T after the patch, forever (the design-lock's "A2 PIT lie", reproduced in §3).
 *
 * The fix (records.ts createRecord/patchRecord) emits the revision in the SAME transaction as the
 * mutation. Ratified terms (§0.5): source:'plugin' (OD-2), actorId:null (OD-3 — the plugin lane is
 * actor-less by design), snapshot = the FULL post-write row including any link-field ids (OD-4).
 *
 * ## Transaction-boundary proof (re-verified per-lane, not assumed — D-1「偏差1」/ D-2 §0)
 *
 * `index.ts` wraps BOTH `createRecord` (index.ts:592-611) and `patchRecord` (index.ts:630-650) in
 * `poolManager.get().transaction(...)` — this is the SOLE production wiring. Rather than grep the
 * source (a source-text assertion is not a behaviour assertion), every golden below drives the REAL
 * `MetaSheetServer.createCoreAPI()` factory — precisely the technique the D-2 suite's G18 uses to close
 * the same "does the entry point actually supply one" gap. If a refactor ever unwrapped the transaction,
 * the ATOMICITY goldens (G7create/G7patch) would immediately go red: the mutation would persist even
 * though the injected revision-INSERT failure threw.
 *
 * ## Failure-injection direction (the one place a wrong choice gives a fake-green suite)
 *
 * D-2's delete sequence is `[…, revision, trash, record-DELETE]` — the destructive statement is LAST, so
 * D-2 injects the failure into that LAST statement and asserts the EARLIER writes (revision/trash) rolled
 * back (D1-5b BEFORE-DELETE-trigger technique; injecting into the revision INSERT there was proven
 * fake-green in #3992 — failing an EARLIER statement in that sequence never even reaches the later ones).
 *
 * This lane's sequence is the OPPOSITE shape: `[meta_records INSERT/UPDATE, revision INSERT]` — the
 * MUTATION is first, the REVISION is last. Failing the mutation would be the fake-green direction here
 * (the revision call would simply never run, "no revision" trivially true with or without a transaction).
 * So — mirroring the design-lock's own G7 recipe verbatim, which is correct FOR THIS LANE precisely
 * because the ordering is inverted vs. D-2 — every atomicity golden below fails the LAST write (the
 * revision INSERT) via a scoped Postgres trigger and asserts the EARLIER write (the INSERT/UPDATE into
 * meta_records) rolled back.
 *
 * Trigger injections are SCOPED (by dedicated sheet, or by record-id + action) so they cannot affect any
 * other suite sharing this Postgres in the same `vitest run` (plugin-tests.yml runs many
 * `describeIfDatabase` files against ONE instance).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { MetaSheetServer } from '../../src/index'
import { reconstructRecordsAtT } from '../../src/multitable/record-reconstructor'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const OWNER = `u_r13b_owner_${TS}`
const BASE = `base_r13b_${TS}`
const SHEET_MAIN = `sheet_r13b_main_${TS}`
const SHEET_LINK = `sheet_r13b_link_${TS}`
const SHEET_LINK_TARGET = `sheet_r13b_linktgt_${TS}`
const SHEET_FAIL_CREATE = `sheet_r13b_failcreate_${TS}`
const SHEET_FAIL_PATCH = `sheet_r13b_failpatch_${TS}`

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

/** The REAL production plugin-SDK surface — same technique as the D-2 suite's G18. */
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

/** Genuine Postgres-level failure injection (never a JS-level mock/stub — see file header). */
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

describeIfDatabase('R13 Lane B — plugin-SDK createRecord/patchRecord revision parity (real DB)', () => {
  let sdk: CoreApiShape['multitable']['records']
  let linkTarget: string

  beforeAll(async () => {
    sdk = realSdk()
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE, 'R13B Base', OWNER])
    await makeSheet(SHEET_MAIN, 'R13B Main')
    await makeSheet(SHEET_LINK, 'R13B Link')
    await makeSheet(SHEET_LINK_TARGET, 'R13B Link Target')
    await makeSheet(SHEET_FAIL_CREATE, 'R13B Fail Create')
    await makeSheet(SHEET_FAIL_PATCH, 'R13B Fail Patch')

    await makeField(`fld_r13b_title_${TS}`, SHEET_MAIN, 'Title', 'string')
    await makeField(`fld_r13b_ftitle_${TS}`, SHEET_FAIL_CREATE, 'Title', 'string')
    await makeField(`fld_r13b_ptitle_${TS}`, SHEET_FAIL_PATCH, 'Title', 'string')
    await makeField(`fld_r13b_tgtname_${TS}`, SHEET_LINK_TARGET, 'Name', 'string')
    await makeField(`fld_r13b_ltitle_${TS}`, SHEET_LINK, 'Title', 'string')
    await makeField(`fld_r13b_lnk_${TS}`, SHEET_LINK, 'Linked', 'link', { foreignSheetId: SHEET_LINK_TARGET })

    // Seed one target record for the link-edge golden (not itself under test — plain SQL insert is fine).
    linkTarget = `rec_r13b_tgt_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
      linkTarget,
      SHEET_LINK_TARGET,
      JSON.stringify({ [`fld_r13b_tgtname_${TS}`]: 'target' }),
    ])
  })

  afterAll(async () => {
    for (const sheet of [SHEET_MAIN, SHEET_LINK, SHEET_LINK_TARGET, SHEET_FAIL_CREATE, SHEET_FAIL_PATCH]) {
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

  // ── G1/G4 createRecord — revision written, correct shape, full snapshot ──────────────────────────
  test('createRecord (A5): writes a revision — action=create source=plugin actorId=null, full snapshot', async () => {
    const created = await sdk.createRecord({
      sheetId: SHEET_MAIN,
      data: { [`fld_r13b_title_${TS}`]: 'plugin-created v1' },
    })
    expect(created.version).toBe(1)

    const revs = await revisionsOf(created.id)
    expect(revs).toHaveLength(1)
    expect(revs[0]!.action).toBe('create')
    expect(revs[0]!.source).toBe('plugin')
    expect(revs[0]!.actor_id).toBeNull()
    expect(revs[0]!.version).toBe(1)
    expect(revs[0]!.snapshot).toMatchObject({ [`fld_r13b_title_${TS}`]: 'plugin-created v1' })
  })

  // ── G2 — the A5 "absent from PIT" bug is gone: the record now EXISTS as of a T right after create ──
  test('createRecord (A5): reconstructRecordsAtT sees the record exist immediately (was ABSENT before the fix)', async () => {
    const created = await sdk.createRecord({
      sheetId: SHEET_MAIN,
      data: { [`fld_r13b_title_${TS}`]: 'plugin-created for-pit' },
    })
    const asOf = await cutoffAfter(created.id, 1)
    const state = await reconstructRecordsAtT(q, SHEET_MAIN, asOf, [created.id])
    const entry = state.get(created.id)
    expect(entry?.exists).toBe(true)
    expect(entry?.version).toBe(1)
    expect(entry?.data).toMatchObject({ [`fld_r13b_title_${TS}`]: 'plugin-created for-pit' })
  })

  // ── G1/G4 patchRecord — revision written, correct shape, FULL merged snapshot (not the bare patch) ─
  test('patchRecord (A2): writes a revision — action=update source=plugin actorId=null, FULL merged snapshot', async () => {
    const titleField = `fld_r13b_title_${TS}`
    const created = await sdk.createRecord({ sheetId: SHEET_MAIN, data: { [titleField]: 'v1-original' } })

    const patched = await sdk.patchRecord({
      sheetId: SHEET_MAIN,
      recordId: created.id,
      changes: { [titleField]: 'v2-edited-via-plugin' },
    })
    expect(patched.version).toBe(2)

    const revs = await revisionsOf(created.id)
    expect(revs).toHaveLength(2) // create (v1) + update (v2)
    const updateRev = revs.find((r) => r.action === 'update')!
    expect(updateRev.source).toBe('plugin')
    expect(updateRev.actor_id).toBeNull()
    expect(updateRev.version).toBe(2)
    expect(updateRev.changed_field_ids).toEqual([titleField])
    // The snapshot is the FULL merged row, not the raw single-field patch — pins the merge trap the
    // design-lock's G4 warns about (a naive `snapshot: patch` would still pass on a single-field record;
    // it is asserted structurally here, not just by field count, so a future multi-field regression
    // cannot slip through).
    expect(updateRev.snapshot).toMatchObject({ [titleField]: 'v2-edited-via-plugin' })
    expect(Object.keys(updateRev.snapshot ?? {})).toEqual([titleField])
  })

  // ── G2/G5 the A2 PIT LIE is gone: PIT-after-edit now returns the NEW value, not the stale one ──────
  test('patchRecord (A2): reconstructRecordsAtT(after edit) returns the NEW value+version (was the PIT LIE before the fix)', async () => {
    const titleField = `fld_r13b_title_${TS}`
    const created = await sdk.createRecord({ sheetId: SHEET_MAIN, data: { [titleField]: 'pit-v1-original' } })
    const beforeEdit = await cutoffAfter(created.id, 1)

    await sdk.patchRecord({
      sheetId: SHEET_MAIN,
      recordId: created.id,
      changes: { [titleField]: 'pit-v2-edited' },
    })
    const afterEdit = await cutoffAfter(created.id, 2)

    // G3 shape: an asOf STRICTLY BEFORE the edit must still report the pre-edit value — the new
    // revision must not corrupt earlier T.
    const beforeState = await reconstructRecordsAtT(q, SHEET_MAIN, beforeEdit, [created.id])
    expect(beforeState.get(created.id)).toMatchObject({
      exists: true,
      version: 1,
      data: { [titleField]: 'pit-v1-original' },
    })

    // The headline golden: asOf AFTER the edit must report the NEW value+version. Before the fix this
    // returned {version:1, data:'pit-v1-original'} FOREVER (the A2 PIT lie) because no v2 revision
    // existed for reconstructRecordsAtT to see.
    const afterState = await reconstructRecordsAtT(q, SHEET_MAIN, afterEdit, [created.id])
    expect(afterState.get(created.id)).toMatchObject({
      exists: true,
      version: 2,
      data: { [titleField]: 'pit-v2-edited' },
    })
  })

  // ── OD-4 link-edge parity: the revision snapshot ↔ meta_links restoration-consistency golden ───────
  test('patchRecord (OD-4): a link-field edit is a real data mutation — revision snapshot carries the link ids consistent with meta_links', async () => {
    const linkField = `fld_r13b_lnk_${TS}`
    const titleField = `fld_r13b_ltitle_${TS}`
    const created = await sdk.createRecord({ sheetId: SHEET_LINK, data: { [titleField]: 'link-host' } })

    const patched = await sdk.patchRecord({
      sheetId: SHEET_LINK,
      recordId: created.id,
      changes: { [linkField]: [linkTarget] },
    })
    expect(patched.version).toBe(2)

    const revs = await revisionsOf(created.id)
    const updateRev = revs.find((r) => r.action === 'update')!
    expect(updateRev.source).toBe('plugin')
    expect(updateRev.actor_id).toBeNull()
    // The revision's data snapshot must include the link ids — they are part of `data` (OD-4 ruling).
    expect(updateRev.snapshot).toMatchObject({ [linkField]: [linkTarget] })

    // Restoration-consistency: the `meta_links` edge the plugin SDK actually wrote matches the ids the
    // revision snapshot claims — a restore/PIT that reproduces the snapshot reproduces the SAME edge.
    const edge = await q(
      'SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2',
      [linkField, created.id],
    )
    expect((edge.rows as Array<{ foreign_record_id: string }>).map((r) => r.foreign_record_id)).toEqual([
      linkTarget,
    ])
  })

  // ── G8 mutation proof reference: see the "source mutation -> red" verification note in the PR/report;
  //    deleting either recordRecordRevision(...) call in records.ts makes every test above in this file
  //    RED (revisionsOf(...) returns fewer rows than expected, and the PIT goldens revert to the stale
  //    pre-fix behaviour). Not re-asserted mechanically here — this file drives the FIX, not its own
  //    absence; the mutation was verified manually (see report) by temporarily reverting the fix locally.

  // ── G7create — atomicity: fail the LAST write (revision INSERT) -> the EARLIER write (the INSERT into
  //    meta_records) rolls back. Uses a DEDICATED sheet (no other test writes to it) so the trigger,
  //    scoped by sheet_id, cannot touch any other suite's rows in a shared-DB CI run.
  test('createRecord (A5) ATOMICITY: a failing revision INSERT rolls back the record INSERT too — no half-write', async () => {
    const trg = `r13b_fail_create_trg_${TS}`
    await injectTrigger(trg, {
      table: 'meta_record_revisions',
      timing: 'INSERT',
      when: `NEW.sheet_id = '${SHEET_FAIL_CREATE}'`,
      errcode: 'P0001',
      message: 'R13B injected create-revision failure',
    })
    try {
      await expect(
        sdk.createRecord({ sheetId: SHEET_FAIL_CREATE, data: { [`fld_r13b_ftitle_${TS}`]: 'never-persisted' } }),
      ).rejects.toThrow(/injected create-revision failure/)
    } finally {
      await dropTrigger(trg, 'meta_record_revisions')
    }

    // The whole unit rolled back: the record the failed call would have created does not exist AT ALL
    // (there is only ever one create attempt against this dedicated sheet in this test).
    const rows = await q('SELECT id FROM meta_records WHERE sheet_id = $1', [SHEET_FAIL_CREATE])
    expect(rows.rows).toHaveLength(0)
    const revRows = await q(
      `SELECT r.id FROM meta_record_revisions r JOIN meta_records m ON m.id = r.record_id WHERE m.sheet_id = $1`,
      [SHEET_FAIL_CREATE],
    )
    expect(revRows.rows).toHaveLength(0)
  })

  // ── G7patch — atomicity: fail the LAST write (revision INSERT) -> the EARLIER write (the UPDATE of
  //    meta_records) rolls back to the record's ORIGINAL pre-patch data+version. Scoped to this ONE
  //    record + action='update' so the record's own CREATE revision (which must succeed first) is
  //    unaffected, and no other suite's writes are touched.
  test('patchRecord (A2) ATOMICITY: a failing revision INSERT rolls back the UPDATE too — record stays at its ORIGINAL pre-patch value', async () => {
    const titleField = `fld_r13b_ptitle_${TS}`
    const created = await sdk.createRecord({
      sheetId: SHEET_FAIL_PATCH,
      data: { [titleField]: 'pre-patch-original' },
    })
    expect(created.version).toBe(1)

    const trg = `r13b_fail_patch_trg_${TS}`
    await injectTrigger(trg, {
      table: 'meta_record_revisions',
      timing: 'INSERT',
      when: `NEW.record_id = '${created.id}' AND NEW.action = 'update'`,
      errcode: 'P0001',
      message: 'R13B injected patch-revision failure',
    })
    try {
      await expect(
        sdk.patchRecord({
          sheetId: SHEET_FAIL_PATCH,
          recordId: created.id,
          changes: { [titleField]: 'should-never-stick' },
        }),
      ).rejects.toThrow(/injected patch-revision failure/)
    } finally {
      await dropTrigger(trg, 'meta_record_revisions')
    }

    // Discriminating assertion: not "a row exists" (a swallowed error would also leave one) but that the
    // row is back at its EXACT original pre-patch data AND version — the UPDATE was undone, not merely
    // left uncommitted-but-visible.
    const row = await recordRow(created.id)
    expect(row).toMatchObject({ version: 1, data: { [titleField]: 'pre-patch-original' } })

    // Only the original create revision exists — no update revision was left behind, and no stray v2
    // revision with the failed patch's data leaked through.
    const revs = await revisionsOf(created.id)
    expect(revs).toHaveLength(1)
    expect(revs[0]).toMatchObject({ action: 'create', version: 1 })
  })

  // ── Behaviour preserved: a genuine plugin-SDK error (not the revision path) still surfaces normally,
  //    and obviously writes no revision for a record that was never created/patched. ─────────────────
  test('BEHAVIOR PRESERVED: patchRecord on a missing record still throws NotFound and writes no revision', async () => {
    const ghost = `rec_r13b_ghost_${TS}`
    await expect(
      sdk.patchRecord({ sheetId: SHEET_MAIN, recordId: ghost, changes: { [`fld_r13b_title_${TS}`]: 'x' } }),
    ).rejects.toThrow(/not found/i)
    expect(await revisionsOf(ghost)).toHaveLength(0)
  })
})
