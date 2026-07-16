/**
 * W0-1 Lane L4 — all-writer canonical per-sheet fence. Real-DB goldens.
 *
 * Design authority: `docs/development/multitable-w0-1-v36-unified-revision-design-lock-20260715.md` §4
 * (all-writer canonical fence + §4.2 writer matrix), forward-aligned to the v3.7 lock §2. Implementation
 * under test: `src/multitable/canonical-sheet-fence.ts` + its wiring; migration
 * `zzzz20260715170000_add_meta_sheet_recovery_writer_state.ts`. Everything is behind
 * `MULTITABLE_ENABLE_WRITER_FENCE` (default OFF); this file only toggles env vars inside its OWN process to
 * exercise the code paths (identical convention to the sibling `…-strict-seq-realdb.test.ts`). Nothing here
 * arms the fence, Revert, or Reset in any real environment.
 *
 * WHAT THIS PROVES (the L4 bug class, v3.6 §0.2-i): before L4, auto-number held the advisory key
 * `hashtext('meta:auto-number:sheet:'||sheetId)` while reset-execute held a DISJOINT key
 * `pg_advisory_xact_lock(PIT_RECOVERY_LOCK_NS::int, hashtext(sheetId)::int)` — two disjoint advisory locks
 * do NOT exclude each other, so a destructive recovery ran CONCURRENTLY with ordinary writers. L4 converges
 * every writer onto ONE canonical fence and, for multi-transaction recoveries, a DURABLE block committed
 * under that fence. The goldens below are FENCE-BEFORE-CHECK behavioral proofs, not source-text assertions.
 *
 * FENCED vs DEFERRED vs UNFENCED (verified against the impl on this branch + the stacked L4-coverage lane —
 * see the lane report). The three formerly-PARTIAL families and the in-txn config-restore record writers are
 * now FULLY FENCED by the L4-coverage lane (`multitable-l4cov-univer-meta-writers-realdb.test.ts`):
 *   FULLY FENCED (advisory fence + durable-block refusal): REST create/patch/delete/restore, bulk/AI/OAPI
 *       patch (RecordWriteService), plugin patch, plugin recoverable delete, attachment cell-strip, HTTP
 *       lock/unlock, revert-execute (durable block, now also the recovery-only PIT lock — P2 follow-up),
 *       reset-execute (fence + durable-block refusal via `fenceWriterEntry` — P2 follow-up; previously
 *       fence-first only, with NO block-check, so a reset begun during revert's released-fence apply window
 *       slipped past its committed `applying` block — see RXR1/RXR2 below);
 *       — added by L4-coverage — plugin create (records.ts::createRecord), auto-number backfill
 *       (auto-number-service.ts::backfillAutoNumberField), form-submit create/edit (univer-meta.ts submit),
 *       and config-restore-execute record writes: un-create (dropFieldCascade column strip), undelete
 *       (recreateFieldFromConfig), lossy retype-revert (applyLossyRetypeCellRewrite — the seq-ALLOCATING one,
 *       one recordRecordRevision per cell). The three formerly-PARTIAL families keep their pre-existing
 *       UNCONDITIONAL canonical fence (the auto-number allocation-serialization lock) and gained a FLAG-GATED
 *       block-check, so flag-off is byte-identical (fence taken, block ignored). GX1/GX2 below, which used to
 *       assert those families PROCEED under a block, are flipped to assert REFUSAL.
 *   ANALYZED → DEFERRED (documented, NOT force-fenced): the POST-COMMIT derived-value recompute
 *       (univer-meta.ts relation-agg materialization @≈2973 / fan-out @≈3869 + formula-engine.ts
 *       recalculateRecordFromData) runs on a fresh pool connection AFTER the fenced write txn commits, but every
 *       one of those writes is an in-place `UPDATE meta_records SET data` with NO revision and NO `seq`
 *       allocation — so it does NOT breach the non-causal-`seq` hole this fence protects; a fence there would be
 *       behavior-changing (see the L4-cov §C write-up). Also deferred: people/seed presets
 *       (ensurePeopleSheetPreset / createSeededSheet) — revision-exempt system/scaffold writes, no `seq`, sheet
 *       resolved mid-txn / created at sheet-birth (no possible active recovery to observe).
 *   UNFENCED entirely → L4-cov-services follow-up (no canonical fence at all — the residual bug class):
 *       automation update/create/delete/lock (automation-executor.ts), approval resultWriteback
 *       (automation-service.ts), formula-engine recompute (formula-engine.ts), approval-record projection
 *       (approval-record-projection-service.ts), field-undelete rehydration (flag HOLD), plugin delete's
 *       NON-transactional flag-off branch (records.ts, disclosed in-code as an "L4-SEAM" —
 *       `deleteRecordWithRecoverability` right above it IS fenced via `fenceWriterEntry`, but the D-1 flag-off
 *       `deleteRecord` branch cannot hold a txn-scoped advisory lock without the transaction wrap that path
 *       deliberately lacks — §1.9 byte-identity keeps it as the D-1 code verbatim). Enumerated in the report;
 *       these service-file families are left untouched here to avoid cross-lane collision.
 *
 * P2-C hygiene (v3.7): every seq comparison uses EXACT bigint (BigInt(), never Number()/parseInt/+/-); this
 * file NEVER calls `setval` on the shared `meta_record_chain_seq`; all fixtures are isolated synthetic rows
 * with unique ids; `afterAll` cleans up ONLY this suite's own base/sheet/record/user rows. Locally the whole
 * suite is run against a throwaway database `metasheet_l4_gate` (created, migrated, dropped) so the shared
 * chain sequence is never touched even transiently — see the lane report.
 *
 * Two-point wiring: plugin-tests.yml real-DB run list + vitest.integration.config.ts default include glob.
 * Runs only with DATABASE_URL; the sentinel below fails-not-skips inside the real-DB allowlist step.
 */
import { EventEmitter } from 'events'
import express, { type Express, type Request } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import type { EventBus } from '../../src/integration/events/event-bus'
import { RecordService } from '../../src/multitable/record-service'
import {
  RecordWriteService,
  type RecordPatchInput as WriteRecordPatchInput,
} from '../../src/multitable/record-write-service'
import { createRecordWriteHelpers, univerMetaRouter } from '../../src/routes/univer-meta'
import { deriveCapabilities, type AccessInfo } from '../../src/multitable/sheet-capabilities'
import {
  patchRecord as pluginPatchRecord,
  createRecord as pluginCreateRecord,
  deleteRecord as pluginDeleteRecord,
} from '../../src/multitable/records'
import { backfillAutoNumberField } from '../../src/multitable/auto-number-service'
import {
  SheetWriterBlockedError,
  assertNoActiveWriterBlock,
  claimDurableWriterBlock,
  setRecoveryWriterState,
  fenceWriterEntry,
  acquireCanonicalSheetFence,
  canonicalSheetFenceKey,
  isWriterBlockState,
  PIT_RECOVERY_LOCK_NS,
  __resetRecoveryWriterStateColumnProbe,
  type WriterBlockState,
} from '../../src/multitable/canonical-sheet-fence'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'
const SIDE_DOOR = 'MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED'

const TS = Date.now()
const BASE = `base_l4_${TS}`
const SHEET = `sheet_l4_${TS}`
const F_STR = `fld_l4_str_${TS}`
const F_AN = `fld_l4_an_${TS}` // auto-number field, for the backfill gap golden
const ACTOR = `u_l4_actor_${TS}`

let seq = 0
const mkRecord = (tag: string) => `rec_l4_${tag}_${TS}_${seq++}`

const eventBus = new EventEmitter() as unknown as EventBus
const access: AccessInfo = { userId: ACTOR, permissions: ['multitable:read', 'multitable:write'], isAdminRole: false }
const capabilities = deriveCapabilities(['multitable:read', 'multitable:write'], false)
const mkRecordService = () =>
  new RecordService(
    poolManager.get() as unknown as ConstructorParameters<typeof RecordService>[0],
    eventBus,
  )
const mkWriteService = () => {
  const fakeReq = { user: { id: ACTOR, roles: [], perms: ['multitable:read', 'multitable:write'] } } as unknown as Request
  const helpers = createRecordWriteHelpers(
    fakeReq,
    poolManager.get() as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }> },
  )
  return new RecordWriteService(
    poolManager.get() as unknown as ConstructorParameters<typeof RecordWriteService>[0],
    eventBus,
    helpers,
  )
}

/** Set (or clear, with null) the durable writer-block, honoring the CHECK constraint's closed value set. */
const setBlock = async (state: WriterBlockState | null) =>
  q('UPDATE meta_sheets SET recovery_writer_state = $2 WHERE id = $1', [SHEET, state])
const readBlock = async (): Promise<unknown> =>
  ((await q('SELECT recovery_writer_state FROM meta_sheets WHERE id = $1', [SHEET])).rows[0] as
    | { recovery_writer_state: unknown }
    | undefined)?.recovery_writer_state ?? null
const recordData = async (id: string): Promise<Record<string, unknown> | undefined> =>
  ((await q('SELECT data FROM meta_records WHERE id = $1', [id])).rows[0] as { data: Record<string, unknown> } | undefined)?.data
const recordExists = async (id: string): Promise<boolean> =>
  (await q('SELECT 1 FROM meta_records WHERE id = $1', [id])).rows.length > 0
/** Seed one live record with a create revision (so the reconstruction/history stream has production's shape). */
const seedRecord = async (id: string, data: Record<string, unknown> = { [F_STR]: 'orig' }): Promise<void> => {
  await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [
    id, SHEET, JSON.stringify(data), ACTOR,
  ])
}

const patchInput = (recordId: string, value: string) => ({
  recordId,
  sheetId: SHEET,
  data: { [F_STR]: value },
  actorId: ACTOR,
  access,
  capabilities,
})

describeIfDatabase('W0-1 L4 — all-writer canonical fence (real DB)', () => {
  beforeAll(async () => {
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'L4 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'L4 Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
      F_STR, SHEET, 'Note', 'string', '{}', 1,
    ])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
      F_AN, SHEET, 'Seq', 'auto_number', JSON.stringify({ prefix: '', digits: 3 }), 2,
    ])
  })

  afterEach(async () => {
    delete process.env[FLAG]
    delete process.env[SIDE_DOOR]
    await setBlock(null).catch(() => {})
  })

  afterAll(async () => {
    delete process.env[FLAG]
    delete process.env[SIDE_DOOR]
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })

  beforeEach(() => {
    // The column-existence probe is module-cached; reset it so each test re-probes (and so the probe path
    // itself is exercised, not just its cached result).
    __resetRecoveryWriterStateColumnProbe()
  })

  test('sentinel: DATABASE_URL is set (this suite must RUN, never skip-green)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
      throw new Error('real-DB allowlist step is missing DATABASE_URL')
    }
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── §M — the fence PRIMITIVES against real Postgres ───────────────────────────────────────────────
  test('M1 fence key is the PRESERVED auto-number key (a renamed key would break rolling-deploy exclusion)', () => {
    expect(canonicalSheetFenceKey(SHEET)).toBe(`meta:auto-number:sheet:${SHEET}`)
  })

  test('M2 assertNoActiveWriterBlock: throws SheetWriterBlockedError iff a durable block is present', async () => {
    await setBlock(null)
    await expect(assertNoActiveWriterBlock(q, SHEET)).resolves.toBeUndefined()
    for (const state of ['fencing', 'applying', 'paused_retryable'] as const) {
      await setBlock(state)
      __resetRecoveryWriterStateColumnProbe()
      const err = await assertNoActiveWriterBlock(q, SHEET).catch((e) => e)
      expect(err).toBeInstanceOf(SheetWriterBlockedError)
      expect((err as SheetWriterBlockedError).state).toBe(state)
      // values-free: the message must NOT leak internal state text to a client.
      expect((err as SheetWriterBlockedError).message).not.toContain(state)
    }
  })

  test('M3 CHECK constraint rejects a foreign block value (closed set — no typo can masquerade as a block)', async () => {
    await expect(setBlock('applyinng' as unknown as WriterBlockState)).rejects.toThrow()
    expect(isWriterBlockState('applyinng')).toBe(false)
    expect(isWriterBlockState('applying')).toBe(true)
    await setBlock(null)
  })

  test('M4 claimDurableWriterBlock: sets applying; RECLAIMS paused_retryable (recoverable, not stuck); REFUSES an active applying/fencing', async () => {
    // clean → applying
    await setBlock(null)
    await poolManager.get().transaction(async ({ query }) => {
      await acquireCanonicalSheetFence(query, SHEET)
      await claimDurableWriterBlock(query, SHEET)
    })
    expect(await readBlock()).toBe('applying')
    // paused_retryable is RECLAIMABLE (a re-run's claim resolves it → not a stuck absorbing state)
    await setBlock('paused_retryable')
    await poolManager.get().transaction(async ({ query }) => {
      await acquireCanonicalSheetFence(query, SHEET)
      await claimDurableWriterBlock(query, SHEET)
    })
    expect(await readBlock()).toBe('applying')
    // another recovery actively holding (applying) is REFUSED
    await setBlock('applying')
    const err = await poolManager
      .get()
      .transaction(async ({ query }) => {
        await acquireCanonicalSheetFence(query, SHEET)
        await claimDurableWriterBlock(query, SHEET)
      })
      .catch((e) => e)
    expect(err).toBeInstanceOf(SheetWriterBlockedError)
    await setBlock(null)
  })

  test('M5 setRecoveryWriterState: sets and clears; returns rows-updated', async () => {
    const set = await setRecoveryWriterState(q, SHEET, 'fencing')
    expect(set).toBe(1)
    expect(await readBlock()).toBe('fencing')
    const cleared = await setRecoveryWriterState(q, SHEET, null)
    expect(cleared).toBe(1)
    expect(await readBlock()).toBeNull()
  })

  // ── §F — per-fenced-family production-wiring (block-set ⇒ REFUSE). Load-bearing: removing the family's
  //         fence call makes it PROCEED instead of refusing ⇒ the golden reds. See report for mutation runs.
  test('F1 [REST create] createRecord under an applying block ⇒ SheetWriterBlockedError (fence + block-check)', async () => {
    process.env[FLAG] = 'true'
    await setBlock('applying')
    const svc = mkRecordService()
    const before = (await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id=$1', [SHEET])).rows[0] as { n: number }
    await expect(
      svc.createRecord({ sheetId: SHEET, data: { [F_STR]: 'new' }, actorId: ACTOR, capabilities }),
    ).rejects.toBeInstanceOf(SheetWriterBlockedError)
    const after = (await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id=$1', [SHEET])).rows[0] as { n: number }
    expect(after.n).toBe(before.n) // refused BEFORE any insert
  })

  test('F2 [REST patch] patchRecord under an applying block ⇒ SheetWriterBlockedError, data unchanged', async () => {
    const R = mkRecord('f2')
    await seedRecord(R)
    process.env[FLAG] = 'true'
    await setBlock('applying')
    await expect(mkRecordService().patchRecord(patchInput(R, 'v-blocked'))).rejects.toBeInstanceOf(SheetWriterBlockedError)
    expect(await recordData(R)).toMatchObject({ [F_STR]: 'orig' })
  })

  test('F3 [REST delete] deleteRecord under an applying block ⇒ SheetWriterBlockedError, record survives', async () => {
    const R = mkRecord('f3')
    await seedRecord(R)
    process.env[FLAG] = 'true'
    await setBlock('applying')
    const resolveSheetAccess = async () => ({ capabilities })
    await expect(
      mkRecordService().deleteRecord({ recordId: R, actorId: ACTOR, access, resolveSheetAccess }),
    ).rejects.toBeInstanceOf(SheetWriterBlockedError)
    expect(await recordExists(R)).toBe(true)
  })

  test('F4 [bulk/AI/OAPI patch] RecordWriteService.patchRecords under an applying block ⇒ SheetWriterBlockedError, data unchanged', async () => {
    const R = mkRecord('f4')
    await seedRecord(R)
    process.env[FLAG] = 'true'
    await setBlock('applying')
    const input: WriteRecordPatchInput = {
      sheetId: SHEET,
      changesByRecord: new Map([[R, [{ fieldId: F_STR, value: 'bulk-blocked' }]]]),
      actorId: ACTOR,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fields: [{ id: F_STR, name: 'Note', type: 'string', property: {}, order: 1 }] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      visiblePropertyFields: [{ id: F_STR, name: 'Note', type: 'string', property: {}, order: 1 }] as any,
      visiblePropertyFieldIds: new Set([F_STR]),
      attachmentFields: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fieldById: new Map([[F_STR, { type: 'string', readOnly: false, hidden: false } as Record<string, unknown>]]) as any,
      capabilities,
      access,
    }
    await expect(mkWriteService().patchRecords(input)).rejects.toBeInstanceOf(SheetWriterBlockedError)
    expect(await recordData(R)).toMatchObject({ [F_STR]: 'orig' })
  })

  test('F5 [plugin patch] records.patchRecord under an applying block ⇒ SheetWriterBlockedError, data unchanged', async () => {
    const R = mkRecord('f5')
    await seedRecord(R)
    process.env[FLAG] = 'true'
    await setBlock('applying')
    await expect(
      poolManager.get().transaction(async ({ query }) =>
        pluginPatchRecord({ query: query as never, sheetId: SHEET, recordId: R, changes: { [F_STR]: 'plugin-blocked' } }),
      ),
    ).rejects.toBeInstanceOf(SheetWriterBlockedError)
    expect(await recordData(R)).toMatchObject({ [F_STR]: 'orig' })
  })

  test('F6 [plugin recoverable delete] records.deleteRecord (SIDE_DOOR on) under an applying block ⇒ SheetWriterBlockedError, record survives', async () => {
    const R = mkRecord('f6')
    await seedRecord(R)
    process.env[FLAG] = 'true'
    process.env[SIDE_DOOR] = 'true' // reach the transactional recoverable branch (deleteRecordWithRecoverability)
    await setBlock('applying')
    await expect(
      poolManager.get().transaction(async ({ query }) =>
        pluginDeleteRecord({ query: query as never, sheetId: SHEET, recordId: R } as never),
      ),
    ).rejects.toBeInstanceOf(SheetWriterBlockedError)
    expect(await recordExists(R)).toBe(true)
  })

  // ── §X — the former GAP, now CLOSED by the L4-coverage lane. These families took the canonical advisory
  //         fence (for seq-ordering) but omitted the durable-block check, so with the flag ON and an
  //         `applying` block they PROCEEDED — slipping past a multi-txn recovery (the ASYMMETRY vs F1 REST
  //         create, which always refused). L4-cov added the flag-gated `assertNoActiveWriterBlock` AFTER the
  //         (still-UNCONDITIONAL, byte-identical-when-off) canonical fence, so they now REFUSE symmetrically
  //         with F1. These goldens were flipped from "PROCEEDS" to "refuses" exactly as this header foretold.
  //         (Fuller per-writer wiring/flag-off/race goldens live in
  //         `multitable-l4cov-univer-meta-writers-realdb.test.ts`.)
  test('GX1 [plugin create] records.createRecord REFUSES under an applying block (fence + flag-gated block-check) — now symmetric with F1', async () => {
    process.env[FLAG] = 'true'
    await setBlock('applying')
    const before = (await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id=$1', [SHEET])).rows[0] as { n: number }
    await expect(
      poolManager.get().transaction(async ({ query }) =>
        pluginCreateRecord({ query: query as never, sheetId: SHEET, data: { [F_STR]: 'plugin-created-during-recovery' } }),
      ),
    ).rejects.toBeInstanceOf(SheetWriterBlockedError)
    const after = (await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id=$1', [SHEET])).rows[0] as { n: number }
    expect(after.n).toBe(before.n) // refused BEFORE any insert
    expect(await readBlock()).toBe('applying') // block untouched
  })

  test('GX2 [auto-number backfill] backfillAutoNumberField REFUSES under an applying block (fence + flag-gated block-check)', async () => {
    const R = mkRecord('gx2')
    await seedRecord(R)
    process.env[FLAG] = 'true'
    await setBlock('applying')
    const property = { prefix: '', digits: 3 }
    await expect(
      backfillAutoNumberField(q as never, SHEET, F_AN, property as never, { overwrite: true }),
    ).rejects.toBeInstanceOf(SheetWriterBlockedError)
    expect(await readBlock()).toBe('applying') // block untouched — writer refused, never ran its UPDATE
  })

  // ── §P — flag-off PARITY: with the fence flag OFF, a durable block is inert; every writer behaves
  //         byte-identically to pre-L4 (the block column is never read). Proven on the REST patch family.
  test('P1 [flag OFF] patchRecord IGNORES an applying block (byte-identical pre-L4) and commits the change', async () => {
    const R = mkRecord('p1')
    await seedRecord(R)
    delete process.env[FLAG] // OFF
    await setBlock('applying')
    await mkRecordService().patchRecord(patchInput(R, 'v-flag-off'))
    expect(await recordData(R)).toMatchObject({ [F_STR]: 'v-flag-off' }) // committed despite the block
    await setBlock(null)
  })

  // ── §R — CONSTRUCTED TOCTOU RACE (two raw pg clients + pg_blocking_pids). A fenced writer A races a
  //         recovery B that claims the durable block under the canonical fence. The fence SERIALIZES them
  //         (A parks on the advisory lock until B commits — proven via pg_blocking_pids, never a timer),
  //         and once A proceeds it OBSERVES B's committed durable block (fence-before-check) and refuses.
  //         Non-vacuity: `waitUntilBlockedOnFence` THROWS if A never parks, so the race can never degrade
  //         into the sequential case. Load-bearing: inverting fence-before-check (read block BEFORE the
  //         fence) or removing the durable block makes A miss B's block ⇒ this reds.
  async function waitUntilBlockedOnFence(blockerPid: number, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const r = await q(
        `SELECT COUNT(*)::int AS c FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND $1 = ANY(pg_blocking_pids(pid))
            AND query ILIKE '%pg_advisory_xact_lock%'`,
        [blockerPid],
      )
      if ((r.rows[0] as { c: number }).c >= 1) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('writer A never parked on the canonical fence held by recovery B — the race did not occur')
  }

  test('R1 fence serialises a writer against a recovery claim and A observes B\'s durable block (fence-before-check)', async () => {
    const R = mkRecord('r1')
    await seedRecord(R)
    process.env[FLAG] = 'true'
    await setBlock(null)

    // Connection B (the recovery): a DEDICATED client. Takes the canonical fence, commits `applying` under it.
    const b = await poolManager.get().getInternalPool().connect()
    // Connection A (the writer): a second DEDICATED client running a fence-then-check via the SAME primitives
    // production writers use (fenceWriterEntry). Its advisory-lock acquire must PARK behind B.
    const a = await poolManager.get().getInternalPool().connect()
    let aOutcome: 'blocked' | 'proceeded' | 'error' = 'proceeded'
    let aErr: unknown
    try {
      await b.query('BEGIN')
      const bPid = Number((await b.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid)
      await b.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(SHEET)]) // canonical fence
      await b.query("UPDATE meta_sheets SET recovery_writer_state = 'applying' WHERE id = $1", [SHEET]) // durable claim (uncommitted)

      // A now tries to enter the fence — it must BLOCK on B's advisory lock (not read the sheet yet).
      const aQuery = (sql: string, params?: unknown[]) => a.query(sql, params) as unknown as Promise<{ rows: unknown[]; rowCount?: number | null }>
      await a.query('BEGIN')
      const aRun = (async () => {
        try {
          await fenceWriterEntry(aQuery, SHEET) // acquire fence (parks) → then assertNoActiveWriterBlock
          aOutcome = 'proceeded'
        } catch (e) {
          aErr = e
          aOutcome = 'blocked'
        }
      })()

      await waitUntilBlockedOnFence(bPid) // deterministic proof A is parked on B's fence, not racing free
      await b.query('COMMIT') // B releases the advisory fence AND commits `applying`
      await aRun // A unblocks, acquires the fence, reads the NOW-committed block → throws
      await a.query('ROLLBACK').catch(() => {})
    } finally {
      a.release()
      b.release()
    }

    expect(aOutcome).toBe('blocked')
    expect(aErr).toBeInstanceOf(SheetWriterBlockedError)
    expect((aErr as SheetWriterBlockedError).state).toBe('applying')
    expect(await readBlock()).toBe('applying') // B's durable block is committed and visible
    await setBlock(null)
  })

  // ── §S — EXACT BIGINT discipline (v3.7 §5 / P2-C): two SYNTHETIC seq literals above 2^53 that Number()
  //         collapses to the same float64 must compare as DISTINCT and correctly ordered under BigInt.
  //         This pins the seq-ordering guarantee the fence exists to protect (allocation order == commit
  //         order) without ever calling setval on the shared sequence. Mutation: compare via Number() ⇒ reds.
  test('S1 exact-bigint seq ordering on synthetic revisions (never setval; Number() would collapse these)', async () => {
    const R = mkRecord('s1')
    await seedRecord(R)
    // Two seq values that are DISTINCT as bigints but EQUAL as float64: above 2^53 the ULP is 2, so the odd
    // value 2^53+1 has no float64 representation and rounds down to 2^53 — colliding with 2^53 itself.
    const seqLo = '9007199254740992' // 2^53 (exactly representable)
    const seqHi = '9007199254740993' // 2^53 + 1 (Number() rounds to 2^53 → collides with seqLo)
    expect(Number(seqLo)).toBe(Number(seqHi)) // the trap: float64 cannot tell them apart
    expect(BigInt(seqLo) < BigInt(seqHi)).toBe(true) // exact bigint can
    // Persist them on isolated fixture revision rows (explicit seq literals — NOT nextval, NOT setval).
    for (const [ver, s, action] of [[1, seqLo, 'create'], [2, seqHi, 'update']] as const) {
      await q(
        `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, seq, created_at)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[$5]::text[],'{}'::jsonb,$6::jsonb,$7::bigint, now())`,
        [SHEET, R, ver, action, F_STR, JSON.stringify({ [F_STR]: action }), s],
      )
    }
    const rows = (await q(
      'SELECT seq::text AS seq FROM meta_record_revisions WHERE record_id = $1 ORDER BY seq ASC',
      [R],
    )).rows as Array<{ seq: string }>
    expect(rows).toHaveLength(2)
    // SQL bigint ORDER BY is exact; assert the ascending order matches bigint (not float64) comparison.
    expect(rows[0]!.seq).toBe(seqLo)
    expect(rows[1]!.seq).toBe(seqHi)
    expect(BigInt(rows[0]!.seq) < BigInt(rows[1]!.seq)).toBe(true)
  })
})

// ── §RXR — RECOVERY-VS-RECOVERY constructed race (P2 follow-up, real DB) ──────────────────────────────────
//
// The finding: reset-execute and revert-execute are both destructive and must never interleave. Pre-fix,
// reset-execute took the canonical fence + PIT_RECOVERY_LOCK_NS but NEVER consulted
// `recovery_writer_state` — so a reset begun during revert-execute's multi-txn apply window (fence
// released between revert's own transactions, but its durable `applying` block already committed) slipped
// past that block and interleaved with the in-flight revert. Drives the REAL HTTP routes (not just the
// shared `fenceWriterEntry` primitive R1 already covers) so the fix's ACTUAL wiring — the block-check
// inside reset-execute's transaction AND its catch mapping to 409 RECOVERY_IN_PROGRESS — is what's proven,
// not a hand-copy. Same two-raw-pg-clients + `pg_blocking_pids` + throw-if-never-parked technique as R1.
describeIfDatabase('W0-1 L4 P2 — reset-vs-revert recovery-vs-recovery (real DB)', () => {
  const RBASE = `base_l4_rxr_${TS}`
  const RSHEET = `sheet_l4_rxr_${TS}`
  const RNAME = `fld_l4_rxr_name_${TS}`
  const RACTOR = `user_l4_rxr_${TS}`
  const T0 = '2026-01-01T00:00:00.000Z'
  const T1 = '2026-01-02T00:00:00.000Z'
  const T2 = '2026-01-03T00:00:00.000Z'

  let app: Express
  const resetPreview = () => request(app).post(`/api/multitable/sheets/${RSHEET}/reset-preview`).send({ asOf: T1 })
  const resetExecute = (body: Record<string, unknown>) => request(app).post(`/api/multitable/sheets/${RSHEET}/reset-execute`).send(body)
  const revertPreview = () => request(app).post(`/api/multitable/sheets/${RSHEET}/revert-preview`).send({ asOf: T1 })
  const revertExecute = (body: Record<string, unknown>) => request(app).post(`/api/multitable/sheets/${RSHEET}/revert-execute`).send(body)
  const rev = (id: string, version: number, action: string, snap: Record<string, unknown>, at: string) =>
    q(
      `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[$5]::text[],'{}'::jsonb,$6::jsonb,$7)`,
      [RSHEET, id, version, action, RNAME, JSON.stringify(snap), at],
    )
  const recordRow = async (id: string) =>
    (await q('SELECT data, version FROM meta_records WHERE id = $1', [id])).rows[0] as
      | { data: Record<string, unknown>; version: number }
      | undefined

  /** supertest/superagent Test objects are LAZY: the underlying HTTP request is only actually dispatched
   *  the first time `.then()`/`.end()` is invoked (see `RequestBase.prototype.then` — it calls `self.end()`
   *  itself). Just holding `const p = resetExecute(...)` WITHOUT awaiting it does NOT put a request in
   *  flight — a naive "fire, then poll for parking, then await" construction would silently degrade into
   *  fully sequential (request only sent once we `await`, by which point B has already committed), which
   *  would make `waitUntilBlockedOnFence` correctly throw (as it did before this helper was added). This
   *  wrapper calls `.end()` explicitly so the request is genuinely in flight before we poll. */
  function fireNow(t: { end: (cb: (err: unknown, res: request.Response) => void) => void }): Promise<request.Response> {
    return new Promise((resolve, reject) => {
      t.end((err, res) => {
        if (err && !res) reject(err)
        else resolve(res)
      })
    })
  }

  /** Same technique as R1's `waitUntilBlockedOnFence`, redefined locally (this describe has its own
   *  connection lifecycle) — polls for a backend genuinely parked on `blockerPid`'s advisory lock. */
  async function waitUntilBlockedOnFence(blockerPid: number, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const r = await q(
        `SELECT COUNT(*)::int AS c FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND $1 = ANY(pg_blocking_pids(pid))
            AND query ILIKE '%pg_advisory_xact_lock%'`,
        [blockerPid],
      )
      if ((r.rows[0] as { c: number }).c >= 1) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('the concurrent HTTP call never parked on the held fence — the race did not occur')
  }

  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: RACTOR, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:share'] }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [RACTOR])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [RBASE, 'L4 RXR Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [RSHEET, RBASE, 'L4 RXR Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [RNAME, RSHEET, 'Note', 'string', '{}', 1])
  })

  afterAll(async () => {
    delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
    delete process.env.MULTITABLE_ENABLE_PIT_RESET
    delete process.env.MULTITABLE_ENABLE_SHEET_REVERT
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [RSHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [RSHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [RSHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [RSHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [RBASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [RACTOR]).catch(() => {})
  })

  beforeEach(async () => {
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    process.env.MULTITABLE_ENABLE_PIT_RESET = 'true'
    process.env.MULTITABLE_ENABLE_SHEET_REVERT = 'true'
    delete process.env.MULTITABLE_META_REVISION_RETENTION_ENABLED
    __resetRecoveryWriterStateColumnProbe()
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [RSHEET])
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [RSHEET])
    await q('UPDATE meta_sheets SET recovery_writer_state = NULL WHERE id = $1', [RSHEET])
  })

  test('sentinel: DATABASE_URL is set (this suite must RUN, never skip-green)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('RXR1 [reset vs revert] a concurrent reset-execute REFUSES (409 RECOVERY_IN_PROGRESS) while revert holds/commits its durable applying block — fence-before-check, never interleaves', async () => {
    const R = `rec_l4_rxr1_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [R, RSHEET, JSON.stringify({ [RNAME]: 'new' })])
    await rev(R, 1, 'create', { [RNAME]: 'old' }, T0)
    await rev(R, 2, 'update', { [RNAME]: 'new' }, T2)

    const pv = await resetPreview()
    expect(pv.status).toBe(200)
    const previewIdentity = pv.body?.data?.previewIdentity as string
    expect(previewIdentity).toBeTruthy()

    const b = await poolManager.get().getInternalPool().connect()
    let resetRes: Awaited<ReturnType<typeof resetExecute>> | undefined
    try {
      await b.query('BEGIN')
      const bPid = Number((await b.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid)
      // Simulates revert-execute's real claim transaction: canonical fence THEN the (P2 follow-up) PIT lock.
      await b.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(RSHEET)])
      await b.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)', [PIT_RECOVERY_LOCK_NS, RSHEET])

      const resetPromise = fireNow(resetExecute({ asOf: T1, previewIdentity, confirm: 'reset' }))
      await waitUntilBlockedOnFence(bPid) // proves reset's fence-acquire genuinely parked on B, not racing free

      await b.query("UPDATE meta_sheets SET recovery_writer_state = 'applying' WHERE id = $1", [RSHEET]) // revert's committed claim
      await b.query('COMMIT') // releases both locks; the durable block STAYS committed (revert's apply window)
      resetRes = await resetPromise
    } finally {
      await b.query('ROLLBACK').catch(() => {})
      b.release()
    }

    expect(resetRes!.status).toBe(409)
    expect(resetRes!.body?.error?.code).toBe('RECOVERY_IN_PROGRESS')
    const row = await recordRow(R)
    expect(row?.data?.[RNAME]).toBe('new') // ZERO writes — reset never reached its destructive work
    expect(row?.version).toBe(2)
    await q('UPDATE meta_sheets SET recovery_writer_state = NULL WHERE id = $1', [RSHEET])
  })

  test("RXR2 [revert vs reset] revert PARKS on an in-flight reset's held fence and only proceeds AFTER reset concludes — never interleaves (symmetric direction)", async () => {
    const R = `rec_l4_rxr2_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [R, RSHEET, JSON.stringify({ [RNAME]: 'new' })])
    await rev(R, 1, 'create', { [RNAME]: 'old' }, T0)
    await rev(R, 2, 'update', { [RNAME]: 'new' }, T2)

    const pv = await revertPreview()
    expect(pv.status).toBe(200)
    const previewIdentity = pv.body?.data?.previewIdentity as string
    expect(previewIdentity).toBeTruthy()

    const b = await poolManager.get().getInternalPool().connect()
    let revertRes: Awaited<ReturnType<typeof revertExecute>> | undefined
    try {
      await b.query('BEGIN')
      const bPid = Number((await b.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid)
      // Simulates reset-execute's real (single, whole-operation) destructive transaction: canonical fence
      // THEN the PIT lock, held open for reset's "duration" (here: until this test releases it below).
      await b.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(RSHEET)])
      await b.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)', [PIT_RECOVERY_LOCK_NS, RSHEET])

      const revertPromise = fireNow(revertExecute({ asOf: T1, previewIdentity }))
      await waitUntilBlockedOnFence(bPid) // proves revert's claim genuinely parked on B (reset's held fence)

      await b.query('COMMIT') // "reset concludes" — releases both locks; recovery_writer_state stays NULL (reset never sets one)
      revertRes = await revertPromise
    } finally {
      await b.query('ROLLBACK').catch(() => {})
      b.release()
    }

    // Proceeded — but ONLY after B released the fence, never concurrently (no interleaving in this
    // direction either): reset holding the SAME canonical fence for its entire single transaction is what
    // makes this direction safe by construction, without needing revert to receive an explicit refusal.
    expect(revertRes!.status).toBe(200)
    expect(revertRes!.body?.data?.revertedCount).toBe(1)
    await q('UPDATE meta_sheets SET recovery_writer_state = NULL WHERE id = $1', [RSHEET])
  })
})
