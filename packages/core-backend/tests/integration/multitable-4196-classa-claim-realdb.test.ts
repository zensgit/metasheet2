/**
 * #4196 — Class-A same-transaction idempotency claim, real-DB goldens (CI-only; DATABASE_URL-gated).
 *
 * When an automation execution is RETRIED/REPLAYED, a Class-A action (a DB mutation) must apply AT MOST
 * ONCE per (execution-lineage-root, action-identity). The claim rides the SAME transaction as the
 * mutation: a duplicate claim → the mutation is skipped entirely (zero second row, zero second revision).
 *
 * These goldens exercise the REAL production wiring: `AutomationService.executeRule(...)` — index.ts
 * constructs `AutomationService` with `pool.query.bind(pool)`, and the constructor hard-wires
 * `deps.transaction` to a real `poolManager.get().transaction(...)`. A replay is driven by calling
 * `executeRule` again with the ORIGINAL execution's `rootExecutionId` in `retryMeta` — exactly what
 * `retryExecution` threads through `collectExecutionLineageIds` for a real admin retry.
 *
 *   G1  REPLAY IS A NO-OP (create): first run creates 1 record + 1 revision + 1 claim; a replay on the same
 *       root claims a DUPLICATE, skips the INSERT, and returns `alreadyApplied` — still exactly 1 of each.
 *   G2  REPLAY IS A NO-OP (update): a fixed-record update applies once (version bump + 1 update revision); a
 *       replay on the same root does NOT bump the version and writes NO second update revision.
 *   G3  CRASH ROLLS BACK THE CLAIM: a Postgres failure injected into the revision INSERT rolls the WHOLE
 *       transaction back — the claim row is NOT durable (no orphan). A clean retry then SUCCEEDS and
 *       applies (proving a crash before COMMIT never permanently skips the missing write).
 *   G4  FLAG-OFF POSITIVE CONTROL: with the claim flag OFF, a replay on the same root RE-APPLIES (a second
 *       record) — proving the claim, not some incidental guard, is what enforces at-most-once.
 *   G5  LOGICAL-FAILURE ROLLS BACK THE CLAIM: a cross-base update/delete whose gate passes but whose target
 *       record does not exist fails AFTER the claim WITHOUT a DB exception. That path rolls the claim back
 *       (throws, not `return {failed}`), so a retry re-attempts rather than being skipped as a false
 *       duplicate. Complements G3 (DB-exception rollback) with the non-throwing logical-failure case.
 *
 * Cannot run locally (no DATABASE_URL). Wired into plugin-tests.yml's multitable real-DB run-list AND
 * excluded from the default no-DB vitest config (two-point convention), mirroring the d1c goldens.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { EventBus } from '../../src/integration/events/event-bus'
import { AutomationService } from '../../src/multitable/automation-service'
import { db } from '../../src/db/db'
import type { AutomationExecution, AutomationRule } from '../../src/multitable/automation-executor'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const FLAG = 'AUTOMATION_CLASSA_CLAIM_ENABLED'
const TS = Date.now()
const OWNER = `u_ca_owner_${TS}`
const BASE = `base_ca_${TS}`
const SHEET = `sheet_ca_${TS}`
const SHEET_CRASH = `sheet_ca_crash_${TS}`
const SHEET_OFF = `sheet_ca_off_${TS}`
const SHEET_RETRY = `sheet_ca_retry_${TS}`
// G5 cross-base: a SECOND base OWNER owns (so the write-gate grants base-write) — the not-found target lives here.
const BASE_XB = `base_ca_xb_${TS}`
const SHEET_XB = `sheet_ca_xb_${TS}`
const FLD_TITLE = `fld_ca_title_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

/** The REAL production AutomationService wiring — mirrors index.ts (real queryFn; constructor hard-wires
 * deps.transaction to a real poolManager.get().transaction(...)). This is what makes the same-transaction
 * claim + atomicity proofs real, never a hand-rolled query calling private methods. */
function realService(): AutomationService {
  const pool = poolManager.get()
  return new AutomationService(new EventBus(), db as never, pool.query.bind(pool))
}

function ruleFor(
  sheetId: string,
  action: { type: 'create_record' | 'update_record' | 'delete_record'; config: Record<string, unknown> },
): AutomationRule {
  return {
    id: `atr_ca_${TS}_${Math.random().toString(36).slice(2, 8)}`,
    name: 'Class-A rule',
    sheetId,
    trigger: { type: 'record.created', config: {} },
    actions: [action as never],
    enabled: true,
    createdBy: OWNER,
    createdAt: new Date().toISOString(),
  } as unknown as AutomationRule
}

async function persistRetryRule(ruleId: string, value: string): Promise<void> {
  await q(
    `INSERT INTO automation_rules
      (id, sheet_id, name, trigger_type, trigger_config, action_type, action_config, enabled, created_by)
     VALUES ($1,$2,$3,'record.created','{}'::jsonb,'create_record',$4::jsonb,true,$5)`,
    [
      ruleId,
      SHEET_RETRY,
      'Retry evidence rule',
      JSON.stringify({ sheetId: SHEET_RETRY, data: { [`${FLD_TITLE}_${SHEET_RETRY}`]: value } }),
      OWNER,
    ],
  )
}

async function persistFailedRoot(rootId: string, ruleId: string, triggeredAt: string): Promise<void> {
  await realService().logs.record({
    id: rootId,
    ruleId,
    triggeredBy: 'event',
    triggeredAt,
    status: 'failed',
    steps: [],
    triggerEvent: { actorId: OWNER, data: {} },
  })
}

const recordsIn = async (sheetId: string): Promise<string[]> =>
  ((await q('SELECT id FROM meta_records WHERE sheet_id = $1 ORDER BY id', [sheetId])).rows as Array<{ id: string }>).map(
    (r) => r.id,
  )

const recordRow = async (recordId: string): Promise<{ version: number; data: Record<string, unknown> } | undefined> =>
  (await q('SELECT version, data FROM meta_records WHERE id = $1', [recordId])).rows[0] as
    | { version: number; data: Record<string, unknown> }
    | undefined

const revisionsOf = async (recordId: string): Promise<Array<{ action: string; version: number }>> =>
  (
    await q(
      `SELECT action, version FROM meta_record_revisions WHERE record_id = $1 ORDER BY created_at ASC, version ASC`,
      [recordId],
    )
  ).rows as Array<{ action: string; version: number }>

const claimRowsFor = async (root: string): Promise<Array<{ action_key: string; action_type: string | null }>> =>
  (
    await q(
      `SELECT action_key, action_type FROM meta_automation_action_applied WHERE kind = 'execution' AND root_execution_id = $1`,
      [root],
    )
  ).rows as Array<{ action_key: string; action_type: string | null }>

/** Genuine Postgres-level failure injection (never a JS mock) — mirrors the d1c goldens. */
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

/** Replay: re-run the rule with the ORIGINAL execution's lineage root (what a real admin retry threads). */
function replay(
  svc: AutomationService,
  rule: AutomationRule,
  triggerEvent: unknown,
  original: AutomationExecution,
): Promise<AutomationExecution> {
  return svc.executeRule(rule, triggerEvent, {
    rerunOfExecutionId: original.id,
    initiatedBy: OWNER,
    rootExecutionId: original.id, // first run had no parent, so its root is its own id
  })
}

describeIfDatabase('#4196 Class-A same-transaction claim (real DB)', () => {
  let svc: AutomationService

  beforeAll(async () => {
    process.env[FLAG] = 'true'
    svc = realService()
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE, 'Class-A Base', OWNER])
    for (const [sheet, name] of [
      [SHEET, 'Class-A Sheet'],
      [SHEET_CRASH, 'Class-A Crash Sheet'],
      [SHEET_OFF, 'Class-A Flag-Off Sheet'],
      [SHEET_RETRY, 'Class-A Retry Evidence Sheet'],
    ]) {
      await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [sheet, BASE, name])
      await q(`INSERT INTO meta_fields (id, sheet_id, name, type, "order") VALUES ($1,$2,'Title','string',0)`, [
        `${FLD_TITLE}_${sheet}`,
        sheet,
      ])
    }
    // G5: a second base OWNER owns + a sheet in it (the cross-base write target).
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE_XB, 'Class-A XBase', OWNER])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_XB, BASE_XB, 'Class-A XSheet'])
  })

  afterAll(async () => {
    for (const sheet of [SHEET, SHEET_CRASH, SHEET_OFF, SHEET_RETRY]) {
      await q(
        'DELETE FROM meta_record_revisions WHERE record_id IN (SELECT id FROM meta_records WHERE sheet_id = $1)',
        [sheet],
      ).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [sheet]).catch(() => {})
    }
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_XB]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_XB]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE, BASE_XB]]).catch(() => {})
    delete process.env[FLAG]
  })

  test('sentinel: DATABASE_URL is set and the flag is ON', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
    expect(process.env[FLAG]).toBe('true')
  })

  test('V5 migration installs the retry marker and both bounded-query indexes', async () => {
    const column = await q(
      `SELECT data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'multitable_automation_executions'
          AND column_name = 'first_retry_attempted_at'`,
    )
    expect(column.rows).toEqual([{ data_type: 'timestamp with time zone' }])

    const indexes = await q(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = ANY($1::text[])
        ORDER BY indexname`,
      [[
        'idx_automation_action_applied_applied_at',
        'idx_automation_executions_rerun_parent',
      ]],
    )
    expect(indexes.rows).toEqual([
      { indexname: 'idx_automation_action_applied_applied_at' },
      { indexname: 'idx_automation_executions_rerun_parent' },
    ])
  })

  test('a persisted manual test execution cannot enter whole-execution retry', async () => {
    const manualId = `axe_manual_retry_guard_${TS}`
    const eventId = `axe_event_retry_control_${TS}`
    try {
      await svc.logs.record({
        id: manualId,
        ruleId: `atr_missing_${TS}`,
        triggeredBy: 'manual_test',
        triggeredAt: new Date().toISOString(),
        status: 'failed',
        steps: [],
        triggerEvent: { recordId: 'test_record', data: {} },
      })
      await svc.logs.record({
        id: eventId,
        ruleId: `atr_missing_${TS}`,
        triggeredBy: 'event',
        triggeredAt: new Date().toISOString(),
        status: 'failed',
        steps: [],
        triggerEvent: { recordId: 'test_record', data: {} },
      })

      await expect(svc.retryExecution(manualId, OWNER)).resolves.toMatchObject({
        status: 409,
        code: 'TEST_RUN_NOT_RETRYABLE',
      })
      await expect(svc.retryExecution(eventId, OWNER)).resolves.toMatchObject({
        status: 409,
        code: 'RULE_MISSING_OR_DISABLED',
      })
    } finally {
      await q('DELETE FROM multitable_automation_executions WHERE id = ANY($1::text[])', [[manualId, eventId]])
    }
  })

  test('V5 first retry proceeds, then a deliberately deleted Class-A ledger fails closed', async () => {
    const ruleId = `atr_retry_evidence_${TS}`
    const rootId = `axe_retry_evidence_${TS}`
    await persistRetryRule(ruleId, 'evidence-once')
    await persistFailedRoot(rootId, ruleId, new Date(Date.now() - 60_000).toISOString())
    try {
      const first = await svc.retryExecution(rootId, OWNER)
      expect('execution' in first).toBe(true)
      if (!('execution' in first)) throw new Error('first retry unexpectedly rejected')
      expect(first.execution.status).toBe('success')
      expect(await claimRowsFor(rootId)).toHaveLength(1)
      const marker = await q(
        'SELECT first_retry_attempted_at FROM multitable_automation_executions WHERE id = $1',
        [rootId],
      )
      expect(marker.rows[0]).toMatchObject({ first_retry_attempted_at: expect.any(Date) })

      const childCountBefore = Number((await q(
        'SELECT count(*)::int AS count FROM multitable_automation_executions WHERE rerun_of_execution_id = $1',
        [rootId],
      )).rows[0].count)
      await q(
        `DELETE FROM meta_automation_action_applied
          WHERE kind = 'execution' AND root_execution_id = $1`,
        [rootId],
      )

      await expect(svc.retryExecution(rootId, OWNER)).resolves.toMatchObject({
        status: 409,
        code: 'RETRY_EVIDENCE_MISSING',
      })
      const childCountAfter = Number((await q(
        'SELECT count(*)::int AS count FROM multitable_automation_executions WHERE rerun_of_execution_id = $1',
        [rootId],
      )).rows[0].count)
      expect(childCountAfter).toBe(childCountBefore)
    } finally {
      await q('DELETE FROM meta_automation_action_applied WHERE root_execution_id = $1', [rootId]).catch(() => {})
      await q(
        'DELETE FROM multitable_automation_executions WHERE id = $1 OR rerun_of_execution_id = $1',
        [rootId],
      ).catch(() => {})
      await q('DELETE FROM automation_rules WHERE id = $1', [ruleId]).catch(() => {})
    }
  })

  test('V5 legacy retry-child signal prevents a missing marker from masquerading as a first retry', async () => {
    const ruleId = `atr_retry_legacy_child_${TS}`
    const rootId = `axe_retry_legacy_root_${TS}`
    const childId = `axe_retry_legacy_child_${TS}`
    await persistRetryRule(ruleId, 'legacy-child')
    await persistFailedRoot(rootId, ruleId, new Date(Date.now() - 60_000).toISOString())
    await svc.logs.record({
      id: childId,
      ruleId,
      triggeredBy: 'event',
      triggeredAt: new Date().toISOString(),
      status: 'failed',
      steps: [],
      triggerEvent: { actorId: OWNER, data: {} },
      rerunOfExecutionId: rootId,
      initiatedBy: OWNER,
    })
    try {
      await expect(svc.retryExecution(rootId, OWNER)).resolves.toMatchObject({
        status: 409,
        code: 'RETRY_EVIDENCE_MISSING',
      })
      const root = await q(
        'SELECT first_retry_attempted_at FROM multitable_automation_executions WHERE id = $1',
        [rootId],
      )
      expect(root.rows[0]).toMatchObject({ first_retry_attempted_at: null })
    } finally {
      await q('DELETE FROM multitable_automation_executions WHERE id = ANY($1::text[])', [[childId, rootId]])
        .catch(() => {})
      await q('DELETE FROM automation_rules WHERE id = $1', [ruleId]).catch(() => {})
    }
  })

  test('V5 missing lineage root cannot be re-minted from its surviving retry child', async () => {
    const ruleId = `atr_retry_missing_root_${TS}`
    const missingRootId = `axe_retry_missing_root_${TS}`
    const childId = `axe_retry_orphan_child_${TS}`
    await persistRetryRule(ruleId, 'missing-root')
    await svc.logs.record({
      id: childId,
      ruleId,
      triggeredBy: 'event',
      triggeredAt: new Date(Date.now() - 60_000).toISOString(),
      status: 'failed',
      steps: [],
      triggerEvent: { actorId: OWNER, data: {} },
      rerunOfExecutionId: missingRootId,
      initiatedBy: OWNER,
    })
    const recordsBefore = await recordsIn(SHEET_RETRY)
    try {
      await expect(svc.retryExecution(childId, OWNER)).resolves.toMatchObject({
        status: 409,
        code: 'RETRY_EVIDENCE_MISSING',
      })
      expect(await recordsIn(SHEET_RETRY)).toEqual(recordsBefore)
      const child = await q(
        'SELECT first_retry_attempted_at FROM multitable_automation_executions WHERE id = $1',
        [childId],
      )
      expect(child.rows[0]).toMatchObject({ first_retry_attempted_at: null })
      expect(await claimRowsFor(childId)).toEqual([])
    } finally {
      await q('DELETE FROM multitable_automation_executions WHERE id = $1', [childId])
      await q('DELETE FROM automation_rules WHERE id = $1', [ruleId])
    }
  })

  test('V5 retry older than retention is rejected before marker claim or dispatch', async () => {
    const ruleId = `atr_retry_expired_${TS}`
    const rootId = `axe_retry_expired_${TS}`
    await persistRetryRule(ruleId, 'expired')
    await persistFailedRoot(rootId, ruleId, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString())
    try {
      const before = await recordsIn(SHEET_RETRY)
      await expect(svc.retryExecution(rootId, OWNER)).resolves.toMatchObject({
        status: 409,
        code: 'RETRY_WINDOW_EXPIRED',
      })
      expect(await recordsIn(SHEET_RETRY)).toEqual(before)
      const root = await q(
        'SELECT first_retry_attempted_at FROM multitable_automation_executions WHERE id = $1',
        [rootId],
      )
      expect(root.rows[0]).toMatchObject({ first_retry_attempted_at: null })
    } finally {
      await q('DELETE FROM multitable_automation_executions WHERE id = $1', [rootId]).catch(() => {})
      await q('DELETE FROM automation_rules WHERE id = $1', [ruleId]).catch(() => {})
    }
  })

  test('V5 concurrent first retries produce one Class-A mutation and one durable claim', async () => {
    const ruleId = `atr_retry_concurrent_${TS}`
    const rootId = `axe_retry_concurrent_${TS}`
    await persistRetryRule(ruleId, 'concurrent')
    await persistFailedRoot(rootId, ruleId, new Date(Date.now() - 60_000).toISOString())
    try {
      const before = (await recordsIn(SHEET_RETRY)).length
      const outcomes = await Promise.all([
        svc.retryExecution(rootId, OWNER),
        svc.retryExecution(rootId, OWNER),
      ])
      expect(outcomes.some((outcome) => 'execution' in outcome)).toBe(true)
      expect((await recordsIn(SHEET_RETRY)).length).toBe(before + 1)
      expect(await claimRowsFor(rootId)).toHaveLength(1)
    } finally {
      await q('DELETE FROM meta_automation_action_applied WHERE root_execution_id = $1', [rootId]).catch(() => {})
      await q(
        'DELETE FROM multitable_automation_executions WHERE id = $1 OR rerun_of_execution_id = $1',
        [rootId],
      ).catch(() => {})
      await q('DELETE FROM automation_rules WHERE id = $1', [ruleId]).catch(() => {})
    }
  })

  test('§5 sweep deletes rows strictly older than the retry cutoff and preserves the boundary', async () => {
    const oldRoot = `axe_retry_sweep_old_${TS}`
    const edgeRoot = `axe_retry_sweep_edge_${TS}`
    const nowMs = Date.now()
    const cutoff = new Date(nowMs - 7 * 24 * 60 * 60 * 1000)
    await q(
      `INSERT INTO meta_automation_action_applied (kind, root_execution_id, action_key, applied_at)
       VALUES ('execution',$1,'old',$3), ('execution',$2,'edge',$4)`,
      [oldRoot, edgeRoot, new Date(cutoff.getTime() - 1), cutoff],
    )
    try {
      await expect(svc.sweepAutomationActionAppliedLedger(nowMs)).resolves.toBe(1)
      expect(await claimRowsFor(oldRoot)).toHaveLength(0)
      expect(await claimRowsFor(edgeRoot)).toHaveLength(1)
    } finally {
      await q('DELETE FROM meta_automation_action_applied WHERE root_execution_id = ANY($1::text[])', [[oldRoot, edgeRoot]])
        .catch(() => {})
    }
  })

  // G1 — create_record replay no-op ────────────────────────────────────────────────────────────────────
  test('G1 create_record: replay on the same root is a NO-OP — exactly ONE record + ONE revision + ONE claim', async () => {
    const rule = ruleFor(SHEET, { type: 'create_record', config: { sheetId: SHEET, data: { [FLD_TITLE]: 'once' } } })
    const first = await svc.executeRule(rule, { actorId: OWNER, data: {} })
    expect(first.status).toBe('success')
    expect(first.steps[0]?.alreadyApplied).toBeUndefined()
    const recordId = (first.steps[0]?.output as { recordId: string }).recordId

    // The claim committed alongside the record + revision.
    expect(await recordsIn(SHEET)).toEqual([recordId])
    expect(await revisionsOf(recordId)).toEqual([{ action: 'create', version: 1 }])
    expect(await claimRowsFor(first.id)).toHaveLength(1)

    // Replay on the SAME root → duplicate claim → the INSERT is skipped entirely.
    const second = await replay(svc, rule, { actorId: OWNER, data: {} }, first)
    expect(second.status).toBe('success')
    expect(second.steps[0]?.alreadyApplied).toBe(true) // the distinguishable skip marker
    expect((second.steps[0]?.output as { recordId?: string }).recordId).toBeUndefined()

    // Zero second row, zero second revision, still exactly one claim.
    expect(await recordsIn(SHEET)).toEqual([recordId])
    expect(await revisionsOf(recordId)).toEqual([{ action: 'create', version: 1 }])
    expect(await claimRowsFor(first.id)).toHaveLength(1)
  })

  // G2 — update_record replay no-op (fixed record) ─────────────────────────────────────────────────────
  test('G2 update_record: replay on the same root does NOT bump the version and writes NO second update revision', async () => {
    const created = await svc.executeRule(
      ruleFor(SHEET, { type: 'create_record', config: { sheetId: SHEET, data: { [FLD_TITLE]: 'v1' } } }),
      { actorId: OWNER, data: {} },
    )
    const recordId = (created.steps[0]?.output as { recordId: string }).recordId

    const updRule = ruleFor(SHEET, { type: 'update_record', config: { fields: { [FLD_TITLE]: 'v2' } } })
    const first = await svc.executeRule(updRule, { recordId, actorId: OWNER, data: {} })
    expect(first.status).toBe('success')
    expect(first.steps[0]?.alreadyApplied).toBeUndefined()
    expect((await recordRow(recordId))?.version).toBe(2)
    expect((await recordRow(recordId))?.data).toMatchObject({ [FLD_TITLE]: 'v2' })
    expect((await revisionsOf(recordId)).filter((r) => r.action === 'update')).toHaveLength(1)

    // Replay on the SAME root → duplicate → no version bump, no second update revision.
    const second = await replay(svc, updRule, { recordId, actorId: OWNER, data: {} }, first)
    expect(second.status).toBe('success')
    expect(second.steps[0]?.alreadyApplied).toBe(true)
    expect((await recordRow(recordId))?.version).toBe(2) // still v2 — no third version
    expect((await revisionsOf(recordId)).filter((r) => r.action === 'update')).toHaveLength(1)
  })

  // G3 — a crash rolls the claim back (no orphan) ──────────────────────────────────────────────────────
  test('G3 crash-atomicity: a failing revision INSERT rolls the CLAIM back too — a clean retry then SUCCEEDS', async () => {
    const rule = ruleFor(SHEET_CRASH, {
      type: 'create_record',
      config: { sheetId: SHEET_CRASH, data: { [FLD_TITLE]: 'crash-then-retry' } },
    })
    const trg = `ca_crash_rev_trg_${TS}`
    let firstRoot: string
    await injectTrigger(trg, {
      table: 'meta_record_revisions',
      timing: 'INSERT',
      when: `NEW.sheet_id = '${SHEET_CRASH}'`,
      errcode: 'P0001',
      message: 'Class-A injected revision failure',
    })
    try {
      const failed = await svc.executeRule(rule, { actorId: OWNER, data: {} })
      firstRoot = failed.id
      expect(failed.status).toBe('failed')
      expect(failed.steps[0]?.error).toMatch(/injected revision failure/)
    } finally {
      await dropTrigger(trg, 'meta_record_revisions')
    }

    // The WHOLE transaction (claim + record INSERT + revision) rolled back: no record, no revision, and —
    // the point of this golden — NO durable claim row. An orphaned claim here would make every retry
    // return 'duplicate' and permanently skip the never-applied write.
    expect(await recordsIn(SHEET_CRASH)).toEqual([])
    expect(await claimRowsFor(firstRoot!)).toHaveLength(0)

    // A clean retry on the SAME root now succeeds (claims fresh, applies once) — not skipped as a duplicate.
    const retry = await replay(svc, rule, { actorId: OWNER, data: {} }, { id: firstRoot! } as unknown as AutomationExecution)
    expect(retry.status).toBe('success')
    expect(retry.steps[0]?.alreadyApplied).toBeUndefined()
    const recordId = (retry.steps[0]?.output as { recordId: string }).recordId
    expect(await recordsIn(SHEET_CRASH)).toEqual([recordId])
    expect(await revisionsOf(recordId)).toEqual([{ action: 'create', version: 1 }])
    expect(await claimRowsFor(firstRoot!)).toHaveLength(1)
  })

  // G4 — flag OFF positive control: replay RE-APPLIES ──────────────────────────────────────────────────
  test('G4 flag-OFF control: with the claim flag OFF a replay RE-APPLIES (a second record) — the claim is what dedups', async () => {
    delete process.env[FLAG]
    try {
      const rule = ruleFor(SHEET_OFF, {
        type: 'create_record',
        config: { sheetId: SHEET_OFF, data: { [FLD_TITLE]: 'flag-off' } },
      })
      const first = await svc.executeRule(rule, { actorId: OWNER, data: {} })
      expect(first.status).toBe('success')
      expect(first.steps[0]?.alreadyApplied).toBeUndefined()

      const second = await replay(svc, rule, { actorId: OWNER, data: {} }, first)
      expect(second.status).toBe('success')
      expect(second.steps[0]?.alreadyApplied).toBeUndefined() // NOT a skip — the flag is off

      // Two distinct records exist, and no claim rows were written at all.
      expect(await recordsIn(SHEET_OFF)).toHaveLength(2)
      expect(await claimRowsFor(first.id)).toHaveLength(0)
    } finally {
      process.env[FLAG] = 'true'
    }
  })

  // G5 — LOGICAL failure (non-throwing return) after the claim also ROLLS BACK ─────────────────────────
  // The claim is the first statement in the txn, but a Class-A method can reject an action AFTER the claim
  // WITHOUT throwing a DB error — e.g. a cross-base update/delete whose write-gate PASSES (OWNER owns the
  // target base) but whose targetRecordId does not exist in the target sheet. That path must roll the claim
  // back (it now THROWS instead of `return {failed}`), else the claim would persist for an action that never
  // mutated and every retry would be skipped as a FALSE duplicate — a permanently-lost update. G3 proves the
  // DB-exception path rolls back; G5 proves the LOGICAL-failure path does too.
  for (const kind of ['update_record', 'delete_record'] as const) {
    test(`G5 ${kind}: a cross-base target-not-found (logical failure after claim) leaves NO claim → retry re-attempts`, async () => {
      const ghost = `ca_ghost_${kind}_${TS}` // a record id that does NOT exist in SHEET_XB
      const config =
        kind === 'update_record'
          ? { targetBaseId: BASE_XB, targetSheetId: SHEET_XB, targetRecordId: ghost, fields: { [FLD_TITLE]: 'x' } }
          : { targetBaseId: BASE_XB, targetSheetId: SHEET_XB, targetRecordId: ghost }
      const rule = ruleFor(SHEET, { type: kind, config })

      const first = await svc.executeRule(rule, { actorId: OWNER, data: {} })
      expect(first.status).toBe('failed')
      expect(first.steps[0]?.error).toMatch(/target record not found/)
      // THE POINT: the transaction rolled back, so the claim is NOT durable (no orphan skip).
      expect(await claimRowsFor(first.id)).toHaveLength(0)

      // A retry on the SAME root is NOT skipped as a duplicate — it re-attempts and fails the same way,
      // and STILL leaves no claim. Before the throw-to-rollback fix this returned `alreadyApplied` success.
      const retry = await replay(svc, rule, { actorId: OWNER, data: {} }, first)
      expect(retry.status).toBe('failed')
      expect(retry.steps[0]?.alreadyApplied).toBeUndefined()
      expect(retry.steps[0]?.error).toMatch(/target record not found/)
      expect(await claimRowsFor(first.id)).toHaveLength(0)
    })
  }
})
