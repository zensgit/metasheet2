/**
 * W0-1 Lane L4-cov-services — the SERVICE writer classes join the canonical per-sheet fence. Real-DB goldens.
 *
 * Stacked on L4 (`multitable-l4-canonical-fence-realdb.test.ts`) + L4-coverage
 * (`multitable-l4cov-univer-meta-writers-realdb.test.ts`), which fenced the HTTP/plugin/auto-number writer
 * families. This lane fences the remaining SERVICE writers — AUTOMATION (executor actions + result
 * writeback), FORMULA materialization, and the APPROVAL-PROJECTION reconcile — and folds the deferred
 * plugin D-1 delete branch into the H1-DELETE implementation matrix (owner directive 2026-07-16: "把
 * deferred plugin D-1 delete 分支明确纳入 H1-DELETE 的实现或验收矩阵").
 *
 * WHAT THIS PROVES (per newly-fenced writer): (1) BLOCK-REFUSAL — with the L4 flag ON and a durable
 * `applying` block, the writer refuses (step failed / throws `SheetWriterBlockedError` / returns null) with
 * ZERO writes; (2) POSITIVE CONTROL — the same operation with no block proceeds; (3) FLAG-OFF PARITY — with
 * the fence flag OFF the block is inert and behaviour is byte-identical to pre-lane.
 * Plus: (§D) the D-1 plugin delete branch now mints + seals its operation with the flag ON — its sealed
 * endpoint is H1-immutable (UPDATE and DELETE both reject) — and stays byte-identical (NULL operation_id,
 * no endpoint) with the flag OFF; (§G) the retention prune's GUC unlock is TRANSACTION-LOCAL — after a
 * successful prune, a plain endpoint DELETE on the SAME session/connection still rejects.
 *
 * P2-C hygiene (v3.7): isolated synthetic fixtures with unique ids; NEVER `setval` on the shared
 * `meta_record_chain_seq`; cleanup deletes ONLY this suite's rows. Two-point wiring: plugin-tests.yml
 * real-DB run list + vitest.integration.config.ts include glob. Runs only with DATABASE_URL; the top-level
 * sentinel fails-not-skips in the real-DB allowlist step.
 */
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'events'

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { pool } from '../../src/db/pg'
import type { EventBus } from '../../src/integration/events/event-bus'
import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationRule,
} from '../../src/multitable/automation-executor'
import { AutomationService } from '../../src/multitable/automation-service'
import { MultitableFormulaEngine } from '../../src/multitable/formula-engine'
import { ApprovalRecordProjectionService, deriveProjectionSheetId } from '../../src/multitable/approval-record-projection-service'
import { APPROVAL_PROJECTION_BASE_ID } from '../../src/multitable/approval-projection-constants'
import { deleteRecord as pluginDeleteRecord } from '../../src/multitable/records'
import type { MultitableRecordsQueryFn } from '../../src/multitable/records'
import {
  SheetWriterBlockedError,
  __resetRecoveryWriterStateColumnProbe,
  type WriterBlockState,
} from '../../src/multitable/canonical-sheet-fence'
import { __resetOperationLedgerColumnProbe } from '../../src/multitable/operation-ledger'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'
const TS = Date.now()
const BASE = `base_l4svc_${TS}`
const SHEET = `sheet_l4svc_${TS}`
const F_STR = `fld_l4svc_str_${TS}`
const F_FORMULA = `fld_l4svc_formula_${TS}`
const ACTOR = `u_l4svc_${TS}`

let seqTag = 0
const mkRecord = (tag: string) => `rec_l4svc_${tag}_${TS}_${seqTag++}`

const eventBus = new EventEmitter() as unknown as EventBus

const setBlock = async (state: WriterBlockState | null, sheetId: string = SHEET) =>
  q('UPDATE meta_sheets SET recovery_writer_state = $2 WHERE id = $1', [sheetId, state])
const recordRow = async (id: string): Promise<{ data: Record<string, unknown>; version: number; locked: boolean | null } | undefined> =>
  (await q('SELECT data, version, locked FROM meta_records WHERE id = $1 AND sheet_id = $2', [id, SHEET])).rows[0] as never

const seedRecord = async (id: string, data: Record<string, unknown> = { [F_STR]: 'orig' }) =>
  q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [id, SHEET, JSON.stringify(data), ACTOR])

/** Executor with the PRODUCTION transaction wiring (mirrors AutomationService's constructor hard-wiring). */
function makeExecutor(withTxn = true): AutomationExecutor {
  const deps: AutomationDeps = {
    eventBus,
    queryFn: (sql: string, params?: unknown[]) => q(sql, params) as never,
    ...(withTxn
      ? {
          transaction: (async (handler: (client: { query: AutomationDeps['queryFn'] }) => Promise<unknown>) =>
            poolManager.get().transaction(async ({ query }) =>
              handler({ query: ((sql: string, params?: unknown[]) => query(sql, params)) as never }),
            )) as AutomationDeps['transaction'],
        }
      : {}),
  }
  return new AutomationExecutor(deps)
}

function ruleWith(action: { type: string; config: Record<string, unknown> }): AutomationRule {
  return {
    id: `axr_l4svc_${TS}_${Math.random().toString(36).slice(2, 8)}`,
    name: 'L4svc rule',
    sheetId: SHEET,
    trigger: { type: 'record.created', config: {} },
    actions: [action as never],
    enabled: true,
    createdBy: ACTOR,
  } as unknown as AutomationRule
}

// Top-level fail-not-skip sentinel, scoped to the CI real-DB allowlist step.
test('sentinel: the real-DB allowlist step must have DATABASE_URL (fail-not-skip, scoped to that step)', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('real-DB allowlist step is missing DATABASE_URL — the harness is broken, not legitimately skippable')
  }
  expect(true).toBe(true)
})

describeIfDatabase('W0-1 L4-cov-services — service writers on the canonical fence (real DB)', () => {
  beforeAll(async () => {
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE, 'L4svc Base', ACTOR])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'L4svc'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_STR, SHEET, 'Note', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
      F_FORMULA, SHEET, 'Calc', 'formula', JSON.stringify({ expression: '1+1' }), 2,
    ])
  })

  afterEach(async () => {
    delete process.env[FLAG]
    __resetRecoveryWriterStateColumnProbe()
    __resetOperationLedgerColumnProbe()
    await setBlock(null)
  })

  afterAll(async () => {
    delete process.env[FLAG]
    for (const t of ['meta_record_version_markers', 'meta_records_trash', 'meta_record_revisions', 'meta_records']) {
      await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
    }
    await q('DELETE FROM meta_record_history_operations WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    // projection fixtures (§P)
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [deriveProjectionSheetId(PRJ_TEMPLATE)]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [deriveProjectionSheetId(PRJ_TEMPLATE)]).catch(() => {})
    await q('DELETE FROM approval_instances WHERE id = $1', [PRJ_INSTANCE]).catch(() => {})
    await q('DELETE FROM approval_templates WHERE id = $1', [PRJ_TEMPLATE]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })

  test('sentinel: DATABASE_URL is set (this suite must RUN, never skip-green)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── §A AUTOMATION EXECUTOR actions ─────────────────────────────────────────────────────────────────────
  test('A1 update_record: applying block + flag ON ⇒ step FAILED, zero writes; positive control + flag-off parity', async () => {
    const R = mkRecord('a1')
    await seedRecord(R)
    const executor = makeExecutor()
    const rule = ruleWith({ type: 'update_record', config: { fields: { [F_STR]: 'mutated' } } })

    // BLOCK-REFUSAL: flag ON + applying ⇒ the fence's durable-block check throws inside the txn; the step
    // fails honestly and the record is untouched.
    process.env[FLAG] = 'true'
    await setBlock('applying')
    const blocked = await executor.execute(rule, { recordId: R, sheetId: SHEET, actorId: ACTOR, data: {} })
    expect(blocked.steps?.[0]?.status).toBe('failed')
    expect((await recordRow(R))?.data?.[F_STR]).toBe('orig')
    expect((await recordRow(R))?.version).toBe(1)

    // POSITIVE CONTROL: clear the block (same flag ON) ⇒ the write proceeds.
    await setBlock(null)
    const ok = await executor.execute(rule, { recordId: R, sheetId: SHEET, actorId: ACTOR, data: {} })
    expect(ok.steps?.[0]?.status).toBe('success')
    expect((await recordRow(R))?.data?.[F_STR]).toBe('mutated')

    // FLAG-OFF PARITY: block present but flag OFF ⇒ the block is inert (byte-identical pre-lane behaviour).
    delete process.env[FLAG]
    await setBlock('applying')
    const off = await executor.execute(ruleWith({ type: 'update_record', config: { fields: { [F_STR]: 'again' } } }), { recordId: R, sheetId: SHEET, actorId: ACTOR, data: {} })
    expect(off.steps?.[0]?.status).toBe('success')
    expect((await recordRow(R))?.data?.[F_STR]).toBe('again')
  })

  test('A2 create_record: applying block + flag ON ⇒ step FAILED, no row created; positive control creates', async () => {
    const executor = makeExecutor()
    const countRows = async () => Number(((await q('SELECT count(*)::int c FROM meta_records WHERE sheet_id = $1', [SHEET])).rows[0] as { c: number }).c)

    process.env[FLAG] = 'true'
    await setBlock('applying')
    const before = await countRows()
    const blocked = await executor.execute(ruleWith({ type: 'create_record', config: { data: { [F_STR]: 'new' } } }), { recordId: '', sheetId: SHEET, actorId: ACTOR, data: {} })
    expect(blocked.steps?.[0]?.status).toBe('failed')
    expect(await countRows()).toBe(before)

    await setBlock(null)
    const ok = await executor.execute(ruleWith({ type: 'create_record', config: { data: { [F_STR]: 'new' } } }), { recordId: '', sheetId: SHEET, actorId: ACTOR, data: {} })
    expect(ok.steps?.[0]?.status).toBe('success')
    expect(await countRows()).toBe(before + 1)
  })

  test('A3 delete_record: applying block + flag ON ⇒ step FAILED, row survives', async () => {
    const R = mkRecord('a3')
    await seedRecord(R)
    const executor = makeExecutor()

    process.env[FLAG] = 'true'
    await setBlock('applying')
    const blocked = await executor.execute(ruleWith({ type: 'delete_record', config: {} }), { recordId: R, sheetId: SHEET, actorId: ACTOR, data: {} })
    expect(blocked.steps?.[0]?.status).toBe('failed')
    expect(await recordRow(R)).toBeDefined() // row survives

    await setBlock(null)
    const ok = await executor.execute(ruleWith({ type: 'delete_record', config: {} }), { recordId: R, sheetId: SHEET, actorId: ACTOR, data: {} })
    expect(ok.steps?.[0]?.status).toBe('success')
    expect(await recordRow(R)).toBeUndefined()
  })

  test('A4 lock_record: applying block + flag ON ⇒ step FAILED, record stays unlocked at v1', async () => {
    const R = mkRecord('a4')
    await seedRecord(R)
    const executor = makeExecutor()

    process.env[FLAG] = 'true'
    await setBlock('applying')
    const blocked = await executor.execute(ruleWith({ type: 'lock_record', config: { locked: true } }), { recordId: R, sheetId: SHEET, actorId: ACTOR, data: {} })
    expect(blocked.steps?.[0]?.status).toBe('failed')
    const row = await recordRow(R)
    expect(row?.locked ?? false).toBe(false)
    expect(row?.version).toBe(1)

    await setBlock(null)
    const ok = await executor.execute(ruleWith({ type: 'lock_record', config: { locked: true } }), { recordId: R, sheetId: SHEET, actorId: ACTOR, data: {} })
    expect(ok.steps?.[0]?.status).toBe('success')
    expect((await recordRow(R))?.locked).toBe(true)
  })

  test('A5 FAIL-CLOSED: flag ON + executor WITHOUT a transaction seam ⇒ step FAILED (no silent unfenced write); flag OFF keeps the legacy no-txn path working', async () => {
    const R = mkRecord('a5')
    await seedRecord(R)
    const executor = makeExecutor(false) // no transaction dep — the legacy direct-queryFn shape

    // Flag ON: an advisory xact lock on an autocommit queryFn cannot hold — refuse loudly, zero writes.
    process.env[FLAG] = 'true'
    const failed = await executor.execute(ruleWith({ type: 'update_record', config: { fields: { [F_STR]: 'mutated' } } }), { recordId: R, sheetId: SHEET, actorId: ACTOR, data: {} })
    expect(failed.steps?.[0]?.status).toBe('failed')
    expect(String(failed.steps?.[0]?.error ?? '')).toMatch(/fence|transaction/i)
    expect((await recordRow(R))?.data?.[F_STR]).toBe('orig')

    // Flag OFF: byte-identical legacy behaviour (the no-txn fallback still works).
    delete process.env[FLAG]
    const ok = await executor.execute(ruleWith({ type: 'update_record', config: { fields: { [F_STR]: 'legacy' } } }), { recordId: R, sheetId: SHEET, actorId: ACTOR, data: {} })
    expect(ok.steps?.[0]?.status).toBe('success')
    expect((await recordRow(R))?.data?.[F_STR]).toBe('legacy')
  })

  // ── §W AUTOMATION result-writeback ─────────────────────────────────────────────────────────────────────
  test('W1 result-writeback: applying block + flag ON ⇒ SheetWriterBlockedError, zero writes; positive control writes', async () => {
    const R = mkRecord('w1')
    await seedRecord(R)
    // Drive the private seam directly (its two production callers are deep approval-bridge paths); the
    // method only uses `withTransaction` + eventBus + realtime emit, so a prototype-constructed instance
    // with just an eventBus exercises the REAL fence wiring.
    const service = Object.create(AutomationService.prototype) as AutomationService & {
      applyResultWritebackPatch: (sheetId: string, recordId: string, patch: Record<string, unknown>, opts: Record<string, unknown>) => Promise<boolean>
    }
    ;(service as unknown as { eventBus: EventBus }).eventBus = eventBus
    const opts = {
      lockActorId: null,
      eventName: 'multitable.record.updated',
      eventPayload: {},
      realtimeActorId: undefined,
      automationDepth: 0,
      lockedMessage: 'locked',
      onMissing: 'skip' as const,
    }

    process.env[FLAG] = 'true'
    await setBlock('applying')
    await expect(service.applyResultWritebackPatch(SHEET, R, { [F_STR]: 'wb' }, opts)).rejects.toThrow(SheetWriterBlockedError)
    expect((await recordRow(R))?.data?.[F_STR]).toBe('orig')

    await setBlock(null)
    await expect(service.applyResultWritebackPatch(SHEET, R, { [F_STR]: 'wb' }, opts)).resolves.toBe(true)
    expect((await recordRow(R))?.data?.[F_STR]).toBe('wb')
  })

  // ── §F FORMULA materialization ─────────────────────────────────────────────────────────────────────────
  test('F1 formula materialization: applying block + flag ON ⇒ null + NOT materialized; positive + flag-off parity', async () => {
    const R = mkRecord('f1')
    await seedRecord(R, { [F_STR]: 'x' })
    const engine = new MultitableFormulaEngine()
    const fields = [
      { id: F_STR, sheetId: SHEET, name: 'Note', type: 'string', property: {}, order: 1 },
      { id: F_FORMULA, sheetId: SHEET, name: 'Calc', type: 'formula', property: { expression: '1+1' }, order: 2 },
    ] as never

    // BLOCK-REFUSAL: the fence throws inside recalculate's try — the engine returns null (its documented
    // failure contract) and the derived value is NOT written into the blocked sheet.
    process.env[FLAG] = 'true'
    await setBlock('applying')
    const query = ((sql: string, params?: unknown[]) => q(sql, params)) as MultitableRecordsQueryFn
    const blocked = await engine.recalculateRecordFromData(query, SHEET, R, { [F_STR]: 'x' }, fields)
    expect(blocked).toBeNull()
    expect((await recordRow(R))?.data?.[F_FORMULA]).toBeUndefined()

    // POSITIVE CONTROL: no block ⇒ materializes the computed key.
    await setBlock(null)
    const ok = await engine.recalculateRecordFromData(query, SHEET, R, { [F_STR]: 'x' }, fields)
    expect(ok?.[F_FORMULA]).toBe(2)
    expect((await recordRow(R))?.data?.[F_FORMULA]).toBe(2)

    // FLAG-OFF PARITY: block present, flag OFF ⇒ inert (writes proceed byte-identically).
    delete process.env[FLAG]
    await setBlock('applying')
    const off = await engine.recalculateRecordFromData(query, SHEET, R, { [F_STR]: 'x' }, fields)
    expect(off?.[F_FORMULA]).toBe(2)
  })

  test('F2 formula recompute is fence-SERIALIZED against recovery: a raw client holding the canonical fence PARKS the recompute until release (recovery-exclusion)', async () => {
    // What this proves: the formula recompute genuinely ACQUIRES the canonical fence, so it cannot run
    // concurrently with a fence holder (a recovery holds the fence for its cutover/apply). The TOCTOU
    // CLOSURE itself — the fence held continuously from block-check THROUGH the UPDATE — is a STRUCTURAL
    // property (engine wraps fenceWriterEntry + UPDATE in ONE `poolManager.get().transaction`, both on the
    // same `fq` connection); the precise block-check→UPDATE interleaving is not deterministically
    // constructible without injecting an engine pause, so it is code-reviewed + reasoned, the same posture
    // the L8 gate accepted for its two-token race. This test's load-bearing half is that the fence is
    // acquired at all (removing `fenceWriterEntry` reds both F1 and F2).
    const R = mkRecord('f2')
    await seedRecord(R, { [F_STR]: 'x' })
    const engine = new MultitableFormulaEngine()
    const fields = [
      { id: F_STR, sheetId: SHEET, name: 'Note', type: 'string', property: {}, order: 1 },
      { id: F_FORMULA, sheetId: SHEET, name: 'Calc', type: 'formula', property: { expression: '1+1' }, order: 2 },
    ] as never
    process.env[FLAG] = 'true'
    const query = ((sql: string, params?: unknown[]) => q(sql, params)) as MultitableRecordsQueryFn
    expect(pool).toBeTruthy()
    const holder = await pool!.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`meta:auto-number:sheet:${SHEET}`])
      const inflight = engine.recalculateRecordFromData(query, SHEET, R, { [F_STR]: 'x' }, fields)
      let sawWaiter = false
      for (let i = 0; i < 100; i++) {
        const waiters = await holder.query(`SELECT count(*)::int AS c FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)
        if (Number((waiters.rows[0] as { c: number }).c) > 0) { sawWaiter = true; break }
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(sawWaiter).toBe(true) // the recompute genuinely parked behind the fence holder
      await holder.query('COMMIT') // release ⇒ the recompute proceeds and materializes
      const result = await inflight
      expect(result?.[F_FORMULA]).toBe(2)
      expect((await recordRow(R))?.data?.[F_FORMULA]).toBe(2)
    } finally {
      holder.release()
    }
  })

  // ── §P APPROVAL-PROJECTION reconcile ───────────────────────────────────────────────────────────────────
  const PRJ_TEMPLATE = randomUUID()
  const PRJ_INSTANCE = randomUUID()

  test('P1 projection reconcile: applying block on the (system) projection sheet + flag ON ⇒ throws + ROLLBACK, zero projection rows; positive control projects; flag-off parity', async () => {
    const prjSheet = deriveProjectionSheetId(PRJ_TEMPLATE)
    // Minimal authoritative template + instance (non-terminal status ⇒ no decision join needed).
    await q(
      `INSERT INTO approval_templates (id, key, name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      [PRJ_TEMPLATE, `l4svc_${TS}`, 'L4svc Projection Template'],
    )
    await q(
      `INSERT INTO approval_instances (id, template_id, status, version, requester_snapshot, created_at, updated_at)
       VALUES ($1,$2,'pending',3,'{}'::jsonb, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [PRJ_INSTANCE, PRJ_TEMPLATE],
    )
    // Pre-provision the DERIVED projection sheet so a durable block can exist on it BEFORE reconcile
    // (reconcile's own ensureFamilySheet provisioning is idempotent against this row).
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [APPROVAL_PROJECTION_BASE_ID, 'Approval Projection'])
    await q(
      `INSERT INTO meta_sheets (id, base_id, name, system_kind) VALUES ($1,$2,$3,'approval_projection') ON CONFLICT (id) DO NOTHING`,
      [prjSheet, APPROVAL_PROJECTION_BASE_ID, 'Projection L4svc'],
    )
    const projection = new ApprovalRecordProjectionService()
    const projectedRow = async () =>
      (await q('SELECT id FROM meta_records WHERE sheet_id = $1', [prjSheet])).rows[0]

    // BLOCK-REFUSAL: flag ON + applying on the projection sheet ⇒ reconcile throws (its catch re-throws
    // after ROLLBACK) and NO projection record lands.
    process.env[FLAG] = 'true'
    await setBlock('applying', prjSheet)
    await expect(projection.reconcile(PRJ_INSTANCE)).rejects.toThrow(SheetWriterBlockedError)
    expect(await projectedRow()).toBeUndefined()

    // POSITIVE CONTROL: clear the block ⇒ reconcile projects the record.
    await setBlock(null, prjSheet)
    const ok = await projection.reconcile(PRJ_INSTANCE)
    expect(ok.status).toBe('projected')
    expect(await projectedRow()).toBeDefined()

    // FLAG-OFF PARITY: block re-set, flag OFF ⇒ inert (a stale-version reconcile is a 'noop', which still
    // proves the fence did not fire — it never reached a refusal).
    delete process.env[FLAG]
    await setBlock('applying', prjSheet)
    const off = await projection.reconcile(PRJ_INSTANCE)
    expect(off.status).toBe('noop') // same version ⇒ noop; crucially NOT a SheetWriterBlockedError
  })

  // ── §D the D-1 plugin delete branch joins the H1-DELETE matrix ────────────────────────────────────────
  test('D1 flag ON: the D-1 plugin delete mints + seals its operation; the sealed endpoint is H1-immutable (UPDATE and DELETE reject)', async () => {
    const R = mkRecord('d1')
    await seedRecord(R)
    process.env[FLAG] = 'true'
    // Drive the REAL plugin-SDK delete inside a real transaction (the OD-7 production shape).
    const result = await poolManager.get().transaction(async ({ query }) =>
      pluginDeleteRecord({ query: ((sql: string, params?: unknown[]) => query(sql, params)) as never, sheetId: SHEET, recordId: R }),
    )
    expect(result.id).toBe(R)
    // The delete revision is ledger-tagged and its operation sealed with event_count 1.
    const rev = (await q(
      `SELECT operation_id::text AS op FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2 AND action = 'delete'`,
      [SHEET, R],
    )).rows[0] as { op?: string | null } | undefined
    expect(rev?.op).toBeTruthy()
    const ep = (await q(
      `SELECT endpoint_seq::text AS s, event_count FROM meta_record_history_operations WHERE sheet_id = $1 AND operation_id = $2::uuid`,
      [SHEET, rev!.op],
    )).rows[0] as { s: string; event_count: number } | undefined
    expect(ep).toBeDefined()
    expect(ep!.event_count).toBe(1)

    // H1 matrix: the endpoint is immutable — UPDATE rejects, plain DELETE rejects.
    await expect(q('UPDATE meta_record_history_operations SET event_count = 99 WHERE sheet_id = $1 AND operation_id = $2::uuid', [SHEET, rev!.op]))
      .rejects.toThrow(/immutable|sealed|reject/i)
    await expect(q('DELETE FROM meta_record_history_operations WHERE sheet_id = $1 AND operation_id = $2::uuid', [SHEET, rev!.op]))
      .rejects.toThrow(/immutable|sealed|reject|retention/i)
  })

  test('D2 flag OFF: the D-1 plugin delete stays byte-identical — NULL operation_id, no endpoint row', async () => {
    const R = mkRecord('d2')
    await seedRecord(R)
    delete process.env[FLAG]
    const before = Number(((await q('SELECT count(*)::int c FROM meta_record_history_operations WHERE sheet_id = $1', [SHEET])).rows[0] as { c: number }).c)
    await poolManager.get().transaction(async ({ query }) =>
      pluginDeleteRecord({ query: ((sql: string, params?: unknown[]) => query(sql, params)) as never, sheetId: SHEET, recordId: R }),
    )
    const rev = (await q(
      `SELECT operation_id FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2 AND action = 'delete'`,
      [SHEET, R],
    )).rows[0] as { operation_id: unknown } | undefined
    expect(rev?.operation_id ?? null).toBeNull()
    const after = Number(((await q('SELECT count(*)::int c FROM meta_record_history_operations WHERE sheet_id = $1', [SHEET])).rows[0] as { c: number }).c)
    expect(after).toBe(before)
  })

  test('D3 BLOCK-REFUSAL (gate P2-1): flag ON + applying block ⇒ the D-1 plugin delete refuses, record + revision/endpoint state untouched', async () => {
    const R = mkRecord('d3')
    await seedRecord(R)
    process.env[FLAG] = 'true'
    await setBlock('applying')
    const revCount = async () => Number(((await q('SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2', [SHEET, R])).rows[0] as { c: number }).c)
    const epCount = async () => Number(((await q('SELECT count(*)::int c FROM meta_record_history_operations WHERE sheet_id = $1', [SHEET])).rows[0] as { c: number }).c)
    const epsBefore = await epCount()
    // The D-1 branch's own fence (fence-before-check) must observe the committed block and refuse BEFORE any
    // destructive write — the exact same block-refusal leg every other writer in this lane carries.
    await expect(
      poolManager.get().transaction(async ({ query }) =>
        pluginDeleteRecord({ query: ((sql: string, params?: unknown[]) => query(sql, params)) as never, sheetId: SHEET, recordId: R }),
      ),
    ).rejects.toThrow(SheetWriterBlockedError)
    expect(await recordRow(R)).toBeDefined() // row survives
    expect(await revCount()).toBe(0) // no delete revision
    expect(await epCount()).toBe(epsBefore) // no endpoint

    // POSITIVE CONTROL: clear the block ⇒ the same delete proceeds.
    await setBlock(null)
    await poolManager.get().transaction(async ({ query }) =>
      pluginDeleteRecord({ query: ((sql: string, params?: unknown[]) => query(sql, params)) as never, sheetId: SHEET, recordId: R }),
    )
    expect(await recordRow(R)).toBeUndefined()
  })

  test('D4 NON-TXN NEGATIVE (gate P2-2, the G16 analogue): flag ON + a NON-transactional caller ⇒ refused BEFORE any destructive write', async () => {
    const R = mkRecord('d4')
    await seedRecord(R)
    process.env[FLAG] = 'true'
    // A bare autocommit query is NOT transactional — assertTransactionalQuery must throw before the
    // meta_links/meta_records deletes run. Without this guard the tagged revision INSERT would trip the
    // deferred FK on its own autocommit statement AFTER the record was destroyed — a record deleted with NO
    // delete revision, the exact PIT lie D-1 exists to prevent.
    await expect(
      pluginDeleteRecord({ query: ((sql: string, params?: unknown[]) => q(sql, params)) as never, sheetId: SHEET, recordId: R }),
    ).rejects.toThrow(/transaction/i)
    expect(await recordRow(R)).toBeDefined() // row survives — nothing destructive ran
    const links = await q('SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2', [SHEET, R])
    expect(Number((links.rows[0] as { c: number }).c)).toBe(0)

    // POSITIVE CONTROL (flag OFF): the same bare caller keeps the legacy D-1 behaviour (guard not reached).
    delete process.env[FLAG]
    await pluginDeleteRecord({ query: ((sql: string, params?: unknown[]) => q(sql, params)) as never, sheetId: SHEET, recordId: R })
    expect(await recordRow(R)).toBeUndefined()
  })

  // ── §G retention-GUC containment ───────────────────────────────────────────────────────────────────────
  test('G1 the prune GUC unlock is TRANSACTION-LOCAL: after a successful prune, a plain endpoint DELETE on the SAME connection still rejects', async () => {
    process.env[FLAG] = 'true'
    // Two sealed single-event operations via the real D-1 plugin delete.
    const R1 = mkRecord('g1a')
    const R2 = mkRecord('g1b')
    await seedRecord(R1)
    await seedRecord(R2)
    const ops: string[] = []
    for (const R of [R1, R2]) {
      await poolManager.get().transaction(async ({ query }) =>
        pluginDeleteRecord({ query: ((sql: string, params?: unknown[]) => query(sql, params)) as never, sheetId: SHEET, recordId: R }),
      )
      const rev = (await q(`SELECT operation_id::text AS op FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2 AND action = 'delete'`, [SHEET, R])).rows[0] as { op: string }
      ops.push(rev.op)
    }

    // ONE dedicated connection for both statements — the containment claim is about the SAME session.
    expect(pool).toBeTruthy()
    const client = await pool!.connect()
    try {
      // The privileged prune channel works (it deletes the op's events + endpoint atomically)...
      await client.query('SELECT meta_record_history_operations_prune($1, $2::uuid)', [SHEET, ops[0]])
      const gone = await client.query('SELECT 1 FROM meta_record_history_operations WHERE sheet_id = $1 AND operation_id = $2::uuid', [SHEET, ops[0]])
      expect(gone.rows.length).toBe(0)
      // ...and its GUC unlock did NOT leak: a plain DELETE of the OTHER endpoint on the SAME connection,
      // in a NEW statement/transaction, still rejects (set_config(..., true) is transaction-local).
      await expect(
        client.query('DELETE FROM meta_record_history_operations WHERE sheet_id = $1 AND operation_id = $2::uuid', [SHEET, ops[1]]),
      ).rejects.toThrow(/immutable|sealed|reject|retention/i)
    } finally {
      client.release()
    }
  })

  // ── §G2 — P3-R (owner review, 2026-07-17): the prune fn's trailing reset is load-bearing IN-TXN ─────────
  test('G2 P3-R: after prune() returns, a later ad-hoc endpoint DELETE in the SAME caller transaction still RAISES (the trailing set_config-off reset is load-bearing)', async () => {
    process.env[FLAG] = 'true'
    // Two sealed single-event operations (same real D-1 plugin-delete producer as G1).
    const R1 = mkRecord('g2a')
    const R2 = mkRecord('g2b')
    await seedRecord(R1)
    await seedRecord(R2)
    const ops: string[] = []
    for (const R of [R1, R2]) {
      await poolManager.get().transaction(async ({ query }) =>
        pluginDeleteRecord({ query: ((sql: string, params?: unknown[]) => query(sql, params)) as never, sheetId: SHEET, recordId: R }),
      )
      const rev = (await q(`SELECT operation_id::text AS op FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2 AND action = 'delete'`, [SHEET, R])).rows[0] as { op: string }
      ops.push(rev.op)
    }

    // ONE explicit transaction: prune op[0], then — LATER IN THE SAME TXN — attempt an ad-hoc DELETE of
    // op[1]. Without the prune fn's trailing `set_config('metasheet.mrho_retention','off',true)`, the
    // txn-local GUC would still read 'on' here and H1 would be silently bypassed for the REST of the caller
    // transaction. This is the P3-R golden gating the first production retention caller.
    expect(pool).toBeTruthy()
    const client = await pool!.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT meta_record_history_operations_prune($1, $2::uuid)', [SHEET, ops[0]])
      // the sanctioned prune worked inside this txn...
      const gone = await client.query('SELECT 1 FROM meta_record_history_operations WHERE sheet_id = $1 AND operation_id = $2::uuid', [SHEET, ops[0]])
      expect(gone.rows.length).toBe(0)
      // ...and the GUC is already back to 'off' INSIDE the same txn, so H1 holds for everything after.
      const guc = await client.query(`SELECT current_setting('metasheet.mrho_retention', true) AS v`)
      expect((guc.rows[0] as { v: string | null }).v).not.toBe('on')
      await expect(
        client.query('DELETE FROM meta_record_history_operations WHERE sheet_id = $1 AND operation_id = $2::uuid', [SHEET, ops[1]]),
      ).rejects.toThrow(/immutable|sealed|reject|retention/i)
      await client.query('ROLLBACK') // the failed DELETE aborted the txn; roll back (op[0]'s prune undone too — fixture hygiene)
    } finally {
      client.release()
    }
    // Positive control: op[1]'s endpoint survived the aborted txn (nothing leaked out of the rollback).
    const survived = await q('SELECT 1 FROM meta_record_history_operations WHERE sheet_id = $1 AND operation_id = $2::uuid', [SHEET, ops[1]])
    expect(survived.rows.length).toBe(1)
  })
})
