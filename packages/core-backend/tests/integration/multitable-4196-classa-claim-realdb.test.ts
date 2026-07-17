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
  action: { type: 'create_record' | 'update_record'; config: Record<string, unknown> },
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
    ]) {
      await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [sheet, BASE, name])
      await q(`INSERT INTO meta_fields (id, sheet_id, name, type, "order") VALUES ($1,$2,'Title','string',0)`, [
        `${FLD_TITLE}_${sheet}`,
        sheet,
      ])
    }
  })

  afterAll(async () => {
    for (const sheet of [SHEET, SHEET_CRASH, SHEET_OFF]) {
      await q(
        'DELETE FROM meta_record_revisions WHERE record_id IN (SELECT id FROM meta_records WHERE sheet_id = $1)',
        [sheet],
      ).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [sheet]).catch(() => {})
    }
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    delete process.env[FLAG]
  })

  test('sentinel: DATABASE_URL is set and the flag is ON', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
    expect(process.env[FLAG]).toBe('true')
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
})
