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
import { deriveActionKey } from '../../src/multitable/automation-action-idempotency'
import { deriveTestRunScopedRoot } from '../../src/multitable/automation-execution-ledger'
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
const SHEET_TEST_RUN = `sheet_ca_test_run_${TS}`
const RULE_TEST_RUN = `atr_ca_test_run_${TS}`
const RULE_TEST_RUN_2 = `atr_ca_test_run_2_${TS}`
const RULE_TEST_RUN_WAIT = `atr_ca_test_run_wait_${TS}`
// G5 cross-base: a SECOND base OWNER owns (so the write-gate grants base-write) — the not-found target lives here.
const BASE_XB = `base_ca_xb_${TS}`
const SHEET_XB = `sheet_ca_xb_${TS}`
const FLD_TITLE = `fld_ca_title_${TS}`
const TEST_RUN_ACTION_CONFIG = { sheetId: SHEET_TEST_RUN, data: { [FLD_TITLE]: 'real-fire' } }
const testRunRoots = new Set<string>()

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function testRunRoot(ruleId: string, operationId: string): string {
  const root = deriveTestRunScopedRoot({ actorId: OWNER, ruleId, testRunOperationId: operationId })
  testRunRoots.add(root)
  return root
}

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
      [SHEET_TEST_RUN, 'Class-A Test-Run Sheet'],
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
    for (const ruleId of [RULE_TEST_RUN, RULE_TEST_RUN_2]) {
      await q(
        `INSERT INTO automation_rules
          (id, sheet_id, name, trigger_type, action_type, action_config, enabled, created_by)
         VALUES ($1,$2,'real-fire class-a','record.created','create_record',$3::jsonb,TRUE,$4)`,
        [ruleId, SHEET_TEST_RUN, JSON.stringify(TEST_RUN_ACTION_CONFIG), OWNER],
      )
    }
    await q(
      `INSERT INTO automation_rules
        (id, sheet_id, name, trigger_type, action_type, action_config, actions, enabled, created_by, execution_mode)
       VALUES ($1,$2,'real-fire wait class-a','record.created','wait_for_callback','{}'::jsonb,$3::jsonb,TRUE,$4,'workflow_job_v1')`,
      [
        RULE_TEST_RUN_WAIT,
        SHEET_TEST_RUN,
        JSON.stringify([
          { type: 'wait_for_callback', config: {} },
          { type: 'create_record', config: TEST_RUN_ACTION_CONFIG },
        ]),
        OWNER,
      ],
    )
  })

  afterAll(async () => {
    const ruleIds = [RULE_TEST_RUN, RULE_TEST_RUN_2, RULE_TEST_RUN_WAIT]
    const executions = await q(
      `SELECT id FROM multitable_automation_executions
        WHERE rule_id = ANY($1::text[]) OR rule_id LIKE $2`,
      [ruleIds, `atr_ca_${TS}_%`],
    )
    const executionIds = executions.rows.map((row) => row.id as string)
    const ledgerRoots = [...new Set([...executionIds, ...testRunRoots])]
    if (ledgerRoots.length > 0) {
      await q('DELETE FROM meta_automation_action_applied WHERE root_execution_id = ANY($1::text[])', [ledgerRoots]).catch(() => {})
      await q('DELETE FROM meta_automation_outbound_intent WHERE root_execution_id = ANY($1::text[])', [ledgerRoots]).catch(() => {})
    }
    if (executionIds.length > 0) {
      await q('DELETE FROM multitable_automation_suspensions WHERE execution_id = ANY($1::text[])', [executionIds]).catch(() => {})
      await q('DELETE FROM multitable_automation_approval_bridges WHERE execution_id = ANY($1::text[])', [executionIds]).catch(() => {})
      await q('DELETE FROM multitable_automation_jobs WHERE execution_id = ANY($1::text[])', [executionIds]).catch(() => {})
      await q('DELETE FROM multitable_automation_executions WHERE id = ANY($1::text[])', [executionIds]).catch(() => {})
    }
    await q('DELETE FROM automation_rules WHERE id = ANY($1::text[])', [ruleIds]).catch(() => {})
    for (const sheet of [SHEET, SHEET_CRASH, SHEET_OFF, SHEET_TEST_RUN]) {
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

  test('migration compatibility: legacy continuation rows default to execution identity', async () => {
    const suspensionId = `asp_ca_legacy_${TS}`
    const bridgeId = `aab_ca_legacy_${TS}`
    try {
      await q(
        `INSERT INTO multitable_automation_suspensions
          (id, execution_id, rule_id, step_index, resume_token, reason, action_fingerprint, status)
         VALUES ($1,$2,$3,0,$4,'external_event',$5::jsonb,'pending')`,
        [suspensionId, `axe_ca_legacy_${TS}`, `atr_ca_legacy_${TS}`, `token_ca_legacy_${TS}`, JSON.stringify({ count: 0, hash: 'legacy' })],
      )
      await q(
        `INSERT INTO multitable_automation_approval_bridges
          (id, execution_id, root_execution_id, rule_id, step_index, approval_template_id,
           idempotency_key, status, action_fingerprint)
         VALUES ($1,$2,$3,$4,0,$5,$6,'creating',$7::jsonb)`,
        [
          bridgeId,
          `axe_ca_legacy_${TS}`,
          `axe_ca_legacy_root_${TS}`,
          `atr_ca_legacy_${TS}`,
          `tpl_ca_legacy_${TS}`,
          `idem_ca_legacy_${TS}`,
          JSON.stringify({ count: 0, hash: 'legacy' }),
        ],
      )
      expect((await q(
        'SELECT root_execution_id, ledger_kind FROM multitable_automation_suspensions WHERE id = $1',
        [suspensionId],
      )).rows).toEqual([{ root_execution_id: null, ledger_kind: 'execution' }])
      expect((await q(
        'SELECT ledger_kind FROM multitable_automation_approval_bridges WHERE id = $1',
        [bridgeId],
      )).rows).toEqual([{ ledger_kind: 'execution' }])
    } finally {
      await q('DELETE FROM multitable_automation_suspensions WHERE id = $1', [suspensionId]).catch(() => {})
      await q('DELETE FROM multitable_automation_approval_bridges WHERE id = $1', [bridgeId]).catch(() => {})
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

  test('V2b real_fire: same operation key dedups sequentially and concurrently; a new key reapplies', async () => {
    const run = (testRunOperationId: string) => {
      testRunRoot(RULE_TEST_RUN, testRunOperationId)
      return svc.testRun(RULE_TEST_RUN, SHEET_TEST_RUN, {
        mode: 'real_fire',
        actorId: OWNER,
        testRunOperationId,
        confirmSideEffects: true,
      })
    }

    const sequentialKey = `seq_${TS}`
    const first = await run(sequentialKey)
    const duplicate = await run(sequentialKey)
    expect(first.steps[0]?.alreadyApplied).toBeUndefined()
    expect(duplicate.steps[0]?.alreadyApplied).toBe(true)
    expect(await recordsIn(SHEET_TEST_RUN)).toHaveLength(1)

    const concurrentKey = `concurrent_${TS}`
    const concurrent = await Promise.all([run(concurrentKey), run(concurrentKey)])
    expect(concurrent.filter((execution) => execution.steps[0]?.alreadyApplied === true)).toHaveLength(1)
    expect(concurrent.filter((execution) => execution.steps[0]?.alreadyApplied !== true)).toHaveLength(1)
    expect(await recordsIn(SHEET_TEST_RUN)).toHaveLength(2)

    await run(`fresh_${TS}`)
    expect(await recordsIn(SHEET_TEST_RUN)).toHaveLength(3)

    for (const operationId of [sequentialKey, concurrentKey, `fresh_${TS}`]) {
      const root = testRunRoot(RULE_TEST_RUN, operationId)
      const rows = await q(
        `SELECT kind, count(*)::int AS count
           FROM meta_automation_action_applied
          WHERE root_execution_id = $1
          GROUP BY kind`,
        [root],
      )
      expect(rows.rows).toEqual([{ kind: 'test_run', count: 1 }])
    }
  })

  test('V2c real_fire: rule scope and kind keep caller keys outside the execution namespace', async () => {
    const countBefore = (await recordsIn(SHEET_TEST_RUN)).length
    const sharedOperationId = `same_key_${TS}`
    testRunRoot(RULE_TEST_RUN, sharedOperationId)
    await svc.testRun(RULE_TEST_RUN, SHEET_TEST_RUN, {
      mode: 'real_fire',
      actorId: OWNER,
      testRunOperationId: sharedOperationId,
      confirmSideEffects: true,
    })
    testRunRoot(RULE_TEST_RUN_2, sharedOperationId)
    await svc.testRun(RULE_TEST_RUN_2, SHEET_TEST_RUN, {
      mode: 'real_fire',
      actorId: OWNER,
      testRunOperationId: sharedOperationId,
      confirmSideEffects: true,
    })
    expect(await recordsIn(SHEET_TEST_RUN)).toHaveLength(countBefore + 2)

    const firstRoot = testRunRoot(RULE_TEST_RUN, sharedOperationId)
    const secondRoot = testRunRoot(RULE_TEST_RUN_2, sharedOperationId)
    expect(firstRoot).not.toBe(secondRoot)

    const craftedExecutionRoot = `axe_collision_${TS}`
    const actionKey = deriveActionKey({
      structuralPath: '0',
      actionType: 'create_record',
      canonicalConfig: TEST_RUN_ACTION_CONFIG,
    })
    await q(
      `INSERT INTO meta_automation_action_applied (kind, root_execution_id, action_key, action_type)
       VALUES ('execution',$1,$2,'create_record')`,
      [craftedExecutionRoot, actionKey],
    )
    testRunRoots.add(craftedExecutionRoot)
    const executionClaimBefore = (await q(
      `SELECT kind, root_execution_id, action_key, action_type, applied_at
         FROM meta_automation_action_applied
        WHERE kind = 'execution' AND root_execution_id = $1 AND action_key = $2`,
      [craftedExecutionRoot, actionKey],
    )).rows[0]
    testRunRoot(RULE_TEST_RUN, craftedExecutionRoot)
    await svc.testRun(RULE_TEST_RUN, SHEET_TEST_RUN, {
      mode: 'real_fire',
      actorId: OWNER,
      testRunOperationId: craftedExecutionRoot,
      confirmSideEffects: true,
    })
    expect(await recordsIn(SHEET_TEST_RUN)).toHaveLength(countBefore + 3)

    const derivedRoot = testRunRoot(RULE_TEST_RUN, craftedExecutionRoot)
    const claims = await q(
      `SELECT kind, root_execution_id, action_key, action_type
         FROM meta_automation_action_applied
        WHERE (kind = 'execution' AND root_execution_id = $1)
           OR (kind = 'test_run' AND root_execution_id = $2)
        ORDER BY kind`,
      [craftedExecutionRoot, derivedRoot],
    )
    expect(claims.rows).toEqual([
      { kind: 'execution', root_execution_id: craftedExecutionRoot, action_key: actionKey, action_type: 'create_record' },
      { kind: 'test_run', root_execution_id: derivedRoot, action_key: actionKey, action_type: 'create_record' },
    ])
    expect((await q(
      `SELECT kind, root_execution_id, action_key, action_type, applied_at
         FROM meta_automation_action_applied
        WHERE kind = 'execution' AND root_execution_id = $1 AND action_key = $2`,
      [craftedExecutionRoot, actionKey],
    )).rows[0]).toEqual(executionClaimBefore)
    const duplicate = await q(
      `INSERT INTO meta_automation_action_applied (kind, root_execution_id, action_key, action_type)
       VALUES ('execution',$1,$2,'create_record')
       ON CONFLICT (kind, root_execution_id, action_key) DO NOTHING`,
      [craftedExecutionRoot, actionKey],
    )
    expect(duplicate.rowCount).toBe(0)
  })

  test('V2d real_fire preserves the test-run root and ledger kind across wait/resume', async () => {
    const operationId = `wait_${TS}`
    const root = testRunRoot(RULE_TEST_RUN_WAIT, operationId)
    const run = () => svc.testRun(RULE_TEST_RUN_WAIT, SHEET_TEST_RUN, {
      mode: 'real_fire',
      actorId: OWNER,
      testRunOperationId: operationId,
      confirmSideEffects: true,
      sampleRecord: { recordId: '', data: {} },
    })

    const first = await run()
    expect(first.status).toBe('running')
    const firstSuspension = await q(
      `SELECT resume_token, root_execution_id, ledger_kind
         FROM multitable_automation_suspensions
        WHERE execution_id = $1`,
      [first.id],
    )
    expect(firstSuspension.rows).toEqual([expect.objectContaining({
      root_execution_id: root,
      ledger_kind: 'test_run',
    })])
    const firstResume = await svc.resumeExecution(firstSuspension.rows[0].resume_token, OWNER)
    expect('execution' in firstResume).toBe(true)
    if (!('execution' in firstResume)) throw new Error(firstResume.code)
    expect(firstResume.execution.status).toBe('success')
    expect(firstResume.execution.steps.map((step) => [step.actionType, step.alreadyApplied])).toEqual([
      ['wait_for_callback', undefined],
      ['create_record', undefined],
    ])
    const countAfterFirst = (await recordsIn(SHEET_TEST_RUN)).length

    const duplicate = await run()
    const duplicateSuspension = await q(
      'SELECT resume_token FROM multitable_automation_suspensions WHERE execution_id = $1',
      [duplicate.id],
    )
    const duplicateResume = await svc.resumeExecution(duplicateSuspension.rows[0].resume_token, OWNER)
    expect('execution' in duplicateResume).toBe(true)
    if (!('execution' in duplicateResume)) throw new Error(duplicateResume.code)
    expect(duplicateResume.execution.steps.at(-1)).toMatchObject({
      actionType: 'create_record',
      alreadyApplied: true,
    })
    expect(await recordsIn(SHEET_TEST_RUN)).toHaveLength(countAfterFirst)
    expect((await q(
      `SELECT kind, root_execution_id, action_type, count(*)::int AS count
         FROM meta_automation_action_applied
        WHERE root_execution_id = $1
        GROUP BY kind, root_execution_id, action_type`,
      [root],
    )).rows).toEqual([{
      kind: 'test_run',
      root_execution_id: root,
      action_type: 'create_record',
      count: 1,
    }])
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
