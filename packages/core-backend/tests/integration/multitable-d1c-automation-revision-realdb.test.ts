/**
 * Global History — D-1c, W0 slice ③ (RATIFIED design-lock, see
 * `docs/development/multitable-global-history-d1c-form-submit-edit-uncaptured-revision-design-lock-20260712.md`,
 * §0.5 OD-1..OD-3, §0/§7a sites A3 + A4):
 *
 *   A3  automation `update_record` (`packages/core-backend/src/multitable/automation-executor.ts:2217`)
 *   A4  automation `create_record` (`packages/core-backend/src/multitable/automation-executor.ts:2475`)
 *
 * Both sites raw-mutated `meta_records` with NO `meta_record_revisions` row, so `reconstructRecordsAtT`
 * (the primitive under the PIT view / revert / reset) derived existence+data PURELY from revisions and
 * could never see these writes — the same "A2 PIT lie" class the design-lock's §3 reproduced end-to-end
 * on the sibling plugin site, just triggered by automation instead. A4 additionally means a
 * Reset-to-T at any T after an uncaptured automation CREATE could not distinguish "created after T" from
 * "created before T but never captured" and would destroy a record legitimately present at T (§0's
 * corrected CREATE-destructive risk).
 *
 * Fix = emit `recordRecordRevision(...)` inside the SAME transaction as each mutation. `source='automation'`
 * (OD-2 — names the write entry point). `actorId=context.actorId ?? null` (OD-3 — the automation actor
 * when present; NEVER a fabricated system actor for an actor-less trigger, e.g. a schedule).
 *
 * This is a RECYCLE of Draft #4220 (`claude/r13-lane-c-automation-revision-writeback-20260713`, left
 * untouched — a parallel session's Draft) with the owner's REQUIRED SURGERY applied: #4220 bundled
 * approval `resultWriteback` (A7) into the same PR. The owner split A7 into its OWN slice ④ — this slice
 * touches ONLY the two `automation-executor.ts` branches above. `automation-service.ts` is UNTOUCHED.
 *
 * ZERO-ROW FAIL-CLOSED DETERMINATION (per-slice obligation): update_record's lock-check SELECT takes NO
 * row lock (no `FOR UPDATE`), so a concurrent DELETE of the trigger record between that SELECT and the
 * UPDATE is reachable — the SAME class slices ①/② hardened. Here it does NOT throw, because this exact
 * lane already has a DOCUMENTED, pre-existing, DIFFERENT contract for a 0-row UPDATE: same-base success,
 * no fabricated revision (see D-1's sibling `executeDeleteRecord`,
 * `multitable-d1-delete-revision-parity-realdb.test.ts`'s "same-base automation delete of a missing
 * record keeps its 0-row success — and fabricates NO revision"). Regressing that into a thrown NotFound
 * would be an UNRELATED behavior change this slice has no mandate to make. So the guard here fails
 * closed on the REVISION ONLY (`if (updatedRow) { ...write revision... }`), proven below both for a
 * never-existed ghost record and for a GENUINE two-connection concurrent-delete race.
 *
 * create_record gets no symmetric zero-row guard: a bare `INSERT ... RETURNING` with no `ON CONFLICT`
 * clause cannot return zero rows without the statement itself throwing — there is no "concurrently
 * deleted" analogue for a row that does not exist yet (mirrors slice ①'s form-submit CREATE branch and
 * slice ②'s plugin `createRecord`, neither of which added one).
 *
 * TRANSACTION-BOUNDARY RE-VERIFICATION (D-1 "偏差1" — this lane was not uniformly transactional
 * pre-D-1, and must be re-proven per slice, not assumed): every mutation under test here is driven
 * through `AutomationService.executeRule(...)`, the REAL production entry point (`index.ts` constructs
 * `AutomationService` with `pool.query.bind(pool)`, whose constructor hard-wires `deps.transaction` to a
 * real `poolManager.get().transaction(...)`). The ATOMICITY goldens below inject a Postgres-level
 * failure into the revision INSERT — the LAST statement at each site — and assert the EARLIER
 * `meta_records` mutation rolled back. That assertion is only satisfiable by a real transaction: a
 * hand-rolled `query` calling the executor's private methods directly, or an executor constructed
 * without `deps.transaction`, could never produce it (mirrors slice ②'s reasoning for using the real
 * entry point instead of a hand-rolled query).
 *
 * OUT OF SCOPE for this slice (do not read anything below as covering these):
 *   - A7 approval `resultWriteback` (`automation-service.ts`) — slice ④, a SEPARATE PR, `source='approval'`.
 *     `automation-service.ts` has ZERO diff in this PR.
 *   - A8 attachment-delete — slice ⑤, a SEPARATE PR, `source='attachment'`.
 *   - The OD-6 revision-disposition guard (#4227) — a separate rung, landing LAST.
 *   - §0.6 `HISTORY_INCOMPLETE` (already landed, #4234) — NOT exercised here at all: PIT-correctness is
 *     proven via a DIRECT `reconstructRecordsAtT` call, never through the revert/reset preview routes
 *     that invoke the §0.6 precheck, so this file adds no fixture obligation against it.
 *   - Cross-base `update_record`/`create_record` write-gate behavior (②b) — unchanged by this slice and
 *     already covered by `multitable-cross-base-automation-write.test.ts` (re-run clean, no regression).
 *
 * Runs only with DATABASE_URL (plugin-tests.yml multitable real-DB job).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { EventBus } from '../../src/integration/events/event-bus'
import { AutomationService } from '../../src/multitable/automation-service'
import { db } from '../../src/db/db'
import { reconstructRecordsAtT } from '../../src/multitable/record-reconstructor'
import type { AutomationRule } from '../../src/multitable/automation-executor'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const OWNER = `u_d1c3_owner_${TS}`
const BASE = `base_d1c3_${TS}`
const SHEET_MAIN = `sheet_d1c3_main_${TS}`
const SHEET_FAIL_CREATE = `sheet_d1c3_failcreate_${TS}`
const SHEET_FAIL_UPDATE = `sheet_d1c3_failupdate_${TS}`
const SHEET_RACE = `sheet_d1c3_race_${TS}`

const FLD_TITLE = `fld_d1c3_title_${TS}`
const FLD_NOTES = `fld_d1c3_notes_${TS}`
const FLD_FAIL_CREATE_TITLE = `fld_d1c3_ftitle_${TS}`
const FLD_FAIL_UPDATE_TITLE = `fld_d1c3_utitle_${TS}`
const FLD_RACE_TITLE = `fld_d1c3_rtitle_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

/** The REAL production AutomationService wiring — mirrors index.ts's construction exactly (real
 * `pool.query.bind(pool)` queryFn; the constructor internally hard-wires `deps.transaction` to a real
 * `poolManager.get().transaction(...)`). Never a hand-rolled query calling the executor's private
 * methods directly — this is what makes the atomicity + transaction-boundary proofs real. */
function realService(): AutomationService {
  const pool = poolManager.get()
  return new AutomationService(new EventBus(), db as never, pool.query.bind(pool))
}

async function makeSheet(id: string, name: string): Promise<void> {
  await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [id, BASE, name])
}
async function makeField(id: string, sheetId: string, name: string, order = 0): Promise<void> {
  await q(`INSERT INTO meta_fields (id, sheet_id, name, type, "order") VALUES ($1,$2,$3,'string',$4)`, [
    id,
    sheetId,
    name,
    order,
  ])
}

function ruleFor(
  sheetId: string,
  action: { type: 'create_record' | 'update_record'; config: Record<string, unknown> },
): AutomationRule {
  return {
    id: `atr_d1c3_${TS}_${Math.random().toString(36).slice(2, 8)}`,
    name: 'D1C3 rule',
    sheetId,
    trigger: { type: 'record.created', config: {} },
    actions: [action as never],
    enabled: true,
    createdBy: OWNER,
    createdAt: new Date().toISOString(),
  } as unknown as AutomationRule
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
 * connection — the deterministic proof (never a sleep heuristic) that `update_record`'s UPDATE is truly
 * parked behind the holder's uncommitted DELETE, not merely "probably done by now". Correlated to the
 * holder's OWN backend pid via `pg_blocking_pids(pid)` — same technique as slice ②'s
 * `waitUntilBlockedOnRecordLock` / `multitable-d2-sidedoor-delete-recoverability-realdb.test.ts`'s
 * `waitUntilBlockedOnRecordLock` — so an unrelated lock-waiter elsewhere in this shared integration
 * database (many `describeIfDatabase` files share ONE Postgres) can never satisfy the probe. Throws
 * (never silently returns) if it never blocks, so this golden can never degrade into the sequential case
 * (a vacuous green).
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
    `automation update_record's UPDATE never blocked on the meta_records row lock HELD BY THIS TEST (pid ${blockerPid}) — interleaving did not occur`,
  )
}

describeIfDatabase('D-1c slice ③ — automation create_record/update_record write automation revisions (real DB)', () => {
  let svc: AutomationService

  beforeAll(async () => {
    svc = realService()
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE, 'D1C3 Base', OWNER])
    await makeSheet(SHEET_MAIN, 'D1C3 Main')
    await makeSheet(SHEET_FAIL_CREATE, 'D1C3 Fail Create')
    await makeSheet(SHEET_FAIL_UPDATE, 'D1C3 Fail Update')
    await makeSheet(SHEET_RACE, 'D1C3 Race')

    await makeField(FLD_TITLE, SHEET_MAIN, 'Title', 1)
    await makeField(FLD_NOTES, SHEET_MAIN, 'Notes', 2) // 2nd field on SHEET_MAIN — G4 merge-trap golden
    await makeField(FLD_FAIL_CREATE_TITLE, SHEET_FAIL_CREATE, 'Title')
    await makeField(FLD_FAIL_UPDATE_TITLE, SHEET_FAIL_UPDATE, 'Title')
    await makeField(FLD_RACE_TITLE, SHEET_RACE, 'Title')
  })

  afterAll(async () => {
    for (const sheet of [SHEET_MAIN, SHEET_FAIL_CREATE, SHEET_FAIL_UPDATE, SHEET_RACE]) {
      await q(
        'DELETE FROM meta_record_revisions WHERE record_id IN (SELECT id FROM meta_records WHERE sheet_id = $1)',
        [sheet],
      ).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [sheet]).catch(() => {})
    }
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  test('sentinel: DATABASE_URL is set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── Site A4 — automation create_record ─────────────────────────────────────────────────────────────
  describe('Site A4 — automation create_record', () => {
    test('create_record writes a revision: action=create source=automation actorId=<known>, full snapshot', async () => {
      const rule = ruleFor(SHEET_MAIN, {
        type: 'create_record',
        config: { sheetId: SHEET_MAIN, data: { [FLD_TITLE]: 'auto-created v1' } },
      })
      const execution = await svc.executeRule(rule, { actorId: OWNER, data: {} })
      expect(execution.status).toBe('success')
      const output = execution.steps[0]?.output as { recordId: string } | undefined
      expect(output?.recordId).toBeTruthy()
      const recordId = output!.recordId

      const revs = await revisionsOf(recordId)
      expect(revs).toHaveLength(1)
      expect(revs[0]!.action).toBe('create')
      expect(revs[0]!.source).toBe('automation')
      expect(revs[0]!.actor_id).toBe(OWNER)
      expect(revs[0]!.version).toBe(1)
      expect(revs[0]!.snapshot).toMatchObject({ [FLD_TITLE]: 'auto-created v1' })
    })

    test('OD-3: actorId=null when the trigger carries no actor (e.g. a schedule) — NEVER a fabricated system actor', async () => {
      const rule = ruleFor(SHEET_MAIN, {
        type: 'create_record',
        config: { sheetId: SHEET_MAIN, data: { [FLD_TITLE]: 'auto-created no-actor' } },
      })
      // No actorId in the trigger payload — mirrors a schedule-driven trigger.
      const execution = await svc.executeRule(rule, { data: {} })
      expect(execution.status).toBe('success')
      const recordId = (execution.steps[0]?.output as { recordId: string }).recordId

      const revs = await revisionsOf(recordId)
      expect(revs).toHaveLength(1)
      expect(revs[0]!.actor_id).toBeNull()
    })

    test('reconstructRecordsAtT sees the record exist immediately after create (was ABSENT before the fix)', async () => {
      const rule = ruleFor(SHEET_MAIN, {
        type: 'create_record',
        config: { sheetId: SHEET_MAIN, data: { [FLD_TITLE]: 'auto-created for-pit' } },
      })
      const execution = await svc.executeRule(rule, { actorId: OWNER, data: {} })
      const recordId = (execution.steps[0]?.output as { recordId: string }).recordId

      const asOf = await cutoffAfter(recordId, 1)
      const state = await reconstructRecordsAtT(q, SHEET_MAIN, asOf, [recordId])
      const entry = state.get(recordId)
      expect(entry?.exists).toBe(true)
      expect(entry?.version).toBe(1)
      expect(entry?.data).toMatchObject({ [FLD_TITLE]: 'auto-created for-pit' })
    })

    test('ATOMICITY + TRANSACTION-BOUNDARY: a failing revision INSERT rolls back the record INSERT too — no half-write', async () => {
      const trg = `d1c3_fail_create_trg_${TS}`
      await injectTrigger(trg, {
        table: 'meta_record_revisions',
        timing: 'INSERT',
        when: `NEW.sheet_id = '${SHEET_FAIL_CREATE}'`,
        errcode: 'P0001',
        message: 'D1C3 injected create-revision failure',
      })
      try {
        const rule = ruleFor(SHEET_FAIL_CREATE, {
          type: 'create_record',
          config: { sheetId: SHEET_FAIL_CREATE, data: { [FLD_FAIL_CREATE_TITLE]: 'never-persisted' } },
        })
        const execution = await svc.executeRule(rule, { actorId: OWNER, data: {} })
        expect(execution.status).toBe('failed')
        expect(execution.steps[0]?.status).toBe('failed')
        expect(execution.steps[0]?.error).toMatch(/injected create-revision failure/)
      } finally {
        await dropTrigger(trg, 'meta_record_revisions')
      }

      // The whole unit rolled back: no record was created on this dedicated sheet at all (only one
      // create attempt against it exists in this test) — this assertion is ONLY satisfiable if the
      // INSERT and the (failed) revision INSERT ran inside the SAME real transaction.
      const rows = await q('SELECT id FROM meta_records WHERE sheet_id = $1', [SHEET_FAIL_CREATE])
      expect(rows.rows).toHaveLength(0)
      const revRows = await q(
        `SELECT r.id FROM meta_record_revisions r JOIN meta_records m ON m.id = r.record_id WHERE m.sheet_id = $1`,
        [SHEET_FAIL_CREATE],
      )
      expect(revRows.rows).toHaveLength(0)
    })
  })

  // ── Site A3 — automation update_record ─────────────────────────────────────────────────────────────
  describe('Site A3 — automation update_record', () => {
    test('update_record writes a revision: action=update source=automation actorId=<known>, single-field record', async () => {
      const created = await svc.executeRule(
        ruleFor(SHEET_MAIN, { type: 'create_record', config: { sheetId: SHEET_MAIN, data: { [FLD_TITLE]: 'v1-original' } } }),
        { actorId: OWNER, data: {} },
      )
      const recordId = (created.steps[0]?.output as { recordId: string }).recordId

      const rule = ruleFor(SHEET_MAIN, {
        type: 'update_record',
        config: { fields: { [FLD_TITLE]: 'v2-edited-via-automation' } },
      })
      const execution = await svc.executeRule(rule, { recordId, actorId: OWNER, data: {} })
      expect(execution.status).toBe('success')

      const revs = await revisionsOf(recordId)
      expect(revs).toHaveLength(2) // create (v1) + update (v2)
      const updateRev = revs.find((r) => r.action === 'update')!
      expect(updateRev.source).toBe('automation')
      expect(updateRev.actor_id).toBe(OWNER)
      expect(updateRev.version).toBe(2)
      expect(updateRev.changed_field_ids).toEqual([FLD_TITLE])
      // NOTE: this is a SINGLE-field record, so patch ≡ nextData and `snapshot: patch` would pass here
      // too. The merge trap is pinned by the TWO-field golden below, not by this test.
      expect(updateRev.snapshot).toMatchObject({ [FLD_TITLE]: 'v2-edited-via-automation' })
      expect(Object.keys(updateRev.snapshot ?? {})).toEqual([FLD_TITLE])
    })

    // G4 THE MERGE TRAP: patch ONE field of a TWO-field record; the untouched field MUST survive in the
    // snapshot. On a single-field record patch ≡ nextData, so `snapshot: patch` would pass vacuously.
    // Only a ≥2-field record distinguishes `snapshot: nextData/updatedRow.data` (full merged row,
    // correct) from `snapshot: patch` (drops the untouched field).
    test('G4 full-merge snapshot: patching ONE field of a TWO-field record keeps the untouched field', async () => {
      const created = await svc.executeRule(
        ruleFor(SHEET_MAIN, {
          type: 'create_record',
          config: { sheetId: SHEET_MAIN, data: { [FLD_TITLE]: 'g4-title-v1', [FLD_NOTES]: 'g4-notes-untouched' } },
        }),
        { actorId: OWNER, data: {} },
      )
      const recordId = (created.steps[0]?.output as { recordId: string }).recordId

      await svc.executeRule(
        ruleFor(SHEET_MAIN, { type: 'update_record', config: { fields: { [FLD_TITLE]: 'g4-title-v2' } } }),
        { recordId, actorId: OWNER, data: {} },
      )

      const updateRev = (await revisionsOf(recordId)).find((r) => r.action === 'update')!
      expect(updateRev.snapshot?.[FLD_TITLE]).toBe('g4-title-v2')
      // the untouched field — `snapshot: patch` (bare single-field patch) would DROP this:
      expect(updateRev.snapshot?.[FLD_NOTES]).toBe('g4-notes-untouched')
      expect(updateRev.changed_field_ids).toEqual([FLD_TITLE])
    })

    test('reconstructRecordsAtT(after edit) returns the NEW value+version (was the PIT LIE before the fix); asOf BEFORE the edit still returns the pre-edit value', async () => {
      const created = await svc.executeRule(
        ruleFor(SHEET_MAIN, { type: 'create_record', config: { sheetId: SHEET_MAIN, data: { [FLD_TITLE]: 'pit-v1-original' } } }),
        { actorId: OWNER, data: {} },
      )
      const recordId = (created.steps[0]?.output as { recordId: string }).recordId
      const beforeEdit = await cutoffAfter(recordId, 1)

      await svc.executeRule(
        ruleFor(SHEET_MAIN, { type: 'update_record', config: { fields: { [FLD_TITLE]: 'pit-v2-edited' } } }),
        { recordId, actorId: OWNER, data: {} },
      )
      const afterEdit = await cutoffAfter(recordId, 2)

      // asOf STRICTLY BEFORE the edit must still report the pre-edit value — the new revision must not
      // corrupt earlier T.
      const beforeState = await reconstructRecordsAtT(q, SHEET_MAIN, beforeEdit, [recordId])
      expect(beforeState.get(recordId)).toMatchObject({
        exists: true,
        version: 1,
        data: { [FLD_TITLE]: 'pit-v1-original' },
      })

      // The headline golden: asOf AFTER the edit must report the NEW value+version. Before the fix this
      // returned {version:1, data:'pit-v1-original'} FOREVER (the A3 PIT lie) because no v2 revision
      // existed for reconstructRecordsAtT to see.
      const afterState = await reconstructRecordsAtT(q, SHEET_MAIN, afterEdit, [recordId])
      expect(afterState.get(recordId)).toMatchObject({
        exists: true,
        version: 2,
        data: { [FLD_TITLE]: 'pit-v2-edited' },
      })
    })

    test('ATOMICITY + TRANSACTION-BOUNDARY: a failing revision INSERT rolls back the UPDATE too — record stays at its ORIGINAL pre-patch value', async () => {
      const created = await svc.executeRule(
        ruleFor(SHEET_FAIL_UPDATE, {
          type: 'create_record',
          config: { sheetId: SHEET_FAIL_UPDATE, data: { [FLD_FAIL_UPDATE_TITLE]: 'pre-patch-original' } },
        }),
        { actorId: OWNER, data: {} },
      )
      const recordId = (created.steps[0]?.output as { recordId: string }).recordId
      expect((await recordRow(recordId))?.version).toBe(1)

      const trg = `d1c3_fail_update_trg_${TS}`
      await injectTrigger(trg, {
        table: 'meta_record_revisions',
        timing: 'INSERT',
        when: `NEW.record_id = '${recordId}' AND NEW.action = 'update'`,
        errcode: 'P0001',
        message: 'D1C3 injected update-revision failure',
      })
      try {
        const execution = await svc.executeRule(
          ruleFor(SHEET_FAIL_UPDATE, { type: 'update_record', config: { fields: { [FLD_FAIL_UPDATE_TITLE]: 'should-never-stick' } } }),
          { recordId, actorId: OWNER, data: {} },
        )
        expect(execution.status).toBe('failed')
        expect(execution.steps[0]?.error).toMatch(/injected update-revision failure/)
      } finally {
        await dropTrigger(trg, 'meta_record_revisions')
      }

      // Discriminating assertion: not "a row exists" (a swallowed error would also leave one) but that
      // the row is back at its EXACT original pre-patch data AND version — the UPDATE was undone.
      const row = await recordRow(recordId)
      expect(row).toMatchObject({ version: 1, data: { [FLD_FAIL_UPDATE_TITLE]: 'pre-patch-original' } })

      // Only the original create revision exists — no update revision was left behind.
      const revs = await revisionsOf(recordId)
      expect(revs).toHaveLength(1)
      expect(revs[0]).toMatchObject({ action: 'create', version: 1 })
    })

    test('BEHAVIOR PRESERVED: same-base update_record of a record absent from the START keeps its 0-row SUCCESS — and fabricates NO revision', async () => {
      const ghost = `rec_d1c3_ghost_${TS}`
      const execution = await svc.executeRule(
        ruleFor(SHEET_MAIN, { type: 'update_record', config: { fields: { [FLD_TITLE]: 'x' } } }),
        { recordId: ghost, actorId: OWNER, data: {} },
      )
      // Pre-existing same-base leniency (unchanged since ②b, mirrors D-1's executeDeleteRecord sibling
      // contract): a missing trigger record yields a 0-row UPDATE reported as SUCCESS. Slice ③ must not
      // regress that — and must NOT invent a revision for a record that never existed.
      expect(execution.status).toBe('success')
      expect(await revisionsOf(ghost)).toHaveLength(0)
    })

    // ── THE ZERO-ROW FAIL-CLOSED GOLDEN ─────────────────────────────────────────────────────────────
    // GENUINE two-connection lock race (never a sleep heuristic): Connection A (this test's "holder")
    // opens its own dedicated raw client, BEGINs, and DELETEs the record — an uncommitted, row-locking
    // delete. Connection B is the REAL `svc.executeRule(...)` call driving `update_record`: its lock-check
    // SELECT (no `FOR UPDATE`) succeeds immediately (readers never block on an uncommitted writer under
    // MVCC), but its `UPDATE` — the FIRST point in the (now transactional) update_record path that
    // actually needs the row lock — blocks behind the holder's uncommitted DELETE. Only once
    // `waitUntilBlockedOnRecordLock` deterministically confirms B is genuinely parked behind A's lock
    // does A COMMIT. B's UPDATE then resumes under READ COMMITTED semantics, discovers the row was
    // concurrently deleted, and affects ZERO rows — exactly the condition the fail-closed guard covers.
    // Unlike slices ①/②'s ghost-record case, THIS lane's documented contract for a 0-row UPDATE is
    // SUCCESS, not NotFound — so the assertion here is: the step still reports success (unchanged
    // leniency), but writes NO spurious revision for the now-nonexistent record.
    test('CONCURRENT-DELETE golden: a DELETE that commits WHILE update_record is blocked on the row lock produces a zero-row UPDATE — step reports SUCCESS (leniency preserved) and writes NO spurious revision', async () => {
      const created = await svc.executeRule(
        ruleFor(SHEET_RACE, { type: 'create_record', config: { sheetId: SHEET_RACE, data: { [FLD_RACE_TITLE]: 'race-v1' } } }),
        { actorId: OWNER, data: {} },
      )
      const recordId = (created.steps[0]?.output as { recordId: string }).recordId
      expect((await recordRow(recordId))?.version).toBe(1)

      const rawPool = poolManager.get().getInternalPool()
      const holder = await rawPool.connect()
      let updateExecution: Awaited<ReturnType<AutomationService['executeRule']>> | undefined
      try {
        await holder.query('BEGIN')
        await holder.query('DELETE FROM meta_records WHERE id = $1', [recordId])
        const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)

        const updatePromise = svc
          .executeRule(
            ruleFor(SHEET_RACE, { type: 'update_record', config: { fields: { [FLD_RACE_TITLE]: 'race-v2-SHOULD-NOT-LAND' } } }),
            { recordId, actorId: OWNER, data: {} },
          )
          .then((execution) => {
            updateExecution = execution
          })

        // Barrier: block until B is deterministically confirmed parked behind A's lock on THIS record.
        await waitUntilBlockedOnRecordLock(holderPid, '%UPDATE meta_records%')

        // A commits ⇒ the row is truly gone ⇒ B's UPDATE unblocks and sees ZERO matching rows.
        await holder.query('COMMIT')
        await updatePromise
      } finally {
        // If the barrier above ever throws (timeout), COMMIT is never reached — releasing the raw
        // connection here WITHOUT first ending its open transaction would return it to the pool
        // `idle in transaction`, still holding the DELETE's row lock, and leave the fire-and-forget
        // `updatePromise` blocked forever. That would poison every OTHER `describeIfDatabase` file
        // sharing this one Postgres in the same `plugin-tests.yml` run — a barrier timeout in THIS test
        // must never cascade into unrelated suites as flake. ROLLBACK is a safe no-op after a successful
        // COMMIT (nothing left to roll back) and a real safety net otherwise — always run it before the
        // connection goes back to the pool.
        await holder.query('ROLLBACK').catch(() => {})
        holder.release()
      }

      expect(updateExecution?.status).toBe('success')

      // THE discriminating assertion: exactly the original create revision — no spurious `update` row.
      const revs = await revisionsOf(recordId)
      expect(revs).toHaveLength(1)
      expect(revs[0]!.action).toBe('create')

      // And the record itself really is gone — this is a genuine concurrent DELETE (not a suppression
      // proxy), so there is no live row left to compare a "did it change" assertion against.
      expect(await recordRow(recordId)).toBeUndefined()
    }, 15000)
  })
})
