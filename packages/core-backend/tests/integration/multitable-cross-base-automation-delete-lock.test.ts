/**
 * Phase C2 automation slice — governed cross-base record DELETE + cross-base record LOCK (real DB).
 *
 * Sibling of `multitable-cross-base-automation-write.test.ts`. C2 extends the same cross-base write gate
 * (`evaluateCrossBaseWrite`: trigger-actor base-write authority + claim==truth + shared per-target-base
 * quota bucket) to two NEW destructive/governance sinks:
 *
 *  - C2a `delete_record`: a delete is a WRITE for abuse-accounting. A CROSS-BASE delete demands full
 *    explicit addressing (`targetBaseId + targetSheetId + targetRecordId`), claim==truth (the record
 *    actually lives in the target sheet), and honors the TARGET record's lock (you cannot delete a record
 *    locked by someone you can't unlock). The delete is a HARD delete — `meta_records` has no `deleted_at`
 *    column and both same-base sinks (`records.ts`, `record-service.ts`) hard-`DELETE`; so this suite
 *    asserts the row is GONE, not a `deleted_at` flag.
 *  - C2b `lock_record`: locking another base's record is a denial-of-edit on foreign data, gated by the
 *    SAME primitive (base:write, not base:admin). Same-base lock/unlock is byte-identical to pre-C2 (the
 *    gate's same-base fast-path), so this suite re-proves the same-base path is unchanged.
 *
 * Drives the REAL AutomationExecutor with a real-DB queryFn (the executor is the write chokepoint — this
 * proves the gate stands alone even if rule-save validation were bypassed). The structural write-guard
 * (`multitable-cross-base-write-guard.guard.test.ts`) separately proves the new DELETE sink + the relabeled
 * lock UPDATEs are enrolled in the gate by construction.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { MemoryRateLimitStore } from '../../src/middleware/rate-limiter'
import { poolManager } from '../../src/integration/db/connection-pool'
import { EventBus } from '../../src/integration/events/event-bus'
import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationRule,
  type CrossBaseWriteQuotaConfig,
} from '../../src/multitable/automation-executor'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()

// Actors (mirrors the write suite).
const OWNER = `u_dl_owner_${TS}` // owns BASE_A (trigger) AND BASE_B (target) → base-write on both (owner)
const ADMIN_CODE = `u_dl_admincode_${TS}` // holds multitable:base:admin grant → base-write on any base
const NO_WRITE = `u_dl_nowrite_${TS}` // owns nothing, no codes → NO base-write on BASE_B

// Bases.
const BASE_A = `base_dl_a_${TS}` // trigger base (source)
const BASE_B = `base_dl_b_${TS}` // target base (cross-base delete/lock sink)

// Sheets.
const SHEET_A = `sheet_dl_a_${TS}` // trigger sheet (BASE_A)
const SHEET_B = `sheet_dl_b_${TS}` // cross-base target sheet (BASE_B)

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

// Default-store executor: a FRESH private high-limit quota store per call so the process-global singleton
// (consumed by sibling cross-base suites in the same process at the generous 60/min default) can never
// perturb these non-quota assertions, and vice-versa. The quota-sharing test below injects its own LOW
// limit deliberately.
function makeExecutor(quota?: CrossBaseWriteQuotaConfig): { executor: AutomationExecutor; eventBus: EventBus } {
  const eventBus = new EventBus()
  const deps: AutomationDeps = {
    eventBus,
    queryFn: (sql: string, params?: unknown[]) => q(sql, params),
    crossBaseWriteQuota: quota ?? { limit: 1000, windowMs: 60_000, store: new MemoryRateLimitStore() },
  }
  return { executor: new AutomationExecutor(deps), eventBus }
}

function ruleWith(action: { type: string; config: Record<string, unknown> }, createdBy: string): AutomationRule {
  return {
    id: `axr_dl_${TS}_${Math.random().toString(36).slice(2, 8)}`,
    name: 'DL rule',
    sheetId: SHEET_A,
    trigger: { type: 'record.created', config: {} },
    actions: [action as never],
    enabled: true,
    createdBy,
    createdAt: new Date().toISOString(),
  } as unknown as AutomationRule
}

const countRecords = async (sheetId: string): Promise<number> => {
  const r = await q('SELECT COUNT(*)::int AS n FROM meta_records WHERE sheet_id = $1', [sheetId])
  return (r.rows as Array<{ n: number }>)[0]?.n ?? 0
}
const recordExists = async (recordId: string): Promise<boolean> => {
  const r = await q('SELECT 1 FROM meta_records WHERE id = $1', [recordId])
  return Boolean((r.rows as unknown[])[0])
}
const recordLocked = async (recordId: string): Promise<boolean | undefined> => {
  const r = await q('SELECT locked FROM meta_records WHERE id = $1', [recordId])
  const row = (r.rows as Array<{ locked: unknown }>)[0]
  return row ? Boolean(row.locked) : undefined
}
const insertRecord = async (recordId: string, sheetId: string): Promise<void> => {
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
    recordId,
    sheetId,
    JSON.stringify({ v: 'x' }),
  ])
}

describeIfDatabase('Phase C2 automation — governed cross-base DELETE + LOCK (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3)', [BASE_A, 'DL Base A', OWNER])
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3)', [BASE_B, 'DL Base B', OWNER])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_A, BASE_A, 'Trigger A'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_B, BASE_B, 'Target B'])

    await q(
      `INSERT INTO permissions (code, name, description)
       VALUES ('multitable:base:admin', 'Base Admin', 'cross-base C2 delete/lock tests')
       ON CONFLICT (code) DO NOTHING`,
    )
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET is_active = TRUE`,
      [ADMIN_CODE, `${ADMIN_CODE}@example.test`],
    )
    await q(
      `INSERT INTO user_permissions (user_id, permission_code)
       VALUES ($1, 'multitable:base:admin') ON CONFLICT DO NOTHING`,
      [ADMIN_CODE],
    )
  })

  afterAll(async () => {
    const sheets = [SHEET_A, SHEET_B]
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [sheets]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_A, BASE_B]]).catch(() => {})
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[ADMIN_CODE]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // ════════════════════════ C2a — cross-base DELETE ════════════════════════

  // ── DL-1: cross-base delete by an authorized actor → target row HARD-deleted ──
  test('DL-1: cross-base delete_record with full addressing + trigger-actor base-write → target record GONE', async () => {
    const { executor } = makeExecutor()
    const recId = `rec_dl1_${TS}`
    await insertRecord(recId, SHEET_B)
    try {
      const rule = ruleWith(
        { type: 'delete_record', config: { targetBaseId: BASE_B, targetSheetId: SHEET_B, targetRecordId: recId } },
        OWNER,
      )
      const exec = await executor.execute(rule, { recordId: 'trigger_rec', sheetId: SHEET_A, actorId: OWNER, data: {} })
      expect(exec.steps[0]?.status).toBe('success')
      expect(await recordExists(recId)).toBe(false) // HARD delete: row is gone (no deleted_at)
    } finally {
      await q('DELETE FROM meta_records WHERE id = $1', [recId]).catch(() => {})
    }
  })

  // ── DL-1 (admin-code path) ──
  test('DL-1 (admin-code): cross-base delete with trigger-actor holding multitable:base:admin → target GONE', async () => {
    const { executor } = makeExecutor()
    const recId = `rec_dl1admin_${TS}`
    await insertRecord(recId, SHEET_B)
    try {
      const rule = ruleWith(
        { type: 'delete_record', config: { targetBaseId: BASE_B, targetSheetId: SHEET_B, targetRecordId: recId } },
        OWNER,
      )
      const exec = await executor.execute(rule, { recordId: 'trigger_rec', sheetId: SHEET_A, actorId: ADMIN_CODE, data: {} })
      expect(exec.steps[0]?.status).toBe('success')
      expect(await recordExists(recId)).toBe(false)
    } finally {
      await q('DELETE FROM meta_records WHERE id = $1', [recId]).catch(() => {})
    }
  })

  // ── DL-1c: cross-base delete also cleans up the foreign_record_id link side ──
  // The FK cascade only covers the record_id side; the executor (mirroring the same-base sinks) deletes
  // BOTH sides explicitly. A link where the deleted record is the FOREIGN endpoint must be gone too.
  test('DL-1c: cross-base delete clears links on the foreign_record_id side (no dangling links)', async () => {
    const { executor } = makeExecutor()
    const victim = `rec_dl1c_victim_${TS}` // the record being deleted (in SHEET_B)
    const other = `rec_dl1c_other_${TS}` // an unrelated live record (in SHEET_A) that links TO the victim
    const fieldId = `fld_dl1c_${TS}`
    const linkId = `lnk_dl1c_${TS}`
    await insertRecord(victim, SHEET_B)
    await insertRecord(other, SHEET_A)
    // meta_links.field_id has an FK to meta_fields — seed a real link field on SHEET_A.
    await q(
      `INSERT INTO meta_fields (id, sheet_id, name, type, "order") VALUES ($1, $2, $3, 'link', 0)`,
      [fieldId, SHEET_A, 'DL1c link'],
    )
    // other → victim: victim is the FOREIGN endpoint (foreign_record_id) — the side the FK cascade does NOT
    // cover (only record_id cascades), so the executor's explicit `OR foreign_record_id` cleanup must remove it.
    await q(
      `INSERT INTO meta_links (id, record_id, field_id, foreign_record_id) VALUES ($1, $2, $3, $4)`,
      [linkId, other, fieldId, victim],
    )
    try {
      const rule = ruleWith(
        { type: 'delete_record', config: { targetBaseId: BASE_B, targetSheetId: SHEET_B, targetRecordId: victim } },
        OWNER,
      )
      const exec = await executor.execute(rule, { recordId: 'trigger_rec', sheetId: SHEET_A, actorId: OWNER, data: {} })
      expect(exec.steps[0]?.status).toBe('success')
      expect(await recordExists(victim)).toBe(false)
      const links = await q('SELECT 1 FROM meta_links WHERE id = $1', [linkId])
      expect((links.rows as unknown[]).length).toBe(0) // foreign-side link cleaned up (no dangling link)
    } finally {
      await q('DELETE FROM meta_links WHERE id = $1', [linkId]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE id = $1', [fieldId]).catch(() => {})
      await q('DELETE FROM meta_records WHERE id = ANY($1::text[])', [[victim, other]]).catch(() => {})
    }
  })

  // ── DL-1b: cross-base delete, NO base-write → blocked, target SURVIVES ──
  test('DL-1b: cross-base delete where trigger actor lacks target base-write → step failed, target survives', async () => {
    const { executor } = makeExecutor()
    const recId = `rec_dl1b_${TS}`
    await insertRecord(recId, SHEET_B)
    try {
      const rule = ruleWith(
        { type: 'delete_record', config: { targetBaseId: BASE_B, targetSheetId: SHEET_B, targetRecordId: recId } },
        OWNER, // rule owner DOES have write — but the ratified actor is the TRIGGER actor, not the owner
      )
      const exec = await executor.execute(rule, { recordId: 'trigger_rec', sheetId: SHEET_A, actorId: NO_WRITE, data: {} })
      expect(exec.steps[0]?.status).toBe('failed')
      expect(await recordExists(recId)).toBe(true) // fail-closed: NOT deleted
    } finally {
      await q('DELETE FROM meta_records WHERE id = $1', [recId]).catch(() => {})
    }
  })

  // ── DL-1d: cross-base delete of a LOCKED target the actor can't unlock → blocked ──
  test('DL-1d: cross-base delete of a target locked by someone else is blocked even WITH base-write', async () => {
    const { executor } = makeExecutor()
    const recId = `rec_dl1d_${TS}`
    await q(
      'INSERT INTO meta_records (id, sheet_id, data, version, locked, locked_by, created_by) VALUES ($1,$2,$3::jsonb,1,true,$4,$5)',
      [recId, SHEET_B, JSON.stringify({ v: 'x' }), `someone_else_${TS}`, `someone_else_${TS}`],
    )
    try {
      const rule = ruleWith(
        { type: 'delete_record', config: { targetBaseId: BASE_B, targetSheetId: SHEET_B, targetRecordId: recId } },
        OWNER,
      )
      // OWNER has base-write on BASE_B — but the TARGET record is locked by someone else → blocked.
      const exec = await executor.execute(rule, { recordId: 'trigger_rec', sheetId: SHEET_A, actorId: OWNER, data: {} })
      expect(exec.steps[0]?.status).toBe('failed')
      expect(await recordExists(recId)).toBe(true) // lock priority: NOT deleted
    } finally {
      await q('DELETE FROM meta_records WHERE id = $1', [recId]).catch(() => {})
    }
  })

  // ── DL-1e: cross-base (target sheet IS foreign) but missing targetRecordId → fail-closed on the triple ──
  // A delete whose resolved target sheet IS in another base (so the gate classifies it cross-base) but which
  // OMITS targetRecordId must fail on the explicit-triple requirement — the executor is the last line of
  // defense even if rule-save validation were bypassed. (A bare targetBaseId with the target sheet defaulting
  // to the trigger sheet resolves SAME-BASE and runs on the trigger record — that's the update template's
  // behavior and is NOT this case.)
  test('DL-1e: cross-base delete with targetSheetId in a foreign base but NO targetRecordId → step failed (triple)', async () => {
    const { executor } = makeExecutor()
    const survivor = `rec_dl1e_${TS}`
    await insertRecord(survivor, SHEET_B) // a record in the TARGET sheet that must NOT be collaterally deleted
    try {
      const rule = ruleWith({ type: 'delete_record', config: { targetBaseId: BASE_B, targetSheetId: SHEET_B } }, OWNER)
      const exec = await executor.execute(rule, { recordId: 'trigger_rec', sheetId: SHEET_A, actorId: OWNER, data: {} })
      expect(exec.steps[0]?.status).toBe('failed')
      expect(exec.steps[0]?.error ?? '').toMatch(/requires targetBaseId \+ targetSheetId \+ targetRecordId/)
      expect(await recordExists(survivor)).toBe(true) // nothing deleted
    } finally {
      await q('DELETE FROM meta_records WHERE id = $1', [survivor]).catch(() => {})
    }
  })

  // ── DL-1f: claim==truth for the record — targetRecordId ∉ targetSheetId → fail-closed ──
  test('DL-1f: cross-base delete where targetRecordId is not in targetSheetId → step failed (no silent no-op)', async () => {
    const { executor } = makeExecutor()
    const before = await countRecords(SHEET_B)
    const rule = ruleWith(
      { type: 'delete_record', config: { targetBaseId: BASE_B, targetSheetId: SHEET_B, targetRecordId: `rec_dl1f_missing_${TS}` } },
      OWNER,
    )
    const exec = await executor.execute(rule, { recordId: 'trigger_rec', sheetId: SHEET_A, actorId: OWNER, data: {} })
    expect(exec.steps[0]?.status).toBe('failed')
    expect(await countRecords(SHEET_B)).toBe(before) // nothing changed
  })

  // ── DL-1g: null actor (scheduled trigger) cross-base delete → fail-closed, NO delete ──
  test('DL-1g: cross-base delete with null actorId (scheduled trigger) → fail-closed, target survives', async () => {
    const { executor } = makeExecutor()
    const recId = `rec_dl1g_${TS}`
    await insertRecord(recId, SHEET_B)
    try {
      const rule = ruleWith(
        { type: 'delete_record', config: { targetBaseId: BASE_B, targetSheetId: SHEET_B, targetRecordId: recId } },
        OWNER, // rule owner has write — but actorId is null and there is NO owner fallback
      )
      const exec = await executor.execute(
        rule,
        { recordId: 'trigger_rec', sheetId: SHEET_A, actorId: null, data: {}, _triggeredBy: 'schedule' } as never,
      )
      expect(exec.steps[0]?.status).toBe('failed')
      expect(await recordExists(recId)).toBe(true) // fail-closed: no delete
    } finally {
      await q('DELETE FROM meta_records WHERE id = $1', [recId]).catch(() => {})
    }
  })

  // ── DL-3: same-base delete → works (no gate; deletes the trigger record), even for a no-write actor ──
  test('DL-3: same-base delete_record (no target addressing) deletes the trigger record', async () => {
    const { executor } = makeExecutor()
    const recId = `rec_dl3_${TS}`
    await insertRecord(recId, SHEET_A)
    try {
      // NO_WRITE has no base-write anywhere — but same-base must NOT hit the gate at all.
      const rule = ruleWith({ type: 'delete_record', config: {} }, OWNER)
      const exec = await executor.execute(rule, { recordId: recId, sheetId: SHEET_A, actorId: NO_WRITE, data: {} })
      expect(exec.steps[0]?.status).toBe('success')
      expect(await recordExists(recId)).toBe(false)
    } finally {
      await q('DELETE FROM meta_records WHERE id = $1', [recId]).catch(() => {})
    }
  })

  // ── DL-Q: a cross-base DELETE shares the per-target-base write QUOTA bucket with cross-base WRITEs ──
  // Proves a base cannot dodge the limit by mixing deletes and creates: with limit=2, a create + a delete
  // exhaust the bucket and the 3rd cross-base op (a create) is rejected (quota), no row.
  test('DL-Q: cross-base delete + create share the per-target-base quota bucket (limit=2 → 3rd rejected)', async () => {
    const { executor } = makeExecutor({ limit: 2, windowMs: 60_000, store: new MemoryRateLimitStore() })
    const delRec = `rec_dlq_del_${TS}`
    const rowWith = async (v: string): Promise<boolean> => {
      const r = await q("SELECT 1 FROM meta_records WHERE sheet_id = $1 AND data->>'v' = $2", [SHEET_B, v])
      return Boolean((r.rows as unknown[])[0])
    }
    await insertRecord(delRec, SHEET_B)
    try {
      // op 1: a cross-base CREATE → slot 1.
      const c1 = await executor.execute(
        ruleWith({ type: 'create_record', config: { sheetId: SHEET_B, targetBaseId: BASE_B, data: { v: 'dlq1' } } }, OWNER),
        { recordId: '', sheetId: SHEET_A, actorId: OWNER, data: {} },
      )
      expect(c1.steps[0]?.status).toBe('success')

      // op 2: a cross-base DELETE → slot 2 (same bucket).
      const d1 = await executor.execute(
        ruleWith({ type: 'delete_record', config: { targetBaseId: BASE_B, targetSheetId: SHEET_B, targetRecordId: delRec } }, OWNER),
        { recordId: 'trigger_rec', sheetId: SHEET_A, actorId: OWNER, data: {} },
      )
      expect(d1.steps[0]?.status).toBe('success')
      expect(await recordExists(delRec)).toBe(false) // the delete consumed its slot AND deleted

      // op 3: another cross-base CREATE → over the limit of 2 → rejected (quota), NO row.
      const c2 = await executor.execute(
        ruleWith({ type: 'create_record', config: { sheetId: SHEET_B, targetBaseId: BASE_B, data: { v: 'dlq-over' } } }, OWNER),
        { recordId: '', sheetId: SHEET_A, actorId: OWNER, data: {} },
      )
      expect(c2.steps[0]?.status).toBe('failed')
      expect(c2.steps[0]?.error ?? '').toMatch(/quota/i)
      // The first create (dlq1) landed and survives; the over-limit create (dlq-over) was rejected → no row.
      expect(await rowWith('dlq1')).toBe(true)
      expect(await rowWith('dlq-over')).toBe(false)
    } finally {
      await q('DELETE FROM meta_records WHERE id = $1', [delRec]).catch(() => {})
      await q("DELETE FROM meta_records WHERE sheet_id = $1 AND data->>'v' IN ('dlq1','dlq-over')", [SHEET_B]).catch(() => {})
    }
  })

  // ════════════════════════ C2b — cross-base LOCK ═════════════════════════

  // ── LK-1: cross-base lock by a base-write actor → target record locked ──
  test('LK-1: cross-base lock_record with full addressing + trigger-actor base-write → target record LOCKED', async () => {
    const { executor } = makeExecutor()
    const recId = `rec_lk1_${TS}`
    await insertRecord(recId, SHEET_B)
    try {
      const rule = ruleWith(
        { type: 'lock_record', config: { locked: true, targetBaseId: BASE_B, targetSheetId: SHEET_B, targetRecordId: recId } },
        OWNER,
      )
      const exec = await executor.execute(rule, { recordId: 'trigger_rec', sheetId: SHEET_A, actorId: OWNER, data: {} })
      expect(exec.steps[0]?.status).toBe('success')
      expect(await recordLocked(recId)).toBe(true) // target locked
    } finally {
      await q('DELETE FROM meta_records WHERE id = $1', [recId]).catch(() => {})
    }
  })

  // ── LK-1b: cross-base lock by a NON-writer → blocked, target NOT locked ──
  test('LK-1b: cross-base lock where trigger actor lacks target base-write → step failed, target NOT locked', async () => {
    const { executor } = makeExecutor()
    const recId = `rec_lk1b_${TS}`
    await insertRecord(recId, SHEET_B)
    try {
      const rule = ruleWith(
        { type: 'lock_record', config: { locked: true, targetBaseId: BASE_B, targetSheetId: SHEET_B, targetRecordId: recId } },
        OWNER, // owner has write — but the TRIGGER actor (NO_WRITE) does not
      )
      const exec = await executor.execute(rule, { recordId: 'trigger_rec', sheetId: SHEET_A, actorId: NO_WRITE, data: {} })
      expect(exec.steps[0]?.status).toBe('failed')
      expect(await recordLocked(recId)).toBe(false) // fail-closed: not locked
    } finally {
      await q('DELETE FROM meta_records WHERE id = $1', [recId]).catch(() => {})
    }
  })

  // ── LK-1e: cross-base lock (target sheet IS foreign) but missing targetRecordId → fail-closed on triple ──
  test('LK-1e: cross-base lock with targetSheetId in a foreign base but NO targetRecordId → step failed (triple)', async () => {
    const { executor } = makeExecutor()
    const survivor = `rec_lk1e_${TS}`
    await insertRecord(survivor, SHEET_B) // target-sheet record that must NOT be collaterally locked
    try {
      const rule = ruleWith({ type: 'lock_record', config: { locked: true, targetBaseId: BASE_B, targetSheetId: SHEET_B } }, OWNER)
      const exec = await executor.execute(rule, { recordId: 'trigger_rec', sheetId: SHEET_A, actorId: OWNER, data: {} })
      expect(exec.steps[0]?.status).toBe('failed')
      expect(exec.steps[0]?.error ?? '').toMatch(/requires targetBaseId \+ targetSheetId \+ targetRecordId/)
      expect(await recordLocked(survivor)).toBe(false) // nothing locked
    } finally {
      await q('DELETE FROM meta_records WHERE id = $1', [survivor]).catch(() => {})
    }
  })

  // ── LK-1f: cross-base lock where targetRecordId ∉ targetSheetId → fail-closed ──
  test('LK-1f: cross-base lock where targetRecordId is not in targetSheetId → step failed (claim==truth)', async () => {
    const { executor } = makeExecutor()
    const rule = ruleWith(
      { type: 'lock_record', config: { locked: true, targetBaseId: BASE_B, targetSheetId: SHEET_B, targetRecordId: `rec_lk1f_missing_${TS}` } },
      OWNER,
    )
    const exec = await executor.execute(rule, { recordId: 'trigger_rec', sheetId: SHEET_A, actorId: OWNER, data: {} })
    expect(exec.steps[0]?.status).toBe('failed')
  })

  // ── LK-3: same-base lock → UNCHANGED (locks the trigger record), even for a no-write actor ──
  // Back-compat keystone: a lock_record with NO targetBaseId must behave EXACTLY as pre-C2 (gate fast-path).
  test('LK-3: same-base lock_record (no target addressing) locks the trigger record (back-compat)', async () => {
    const { executor } = makeExecutor()
    const recId = `rec_lk3_${TS}`
    await insertRecord(recId, SHEET_A)
    try {
      // NO_WRITE has no base-write — same-base lock must NOT hit the gate at all (unchanged behavior).
      const rule = ruleWith({ type: 'lock_record', config: { locked: true } }, OWNER)
      const exec = await executor.execute(rule, { recordId: recId, sheetId: SHEET_A, actorId: NO_WRITE, data: {} })
      expect(exec.steps[0]?.status).toBe('success')
      expect(await recordLocked(recId)).toBe(true)
    } finally {
      await q('DELETE FROM meta_records WHERE id = $1', [recId]).catch(() => {})
    }
  })

  // ── LK-3b: same-base UNLOCK → UNCHANGED (clears the lock on the trigger record) ──
  test('LK-3b: same-base lock_record{locked:false} unlocks the trigger record (back-compat)', async () => {
    const { executor } = makeExecutor()
    const recId = `rec_lk3b_${TS}`
    await q(
      'INSERT INTO meta_records (id, sheet_id, data, version, locked, locked_by) VALUES ($1,$2,$3::jsonb,1,true,$4)',
      [recId, SHEET_A, JSON.stringify({ v: 'x' }), NO_WRITE],
    )
    try {
      const rule = ruleWith({ type: 'lock_record', config: { locked: false } }, OWNER)
      const exec = await executor.execute(rule, { recordId: recId, sheetId: SHEET_A, actorId: NO_WRITE, data: {} })
      expect(exec.steps[0]?.status).toBe('success')
      expect(await recordLocked(recId)).toBe(false)
    } finally {
      await q('DELETE FROM meta_records WHERE id = $1', [recId]).catch(() => {})
    }
  })
})
