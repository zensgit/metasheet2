/**
 * Time Machine closeout — the AUTOMATION lock/unlock MARKER leg of the exact-anchor trust chain (real DB).
 *
 * Design authority: `…v37-exact-anchor-trust-design-lock-20260715.md` §1.2 (sealed operation endpoints —
 * "an operation with no record revision/marker is NOT an executable record anchor"), §1.3 (exact
 * recovery-anchor resolution). Under test: `automation-executor.ts` executeLockRecord (lock AND unlock
 * branches), `operation-ledger.ts` mint/seal, `exact-anchor-recovery.ts` resolveExactAnchor /
 * executeExactAnchorRecovery (read-half). Everything is behind `MULTITABLE_ENABLE_WRITER_FENCE`
 * (default OFF); this file toggles the env var only inside its OWN process.
 *
 * WHAT THIS PROVES — the two residual P3 items:
 *   G1 MARKER-ANCHOR GOLDEN (P3-1 marker leg): a marker minted by the REAL automation lock action (and the
 *      unlock action) carries an operation_id whose sealed endpoint is ACCEPTED by the real anchor-selection
 *      path — `resolveExactAnchor` returns it as `anchorOperationId` with the exact marker seq frozen in, and
 *      the minted token passes `executeExactAnchorRecovery` (read-half). The sibling L6-a suite's W4 resolves
 *      only the TERMINAL UNLOCK marker; this golden pins the LOCK-kind marker as an anchor too.
 *   G2 PHANTOM-ANCHOR NEGATIVE: an automation lock/unlock whose `UPDATE … meta_records` hits ZERO rows
 *      (record does not exist) mints NO marker — and must NOT leave a SEALED ZERO-MARKER operation (a
 *      "phantom endpoint" with nothing on the anchor). The empty-op seal skip lives in
 *      `operation-ledger.ts` `sealOperation` (`eventCount === 0 → no endpoint row`, backed in-DB by
 *      `chk_mrho_event_count_positive` + the endpoint-validation trigger). MUTATION TRIPWIRE: neutering that
 *      skip makes the empty-op seal attempt an endpoint INSERT that the DB refuses (NOT NULL / CHECK /
 *      validation trigger) ⇒ the step flips to 'failed' ⇒ the G2 success-status assertion REDS. The
 *      structural zero-marker-endpoint scan is the second (DB-layer) leg of the same claim.
 *
 * P2-C hygiene: NEVER `setval` on the shared `meta_record_chain_seq`; writers allocate real seq via nextval.
 * Cleanup deletes ONLY this suite's rows; sealed endpoints are removed via the sanctioned retention prune.
 * Runs only with DATABASE_URL; the top-level sentinel fails-not-skips inside the real-DB allowlist step.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { EventBus as AutomationEventBus } from '../../src/integration/events/event-bus'
import type { AutomationRule } from '../../src/multitable/automation-executor'
import { AutomationService } from '../../src/multitable/automation-service'
import { db } from '../../src/db/db'
import { resolveExactAnchor, executeExactAnchorRecovery } from '../../src/multitable/exact-anchor-recovery'
import { activateCheckpoint } from '../../src/multitable/history-trust-checkpoint'
import type { QueryFn as CheckpointQuery } from '../../src/multitable/permission-service'
import { pruneSealedOperation, __resetOperationLedgerColumnProbe } from '../../src/multitable/operation-ledger'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'
const TS = Date.now()
const BASE = `base_mkanchor_${TS}`
const SHEET = `sheet_mkanchor_${TS}`
const F_STR = `fld_mkanchor_str_${TS}`
const ACTOR = `u_mkanchor_${TS}`

let seqCounter = 0
const mkRecord = (tag: string) => `rec_mkanchor_${tag}_${TS}_${seqCounter++}`

/** Production entry-point wiring: AutomationService constructs AutomationExecutor with the REAL poolManager
 *  transaction seam — the goldens below are transaction-boundary proofs, not hand-wired fakes (same shape as
 *  the sibling L6-a suite's W4-W6). */
const mkAutomationService = () => {
  const pool = poolManager.get()
  return new AutomationService(new AutomationEventBus(), db as never, pool.query.bind(pool))
}
const automationLockRule = (locked: boolean): AutomationRule => ({
  id: `rule_mkanchor_${locked ? 'lock' : 'unlock'}_${TS}_${seqCounter++}`,
  name: `MarkerAnchor automation ${locked ? 'lock' : 'unlock'}`,
  sheetId: SHEET,
  enabled: true,
  trigger: { type: 'record.updated', config: {} },
  actions: [{ type: 'lock_record', config: { locked } } as never],
  createdBy: ACTOR,
  createdAt: new Date().toISOString(),
} as unknown as AutomationRule)
const executeAutomationLock = (recordId: string, locked: boolean) =>
  mkAutomationService().executeRule(automationLockRule(locked), { recordId, actorId: ACTOR, data: {} })

const seedRecord = async (id: string): Promise<void> => {
  await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [
    id, SHEET, JSON.stringify({ [F_STR]: 'orig' }), ACTOR,
  ])
}

const endpointOf = async (operationId: string): Promise<{ endpoint_seq: string; event_count: number } | undefined> =>
  (
    await q('SELECT endpoint_seq::text AS endpoint_seq, event_count FROM meta_record_history_operations WHERE sheet_id=$1 AND operation_id=$2::uuid', [SHEET, operationId])
  ).rows[0] as { endpoint_seq: string; event_count: number } | undefined

const endpointCount = async (): Promise<number> =>
  Number(((await q('SELECT count(*)::int AS n FROM meta_record_history_operations WHERE sheet_id=$1', [SHEET])).rows[0] as { n: number }).n)

const markerCount = async (recordId: string): Promise<number> =>
  Number(((await q('SELECT count(*)::int AS n FROM meta_record_version_markers WHERE sheet_id=$1 AND record_id=$2', [SHEET, recordId])).rows[0] as { n: number }).n)

/** The exact phantom shape: a sealed endpoint on this sheet with ZERO events (no revision AND no marker
 *  carries its operation_id) — "an anchor with nothing on it". Must always be zero. */
const zeroMarkerEndpointCount = async (): Promise<number> =>
  Number(((
    await q(
      `SELECT count(*)::int AS n
       FROM meta_record_history_operations o
       WHERE o.sheet_id = $1
         AND NOT EXISTS (SELECT 1 FROM meta_record_revisions r WHERE r.sheet_id = o.sheet_id AND r.operation_id = o.operation_id)
         AND NOT EXISTS (SELECT 1 FROM meta_record_version_markers m WHERE m.sheet_id = o.sheet_id AND m.operation_id = o.operation_id)`,
      [SHEET],
    )
  ).rows[0] as { n: number }).n)

// Top-level fail-not-skip sentinel, scoped to the CI real-DB allowlist step.
test('sentinel: the real-DB allowlist step must have DATABASE_URL (fail-not-skip, scoped to that step)', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('real-DB allowlist step is missing DATABASE_URL — the harness is broken, not legitimately skippable')
  }
  expect(true).toBe(true)
})

describeIfDatabase('TM closeout — automation lock/unlock marker anchors + phantom-anchor negative (real DB)', () => {
  beforeAll(async () => {
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'MarkerAnchor Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'MarkerAnchor Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_STR, SHEET, 'Note', 'string', '{}', 1])
  })

  beforeEach(() => {
    __resetOperationLedgerColumnProbe()
  })

  afterEach(() => {
    delete process.env[FLAG]
  })

  afterAll(async () => {
    delete process.env[FLAG]
    // Sealed endpoints are DELETE-immutable (H1) — remove any leftovers via the sanctioned retention prune.
    const ops = (await q('SELECT operation_id::text AS op FROM meta_record_history_operations WHERE sheet_id=$1', [SHEET])).rows as Array<{ op: string }>
    for (const { op } of ops) await pruneSealedOperation(q, SHEET, op).catch(() => {})
    for (const t of ['meta_history_baselines', 'meta_history_trust_checkpoints', 'meta_record_version_markers', 'meta_records_trash', 'meta_record_revisions', 'meta_records']) {
      await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
    }
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })

  test('sentinel: DATABASE_URL is set (this suite must RUN, never skip-green)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── G1 — MARKER-ANCHOR GOLDEN (P3-1 marker leg) ────────────────────────────────────────────────────────
  test('G1: automation lock AND unlock markers are each selectable as the recovery anchorOperationId (real resolver, exact marker seq frozen)', async () => {
    const R = mkRecord('g1')
    await seedRecord(R)
    let checkpointId: string | null = null
    const operationIds: string[] = []
    try {
      // The checkpoint predates both operations, so each marker endpoint is inside its trusted seq range.
      const checkpoint = await poolManager.get().transaction(async ({ query }) =>
        activateCheckpoint(query as unknown as CheckpointQuery, { sheetId: SHEET }))
      checkpointId = checkpoint.checkpointId
      process.env[FLAG] = 'true'

      const lock = await executeAutomationLock(R, true)
      expect(lock.steps[0]?.status).toBe('success')
      const unlock = await executeAutomationLock(R, false)
      expect(unlock.steps[0]?.status).toBe('success')

      const markers = (await q(
        `SELECT kind, version, seq::text AS seq, operation_id::text AS operation_id
         FROM meta_record_version_markers WHERE sheet_id=$1 AND record_id=$2 ORDER BY version`,
        [SHEET, R],
      )).rows as Array<{ kind: 'lock' | 'unlock'; version: number; seq: string; operation_id: string | null }>
      expect(markers.map((m) => [m.kind, m.version])).toEqual([['lock', 2], ['unlock', 3]])

      // EVERY marker operation — the LOCK-kind one included (the leg W4 leaves unresolved) — is a sealed
      // single-event endpoint that the REAL anchor-selection path accepts as anchorOperationId, freezing the
      // exact marker seq (never a live MAX) into the preview identity.
      for (const marker of markers) {
        expect(marker.operation_id).toMatch(/^[0-9a-f-]{36}$/)
        operationIds.push(marker.operation_id!)
        expect(await endpointOf(marker.operation_id!)).toEqual({ endpoint_seq: marker.seq, event_count: 1 })

        const resolved = await resolveExactAnchor(q, {
          sheetId: SHEET,
          request: { kind: 'exact-anchor', anchorOperationId: marker.operation_id! },
          actorId: ACTOR,
          mode: 'revert',
          evaluateFullReadAccess: async () => true,
        })
        expect(resolved.ok).toBe(true)
        if (resolved.ok) {
          expect(resolved.anchorOperationId).toBe(marker.operation_id)
          expect(resolved.anchorSeq).toBe(marker.seq)
          // the minted preview identity survives the read-half execute (same trust chain end-to-end)
          const ex = await executeExactAnchorRecovery(q, { token: resolved.token, sheetId: SHEET, actorId: ACTOR, evaluateFullReadAccess: async () => true })
          expect(ex.ok).toBe(true)
          if (ex.ok) expect(ex.anchorSeq).toBe(marker.seq)
        }
      }
      expect(operationIds[0]).not.toBe(operationIds[1]) // one operation per action, never shared
    } finally {
      for (const operationId of operationIds) await pruneSealedOperation(q, SHEET, operationId).catch(() => {})
      if (checkpointId) {
        await q('DELETE FROM meta_history_baselines WHERE checkpoint_id=$1', [checkpointId]).catch(() => {})
        await q('DELETE FROM meta_history_trust_checkpoints WHERE id=$1', [checkpointId]).catch(() => {})
      }
      await q('DELETE FROM meta_record_version_markers WHERE sheet_id=$1 AND record_id=$2', [SHEET, R]).catch(() => {})
      await q('DELETE FROM meta_records WHERE id=$1 AND sheet_id=$2', [R, SHEET]).catch(() => {})
    }
  })

  // ── G2 — PHANTOM-ANCHOR NEGATIVE (UPDATE hits 0 rows ⇒ no sealed zero-marker operation) ────────────────
  test('G2: lock/unlock whose UPDATE hits 0 rows (missing record) mints NO marker and seals NO zero-marker operation — and the step stays graceful', async () => {
    const MISSING = mkRecord('g2_missing') // never inserted — the same-base UPDATE will hit 0 rows
    process.env[FLAG] = 'true'
    const endpointsBefore = await endpointCount()

    // LOCK branch: Number.isFinite(newVersion) is false ⇒ recordVersionMarker is skipped ⇒ the operation
    // tracked ZERO events. The empty-op seal skip (operation-ledger.ts sealOperation) must turn the seal
    // into a no-op. MUTATION TRIPWIRE: neuter that skip and the empty-op endpoint INSERT is refused by the
    // DB (NOT NULL / chk_mrho_event_count_positive / validation trigger) ⇒ the transaction aborts ⇒ this
    // status assertion REDS ('failed', error mentions the endpoint constraint).
    const lock = await executeAutomationLock(MISSING, true)
    expect(lock.steps[0]?.status).toBe('success')
    expect(lock.steps[0]?.error).toBeUndefined()

    // UNLOCK branch: identical structure, identical guarantee.
    const unlock = await executeAutomationLock(MISSING, false)
    expect(unlock.steps[0]?.status).toBe('success')
    expect(unlock.steps[0]?.error).toBeUndefined()

    // No marker was minted for the phantom target, no record materialized…
    expect(await markerCount(MISSING)).toBe(0)
    expect((await q('SELECT 1 FROM meta_records WHERE id=$1 AND sheet_id=$2', [MISSING, SHEET])).rows).toHaveLength(0)
    // …no endpoint was added by either action…
    expect(await endpointCount()).toBe(endpointsBefore)
    // …and structurally there is NO sealed zero-marker operation anywhere on the sheet (the phantom shape
    // itself — an anchor with nothing on it — does not exist).
    expect(await zeroMarkerEndpointCount()).toBe(0)
  })

  // ── G2b — flag-OFF parity for the same 0-row path (byte-identical legacy no-op, nothing minted) ────────
  test('G2b: flag OFF, lock on a missing record stays a graceful no-op with zero markers and zero endpoints', async () => {
    const MISSING = mkRecord('g2b_missing')
    delete process.env[FLAG]
    const endpointsBefore = await endpointCount()
    const result = await executeAutomationLock(MISSING, true)
    expect(result.steps[0]?.status).toBe('success')
    expect(await markerCount(MISSING)).toBe(0)
    expect(await endpointCount()).toBe(endpointsBefore)
  })
})
