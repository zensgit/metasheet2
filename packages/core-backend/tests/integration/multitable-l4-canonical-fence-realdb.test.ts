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
 * FENCED vs PARTIAL vs UNFENCED (verified against the impl on this branch — see the lane report):
 *   FULLY FENCED (advisory fence + durable-block refusal): REST create/patch/delete/restore, bulk/AI/OAPI
 *       patch (RecordWriteService), plugin patch, plugin recoverable delete, attachment cell-strip, HTTP
 *       lock/unlock, revert-execute (durable block), reset-execute (fence-first).
 *   PARTIAL (advisory canonical fence for seq-ordering, but NO durable-block check ⇒ slips past a
 *       multi-txn `applying` recovery): plugin create (records.ts:592), auto-number backfill
 *       (auto-number-service.ts:84), form-submit create/edit (univer-meta.ts:14585). GX1/GX2 EXPOSE this.
 *   UNFENCED entirely (no canonical fence at all — the residual bug class): automation
 *       update/create/delete/lock (automation-executor.ts), approval resultWriteback
 *       (automation-service.ts), formula-engine recompute (formula-engine.ts), approval-record projection
 *       (approval-record-projection-service.ts), post-commit derived-value recompute (univer-meta.ts:2973 /
 *       :3869), config-restore-execute record writes (univer-meta.ts:6171 / :6449 / :6555), people/seed
 *       presets (:5188 / :5825), field-undelete rehydration (flag HOLD). Enumerated in the report; behavioral
 *       exposure of these is deferred (their end-to-end harnesses are heavy) — see GX3 for the design of the
 *       exposure, driven for the two cheap, high-signal PARTIAL families here.
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
import type { Request } from 'express'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import type { EventBus } from '../../src/integration/events/event-bus'
import { RecordService } from '../../src/multitable/record-service'
import {
  RecordWriteService,
  type RecordPatchInput as WriteRecordPatchInput,
} from '../../src/multitable/record-write-service'
import { createRecordWriteHelpers } from '../../src/routes/univer-meta'
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

  // ── §X — GAP EXPOSURE. These families take the canonical advisory fence (for seq-ordering) but do NOT
  //         perform the durable-block check, so with the flag ON and an `applying` block they PROCEED —
  //         slipping past a multi-txn recovery. The positive control (F1: REST create) REFUSES the same
  //         block, so this is a genuine ASYMMETRY, not a flag/plumbing artifact. When the impl closes the
  //         gap (adds `assertNoActiveWriterBlock` to these entries), these two goldens flip RED — convert
  //         them to `rejects.toBeInstanceOf(SheetWriterBlockedError)` at that point.
  test('GX1 [plugin create — PARTIAL] records.createRecord PROCEEDS under an applying block (no durable-block check) — asymmetric with F1', async () => {
    process.env[FLAG] = 'true'
    await setBlock('applying')
    const created = await poolManager.get().transaction(async ({ query }) =>
      pluginCreateRecord({ query: query as never, sheetId: SHEET, data: { [F_STR]: 'plugin-created-during-recovery' } }),
    )
    // The gap: an insert landed on a sheet a recovery has durably blocked. (F1 proves REST create refuses.)
    expect((created as { id: string }).id).toBeTruthy()
    expect(await recordExists((created as { id: string }).id)).toBe(true)
    // The block itself is untouched — the writer neither observed nor cleared it.
    expect(await readBlock()).toBe('applying')
    await q('DELETE FROM meta_records WHERE id = $1', [(created as { id: string }).id]).catch(() => {})
  })

  test('GX2 [auto-number backfill — PARTIAL] backfillAutoNumberField PROCEEDS under an applying block (advisory fence only, no durable-block check)', async () => {
    const R = mkRecord('gx2')
    await seedRecord(R)
    process.env[FLAG] = 'true'
    await setBlock('applying')
    const property = { prefix: '', digits: 3 }
    // Fence acquired (advisory) but no block-check ⇒ backfill runs its UPDATE despite the recovery block.
    const res = await backfillAutoNumberField(q as never, SHEET, F_AN, property as never, { overwrite: true })
    expect(res).toBeTruthy()
    expect(await readBlock()).toBe('applying') // block untouched — writer slipped past it
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
